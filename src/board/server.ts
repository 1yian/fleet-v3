import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import type { CardStore } from "./store.ts";
import {
  BoardError,
  CARD_STATES,
  DELIVERIES,
  ENTRY_KINDS,
  type BoardEvent,
  type CardState,
  type ClaimReceipt,
} from "./types.ts";

const CreateCardBodySchema = z.object({
  mate: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  project: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  delivery: z.enum(DELIVERIES).optional(),
  needs: z.array(z.string()).optional(),
  labels: z.record(z.string(), z.string()).optional(),
  holder: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
});

const QueueCardBodySchema = z.object({
  project: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  delivery: z.enum(DELIVERIES).optional(),
  actor: z.string().min(1).optional(),
});

const ClaimBodySchema = z.object({
  host: z.string().min(1),
  mates: z.array(z.string().min(1)).optional(),
  leaseSeconds: z.number().int().min(5).max(3600).default(900),
  claimBy: z.string().min(1).default("runner"),
  waitSeconds: z.number().int().min(0).max(60).default(0),
});

const RenewBodySchema = z.object({
  epoch: z.number().int().positive(),
  token: z.string().min(1),
  leaseSeconds: z.number().int().min(5).max(3600).default(900),
});

const FenceBodySchema = z.object({
  epoch: z.number().int().positive(),
  token: z.string().min(1),
});

const FinishBodySchema = z.object({
  epoch: z.number().int().positive(),
  token: z.string().min(1),
  outcome: z.enum(["done", "needs_mate"]),
  summary: z.string(),
  actor: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
});

const EntryBodySchema = z.object({
  text: z.string().min(1),
  by: z.string().min(1).optional(),
  internal: z.boolean().optional(),
  kind: z.enum(ENTRY_KINDS).optional(),
});

const EscalateBodySchema = z.object({
  reason: z.string().min(1),
  to: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
});

const HandoffBodySchema = z.object({
  to: z.string().min(1).optional(),
  text: z.string().optional(),
  actor: z.string().min(1).optional(),
  internal: z.boolean().optional(),
});

const AnswerBodySchema = z.object({
  text: z.string().min(1),
  to: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
});

const CloseBodySchema = z.object({
  result: z.string().optional(),
  actor: z.string().min(1).optional(),
});

const CancelBodySchema = z.object({
  reason: z.string().min(1),
  actor: z.string().min(1).optional(),
});

const HostBodySchema = z.object({
  host: z.string().min(1),
  mode: z.string().min(1),
  viewport: z.string().min(1),
  repos: z.array(z.string()),
});

const TextBodySchema = z.object({
  text: z.string(),
});

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
    else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BoardError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function parseStateFilter(value: string | null): CardState | "open" | "all" {
  if (value === null || value === "" || value === "open") return "open";
  if (value === "all") return "all";
  const matched = CARD_STATES.find((each) => each === value);
  if (matched === undefined) {
    throw new BoardError(400, "invalid_state", `Invalid state filter: "${value}"`);
  }
  return matched;
}

function matchesEventFilter(
  event: BoardEvent,
  holderFilter: string | null,
  mateFilter: string | null,
): boolean {
  if (holderFilter !== null && holderFilter.length > 0) {
    const mentionsHolder =
      event.holder === holderFilter ||
      event.mate === holderFilter ||
      (event.type === "entry.posted" &&
        typeof event.payload["text"] === "string" &&
        new RegExp(`@${holderFilter}\\b`, "iu").test(event.payload["text"]));
    if (!mentionsHolder) return false;
  }
  if (mateFilter !== null && mateFilter.length > 0 && event.mate !== mateFilter) {
    return false;
  }
  return true;
}

