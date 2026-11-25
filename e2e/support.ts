import type { PiExtensionApi } from "../src/adapters/pi.ts";
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
    readonly port?: number;
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
    port: options.port ?? 0,
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
  options: {
    readonly after?: number;
    readonly holder?: string;
    readonly initialChase?: boolean;
  } = {},
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

export function createMockPi(): {
  readonly api: PiExtensionApi;
  readonly delivered: string[];
  readonly woke: boolean[];
  readonly emitStart: () => Promise<void>;
  readonly emitShutdown: () => Promise<void>;
  readonly emitBeforeStart: (systemPrompt: string) => Promise<{ systemPrompt: string } | undefined>;
} {
  const handlers: {
    start?: () => Promise<void> | void;
    shutdown?: () => Promise<void> | void;
    beforeStart?: (event: {
      readonly systemPrompt: string;
    }) => Promise<{ systemPrompt: string } | undefined> | { systemPrompt: string } | undefined;
  } = {};
  const delivered: string[] = [];
  const woke: boolean[] = [];

  const on: PiExtensionApi["on"] = (event: string, handler: (...args: never[]) => unknown) => {
    if (event === "session_start") {
      handlers.start = () => {
        const result: unknown = Reflect.apply(handler, undefined, []);
        return result instanceof Promise ? result.then(() => undefined) : undefined;
      };
      return;
    }
    if (event === "session_shutdown") {
      handlers.shutdown = () => {
        const result: unknown = Reflect.apply(handler, undefined, []);
        return result instanceof Promise ? result.then(() => undefined) : undefined;
      };
      return;
    }
    if (event === "before_agent_start") {
      handlers.beforeStart = async (ev) => {
        const raw: unknown = await Promise.resolve(Reflect.apply(handler, undefined, [ev]));
        if (typeof raw === "object" && raw !== null && "systemPrompt" in raw) {
          const prompt: unknown = Reflect.get(raw, "systemPrompt");
          if (typeof prompt === "string") return { systemPrompt: prompt };
        }
        return undefined;
      };
    }
  };

  return {
    api: {
      on,
      sendMessage(message, options) {
        delivered.push(message.content);
        woke.push(options.triggerTurn);
      },
    },
    delivered,
    woke,
    async emitStart() {
      await handlers.start?.();
    },
    async emitShutdown() {
      await handlers.shutdown?.();
    },
    emitBeforeStart(systemPrompt: string) {
      return Promise.resolve(handlers.beforeStart?.({ systemPrompt }));
    },
  };
}
