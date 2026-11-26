import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { BoardClient } from "../board/client.ts";
import { checkWriteIngress } from "../board/ingress.ts";
import {
  CARD_STATES,
  DELIVERIES,
  HolderFilterSchema,
  HolderNameSchema,
  MateNameSchema,
  parseDurationMs,
} from "../board/types.ts";
import { createLineWriter } from "../board/wake.ts";
import { VERSION } from "../version.ts";

const PROTOCOL_VERSION = "2025-06-18";
const PARSE_ERROR = -32_700;
const INVALID_REQUEST = -32_600;
const METHOD_NOT_FOUND = -32_601;
const INVALID_PARAMS = -32_602;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_HTTP_BODY_BYTES = 1_048_576;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface JsonRpcRequest {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: unknown;
}

interface McpToolContext {
  readonly client: BoardClient;
  readonly mate: string;
  readonly signal?: AbortSignal;
}

interface McpToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly execute: (args: unknown, ctx: McpToolContext) => Promise<Record<string, unknown>>;
}

function defineTool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  run: (args: z.infer<S>, ctx: McpToolContext) => Promise<Record<string, unknown>>,
): McpToolSpec {
  const { $schema: _draft, ...inputSchema } = z.toJSONSchema(schema);
  return {
    name,
    description,
    inputSchema,
    execute: (raw, ctx) => run(schema.parse(raw ?? {}), ctx),
  };
}

const CARDS_DEFAULT_LIMIT = 50;

const nonEmptyString = z.string().min(1);
const cardId = z.string().min(1).describe("Card ID");

