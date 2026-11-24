import { createHttpBoardClient, type BoardClient } from "../src/board/client.ts";
import { startBoardServer } from "../src/board/server.ts";
import { CardStore } from "../src/board/store.ts";
import type { BoardEvent } from "../src/board/types.ts";

export interface TestServer {
  readonly url: string;
  readonly client: BoardClient;
  readonly stop: () => Promise<void>;
}

export async function startTestServer(
  options: {
    readonly dataDir?: string;
    readonly parents?: Readonly<Record<string, string>>;
    readonly now?: () => number;
    readonly chaseIntervalMs?: number;
    readonly staleAfterMs?: number;
  } = {},
): Promise<TestServer> {
  const store = new CardStore({
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : { memory: true }),
    ...(options.parents !== undefined ? { parents: options.parents } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const started = await startBoardServer({
    store,
    host: "127.0.0.1",
    port: 0,
    chaseIntervalMs: options.chaseIntervalMs ?? 3_600_000,
    staleAfterMs: options.staleAfterMs ?? 600_000,
  });
  return {
    url: started.url,
    client: createHttpBoardClient(started.url),
    stop: async () => {
      await started.stop();
      store.close();
    },
  };
}

export interface EventWatch {
  readonly events: BoardEvent[];
  readonly stop: () => Promise<void>;
}

export function watchEvents(
  client: BoardClient,
  options: { readonly after?: number; readonly holder?: string; readonly mate?: string } = {},
): EventWatch {
  const controller = new AbortController();
  const events: BoardEvent[] = [];
  const loop = (async () => {
    for await (const event of client.events({ ...options, signal: controller.signal })) {
      events.push(event);
    }
  })().catch(() => undefined);
  return {
    events,
    stop: async () => {
      controller.abort();
      await loop;
    },
  };
}

export async function cardField(
  client: BoardClient,
  id: string,
  field: "state" | "epoch" | "holder",
): Promise<string | number> {
  const thread = await client.getThread(id);
  return thread.card[field];
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return predicate();
}
