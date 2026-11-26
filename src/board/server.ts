import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { checkWriteIngress } from "./ingress.ts";
import type { CardStore } from "./store.ts";
import {
  BoardError,
  CARD_STATES,
  DELIVERIES,
  ENTRY_KINDS,
  HolderFilterSchema,
  HolderNameSchema,
  MateNameSchema,
  type BoardEvent,
  type CardState,
  type ClaimReceipt,
  type OptionalFenceInput,
} from "./types.ts";

const FenceFields = {
  epoch: z.number().int().positive().optional(),
  token: z.string().min(1).optional(),
};

const CreateCardBodySchema = z.object({
  mate: MateNameSchema,
  title: z.string().min(1),
  body: z.string().optional(),
  project: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  delivery: z.enum(DELIVERIES).optional(),
  needs: z.array(z.string()).optional(),
  actor: z.string().min(1).optional(),
});

const QueueCardBodySchema = z.object({
  ...FenceFields,
  project: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  delivery: z.enum(DELIVERIES).optional(),
  actor: z.string().min(1).optional(),
});

const ClaimBodySchema = z.object({
  host: z.string().min(1),
  mates: z.array(MateNameSchema).optional(),
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
  outcome: z.enum(["done", "needs_mate", "awaiting_merge"]),
  summary: z.string(),
  pr: z.url().optional(),
  yolo: z.boolean().optional(),
  actor: z.string().min(1).optional(),
});

const EntryBodySchema = z.object({
  ...FenceFields,
  text: z.string().min(1),
  by: z.string().min(1).optional(),
  internal: z.boolean().optional(),
  kind: z.enum(ENTRY_KINDS).optional(),
});

const EscalateBodySchema = z.object({
  ...FenceFields,
  reason: z.string().min(1),
  actor: z.string().min(1).optional(),
});

const HandoffBodySchema = z.object({
  ...FenceFields,
  to: HolderNameSchema.optional(),
  text: z.string().optional(),
  actor: z.string().min(1).optional(),
});

const AnswerBodySchema = z.object({
  ...FenceFields,
  text: z.string().min(1),
  actor: z.string().min(1).optional(),
});

const CloseBodySchema = z.object({
  ...FenceFields,
  result: z.string().optional(),
  merged: z.boolean().optional(),
  actor: z.string().min(1).optional(),
});

const CancelBodySchema = z.object({
  ...FenceFields,
  reason: z.string().min(1),
  words: z.string().optional(),
  actor: z.string().min(1).optional(),
});