const FLEET_MCP_TOOLS: readonly McpToolSpec[] = [
  defineTool(
    "fleet_overview",
    "Read a scoped overview of open cards, counts, and advertised runner hosts.",
    z.object({}).strict(),
    async (_args, ctx) => ({ overview: await ctx.client.getOverview(ctx.mate, ctx.signal) }),
  ),
  defineTool(
    "fleet_cards",
    `List cards in this mate's subtree with optional mate, holder, state, and limit filters (default limit ${String(CARDS_DEFAULT_LIMIT)}).`,
    z
      .object({
        mate: MateNameSchema.optional().describe("Filter by owning mate name"),
        holder: HolderFilterSchema.optional().describe("Filter by current holder"),
        state: z
          .enum(["open", ...CARD_STATES])
          .optional()
          .describe("Filter by card state or open"),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    async (args, ctx) => {
      const page = await ctx.client.listCards(
        {
          scope: ctx.mate,
          limit: args.limit ?? CARDS_DEFAULT_LIMIT,
          ...(args.mate !== undefined ? { mate: args.mate } : {}),
          ...(args.holder !== undefined ? { holder: args.holder } : {}),
          ...(args.state !== undefined ? { state: args.state } : {}),
        },
        ctx.signal,
      );
      return { total: page.total, cards: page.cards };
    },
  ),
  defineTool(
    "fleet_view",
    "Inspect a single card and its full entry thread.",
    z.object({ id: cardId }).strict(),
    async (args, ctx) => {
      const thread = await ctx.client.getThread(args.id, ctx.mate);
      return { card: thread.card, entries: thread.entries };
    },
  ),
  defineTool(
    "fleet_dispatch",
    "Create a card for yourself or a direct child 2ndmate, or pass both project and host to spawn an isolated crewmate.",
    z
      .object({
        title: z.string().min(1).describe("Short imperative card title"),
        body: z.string().optional().describe("Full specification and acceptance criteria"),
        mate: MateNameSchema.optional().describe("Target mate (defaults to this mate)"),
        project: z
          .string()
          .min(1)
          .optional()
          .describe("Repo key from runner config (requires host)"),
        host: z.string().min(1).optional().describe("Advertised runner host (requires project)"),
        delivery: z.enum(DELIVERIES).optional(),
        needs: z.array(nonEmptyString).optional(),
      })
      .strict(),
    async (args, ctx) => {
      const card = await ctx.client.createCard({
        mate: args.mate ?? ctx.mate,
        title: args.title,
        actor: ctx.mate,
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(args.project !== undefined ? { project: args.project } : {}),
        ...(args.host !== undefined ? { host: args.host } : {}),
        ...(args.delivery !== undefined ? { delivery: args.delivery } : {}),
        ...(args.needs !== undefined ? { needs: args.needs } : {}),
      });
      return { card };
    },
  ),
  defineTool(
    "fleet_queue",
    "Queue an existing held card to a runner host and project for a crewmate.",
    z
      .object({
        id: cardId,
        project: z.string().min(1).optional(),
        host: z.string().min(1).optional(),
        delivery: z.enum(DELIVERIES).optional(),
      })
      .strict(),
    async (args, ctx) => {
      const card = await ctx.client.queueCard(args.id, {
        actor: ctx.mate,
        ...(args.project !== undefined ? { project: args.project } : {}),
        ...(args.host !== undefined ? { host: args.host } : {}),
        ...(args.delivery !== undefined ? { delivery: args.delivery } : {}),
      });
      return { card };
    },
  ),
  defineTool(
    "fleet_reply",
    "Post a reply without transferring the card. A public reply wakes only the current holder, not yourself. Use fleet_answer or fleet_handoff to pass work back.",
    z
      .object({
        id: cardId,
        text: z.string().min(1).describe("Reply text"),
        internal: z.boolean().optional().describe("Post a quiet internal note"),
      })
      .strict(),
    async (args, ctx) => {
      const { entry } = await ctx.client.postEntry(args.id, {
        by: ctx.mate,
        text: args.text,
        ...(args.internal !== undefined ? { internal: args.internal } : {}),
      });
      return { entry };
    },
  ),
  defineTool(
    "fleet_escalate",
    "Escalate a held card up to this mate's parent (or captain).",
    z
      .object({ id: cardId, reason: z.string().min(1).describe("Why escalation is needed") })
      .strict(),
    async (args, ctx) => {
      const card = await ctx.client.escalateCard(args.id, {
        actor: ctx.mate,
        reason: args.reason,
      });
      return { card };
    },
  ),
  defineTool(
    "fleet_handoff",
    "Pass a held card to another mate or the captain (or back to its owning mate if `to` is omitted).",
    z
      .object({
        id: cardId,
        to: HolderNameSchema.optional().describe("Target mate name or captain"),
        text: z.string().optional().describe("Optional handoff summary"),
      })
      .strict(),
    async (args, ctx) => {
      const card = await ctx.client.handoffCard(args.id, {
        actor: ctx.mate,
        ...(args.to !== undefined ? { to: args.to } : {}),
        ...(args.text !== undefined ? { text: args.text } : {}),
      });
      return { card };
    },
  ),
  defineTool(
    "fleet_answer",
    "Answer an escalated card and return it to its owning mate.",
    z.object({ id: cardId, text: z.string().min(1).describe("Decision or answer text") }).strict(),
    async (args, ctx) => {
      const card = await ctx.client.answerCard(args.id, { actor: ctx.mate, text: args.text });
      return { card };
    },
  ),
  defineTool(
    "fleet_snooze",
    "Defer stale-card chases while waiting on an external event (e.g. duration '30m').",
    z
      .object({
        id: cardId,
        duration: z.string().min(1).describe("Duration such as 30s, 15m, 2h, 1d"),
        reason: z.string().optional().describe("Optional reason for waiting"),
      })
      .strict(),
    async (args, ctx) => {
      const durationMs = parseDurationMs(args.duration);
      if (durationMs === undefined) {
        throw new Error(`Invalid duration "${args.duration}" (use e.g. 30s, 15m, 2h, 1d)`);
      }
      const card = await ctx.client.snoozeCard(args.id, {
        actor: ctx.mate,
        until: Date.now() + durationMs,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
      return { card };
    },
  ),
  defineTool(
    "fleet_close",
    "Mark a card done and unblock any waiting dependent cards.",
    z
      .object({ id: cardId, text: z.string().optional().describe("Optional final outcome note") })
      .strict(),
    async (args, ctx) => {
      const card = await ctx.client.closeCard(args.id, {
        actor: ctx.mate,
        ...(args.text !== undefined ? { text: args.text } : {}),
      });
      return { card };
    },
  ),
  defineTool(
    "fleet_cancel",
    "Cancel an open or obsolete card with a reason.",
    z
      .object({ id: cardId, reason: z.string().min(1).describe("Reason for cancellation") })
      .strict(),
    async (args, ctx) => {
      const card = await ctx.client.cancelCard(args.id, {
        actor: ctx.mate,
        reason: args.reason,
      });
      return { card };
    },
  ),
  defineTool(
    "fleet_hosts",
    "List runner hosts currently advertised on the Card Server.",
    z.object({}).strict(),
    async (_args, ctx) => ({ hosts: await ctx.client.listHosts(ctx.signal) }),
  ),
  defineTool(
    "fleet_charter",
    "Read this mate's Markdown charter.",
    z.object({}).strict(),
    async (_args, ctx) => ({
      mate: ctx.mate,
      text: await ctx.client.getCharter(ctx.mate, ctx.signal),
    }),
  ),
  defineTool(
    "fleet_prefs",
    "Read captain-wide preferences.",
    z.object({}).strict(),
    async (_args, ctx) => ({ text: await ctx.client.getPrefs(ctx.signal) }),
  ),
];

const TOOL_BY_NAME = new Map<string, McpToolSpec>(FLEET_MCP_TOOLS.map((tool) => [tool.name, tool]));

function parseJsonRpcRequest(value: unknown): JsonRpcRequest | undefined {
  if (!isRecord(value) || Array.isArray(value)) return undefined;
  const { jsonrpc, id, method, params } = value;
  if (jsonrpc !== "2.0" || typeof method !== "string") return undefined;
  if (id !== undefined && typeof id !== "string" && typeof id !== "number") return undefined;
  return { ...(id !== undefined ? { id } : {}), method, params };
}

function formatErrorText(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

async function handleToolCall(
  id: string | number,
  params: unknown,
  ctx: McpToolContext,
): Promise<Record<string, unknown>> {
  if (!isRecord(params) || typeof params["name"] !== "string") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: INVALID_PARAMS, message: "tools/call requires a string tool name" },
    };
  }
  const tool = TOOL_BY_NAME.get(params["name"]);
  if (tool === undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: INVALID_PARAMS, message: `Unknown tool "${params["name"]}"` },
    };
  }
  try {
    const data = await tool.execute(params["arguments"], ctx);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
      },
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        isError: true,
        content: [{ type: "text", text: formatErrorText(error) }],
      },
    };
  }
}

