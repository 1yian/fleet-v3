import { z } from "zod";
import {
  BoardError,
  BoardEventSchema,
  CardPageSchema,
  CardSchema,
  CardThreadSchema,
  ClaimReceiptSchema,
  PostedEntrySchema,
  HostInfoSchema,
  OverviewSchema,
  type AdvertiseHostInput,
  type AnswerCardInput,
  type BoardEvent,
  type BoardOverview,
  type CancelCardInput,
  type Card,
  type CardPage,
  type CardThread,
  type ClaimFenceInput,
  type ClaimNextInput,
  type ClaimReceipt,
  type CloseCardInput,
  type CreateCardInput,
  type PostedEntry,
  type EscalateCardInput,
  type FinishClaimInput,
  type HandoffCardInput,
  type HostInfo,
  type ListCardsQuery,
  type PostEntryInput,
  type QueueCardInput,
  type SnoozeCardInput,
} from "./types.ts";

export interface BoardClient {
  readonly getOverview: (scope?: string, signal?: AbortSignal) => Promise<BoardOverview>;
  readonly listCards: (query?: ListCardsQuery, signal?: AbortSignal) => Promise<CardPage>;
  readonly createCard: (input: CreateCardInput) => Promise<Card>;
  readonly getThread: (id: string, scope?: string) => Promise<CardThread>;
  readonly postEntry: (id: string, input: PostEntryInput) => Promise<PostedEntry>;
  readonly queueCard: (id: string, input: QueueCardInput) => Promise<Card>;
  readonly escalateCard: (id: string, input: EscalateCardInput) => Promise<Card>;
  readonly handoffCard: (id: string, input: HandoffCardInput) => Promise<Card>;
  readonly answerCard: (id: string, input: AnswerCardInput) => Promise<Card>;
  readonly snoozeCard: (id: string, input: SnoozeCardInput) => Promise<Card>;
  readonly closeCard: (id: string, input: CloseCardInput) => Promise<Card>;
  readonly cancelCard: (id: string, input: CancelCardInput) => Promise<Card>;
  readonly claimNext: (
    input: ClaimNextInput,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<ClaimReceipt | null>;
  readonly renewClaim: (
    id: string,
    input: ClaimFenceInput & { readonly leaseSeconds: number },
  ) => Promise<{ readonly leaseUntil: number }>;
  readonly releaseClaim: (id: string, input: ClaimFenceInput) => Promise<Card>;
  readonly finishClaim: (id: string, input: FinishClaimInput) => Promise<Card>;
  readonly advertiseHost: (input: AdvertiseHostInput) => Promise<HostInfo>;
  readonly listHosts: (signal?: AbortSignal) => Promise<HostInfo[]>;
  readonly getCharter: (mate: string, signal?: AbortSignal) => Promise<string>;
  readonly setCharter: (mate: string, text: string) => Promise<string>;
  readonly getPrefs: (signal?: AbortSignal) => Promise<string>;
  readonly setPrefs: (text: string) => Promise<string>;
  readonly getParents: (signal?: AbortSignal) => Promise<Record<string, string>>;
  readonly latestEventId: (signal?: AbortSignal) => Promise<number>;
  readonly events: (options?: {
    readonly after?: number;
    readonly holder?: string;
    readonly initialChase?: boolean;
    readonly signal?: AbortSignal;
  }) => AsyncIterable<BoardEvent>;
}

const ErrorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
});
const CardWrapSchema = z.object({ card: CardSchema });
const HealthSchema = z.object({ latestEventId: z.number().int() });
const ClaimWrapSchema = z.object({ claim: ClaimReceiptSchema.nullable() });
const RenewWrapSchema = z.object({ leaseUntil: z.number().int() });
const HostWrapSchema = z.object({ host: HostInfoSchema });
const HostsWrapSchema = z.object({ hosts: z.array(HostInfoSchema) });
const TextWrapSchema = z.object({ text: z.string() });
const ParentsWrapSchema = z.object({ parents: z.record(z.string(), z.string()) });

function requestOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal !== undefined ? { signal } : {};
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  schema: z.ZodType<T>,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly signal?: AbortSignal;
  } = {},
): Promise<T> {
  const url = `${baseUrl.replace(/\/+$/u, "")}${path}`;
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.body !== undefined ? { "content-type": "application/json" } : {},
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    let code = "http_error";
    let message = text || `HTTP ${String(res.status)}`;
    try {
      const parsed = ErrorBodySchema.safeParse(JSON.parse(text));
      if (parsed.success) {
        code = parsed.data.error ?? code;
        message = parsed.data.message ?? message;
      }
    } catch {
      message = text || `HTTP ${String(res.status)}`;
    }
    throw new BoardError(res.status, code, message);
  }
  return schema.parse(JSON.parse(text));
}

function parseSseBlock(block: string): BoardEvent | undefined {
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return undefined;
  const parsed = BoardEventSchema.safeParse(JSON.parse(dataLines.join("\n")));
  return parsed.success ? parsed.data : undefined;
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<BoardEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) break;
        const event = parseSseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (event !== undefined) yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function createHttpBoardClient(baseUrl: string): BoardClient {
  const cleanBase = baseUrl.replace(/\/+$/u, "");

  return {
    getOverview: (scope, signal) => {
      const qs = scope !== undefined ? `?scope=${encodeURIComponent(scope)}` : "";
      return requestJson(cleanBase, `/api/overview${qs}`, OverviewSchema, requestOptions(signal));
    },
    listCards: (query, signal) => {
      const filters = query ?? {};
      const params = new URLSearchParams();
      if (filters.mate !== undefined) params.set("mate", filters.mate);
      if (filters.holder !== undefined) params.set("holder", filters.holder);
      if (filters.state !== undefined) params.set("state", filters.state);
      if (filters.limit !== undefined) params.set("limit", String(filters.limit));
      if (filters.scope !== undefined) params.set("scope", filters.scope);
      const qs = params.toString();
      return requestJson(
        cleanBase,
        `/api/cards${qs.length > 0 ? `?${qs}` : ""}`,
        CardPageSchema,
        requestOptions(signal),
      );
    },
    createCard: async (input) => {
      const res = await requestJson(cleanBase, "/api/cards", CardWrapSchema, {
        method: "POST",
        body: input,
      });
      return res.card;
    },
    getThread: (id, scope) => {
      const qs = scope !== undefined ? `?scope=${encodeURIComponent(scope)}` : "";
      return requestJson(cleanBase, `/api/cards/${encodeURIComponent(id)}${qs}`, CardThreadSchema);
    },
    postEntry: (id, input) =>
      requestJson(cleanBase, `/api/cards/${encodeURIComponent(id)}/entries`, PostedEntrySchema, {
        method: "POST",
        body: input,
      }),
    queueCard: async (id, input) => {
      const res = await requestJson(
        cleanBase,
        `/api/cards/${encodeURIComponent(id)}/queue`,
        CardWrapSchema,
        { method: "POST", body: input },
      );
      return res.card;
    },
    escalateCard: async (id, input) => {
      const res = await requestJson(
        cleanBase,
        `/api/cards/${encodeURIComponent(id)}/escalate`,
        CardWrapSchema,
        { method: "POST", body: input },
      );
      return res.card;
    },
    handoffCard: async (id, input) => {
      const res = await requestJson(
        cleanBase,
        `/api/cards/${encodeURIComponent(id)}/handoff`,
        CardWrapSchema,
        { method: "POST", body: input },
      );
      return res.card;
    },
    answerCard: async (id, input) => {
      const res = await requestJson(
        cleanBase,
        `/api/cards/${encodeURIComponent(id)}/answer`,
        CardWrapSchema,
        { method: "POST", body: input },
      );
      return res.card;
    },
    snoozeCard: async (id, input) => {
      const res = await requestJson(
        cleanBase,
        `/api/cards/${encodeURIComponent(id)}/snooze`,
        CardWrapSchema,
        { method: "POST", body: input },
      );
      return res.card;
    },
    closeCard: async (id, input) => {
      const res = await requestJson(
        cleanBase,
        `/api/cards/${encodeURIComponent(id)}/close`,
        CardWrapSchema,
        { method: "POST", body: input },
      );
      return res.card;
    },
    cancelCard: async (id, input) => {
      const res = await requestJson(
        cleanBase,
        `/api/cards/${encodeURIComponent(id)}/cancel`,
        CardWrapSchema,
        { method: "POST", body: input },
      );
      return res.card;
    },
    claimNext: async (input, options = {}) => {
      const res = await requestJson(cleanBase, "/api/claims", ClaimWrapSchema, {
        method: "POST",
        body: input,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      return res.claim;
    },
    renewClaim: (id, input) =>
      requestJson(cleanBase, `/api/cards/${encodeURIComponent(id)}/renew`, RenewWrapSchema, {
        method: "POST",
        body: input,
      }),
    releaseClaim: async (id, input) => {
      const res = await requestJson(
        cleanBase,
        `/api/cards/${encodeURIComponent(id)}/release`,
        CardWrapSchema,
        { method: "POST", body: input },
      );
      return res.card;
    },
    finishClaim: async (id, input) => {
      const res = await requestJson(
        cleanBase,
        `/api/cards/${encodeURIComponent(id)}/finish`,
        CardWrapSchema,
        { method: "POST", body: input },
      );
      return res.card;
    },
    advertiseHost: async (input) => {
      const res = await requestJson(cleanBase, "/api/hosts", HostWrapSchema, {
        method: "POST",
        body: input,
      });
      return res.host;
    },
    listHosts: async (signal) => {
      const res = await requestJson(
        cleanBase,
        "/api/hosts",
        HostsWrapSchema,
        requestOptions(signal),
      );
      return res.hosts;
    },
    getCharter: async (mate, signal) => {
      const res = await requestJson(
        cleanBase,
        `/api/charters/${encodeURIComponent(mate)}`,
        TextWrapSchema,
        requestOptions(signal),
      );
      return res.text;
    },
    setCharter: async (mate, text) => {
      const res = await requestJson(
        cleanBase,
        `/api/charters/${encodeURIComponent(mate)}`,
        TextWrapSchema,
        { method: "PUT", body: { text } },
      );
      return res.text;
    },
    getPrefs: async (signal) => {
      const res = await requestJson(
        cleanBase,
        "/api/prefs",
        TextWrapSchema,
        requestOptions(signal),
      );
      return res.text;
    },
    setPrefs: async (text) => {
      const res = await requestJson(cleanBase, "/api/prefs", TextWrapSchema, {
        method: "PUT",
        body: { text },
      });
      return res.text;
    },
    latestEventId: async (signal) => {
      const res = await requestJson(cleanBase, "/api/health", HealthSchema, requestOptions(signal));
      return res.latestEventId;
    },
    getParents: async (signal) => {
      const res = await requestJson(
        cleanBase,
        "/api/mates",
        ParentsWrapSchema,
        requestOptions(signal),
      );
      return res.parents;
    },
    events(options = {}) {
      return {
        async *[Symbol.asyncIterator]() {
          const params = new URLSearchParams();
          if (options.after !== undefined) params.set("after", String(options.after));
          if (options.holder !== undefined) params.set("holder", options.holder);
          if (options.initialChase === true) params.set("initialChase", "1");
          const qs = params.toString();
          const res = await fetch(`${cleanBase}/api/events${qs.length > 0 ? `?${qs}` : ""}`, {
            headers: { accept: "text/event-stream" },
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          });
          if (!res.ok || res.body === null) {
            throw new BoardError(res.status, "sse_failed", `SSE failed with ${String(res.status)}`);
          }
          yield* parseSseStream(res.body);
        },
      };
    },
  };
}
