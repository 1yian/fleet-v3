import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { z } from "zod";
import type { BoardClient } from "../board/client.ts";
import { checkWriteIngress } from "../board/ingress.ts";
import { watchMateWakes, type WakeMessage } from "../board/wake.ts";
import { VERSION } from "../version.ts";
import {
  CallbackError,
  decodeSigningSecret,
  deliverEvent,
  parseCallbackUrl,
  parseJson,
  safeEqual,
  verifyCallback,
  type CallbackPolicy,
  type EventEnvelope,
} from "./events-delivery.ts";

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26"];
const SUPPORTED_VERSIONS: readonly string[] = [MODERN_VERSION, ...LEGACY_VERSIONS];
const EVENT_NAME = "card.wake";
const MAX_BODY_BYTES = 65_536;
const DEFAULT_TTL_MS = 86_400_000;
const MIN_TTL_MS = 60_000;
const VERIFICATION_REUSE_MS = 3_600_000;
const ROTATION_WINDOW_MS = 600_000;
const MIN_TOKEN_LENGTH = 24;
const ENDPOINT = "/mcp";

const PARSE_ERROR = -32_700;
const INVALID_REQUEST = -32_600;
const METHOD_NOT_FOUND = -32_601;
const INVALID_PARAMS = -32_602;
const HEADER_MISMATCH = -32_020;
const UNSUPPORTED_PROTOCOL_VERSION = -32_022;
const CALLBACK_ENDPOINT_ERROR = -32_015;
const NOT_FOUND = -32_023;
const UNSUPPORTED = -32_026;

const SubscriptionSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  secret: z.string().min(1),
  previousSecret: z.string().min(1).optional(),
  previousUntil: z.number().optional(),
  refreshBefore: z.number().nullable(),
  verifiedAt: z.number(),
});

const StateSchema = z.object({ subscriptions: z.array(SubscriptionSchema) });

type Subscription = z.infer<typeof SubscriptionSchema>;

const DeliverySchema = z.object({
  mode: z.string(),
  url: z.string(),
  secret: z.string().optional(),
});

const SubscribeParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: DeliverySchema,
  ttlMs: z.number().int().positive().nullable().optional(),
});

const UnsubscribeParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: DeliverySchema.pick({ url: true }),
});

const InitializeParamsSchema = z.object({ protocolVersion: z.string() });

const ModernRequestSchema = z.object({
  _meta: z.object({ "io.modelcontextprotocol/protocolVersion": z.literal(MODERN_VERSION) }).loose(),
});

class RpcError extends Error {
  public readonly code: number;
  public readonly data: unknown;

