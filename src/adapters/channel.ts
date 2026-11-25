import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { BoardClient } from "../board/client.ts";
import { watchMateWakes, type WakeMessage } from "../board/wake.ts";
import { VERSION } from "../version.ts";

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: string | number | null;
  readonly method?: unknown;
  readonly params?: unknown;
}

export interface FleetChannelOptions {
  readonly client: BoardClient;
  readonly mate: string;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly signal?: AbortSignal;
  readonly reconnectDelayMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function channelMeta(wake: WakeMessage): Record<string, string> {
  const meta: Record<string, string> = {
    mate: wake.mate,
    event_type: wake.event?.type ?? "reconciliation",
  };
  if (wake.event?.cardId !== undefined && wake.event.cardId !== null) {
    meta["card_id"] = wake.event.cardId;
  }
  if (wake.event?.actor !== undefined && wake.event.actor !== null) {
    meta["actor"] = wake.event.actor;
  }
  return meta;
}

function writeJsonLine(output: Writable, payload: unknown): void {
  output.write(`${JSON.stringify(payload)}\n`);
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

  let watchPromise: Promise<void> | undefined;
  const startWatch = (): void => {
    if (watchPromise !== undefined || controller.signal.aborted) return;
    watchPromise = (async () => {
      const initialCursor = await options.client.latestEventId().catch(() => undefined);
      await watchMateWakes({
        client: options.client,
        mate: options.mate,
        signal: controller.signal,
        ...(initialCursor !== undefined ? { initialCursor } : {}),
        ...(options.reconnectDelayMs !== undefined
          ? { reconnectDelayMs: options.reconnectDelayMs }
          : {}),
        onWake(wake) {
          writeJsonLine(output, {
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

  const handleRequest = (req: JsonRpcRequest): void => {
    const method = typeof req.method === "string" ? req.method : undefined;
    const hasId = req.id !== undefined && req.id !== null;

    if (method === "initialize") {
      const requestedVersion =
        isRecord(req.params) && typeof req.params["protocolVersion"] === "string"
          ? req.params["protocolVersion"]
          : "2025-03-26";
      if (hasId) {
        writeJsonLine(output, {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            protocolVersion: requestedVersion,
            capabilities: {
              experimental: {
                "claude/channel": {},
              },
            },
            serverInfo: {
              name: "fleet",
              version: VERSION,
            },
            instructions: channelInstructions(options.mate),
          },
        });
      }
      startWatch();
      return;
    }

    if (method === "notifications/initialized") {
      startWatch();
      return;
    }

    if (method === "ping") {
      if (hasId) {
        writeJsonLine(output, { jsonrpc: "2.0", id: req.id, result: {} });
      }
      return;
    }

    if (method === "tools/list") {
      if (hasId) {
        writeJsonLine(output, { jsonrpc: "2.0", id: req.id, result: { tools: [] } });
      }
      return;
    }

    if (hasId) {
      writeJsonLine(output, {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: -32_601,
          message: `Method not found: ${method ?? "unknown"}`,
        },
      });
    }
  };

  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    handleRequest(parsed);
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
