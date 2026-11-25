import { createInterface } from "node:readline";
import type { BoardClient } from "../board/client.ts";
import { createLineWriter, watchMateWakes, type WakeMessage } from "../board/wake.ts";
import { VERSION } from "../version.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface JsonRpcRequest {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: unknown;
}

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const PARSE_ERROR = -32_700;
const INVALID_REQUEST = -32_600;
const METHOD_NOT_FOUND = -32_601;

function parseJsonRpcRequest(value: unknown): JsonRpcRequest | undefined {
  if (!isRecord(value) || Array.isArray(value)) return undefined;
  const { jsonrpc, id, method, params } = value;
  if (jsonrpc !== "2.0" || typeof method !== "string") return undefined;
  if (id !== undefined && typeof id !== "string" && typeof id !== "number") return undefined;
  return { ...(id !== undefined ? { id } : {}), method, params };
}

function negotiateProtocolVersion(params: unknown): string {
  const requested = isRecord(params) ? params["protocolVersion"] : undefined;
  return (
    SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === requested) ??
    SUPPORTED_PROTOCOL_VERSIONS[0]
  );
}

export interface FleetChannelOptions {
  readonly client: BoardClient;
  readonly mate: string;
  readonly controller: AbortController;
}

function channelMeta(wake: WakeMessage): Record<string, string> {
  return {
    mate: wake.mate,
    event_type: wake.eventType,
    ...(wake.cardId !== undefined ? { card_id: wake.cardId } : {}),
    ...(wake.actor !== undefined ? { actor: wake.actor } : {}),
  };
}

function channelInstructions(mate: string): string {
  return [
    `Fleet wake events for mate "${mate}" arrive inside <channel source="fleet"> tags.`,
    "Inspect each card with `fleet view <id> --full`, handle work inline or delegate via `fleet dispatch`, and update state with `fleet close`, `fleet queue`, `fleet snooze`, `fleet handoff`, or `fleet escalate`.",
  ].join(" ");
}

export async function runFleetChannel(options: FleetChannelOptions): Promise<void> {
  const { client, mate, controller } = options;
  const send = createLineWriter(process.stdout, controller);
  const reply = (payload: unknown): Promise<void> => send(`${JSON.stringify(payload)}\n`);
  const replyError = (id: string | number | null, code: number, message: string): Promise<void> =>
    reply({ jsonrpc: "2.0", id, error: { code, message } });

  let initialCursor: number | undefined;
  let initializeAnswered = false;
  let watchPromise: Promise<void> | undefined;

  const startWatch = (): void => {
    if (watchPromise !== undefined || controller.signal.aborted) return;
    watchPromise = watchMateWakes({
      client,
      mate,
      signal: controller.signal,
      ...(initialCursor !== undefined ? { initialCursor } : {}),
      onWake(wake) {
        return reply({
          jsonrpc: "2.0",
          method: "notifications/claude/channel",
          params: {
            content: wake.notice,
            meta: channelMeta(wake),
          },
        });
      },
    });
  };

  const handleRequest = async (req: JsonRpcRequest): Promise<void> => {
    const { id, method } = req;

    if (id === undefined) {
      if (method === "notifications/initialized" && initializeAnswered) startWatch();
      return;
    }

    if (method === "initialize") {
      if (initializeAnswered) {
        await replyError(id, INVALID_REQUEST, "Already initialized");
        return;
      }
      initializeAnswered = true;
      initialCursor = await client.latestEventId(controller.signal).catch(() => undefined);
      await reply({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(req.params),
          capabilities: { experimental: { "claude/channel": {} } },
          serverInfo: { name: "fleet", version: VERSION },
          instructions: channelInstructions(mate),
        },
      });
      return;
    }

    if (method === "ping") {
      await reply({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    await replyError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  };

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      await replyError(null, PARSE_ERROR, "Parse error");
      return;
    }
    const request = parseJsonRpcRequest(parsed);
    if (request === undefined) {
      const id = isRecord(parsed) ? parsed["id"] : undefined;
      await replyError(
        typeof id === "string" || typeof id === "number" ? id : null,
        INVALID_REQUEST,
        "Invalid Request",
      );
      return;
    }
    await handleRequest(request);
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const closeOnAbort = (): void => {
    rl.close();
  };
  controller.signal.addEventListener("abort", closeOnAbort, { once: true });
  for await (const line of rl) {
    await handleLine(line);
  }
  controller.abort();
  controller.signal.removeEventListener("abort", closeOnAbort);
  await watchPromise?.catch(() => undefined);
}
