import { z } from "zod";
import type { BoardClient } from "./client.ts";
import type { BoardEvent } from "./types.ts";

export interface WakeMessage {
  readonly mate: string;
  readonly notice: string;
  readonly eventType: string;
  readonly cardId?: string;
  readonly actor?: string;
}

function wakeFromEvent(mate: string, notice: string, event: BoardEvent): WakeMessage {
  return {
    mate,
    notice,
    eventType: event.type,
    ...(typeof event.cardId === "string" ? { cardId: event.cardId } : {}),
    ...(typeof event.actor === "string" ? { actor: event.actor } : {}),
  };
}

export interface WatchMateWakesOptions {
  readonly client: BoardClient;
  readonly mate: string;
  readonly signal: AbortSignal;
  readonly initialCursor?: number;
  readonly reconnectDelayMs?: number;
  readonly onRecovered?: () => Promise<void> | void;
  readonly onWake: (wake: WakeMessage) => Promise<void> | void;
  readonly onError?: (error: unknown) => void;
}

const ChaseItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.string(),
  ageMs: z.number(),
  stalledChild: z.string().optional(),
});

const ChasePayloadSchema = z.object({
  holder: z.string(),
  cards: z.array(ChaseItemSchema),
});

function payloadString(payload: Readonly<Record<string, unknown>>, key: string): string {
  const val = payload[key];
  return typeof val === "string" ? val : "";
}

function formatChaseNotice(event: BoardEvent): string | undefined {
  const parsed = ChasePayloadSchema.safeParse(event.payload);
  if (!parsed.success || parsed.data.cards.length === 0) return undefined;
  const lines = parsed.data.cards.map((card) => {
    const mins = Math.max(1, Math.round(card.ageMs / 60_000));
    const status =
      card.stalledChild !== undefined ? `stalled with ${card.stalledChild}` : card.state;
    return `- #${card.id} [${status}, ${String(mins)}m]: ${card.title}`;
  });
  return `[fleet] Cards needing attention:\n${lines.join("\n")}\nReview each with \`fleet view <id> --full\` and close, queue, snooze, hand off, or escalate.`;
}

function formatHolderTransition(
  event: BoardEvent,
  mate: string,
  cardId: string,
  title: string,
): string | undefined {
  if (event.holder !== mate) return undefined;
  if (event.type === "card.returned") {
    const summary = payloadString(event.payload, "summary");
    return `[fleet] Card #${cardId} returned to you: ${title}${summary.length > 0 ? `\n${summary}` : ""}\nRun \`fleet view ${cardId} --full\` to decide the next step.`;
  }
  if (event.type === "card.escalated") {
    const from = payloadString(event.payload, "from");
    const reason = payloadString(event.payload, "reason");
    return `[fleet] Card #${cardId} escalated from ${from || "mate"} to you: ${title}\nReason: ${reason}\nRun \`fleet view ${cardId} --full\` and \`fleet charter ${event.mate ?? mate}\` before answering or escalating.`;
  }
  if (event.type === "card.answered") {
    const text = payloadString(event.payload, "text");
    return `[fleet] Card #${cardId} answered by ${event.actor ?? "parent"}: ${title}\nAnswer: ${text}\nRun \`fleet view ${cardId} --full\` to proceed.`;
  }
  if (event.type === "card.handed_off") {
    const text = payloadString(event.payload, "text");
    return `[fleet] Card #${cardId} handed to you by ${event.actor ?? "mate"}: ${title}${text.length > 0 ? `\n${text}` : ""}\nRun \`fleet view ${cardId} --full\`.`;
  }
  if (event.type === "card.created") {
    return `[fleet] New card #${cardId} in your court: ${title}\nRun \`fleet view ${cardId} --full\`.`;
  }
  return undefined;
}

function formatEntryNotice(
  event: BoardEvent,
  mate: string,
  cardId: string,
  title: string,
): string | undefined {
  if (event.payload["internal"] === true) return undefined;
  const text = payloadString(event.payload, "text");
  if (event.holder !== mate) return undefined;
  return `[fleet] Reply on card #${cardId} (${title}) from ${event.actor ?? "unknown"}:\n${text}`;
}