function handleMcpRequest(
  raw: unknown,
  ctx: McpToolContext,
): Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined {
  const request = parseJsonRpcRequest(raw);
  if (request === undefined) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: INVALID_REQUEST, message: "Invalid JSON-RPC 2.0 request" },
    };
  }

  if (request.id === undefined) {
    return undefined;
  }

  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "fleet-mcp", version: VERSION },
        instructions: `Fleet MCP tools scoped to mate "${ctx.mate}". Use fleet_view to inspect cards, fleet_dispatch to delegate to 2ndmates or spawn crewmates, and fleet_close / fleet_snooze / fleet_handoff / fleet_escalate to manage card state.`,
      },
    };
  }

  if (request.method === "ping") {
    return { jsonrpc: "2.0", id: request.id, result: {} };
  }

  if (request.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: FLEET_MCP_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
    };
  }

  if (request.method === "tools/call") {
    return handleToolCall(request.id, request.params, ctx);
  }

  return {
    jsonrpc: "2.0",
    id: request.id,
    error: { code: METHOD_NOT_FOUND, message: `Method not found: ${request.method}` },
  };
}

export interface FleetMcpStdioOptions {
  readonly client: BoardClient;
  readonly mate: string;
  readonly controller: AbortController;
}

export async function runFleetMcpStdio(options: FleetMcpStdioOptions): Promise<void> {
  const { client, mate, controller } = options;
  const send = createLineWriter(process.stdout, controller);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  controller.signal.addEventListener("abort", () => {
    rl.close();
  });

  try {
    for await (const line of rl) {
      if (controller.signal.aborted) break;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        await send(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: PARSE_ERROR, message: "Invalid JSON" },
          })}\n`,
        );
        continue;
      }
      const response = await handleMcpRequest(parsed, {
        client,
        mate,
        signal: controller.signal,
      });
      if (response !== undefined) {
        await send(`${JSON.stringify(response)}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