  public constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

function rotationFor(
  existing: Subscription | undefined,
  secret: string,
  now: number,
): Pick<Subscription, "previousSecret" | "previousUntil"> {
  if (existing === undefined) return {};
  if (existing.secret !== secret) {
    return { previousSecret: existing.secret, previousUntil: now + ROTATION_WINDOW_MS };
  }
  if (existing.previousSecret !== undefined && (existing.previousUntil ?? 0) > now) {
    return { previousSecret: existing.previousSecret, previousUntil: existing.previousUntil };
  }
  return {};
}

function loadState(path: string): Subscription[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = StateSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid events state file ${path}: ${parsed.error.issues[0]?.message ?? ""}`);
  }
  return parsed.data.subscriptions;
}

function saveState(path: string, subscriptions: readonly Subscription[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ subscriptions }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tempPath, path);
}

function eventDefinition(mate: string): Record<string, unknown> {
  return {
    name: EVENT_NAME,
    description: `Something changed in the court of Fleet mate "${mate}" and needs attention: a new card, a reply, an escalation or answer, a crewmate handback, a completion, or a stale-card chase. The payload carries only a card id and a short summary; read the card itself with the fleet CLI before acting.`,
    delivery: ["webhook"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    payloadSchema: {
      type: "object",
      properties: {
        mate: { type: "string", description: "Mate whose court the wake is for." },
        eventType: { type: "string", description: "Card Server event type that caused the wake." },
        cardId: {
          type: "string",
          description: "Card to re-read with the fleet CLI, when the wake concerns one card.",
        },
        actor: { type: "string", description: "Who caused the change, when known." },
        summary: { type: "string", description: "Short human-readable description of the wake." },
      },
      required: ["mate", "eventType", "summary"],
      additionalProperties: false,
    },
  };
}

interface RequestContext {
  readonly modern: boolean;
}

export interface FleetEventsOptions {
  readonly client: BoardClient;
  readonly mate: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly statePath: string;
  readonly allowLocalCallbacks: boolean;
  readonly onError?: (error: unknown) => void;
}

export interface RunningFleetEvents {
  readonly url: string;
  readonly subscriptionCount: () => number;
  readonly stop: () => Promise<void>;
}

interface EventsBridge {
  readonly count: () => number;
  readonly subscribe: (rawParams: unknown) => Promise<Record<string, unknown>>;
  readonly unsubscribe: (rawParams: unknown) => Record<string, unknown>;
  readonly dispatch: (wake: WakeMessage) => void;
  readonly drain: () => Promise<void>;
}

function requireEmptyArguments(args: Readonly<Record<string, unknown>> | undefined): void {
  if (args !== undefined && Object.keys(args).length > 0) {
    throw new RpcError(INVALID_PARAMS, `${EVENT_NAME} takes no arguments`);
  }
}

function requireEventName(name: string): void {
  if (name !== EVENT_NAME) {
    throw new RpcError(NOT_FOUND, `Unknown event "${name}"`, { kind: "event" });
  }
}

function parseSubscribeParams(rawParams: unknown): {
  readonly delivery: z.infer<typeof DeliverySchema>;
  readonly secret: string;
  readonly ttlMs: number | null | undefined;
} {
  const parsed = SubscribeParamsSchema.safeParse(rawParams);
  if (!parsed.success) throw new RpcError(INVALID_PARAMS, "Invalid events/subscribe params");
  const { name, delivery, ttlMs } = parsed.data;
  requireEventName(name);
  requireEmptyArguments(parsed.data.arguments);
  if (delivery.mode !== "webhook") {
    throw new RpcError(UNSUPPORTED, "Only webhook delivery is supported", {
      feature: "deliveryMode",
      value: delivery.mode,
    });
  }
  const secret = delivery.secret;
  if (secret === undefined || decodeSigningSecret(secret) === undefined) {
    throw new RpcError(INVALID_PARAMS, "delivery.secret must be a whsec_ value of 24 to 64 bytes");
  }
  return { delivery, secret, ttlMs };
}

function wakeEvent(wake: WakeMessage): EventEnvelope {
  return {
    eventId: `evt_${randomUUID()}`,
    name: EVENT_NAME,
    timestamp: new Date().toISOString(),
    data: {
      mate: wake.mate,
      eventType: wake.eventType,
      summary: wake.notice,
      ...(wake.cardId !== undefined ? { cardId: wake.cardId } : {}),
      ...(wake.actor !== undefined ? { actor: wake.actor } : {}),
    },
    cursor: null,
  };
}

function createEventsBridge(options: FleetEventsOptions): EventsBridge {
  const policy: CallbackPolicy = { allowLocal: options.allowLocalCallbacks };
  const inflight = new Set<Promise<void>>();
  const controller = new AbortController();
  const state = { subscriptions: loadState(options.statePath) };

  const live = (): Subscription[] => {
    const now = Date.now();
    return state.subscriptions.filter(
      (sub) => sub.refreshBefore === null || sub.refreshBefore > now,
    );
  };

  const commit = (next: Subscription[]): void => {
    state.subscriptions = next;
    saveState(options.statePath, next);
  };

  const subscriptionId = (url: URL): string => {
    const hash = createHash("sha256")
      .update(`${options.mate}\n${EVENT_NAME}\n{}\n${url.href}`)
      .digest("hex");
    return `sub_${hash.slice(0, 32)}`;
  };

  const parseCallback = (raw: string): URL => {
    const url = parseCallbackUrl(raw, policy);
    if (url === undefined) {
      throw new RpcError(
        INVALID_PARAMS,
        "delivery.url must be an https URL without credentials or fragment",
      );
    }
    return url;
  };

  const verify = async (url: URL, secret: string, id: string): Promise<void> => {
    try {
      await verifyCallback(
        url,
        secret,
        id,
        randomBytes(24).toString("base64url"),
        `msg_verification_${randomUUID()}`,
        policy,
      );
    } catch (error) {
      const reason = error instanceof CallbackError ? error.reason : "unreachable";
      throw new RpcError(CALLBACK_ENDPOINT_ERROR, "Callback endpoint verification failed", {
        reason,
      });
    }
  };

  const subscribe = async (rawParams: unknown): Promise<Record<string, unknown>> => {
    const { delivery, secret, ttlMs } = parseSubscribeParams(rawParams);
    const url = parseCallback(delivery.url);
    const id = subscriptionId(url);
    const now = Date.now();
    const existing = state.subscriptions.find((sub) => sub.id === id);
    const reusable =
      existing !== undefined &&
      existing.secret === secret &&
      now - existing.verifiedAt < VERIFICATION_REUSE_MS;
    if (!reusable) await verify(url, secret, id);
    const refreshBefore =
      ttlMs === null ? null : now + Math.max(ttlMs ?? DEFAULT_TTL_MS, MIN_TTL_MS);
    const record: Subscription = {
      id,
      url: url.href,
      secret,
      refreshBefore,
      verifiedAt: reusable ? existing.verifiedAt : now,
      ...rotationFor(existing, secret, now),
    };
    commit([...live().filter((sub) => sub.id !== id), record]);
    return {
      id,
      refreshBefore: refreshBefore === null ? null : new Date(refreshBefore).toISOString(),
      cursor: null,
      truncated: false,
    };
  };

  const unsubscribe = (rawParams: unknown): Record<string, unknown> => {
    const parsed = UnsubscribeParamsSchema.safeParse(rawParams);
    if (!parsed.success) throw new RpcError(INVALID_PARAMS, "Invalid events/unsubscribe params");
    requireEventName(parsed.data.name);
    requireEmptyArguments(parsed.data.arguments);
    const id = subscriptionId(parseCallback(parsed.data.delivery.url));
    if (state.subscriptions.some((sub) => sub.id === id)) {
      commit(state.subscriptions.filter((sub) => sub.id !== id));
    }
    return {};
  };

  const deliverTo = (sub: Subscription, event: EventEnvelope): void => {
    const rotating = sub.previousSecret !== undefined && (sub.previousUntil ?? 0) > Date.now();
    const task: Promise<void> = deliverEvent(
      new URL(sub.url),
      { current: sub.secret, ...(rotating ? { previous: sub.previousSecret } : {}) },
      sub.id,
      event,
      policy,
      controller.signal,
    )
      .then((outcome) => {
        if (outcome === "gone") commit(state.subscriptions.filter((s) => s.id !== sub.id));
        return undefined;
      })
      .catch((error: unknown) => {
        options.onError?.(error);
      })
      .finally(() => {
        inflight.delete(task);
      });
    inflight.add(task);
  };

  const dispatch = (wake: WakeMessage): void => {
    const event = wakeEvent(wake);
    const active = live();
    if (active.length !== state.subscriptions.length) commit(active);
    for (const sub of active) deliverTo(sub, event);
  };

  const drain = async (): Promise<void> => {
    controller.abort();
    await Promise.allSettled(inflight);
  };

  return { count: () => live().length, subscribe, unsubscribe, dispatch, drain };
}

function resultFor(
  result: Record<string, unknown>,
  context: RequestContext,
): Record<string, unknown> {
  if (!context.modern) return result;
  return {
    resultType: "complete",
    ...result,
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "fleet-events", version: VERSION } },
  };
}

function instructionsFor(mate: string): string {
  return `Fleet wake bridge for mate "${mate}". Subscribe to ${EVENT_NAME} to be woken when a card needs attention. The event carries only a card id and summary; run \`fleet view <cardId> --full\` with the fleet CLI to read the card and act on it.`;
}

async function handleRpc(
  bridge: EventsBridge,
  mate: string,
  method: string,
  params: unknown,
  context: RequestContext,
): Promise<Record<string, unknown>> {
  if (method === "initialize") {
    const requested = InitializeParamsSchema.safeParse(params).data?.protocolVersion;
    const protocolVersion =
      requested !== undefined && LEGACY_VERSIONS.includes(requested)
        ? requested
        : LEGACY_VERSIONS[0];
    return {
      protocolVersion,
      capabilities: { events: {} },
      serverInfo: { name: "fleet-events", version: VERSION },
      instructions: instructionsFor(mate),
    };
  }
  if (method === "server/discover") {
    return resultFor(
      {
        supportedVersions: [MODERN_VERSION],
        capabilities: { events: {} },
        instructions: instructionsFor(mate),
        ttlMs: 3_600_000,
        cacheScope: "private",
      },
      context,
    );
  }
  if (method === "ping") return resultFor({}, context);
  if (method === "events/list") {
    return resultFor({ events: [eventDefinition(mate)] }, context);
  }
  if (method === "events/subscribe") return resultFor(await bridge.subscribe(params), context);
  if (method === "events/unsubscribe") return resultFor(bridge.unsubscribe(params), context);
  throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function rpcError(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

type JsonBodyResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly status: number; readonly message: string };

function readJsonBody(req: IncomingMessage): Promise<JsonBodyResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.pause();
        resolve({ ok: false, status: 413, message: "Request body exceeds 64 KiB limit" });
        return;
      }
      chunks.push(chunk);
    });
    req.once("error", reject);
    req.once("end", () => {
      const body = parseJson(Buffer.concat(chunks).toString("utf8"));
      resolve(
        body === undefined
          ? { ok: false, status: 400, message: "Invalid JSON" }
          : { ok: true, body },
      );
    });
  });
}