const SnoozeBodySchema = z.object({
  ...FenceFields,
  until: z.number().int().positive(),
  reason: z.string().optional(),
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

const REPLAY_BATCH = 500;

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

function fenceOf(body: {
  readonly epoch?: number | undefined;
  readonly token?: string | undefined;
}): OptionalFenceInput {
  return {
    ...(body.epoch !== undefined ? { epoch: body.epoch } : {}),
    ...(body.token !== undefined ? { token: body.token } : {}),
  };
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

function parseNameFilter(value: string | null, schema: z.ZodType<string>): string | null {
  if (value === null || value.length === 0) return null;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BoardError(400, "invalid_mate", `Invalid mate name: "${value}"`);
  }
  return parsed.data;
}

function matchesHolderFilter(event: BoardEvent, holderFilter: string | null): boolean {
  return holderFilter === null || event.holder === holderFilter;
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

function handleSse(
  store: CardStore,
  staleAfterMs: number,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const afterHeader = req.headers["last-event-id"];
  const afterRaw =
    url.searchParams.get("after") ?? (typeof afterHeader === "string" ? afterHeader : null);
  const afterId =
    afterRaw !== null && /^\d+$/u.test(afterRaw) ? Number(afterRaw) : store.latestEventId();
  const holderFilter = parseNameFilter(url.searchParams.get("holder"), HolderFilterSchema);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const writeEvent = (event: BoardEvent): void => {
    if (res.writableEnded || !matchesHolderFilter(event, holderFilter)) return;
    const idLine = event.id > 0 ? `id: ${String(event.id)}\n` : "";
    res.write(`${idLine}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  res.write(": connected\n\n");
  let lastSentId = afterId;
  for (;;) {
    const batch = store.listEventsSince(lastSentId, REPLAY_BATCH);
    for (const event of batch) {
      writeEvent(event);
      lastSentId = Math.max(lastSentId, event.id);
    }
    if (batch.length < REPLAY_BATCH) break;
  }

  if (
    holderFilter !== null &&
    (afterRaw === null || url.searchParams.get("initialChase") === "1")
  ) {
    const pending = store.pendingChase(holderFilter, staleAfterMs);
    if (pending !== undefined) writeEvent(pending);
  }

  const unsubscribe = store.subscribe((event) => {
    if (event.id === 0) {
      writeEvent(event);
      return;
    }
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
  const posted = store.postEntry(cardId, {
    ...fenceOf(body),
    text: body.text,
    ...(body.by !== undefined ? { by: body.by } : {}),
    ...(body.internal !== undefined ? { internal: body.internal } : {}),
    ...(body.kind !== undefined ? { kind: body.kind } : {}),
  });
  sendJson(res, 201, posted);
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
      ...fenceOf(body),
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
      ...fenceOf(body),
      reason: body.reason,
      ...(body.actor !== undefined ? { actor: body.actor } : {}),
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
      ...fenceOf(body),
      ...(body.to !== undefined ? { to: body.to } : {}),
      ...(body.text !== undefined ? { text: body.text } : {}),
      ...(body.actor !== undefined ? { actor: body.actor } : {}),
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
      ...fenceOf(body),
      text: body.text,
      ...(body.actor !== undefined ? { actor: body.actor } : {}),
    }),
  });
}

async function handleSnoozeCard(
  store: CardStore,
  cardId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = SnoozeBodySchema.parse(await readJsonBody(req));
  sendJson(res, 200, {
    card: store.snoozeCard(cardId, {
      ...fenceOf(body),
      until: body.until,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
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
  if (action === "snooze") {
    await handleSnoozeCard(store, cardId, req, res);
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
        ...fenceOf(body),
        ...(body.result !== undefined ? { result: body.result } : {}),
        ...(body.merged !== undefined ? { merged: body.merged } : {}),
        ...(body.actor !== undefined ? { actor: body.actor } : {}),
      }),
    });
    return true;
  }
  if (action === "cancel") {
    const body = CancelBodySchema.parse(await readJsonBody(req));
    sendJson(res, 200, {
      card: store.cancelCard(cardId, {
        ...fenceOf(body),
        reason: body.reason,
        ...(body.words !== undefined ? { words: body.words } : {}),
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
        ...(body.pr !== undefined ? { pr: body.pr } : {}),
        ...(body.yolo !== undefined ? { yolo: body.yolo } : {}),
        ...(body.actor !== undefined ? { actor: body.actor } : {}),
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
    const mate = parseNameFilter(url.searchParams.get("mate"), MateNameSchema);
    const holder = parseNameFilter(url.searchParams.get("holder"), HolderFilterSchema);
    const scope = parseNameFilter(url.searchParams.get("scope"), HolderNameSchema);
    const state = parseStateFilter(url.searchParams.get("state"));
    const limitRaw = url.searchParams.get("limit");
    if (limitRaw !== null && !/^[1-9]\d*$/u.test(limitRaw)) {
      throw new BoardError(400, "invalid_limit", `Invalid limit: "${limitRaw}"`);
    }
    sendJson(
      res,
      200,
      store.listCards({
        ...(mate !== null ? { mate } : {}),
        ...(holder !== null ? { holder } : {}),
        ...(scope !== null ? { scope } : {}),
        state,
        ...(limitRaw !== null ? { limit: Number(limitRaw) } : {}),
      }),
    );
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
        ...(body.actor !== undefined ? { actor: body.actor } : {}),
      }),
    });
    return true;
  }
  return false;
}

async function routeCollectionRequest(
  store: CardStore,
  staleAfterMs: number,
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
    const scope = parseNameFilter(url.searchParams.get("scope"), HolderNameSchema);
    sendJson(res, 200, store.getOverview(scope ?? undefined));
    return true;
  }
  if (method === "GET" && path === "/api/events") {
    handleSse(store, staleAfterMs, url, req, res);
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
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const cardGetMatch = /^\/api\/cards\/([^/]+)$/u.exec(path);
  if (method === "GET" && cardGetMatch?.[1] !== undefined) {
    const scope = parseNameFilter(url.searchParams.get("scope"), HolderNameSchema);
    sendJson(res, 200, store.getThread(decodeURIComponent(cardGetMatch[1]), scope ?? undefined));
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
  staleAfterMs: number,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const path = url.pathname;
  if (await routeCollectionRequest(store, staleAfterMs, method, path, url, req, res)) return;
  if (await routeResourceRequest(store, method, path, url, req, res)) return;
  sendJson(res, 404, { error: "not_found", message: `No route for ${method} ${path}` });
}

export interface BoardServerOptions {
  readonly store: CardStore;
  readonly host: string;
  readonly port: number;
  readonly chaseIntervalMs: number;
  readonly staleAfterMs: number;
}

export interface StartedBoardServer {
  readonly server: Server;
  readonly url: string;
  readonly stop: () => Promise<void>;
}

export async function startBoardServer(options: BoardServerOptions): Promise<StartedBoardServer> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const rejected = checkWriteIngress(req);
        if (rejected !== undefined) throw rejected;
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
        await routeApiRequest(options.store, options.staleAfterMs, url, req, res);
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

  const leaseTimer = setInterval(() => {
    options.store.expireLeases();
  }, 30_000);
  leaseTimer.unref();

  const chaseTimer = setInterval(() => {
    options.store.sweepStale(options.staleAfterMs);
  }, options.chaseIntervalMs);
  chaseTimer.unref();

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
      clearInterval(leaseTimer);
      clearInterval(chaseTimer);
      const closed = new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      server.closeAllConnections();
      await closed;
    },
  };
}