export interface FleetMcpHttpOptions {
  readonly client: BoardClient;
  readonly host: string;
  readonly port: number;
}

export interface RunningFleetMcpHttp {
  readonly url: string;
  readonly stop: () => Promise<void>;
}

type JsonBodyResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly status: number; readonly error: string };

function readJsonBody(req: IncomingMessage): Promise<JsonBodyResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > MAX_HTTP_BODY_BYTES) {
        req.removeListener("data", onData);
        req.pause();
        resolve({ ok: false, status: 413, error: "Request body exceeds 1 MiB limit" });
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("error", reject);
    req.once("close", () => {
      if (!req.complete) reject(new Error("Client disconnected before the request body finished"));
    });
    req.once("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) {
        resolve({ ok: false, status: 400, error: "Empty JSON-RPC body" });
        return;
      }
      try {
        resolve({ ok: true, body: JSON.parse(raw) });
      } catch {
        resolve({ ok: false, status: 400, error: "Invalid JSON" });
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: FleetMcpHttpOptions,
  allowedHosts: ReadonlySet<string>,
): Promise<void> {
  if (!allowedHosts.has((req.headers.host ?? "").toLowerCase())) {
    sendJson(res, 403, { error: "forbidden_host", message: "Host is not served by this listener" });
    return;
  }
  if (!URL.canParse(req.url ?? "/", "http://localhost")) {
    sendJson(res, 400, { error: "bad_request", message: "Malformed request target" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/mcp") {
    sendJson(res, 404, { error: "not_found", message: "POST JSON-RPC 2.0 requests to /mcp" });
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST", "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "method_not_allowed", message: "Use POST /mcp" }));
    return;
  }
  const ingressErr = checkWriteIngress(req);
  if (ingressErr !== undefined) {
    sendJson(res, ingressErr.status, { error: ingressErr.code, message: ingressErr.message });
    return;
  }

  const protocolVersion = req.headers["mcp-protocol-version"];
  if (protocolVersion !== undefined && protocolVersion !== PROTOCOL_VERSION) {
    sendJson(res, 400, {
      error: "unsupported_protocol_version",
      message: `Only MCP protocol version ${PROTOCOL_VERSION} is supported`,
    });
    return;
  }

  const mate = MateNameSchema.safeParse(url.searchParams.get("mate")).data;
  if (mate === undefined) {
    sendJson(res, 400, {
      error: "missing_mate",
      message: "Pass ?mate=<name> with a valid mate name",
    });
    return;
  }

  const bodyResult = await readJsonBody(req);
  if (!bodyResult.ok) {
    if (bodyResult.status === 413) res.setHeader("connection", "close");
    sendJson(res, bodyResult.status, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: bodyResult.status === 413 ? INVALID_REQUEST : PARSE_ERROR,
        message: bodyResult.error,
      },
    });
    return;
  }

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const response = await handleMcpRequest(bodyResult.body, {
    client: options.client,
    mate,
    signal: controller.signal,
  });
  if (res.destroyed || res.writableEnded) return;
  if (response === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, response);
}

export async function startFleetMcpHttpServer(
  options: FleetMcpHttpOptions,
): Promise<RunningFleetMcpHttp> {
  const allowedHosts = new Set<string>();
  const server: Server = createServer((req, res) => {
    handleHttpRequest(req, res, options, allowedHosts).catch(() => {
      if (res.destroyed || res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { error: "internal_error", message: "Request failed" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = addr !== null && typeof addr === "object" ? addr.port : options.port;
  const displayHost = options.host.includes(":") ? `[${options.host}]` : options.host;
  const authorities = LOOPBACK_HOSTS.has(options.host)
    ? ["localhost", "127.0.0.1", "[::1]"]
    : [displayHost.toLowerCase()];
  for (const authority of authorities) allowedHosts.add(`${authority}:${String(actualPort)}`);
  return {
    url: `http://${displayHost}:${String(actualPort)}/mcp`,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