function presentedToken(req: IncomingMessage, pathToken: string | undefined): string | undefined {
  if (pathToken !== undefined) return pathToken;
  const header = req.headers.authorization ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface Rejection {
  readonly status: number;
  readonly payload: unknown;
  readonly headers?: Record<string, string>;
}

const RpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

function pathRejection(req: IncomingMessage, token: string): Rejection | undefined {
  const url = new URL(req.url ?? "/", "http://localhost");
  const [, endpoint, pathToken, ...rest] = url.pathname.split("/");
  if (`/${endpoint ?? ""}` !== ENDPOINT || rest.length > 0) {
    return { status: 404, payload: { error: "not_found" } };
  }
  if (req.method !== "POST") {
    return { status: 405, payload: { error: "method_not_allowed" }, headers: { allow: "POST" } };
  }
  const presented = presentedToken(req, pathToken);
  if (presented === undefined || !safeEqual(digest(presented), digest(token))) {
    return {
      status: 401,
      payload: { error: "unauthorized" },
      headers: { "www-authenticate": "Bearer" },
    };
  }
  return undefined;
}

function protocolVersionOf(req: IncomingMessage): string | undefined {
  const raw = req.headers["mcp-protocol-version"];
  return typeof raw === "string" ? raw : undefined;
}

function headerRejection(req: IncomingMessage): Rejection | undefined {
  const ingress = checkWriteIngress(req);
  if (ingress !== undefined) {
    return { status: ingress.status, payload: { error: ingress.code, message: ingress.message } };
  }
  const version = protocolVersionOf(req);
  if (version !== undefined && !SUPPORTED_VERSIONS.includes(version)) {
    return {
      status: 400,
      payload: rpcError(null, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
        supported: SUPPORTED_VERSIONS,
        requested: version,
      }),
    };
  }
  return undefined;
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  bridge: EventsBridge,
  options: FleetEventsOptions,
): Promise<void> {
  const rejection = pathRejection(req, options.token) ?? headerRejection(req);
  if (rejection !== undefined) {
    sendJson(res, rejection.status, rejection.payload, rejection.headers);
    return;
  }
  const body = await readJsonBody(req);
  if (!body.ok) {
    const code = body.status === 413 ? INVALID_REQUEST : PARSE_ERROR;
    sendJson(res, body.status, rpcError(null, code, body.message));
    return;
  }
  const request = RpcRequestSchema.safeParse(body.body);
  if (!request.success) {
    sendJson(res, 400, rpcError(null, INVALID_REQUEST, "Invalid JSON-RPC 2.0 request"));
    return;
  }
  const { id, method, params } = request.data;
  if (id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  const modern = protocolVersionOf(req) === MODERN_VERSION;
  if (
    modern &&
    (req.headers["mcp-method"] !== method || !ModernRequestSchema.safeParse(params).success)
  ) {
    const message =
      "Header mismatch: Mcp-Method or protocol version does not match the request body";
    sendJson(res, 400, rpcError(id, HEADER_MISMATCH, message));
    return;
  }
  try {
    const result = await handleRpc(bridge, options.mate, method, params, { modern });
    sendJson(res, 200, { jsonrpc: "2.0", id, result });
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    sendJson(res, 200, rpcError(id, error.code, error.message, error.data));
  }
}

export function validateEventsToken(token: string | undefined): string {
  if (token === undefined || token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `FLEET_EVENTS_TOKEN must be set to a secret of at least ${String(MIN_TOKEN_LENGTH)} characters`,
    );
  }
  if (!/^[A-Za-z0-9._~-]+$/u.test(token)) {
    throw new Error("FLEET_EVENTS_TOKEN may contain only letters, digits, and . _ ~ -");
  }
  return token;
}

export async function startFleetEvents(options: FleetEventsOptions): Promise<RunningFleetEvents> {
  const bridge = createEventsBridge(options);
  const server: Server = createServer((req, res) => {
    handleHttp(req, res, bridge, options).catch((error: unknown) => {
      options.onError?.(error);
      if (res.destroyed || res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { error: "internal_error" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const watchController = new AbortController();
  const initialCursor = await options.client
    .latestEventId(watchController.signal)
    .catch(() => undefined);
  const watching = watchMateWakes({
    client: options.client,
    mate: options.mate,
    signal: watchController.signal,
    ...(initialCursor !== undefined ? { initialCursor } : {}),
    onWake: (wake) => {
      bridge.dispatch(wake);
    },
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });

  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : options.port;
  const displayHost = options.host.includes(":") ? `[${options.host}]` : options.host;
  return {
    url: `http://${displayHost}:${String(port)}${ENDPOINT}`,
    subscriptionCount: bridge.count,
    stop: async () => {
      watchController.abort();
      await watching;
      await bridge.drain();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
