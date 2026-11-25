import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { BoardClient } from "../board/client.ts";
import { watchMateWakes, writeLine, type WakeMessage } from "../board/wake.ts";
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
  readonly input?: Readable;
  readonly output?: Writable;
  readonly signal?: AbortSignal;
  readonly reconnectDelayMs?: number;
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
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const controller = new AbortController();

  const onExternalAbort = (): void => {
    controller.abort();
  };
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const send = (payload: unknown): Promise<void> =>
    writeLine(output, `${JSON.stringify(payload)}\n`, controller.signal);
  const reply = (payload: unknown): void => {
    void send(payload);
  };

  let watchPromise: Promise<void> | undefined;
  const startWatch = (): void => {
    if (watchPromise !== undefined || controller.signal.aborted) return;
    watchPromise = (async () => {
      const initialCursor = await options.client
        .latestEventId(controller.signal)
        .catch(() => undefined);
      await watchMateWakes({
        client: options.client,
        mate: options.mate,
        signal: controller.signal,
        ...(initialCursor !== undefined ? { initialCursor } : {}),
        ...(options.reconnectDelayMs !== undefined
          ? { reconnectDelayMs: options.reconnectDelayMs }
          : {}),
        onWake(wake) {
          return send({
            jsonrpc: "2.0",
            method: "notifications/claude/channel",
            params: {
              content: wake.notice,
              meta: channelMeta(wake),
            },
          });
        },
      });
    })();
  };

  const writeError = (id: string | number | null, code: number, message: string): void => {
    reply({ jsonrpc: "2.0", id, error: { code, message } });
  };

  let initializeAnswered = false;

  const handleRequest = (req: JsonRpcRequest): void => {
    const { id, method } = req;

    if (id === undefined) {
      if (method === "notifications/initialized" && initializeAnswered) startWatch();
      return;
    }

    if (method === "initialize") {
      if (initializeAnswered) {
        writeError(id, INVALID_REQUEST, "Already initialized");
        return;
      }
      initializeAnswered = true;
      reply({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(req.params),
          capabilities: { experimental: { "claude/channel": {} } },
          serverInfo: { name: "fleet", version: VERSION },
          instructions: channelInstructions(options.mate),
        },
      });
      return;
    }

    if (method === "ping") {
      reply({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    writeError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  };

  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeError(null, PARSE_ERROR, "Parse error");
      return;
    }
    const request = parseJsonRpcRequest(parsed);
    if (request === undefined) {
      const id = isRecord(parsed) ? parsed["id"] : undefined;
      writeError(
        typeof id === "string" || typeof id === "number" ? id : null,
        INVALID_REQUEST,
        "Invalid Request",
      );
      return;
    }
    handleRequest(request);
  });

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      controller.abort();
      rl.close();
      resolve();
    };
    rl.once("close", finish);
    input.once("end", finish);
    controller.signal.addEventListener("abort", finish, { once: true });
  });

  options.signal?.removeEventListener("abort", onExternalAbort);
  await watchPromise?.catch(() => undefined);
}