function waitForClaim(
  store: CardStore,
  input: z.infer<typeof ClaimBodySchema>,
  res: ServerResponse,
): Promise<ClaimReceipt | null> {
  const immediate = store.claimNext({
    host: input.host,
    ...(input.mates !== undefined ? { mates: input.mates } : {}),
    leaseSeconds: input.leaseSeconds,
    claimBy: input.claimBy,
  });
  if (immediate !== null || input.waitSeconds <= 0) {
    return Promise.resolve(immediate);
  }

  return new Promise((resolve) => {
    const state: {
      settled: boolean;
      timer?: ReturnType<typeof setTimeout>;
      unsubscribe?: () => void;
      onClose?: () => void;
    } = { settled: false };

    const finish = (receipt: ClaimReceipt | null): void => {
      if (state.settled) return;
      state.settled = true;
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.unsubscribe?.();
      if (state.onClose !== undefined) res.off("close", state.onClose);
      resolve(receipt);
    };

    const claimPayload = {
      host: input.host,
      ...(input.mates !== undefined ? { mates: input.mates } : {}),
      leaseSeconds: input.leaseSeconds,
      claimBy: input.claimBy,
    };

    state.onClose = () => {
      if (!res.writableEnded) finish(null);
    };

    state.unsubscribe = store.subscribe((event) => {
      if (event.type !== "card.queued" && event.type !== "card.expired") return;
      const claimed = store.claimNext(claimPayload);
      if (claimed !== null) finish(claimed);
    });

    state.timer = setTimeout(() => {
      finish(store.claimNext(claimPayload));
    }, input.waitSeconds * 1000);
    state.timer.unref();
    res.on("close", state.onClose);
  });
}