function formatMateEvent(event: BoardEvent, mate: string): string | undefined {
  if (event.actor === mate) return undefined;
  if (event.type === "chase.due") {
    return event.holder === mate ? formatChaseNotice(event) : undefined;
  }
  const cardId = event.cardId ?? payloadString(event.payload, "id");
  const title = payloadString(event.payload, "title");
  if (event.type === "card.done" && event.holder === mate) {
    const result = payloadString(event.payload, "result");
    return `[fleet] Card #${cardId} completed: ${title}${result.length > 0 ? ` (${result})` : ""}`;
  }
  if (event.type === "card.canceled" && event.holder === mate) {
    const reason = payloadString(event.payload, "reason");
    return `[fleet] Card #${cardId} canceled: ${title}${reason.length > 0 ? ` (${reason})` : ""}`;
  }
  if (event.type === "entry.posted") {
    return formatEntryNotice(event, mate, cardId, title);
  }
  return formatHolderTransition(event, mate, cardId, title);
}

async function buildReconciliationNotice(
  client: BoardClient,
  mate: string,
): Promise<string | undefined> {
  const [held, overview] = await Promise.all([
    client.listCards({ holder: mate, state: "open", scope: mate }),
    client.getOverview(mate),
  ]);
  const involved = (card: { readonly mate: string; readonly createdBy: string }): boolean =>
    card.mate === mate || card.createdBy === mate;
  const completed = overview.recentDone.filter(involved).slice(0, 5);
  const canceled = overview.recentCanceled.slice(0, 5);
  if (held.cards.length === 0 && completed.length === 0 && canceled.length === 0) {
    return undefined;
  }
  const lines = [
    ...held.cards.map((card) => `- #${card.id} [${card.state}] in your court: ${card.title}`),
    ...completed.map((card) => `- #${card.id} completed: ${card.title}`),
    ...canceled.map((card) => `- #${card.id} canceled: ${card.title}`),
  ];
  return `[fleet] The Card Server is reachable again after an outage. Current state for ${mate}:\n${lines.join("\n")}`;
}

function waitAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const state: { timer?: ReturnType<typeof setTimeout> } = {};
    const onAbort = (): void => {
      if (state.timer !== undefined) clearTimeout(state.timer);
      resolve();
    };
    state.timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function deliverWake(options: WatchMateWakesOptions, wake: WakeMessage): Promise<void> {
  try {
    await options.onWake(wake);
  } catch (error) {
    options.onError?.(error);
  }
}

export async function watchMateWakes(options: WatchMateWakesOptions): Promise<void> {
  const baseDelayMs = options.reconnectDelayMs ?? 1500;
  let lastEventId = options.initialCursor;
  let initialChase = true;
  let attempt = 0;

  while (!options.signal.aborted) {
    try {
      if (lastEventId === undefined) {
        const recovered = await options.client.latestEventId();
        const reconciliation = await buildReconciliationNotice(options.client, options.mate);
        await options.onRecovered?.();
        lastEventId = recovered;
        if (reconciliation !== undefined) {
          await deliverWake(options, {
            mate: options.mate,
            notice: reconciliation,
            eventType: "reconciliation",
          });
        }
      }
      for await (const event of options.client.events({
        ...(lastEventId !== undefined ? { after: lastEventId } : {}),
        ...(initialChase ? { initialChase: true } : {}),
        holder: options.mate,
        signal: options.signal,
      })) {
        attempt = 0;
        initialChase = false;
        if (event.id > 0) lastEventId = Math.max(lastEventId ?? 0, event.id);
        const notice = formatMateEvent(event, options.mate);
        if (notice === undefined) continue;
        await deliverWake(options, wakeFromEvent(options.mate, notice, event));
      }
    } catch (error) {
      if (options.signal.aborted) break;
      options.onError?.(error);
    }
    if (options.signal.aborted) break;
    const delayMs = Math.min(30_000, baseDelayMs * 2 ** Math.min(attempt, 4));
    attempt += 1;
    await waitAbortable(delayMs, options.signal);
  }
}

export function validateWebhookUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid webhook URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Webhook URL must use http:// or https://");
  }
  return parsed.toString();
}

export function parseHeaderFlag(raw: string): readonly [string, string] {
  const colon = raw.indexOf(":");
  if (colon <= 0) {
    throw new Error('Invalid --header value. Expected "Name: Value".');
  }
  const name = raw.slice(0, colon).trim();
  const value = raw.slice(colon + 1).trim();
  if (!/^[A-Za-z0-9-]+$/u.test(name) || /[\r\n]/u.test(value)) {
    throw new Error("Invalid --header name or value");
  }
  return [name, value];
}

const WEBHOOK_TIMEOUT_MS = 15_000;

export async function postWakeWebhook(
  url: string,
  wake: WakeMessage,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(wake),
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)]),
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`Webhook delivery failed with HTTP ${String(response.status)}`);
  }
}
