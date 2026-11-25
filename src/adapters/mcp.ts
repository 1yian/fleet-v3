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
} from "../board/types.ts";
import { createLineWriter } from "../board/wake.ts";
import { VERSION } from "../version.ts";

const PROTOCOL_VERSION = "2025-06-18";
const PARSE_ERROR = -32_700;
const INVALID_REQUEST = -32_600;
const METHOD_NOT_FOUND = -32_601;
const INVALID_PARAMS = -32_602;
const MAX_HTTP_BODY_BYTES = 1_048_576;

const DURATION_UNITS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

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

function parseDurationMs(raw: string): number {
  const match = /^([1-9]\d*)(s|m|h|d)$/u.exec(raw.trim());
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`Invalid duration "${raw}" (use e.g. 30s, 15m, 2h, 1d)`);
  }
  const unitMs = DURATION_UNITS[match[2]] ?? 0;
  return Number(match[1]) * unitMs;
}

const EmptyArgsSchema = z.object({}).strict();

const CardsArgsSchema = z
  .object({
    mate: MateNameSchema.optional(),
    holder: HolderFilterSchema.optional(),
    state: z.enum(["open", ...CARD_STATES]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const ViewArgsSchema = z.object({ id: z.string().min(1) }).strict();

const DispatchArgsSchema = z
  .object({
    title: z.string().min(1),
    body: z.string().optional(),
    mate: MateNameSchema.optional(),
    project: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    delivery: z.enum(DELIVERIES).optional(),
    needs: z.array(z.string().min(1)).optional(),
  })
  .strict();

const QueueArgsSchema = z
  .object({
    id: z.string().min(1),
    project: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    delivery: z.enum(DELIVERIES).optional(),
  })
  .strict();

const ReplyArgsSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();

const EscalateArgsSchema = z
  .object({
    id: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

const HandoffArgsSchema = z
  .object({
    id: z.string().min(1),
    to: HolderNameSchema.optional(),
    text: z.string().optional(),
  })
  .strict();

const AnswerArgsSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();

const SnoozeArgsSchema = z
  .object({
    id: z.string().min(1),
    duration: z.string().min(1),
    reason: z.string().optional(),
  })
  .strict();

const CloseArgsSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().optional(),
  })
  .strict();

const CancelArgsSchema = z
  .object({
    id: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

const FLEET_MCP_TOOLS: readonly McpToolSpec[] = [
  {
    name: "fleet_overview",
    description: "Read a scoped overview of open cards, counts, and advertised runner hosts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async (raw, ctx) => {
      EmptyArgsSchema.parse(raw ?? {});
      const overview = await ctx.client.getOverview(ctx.mate, ctx.signal);
      return { overview };
    },
  },
  {
    name: "fleet_cards",
    description:
      "List cards in this mate's subtree with optional mate, holder, state, and limit filters.",
    inputSchema: {
      type: "object",
      properties: {
        mate: { type: "string", description: "Filter by owning mate name" },
        holder: { type: "string", description: "Filter by current holder" },
        state: {
          type: "string",
          enum: ["open", ...CARD_STATES],
          description: "Filter by card state or open",
        },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    execute: async (raw, ctx) => {
      const args = CardsArgsSchema.parse(raw ?? {});
      const page = await ctx.client.listCards(
        {
          scope: ctx.mate,
          ...(args.mate !== undefined ? { mate: args.mate } : {}),
          ...(args.holder !== undefined ? { holder: args.holder } : {}),
          ...(args.state !== undefined ? { state: args.state } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
        ctx.signal,
      );
      return { total: page.total, cards: page.cards };
    },
  },
  {
    name: "fleet_view",
    description: "Inspect a single card and its full entry thread.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Card ID" } },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (raw, ctx) => {
      const args = ViewArgsSchema.parse(raw);
      const thread = await ctx.client.getThread(args.id, ctx.mate);
      return { card: thread.card, entries: thread.entries };
    },
  },
  {
    name: "fleet_dispatch",
    description:
      "Create a card for yourself or a direct child 2ndmate, or pass both project and host to spawn an isolated crewmate.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short imperative card title" },
        body: { type: "string", description: "Full specification and acceptance criteria" },
        mate: { type: "string", description: "Target mate (defaults to this mate)" },
        project: { type: "string", description: "Repo key from runner config (requires host)" },
        host: { type: "string", description: "Advertised runner host (requires project)" },
        delivery: { type: "string", enum: [...DELIVERIES] },
        needs: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
      additionalProperties: false,
    },
    execute: async (raw, ctx) => {
      const args = DispatchArgsSchema.parse(raw);
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
  },
  {
    name: "fleet_queue",
    description: "Queue an existing held card to a runner host and project for a crewmate.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Card ID" },
        project: { type: "string" },
        host: { type: "string" },
        delivery: { type: "string", enum: [...DELIVERIES] },
      },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (raw, ctx) => {
      const args = QueueArgsSchema.parse(raw);
      const card = await ctx.client.queueCard(args.id, {
        actor: ctx.mate,
        ...(args.project !== undefined ? { project: args.project } : {}),
        ...(args.host !== undefined ? { host: args.host } : {}),
        ...(args.delivery !== undefined ? { delivery: args.delivery } : {}),
      });
      return { card };
    },
  },
  {
    name: "fleet_reply",
    description: "Post a visible reply entry on a card thread.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Card ID" },
        text: { type: "string", description: "Reply text" },
      },
      required: ["id", "text"],
      additionalProperties: false,
    },
    execute: async (raw, ctx) => {
      const args = ReplyArgsSchema.parse(raw);
      const entry = await ctx.client.postEntry(args.id, { by: ctx.mate, text: args.text });
      return { entry };
    },
  },
  {
    name: "fleet_escalate",
    description: "Escalate a held card up to this mate's parent (or captain).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Card ID" },
        reason: { type: "string", description: "Why escalation is needed" },
      },
      required: ["id", "reason"],
      additionalProperties: false,
    },
    execute: async (raw, ctx) => {
      const args = EscalateArgsSchema.parse(raw);
      const card = await ctx.client.escalateCard(args.id, {
        actor: ctx.mate,
        reason: args.reason,
      });
      return { card };
    },
  },
  {
    name: "fleet_handoff",
    description:
      "Pass a held card to another mate or the captain (or back to its owning mate if `to` is omitted).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Card ID" },
        to: { type: "string", description: "Target mate name or captain" },
        text: { type: "string", description: "Optional handoff summary" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (raw, ctx) => {
      const args = HandoffArgsSchema.parse(raw);
      const card = await ctx.client.handoffCard(args.id, {
        actor: ctx.mate,
        ...(args.to !== undefined ? { to: args.to } : {}),
        ...(args.text !== undefined ? { text: args.text } : {}),
      });
      return { card };
    },
  },
  {
    name: "fleet_answer",
    description: "Answer an escalated card and return it to its owning mate.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Card ID" },
        text: { type: "string", description: "Decision or answer text" },
      },
      required: ["id", "text"],
      additionalProperties: false,
    },
    execute: async (raw, ctx) => {
      const args = AnswerArgsSchema.parse(raw);
      const card = await ctx.client.answerCard(args.id, { actor: ctx.mate, text: args.text });
      return { card };
    },
  },
  {
    name: "fleet_snooze",
    description:
      "Defer stale-card chases while waiting on an external event (e.g. duration '30m').",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Card ID" },
        duration: { type: "string", description: "Duration such as 30s, 15m, 2h, 1d" },
        reason: { type: "string", description: "Optional reason for waiting" },
      },
      required: ["id", "duration"],
      additionalProperties: false,
    },
    execute: async (raw, ctx) => {
      const args = SnoozeArgsSchema.parse(raw);
      const until = Date.now() + parseDurationMs(args.duration);
      const card = await ctx.client.snoozeCard(args.id, {
        actor: ctx.mate,
        until,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
      return { card };
    },
  },
  {
    name: "fleet_close",
    description: "Mark a card done and unblock any waiting dependent cards.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Card ID" },
        text: { type: "string", description: "Optional final outcome note" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (raw, ctx) => {
      const args = CloseArgsSchema.parse(raw);
      const card = await ctx.client.closeCard(args.id, {
        actor: ctx.mate,
        ...(args.text !== undefined ? { text: args.text } : {}),
      });
      return { card };
    },
  },
  {
    name: "fleet_cancel",
    description: "Cancel an open or obsolete card with a reason.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Card ID" },
        reason: { type: "string", description: "Reason for cancellation" },
      },
      required: ["id", "reason"],
      additionalProperties: false,
    },
    execute: async (raw, ctx) => {
      const args = CancelArgsSchema.parse(raw);
      const card = await ctx.client.cancelCard(args.id, {
        actor: ctx.mate,
        reason: args.reason,
      });
      return { card };
    },
  },
  {
    name: "fleet_hosts",
    description: "List runner hosts currently advertised on the Card Server.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async (raw, ctx) => {
      EmptyArgsSchema.parse(raw ?? {});
      const hosts = await ctx.client.listHosts(ctx.signal);
      return { hosts };
    },
  },
  {
    name: "fleet_charter",
    description: "Read this mate's Markdown charter.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async (raw, ctx) => {
      EmptyArgsSchema.parse(raw ?? {});
      const text = await ctx.client.getCharter(ctx.mate, ctx.signal);
      return { mate: ctx.mate, text };
    },
  },
  {
    name: "fleet_prefs",
    description: "Read captain-wide preferences.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async (raw, ctx) => {
      EmptyArgsSchema.parse(raw ?? {});
      const text = await ctx.client.getPrefs(ctx.signal);
      return { text };
    },
  },
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

  if (request.method === "notifications/initialized" && request.id === undefined) {
    return undefined;
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
  const abort = (): void => {
    controller.abort();
    rl.close();
  };
  controller.signal.addEventListener("abort", () => {
    rl.close();
  });
  process.stdin.once("end", abort);
  process.stdin.once("close", abort);

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
    process.stdin.removeListener("end", abort);
    process.stdin.removeListener("close", abort);
    rl.close();
  }
}

export interface FleetMcpHttpOptions {
  readonly client: BoardClient;
  readonly host: string;
  readonly port: number;
  readonly defaultMate?: string;
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

function resolveHttpMate(
  req: IncomingMessage,
  url: URL,
  defaultMate: string | undefined,
): string | undefined {
  const headerVal = req.headers["x-fleet-mate"];
  const raw =
    url.searchParams.get("mate") ??
    (typeof headerVal === "string" && headerVal.trim().length > 0 ? headerVal.trim() : undefined) ??
    defaultMate;
  if (raw === undefined) return undefined;
  const parsed = MateNameSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: FleetMcpHttpOptions,
): Promise<void> {
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

  const mate = resolveHttpMate(req, url, options.defaultMate);
  if (mate === undefined) {
    sendJson(res, 400, {
      error: "missing_mate",
      message: "Pass ?mate=<name>, X-Fleet-Mate header, or start `fleet mcp --http --mate <name>`",
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
  const server: Server = createServer((req, res) => {
    handleHttpRequest(req, res, options).catch(() => {
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