function handleSse(store: CardStore, url: URL, req: IncomingMessage, res: ServerResponse): void {
  const afterHeader = req.headers["last-event-id"];
  const afterRaw =
    url.searchParams.get("after") ?? (typeof afterHeader === "string" ? afterHeader : null);
  const afterId =
    afterRaw !== null && /^\d+$/u.test(afterRaw) ? Number(afterRaw) : store.latestEventId();
  const holderFilter = url.searchParams.get("holder");
  const mateFilter = url.searchParams.get("mate");

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const writeEvent = (event: BoardEvent): void => {
    if (res.writableEnded || !matchesEventFilter(event, holderFilter, mateFilter)) return;
    res.write(`id: ${String(event.id)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  res.write(": connected\n\n");
  let lastSentId = afterId;
  for (const event of store.listEventsSince(afterId)) {
    writeEvent(event);
    lastSentId = Math.max(lastSentId, event.id);
  }

  const unsubscribe = store.subscribe((event) => {
    if (event.id <= lastSentId) return;
    lastSentId = event.id;
    writeEvent(event);
  });

  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, 15_000);
  keepalive.unref();

  res.on("close", () => {
    clearInterval(keepalive);
    unsubscribe();
    if (!res.writableEnded) res.end();
  });
}

async function handlePostEntry(
  store: CardStore,
  cardId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = EntryBodySchema.parse(await readJsonBody(req));
  sendJson(res, 201, {
    entry: store.postEntry(cardId, {
      text: body.text,
      ...(body.by !== undefined ? { by: body.by } : {}),
      ...(body.internal !== undefined ? { internal: body.internal } : {}),
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
    }),
  });
}

async function handleQueueCard(
  store: CardStore,
  cardId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = QueueCardBodySchema.parse(await readJsonBody(req));
  sendJson(res, 200, {
    card: store.queueCard(cardId, {
      ...(body.project !== undefined ? { project: body.project } : {}),
      ...(body.host !== undefined ? { host: body.host } : {}),
      ...(body.delivery !== undefined ? { delivery: body.delivery } : {}),
      ...(body.actor !== undefined ? { actor: body.actor } : {}),
    }),
  });
}

async function handleEscalateCard(
  store: CardStore,
  cardId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = EscalateBodySchema.parse(await readJsonBody(req));
  sendJson(res, 200, {
    card: store.escalateCard(cardId, {
      reason: body.reason,
      ...(body.to !== undefined ? { to: body.to } : {}),
      ...(body.actor !== undefined ? { actor: body.actor } : {}),
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
    }),
  });
}

async function handleHandoffCard(
  store: CardStore,
  cardId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = HandoffBodySchema.parse(await readJsonBody(req));
  sendJson(res, 200, {
    card: store.handoffCard(cardId, {
      ...(body.to !== undefined ? { to: body.to } : {}),
      ...(body.text !== undefined ? { text: body.text } : {}),
      ...(body.actor !== undefined ? { actor: body.actor } : {}),
      ...(body.internal !== undefined ? { internal: body.internal } : {}),
    }),
  });
}

async function handleAnswerCard(
  store: CardStore,
  cardId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = AnswerBodySchema.parse(await readJsonBody(req));
  sendJson(res, 200, {
    card: store.answerCard(cardId, {
      text: body.text,
      ...(body.to !== undefined ? { to: body.to } : {}),
      ...(body.actor !== undefined ? { actor: body.actor } : {}),
    }),
  });
}

async function routeCardLifecycleAction(
  store: CardStore,
  cardId: string,
  action: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (action === "entries") {
    await handlePostEntry(store, cardId, req, res);
    return true;
  }
  if (action === "queue") {
    await handleQueueCard(store, cardId, req, res);
    return true;
  }
  if (action === "escalate") {
    await handleEscalateCard(store, cardId, req, res);
    return true;
  }
  if (action === "handoff") {
    await handleHandoffCard(store, cardId, req, res);
    return true;
  }
  if (action === "answer") {
    await handleAnswerCard(store, cardId, req, res);
    return true;
  }
  return false;
}

async function routeCardTerminalOrFenceAction(
  store: CardStore,
  cardId: string,
  action: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (action === "close") {
    const body = CloseBodySchema.parse(await readJsonBody(req));
    sendJson(res, 200, {
      card: store.closeCard(cardId, {
        ...(body.result !== undefined ? { result: body.result } : {}),
        ...(body.actor !== undefined ? { actor: body.actor } : {}),
      }),
    });
    return true;
  }
  if (action === "cancel") {
    const body = CancelBodySchema.parse(await readJsonBody(req));
    sendJson(res, 200, {
      card: store.cancelCard(cardId, {
        reason: body.reason,
        ...(body.actor !== undefined ? { actor: body.actor } : {}),
      }),
    });
    return true;
  }
  if (action === "renew") {
    const body = RenewBodySchema.parse(await readJsonBody(req));
    sendJson(res, 200, store.renewClaim(cardId, body));
    return true;
  }
  if (action === "release") {
    const body = FenceBodySchema.parse(await readJsonBody(req));
    sendJson(res, 200, { card: store.releaseClaim(cardId, body) });
    return true;
  }
  if (action === "finish") {
    const body = FinishBodySchema.parse(await readJsonBody(req));
    sendJson(res, 200, {
      card: store.finishClaim(cardId, {
        epoch: body.epoch,
        token: body.token,
        outcome: body.outcome,
        summary: body.summary,
        ...(body.actor !== undefined ? { actor: body.actor } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
      }),
    });
    return true;
  }
  return false;
}

async function routeCardMutation(
  store: CardStore,
  cardId: string,
  action: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (await routeCardLifecycleAction(store, cardId, action, req, res)) return true;
  return routeCardTerminalOrFenceAction(store, cardId, action, req, res);
}

async function routeCardsCollection(
  store: CardStore,
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method === "GET") {
    const mate = url.searchParams.get("mate") ?? undefined;
    const holder = url.searchParams.get("holder") ?? undefined;
    const state = parseStateFilter(url.searchParams.get("state"));
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw !== null && /^\d+$/u.test(limitRaw) ? Number(limitRaw) : undefined;
    sendJson(res, 200, {
      cards: store.listCards({
        ...(mate !== undefined ? { mate } : {}),
        ...(holder !== undefined ? { holder } : {}),
        state,
        ...(limit !== undefined ? { limit } : {}),
      }),
    });
    return true;
  }
  if (method === "POST") {
    const body = CreateCardBodySchema.parse(await readJsonBody(req));
    sendJson(res, 201, {
      card: store.createCard({
        mate: body.mate,
        title: body.title,
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.project !== undefined ? { project: body.project } : {}),
        ...(body.host !== undefined ? { host: body.host } : {}),
        ...(body.delivery !== undefined ? { delivery: body.delivery } : {}),
        ...(body.needs !== undefined ? { needs: body.needs } : {}),
        ...(body.labels !== undefined ? { labels: body.labels } : {}),
        ...(body.holder !== undefined ? { holder: body.holder } : {}),
        ...(body.actor !== undefined ? { actor: body.actor } : {}),
      }),
    });
    return true;
  }
  return false;
}

async function routeCollectionRequest(
  store: CardStore,
  method: string,
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (path === "/api/cards") {
    return routeCardsCollection(store, method, url, req, res);
  }
  if (method === "GET" && path === "/api/health") {
    sendJson(res, 200, { ok: true, latestEventId: store.latestEventId() });
    return true;
  }
  if (method === "GET" && path === "/api/overview") {
    sendJson(res, 200, store.getOverview());
    return true;
  }
  if (method === "GET" && path === "/api/events") {
    handleSse(store, url, req, res);
    return true;
  }
  if (method === "GET" && path === "/api/mates") {
    sendJson(res, 200, { parents: store.getParents() });
    return true;
  }
  if (method === "GET" && path === "/api/hosts") {
    sendJson(res, 200, { hosts: store.listHosts() });
    return true;
  }
  if (method === "POST" && path === "/api/hosts") {
    const body = HostBodySchema.parse(await readJsonBody(req));
    sendJson(res, 200, { host: store.advertiseHost(body) });
    return true;
  }
  if (method === "POST" && path === "/api/claims") {
    const body = ClaimBodySchema.parse(await readJsonBody(req));
    const claim = await waitForClaim(store, body, res);
    if (!res.writableEnded) sendJson(res, 200, { claim });
    return true;
  }
  return false;
}

async function routeResourceRequest(
  store: CardStore,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const cardGetMatch = /^\/api\/cards\/([^/]+)$/u.exec(path);
  if (method === "GET" && cardGetMatch?.[1] !== undefined) {
    sendJson(res, 200, store.getThread(decodeURIComponent(cardGetMatch[1])));
    return true;
  }
  const cardActionMatch = /^\/api\/cards\/([^/]+)\/([a-z-]+)$/u.exec(path);
  if (method === "POST" && cardActionMatch?.[1] !== undefined && cardActionMatch[2] !== undefined) {
    return routeCardMutation(
      store,
      decodeURIComponent(cardActionMatch[1]),
      cardActionMatch[2],
      req,
      res,
    );
  }
  const charterMatch = /^\/api\/charters\/([^/]+)$/u.exec(path);
  if (charterMatch?.[1] !== undefined) {
    const mate = decodeURIComponent(charterMatch[1]);
    if (method === "GET") {
      sendJson(res, 200, { mate, text: store.getCharter(mate) });
      return true;
    }
    if (method === "PUT") {
      const body = TextBodySchema.parse(await readJsonBody(req));
      sendJson(res, 200, { mate, text: store.setCharter(mate, body.text) });
      return true;
    }
  }
  if (path === "/api/prefs") {
    if (method === "GET") {
      sendJson(res, 200, { text: store.getPrefs() });
      return true;
    }
    if (method === "PUT") {
      const body = TextBodySchema.parse(await readJsonBody(req));
      sendJson(res, 200, { text: store.setPrefs(body.text) });
      return true;
    }
  }
  return false;
}

async function routeApiRequest(
  store: CardStore,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const path = url.pathname;
  if (await routeCollectionRequest(store, method, path, url, req, res)) return;
  if (await routeResourceRequest(store, method, path, req, res)) return;
  sendJson(res, 404, { error: "not_found", message: `No route for ${method} ${path}` });
}

export interface BoardServerOptions {
  readonly store: CardStore;
  readonly host: string;
  readonly port: number;
  readonly uiHtml?: string;
  readonly chaseIntervalMs?: number;
  readonly staleAfterMs?: number;
}

export interface StartedBoardServer {
  readonly server: Server;
  readonly url: string;
  readonly stop: () => Promise<void>;
}

export async function startBoardServer(options: BoardServerOptions): Promise<StartedBoardServer> {
  const chaseIntervalMs = options.chaseIntervalMs ?? 60_000;
  const staleAfterMs = options.staleAfterMs ?? 600_000;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
        if (
          options.uiHtml !== undefined &&
          (url.pathname === "/" || url.pathname === "/index.html")
        ) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(options.uiHtml);
          return;
        }
        await routeApiRequest(options.store, url, req, res);
      } catch (error) {
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
          return;
        }
        if (error instanceof BoardError) {
          sendJson(res, error.status, { error: error.code, message: error.message });
          return;
        }
        if (error instanceof z.ZodError) {
          sendJson(res, 400, { error: "validation_error", message: error.message });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: "internal_error", message });
      }
    })();
  });

  const chaseTimer =
    chaseIntervalMs > 0
      ? setInterval(() => {
          options.store.sweepStale(staleAfterMs);
        }, chaseIntervalMs)
      : undefined;
  chaseTimer?.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : options.port;
  const url = `http://${options.host}:${String(actualPort)}`;

  return {
    server,
    url,
    stop: async () => {
      if (chaseTimer !== undefined) clearInterval(chaseTimer);
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
