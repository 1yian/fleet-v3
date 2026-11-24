import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import { createHttpBoardClient, type BoardClient } from "../board/client.ts";
import type { BoardEvent } from "../board/types.ts";
import { loadFleetConfig } from "../config.ts";

interface BeforeAgentStartEvent {
  readonly systemPrompt: string;
}

export interface PiExtensionApi {
  readonly on: {
    (
      event: "before_agent_start",
      handler: (
        event: BeforeAgentStartEvent,
      ) => Promise<{ systemPrompt: string } | undefined> | { systemPrompt: string } | undefined,
    ): void;
    (event: "session_start" | "session_shutdown", handler: () => Promise<void> | void): void;
  };
  readonly sendMessage: (
    message: { readonly customType: string; readonly content: string; readonly display: boolean },
    options: { readonly triggerTurn: boolean; readonly deliverAs: "followUp" | "steer" },
  ) => void;
}

export interface FleetPiAdapterOptions {
  readonly boardUrl?: string;
  readonly mate?: string;
  readonly reconnectDelayMs?: number;
}

const ChaseItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.string(),
  ageMs: z.number(),
});
const ChasePayloadSchema = z.object({
  holder: z.string(),
  cards: z.array(ChaseItemSchema),
});

function resolveBoardClient(overrides: FleetPiAdapterOptions = {}): {
  readonly client: BoardClient;
  readonly mate: string;
} {
  let boardUrl = overrides.boardUrl ?? process.env["BOARD_URL"];
  const candidates = [
    process.env["FLEET_CONFIG"],
    resolvePath(process.cwd(), "fleet.yaml"),
    resolvePath(homedir(), ".config", "fleet", "fleet.yaml"),
    resolvePath(homedir(), ".fleet-v3", "fleet.yaml"),
  ];
  const cfgPath = candidates.find((p): p is string => p !== undefined && existsSync(p));
  if (boardUrl === undefined && cfgPath !== undefined) {
    const cfg = loadFleetConfig(cfgPath);
    boardUrl = cfg.boardUrl;
  }
  const effectiveUrl = boardUrl ?? "http://127.0.0.1:4100";
  const mate = overrides.mate ?? process.env["FLEET_MATE"];
  if (mate === undefined) {
    throw new Error("fleet Pi adapter requires FLEET_MATE (the configured mate this pane serves)");
  }
  return {
    client: createHttpBoardClient(effectiveUrl),
    mate,
  };
}

function payloadString(payload: Readonly<Record<string, unknown>>, key: string): string {
  const val = payload[key];
  return typeof val === "string" ? val : "";
}

function formatChaseNotice(event: BoardEvent): string | undefined {
  const parsed = ChasePayloadSchema.safeParse(event.payload);
  if (!parsed.success || parsed.data.cards.length === 0) return undefined;
  const lines = parsed.data.cards.map((card) => {
    const mins = Math.max(1, Math.round(card.ageMs / 60_000));
    return `- #${card.id} [${card.state}, ${String(mins)}m]: ${card.title}`;
  });
  return `[fleet] Cards waiting in your court:\n${lines.join("\n")}\nReview each with \`fleet view <id> --full\` and close, queue, hand off, or escalate.`;
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
  if (event.type === "card.done" && event.mate === mate) {
    const result = payloadString(event.payload, "result");
    return `[fleet] Card #${cardId} completed: ${title}${result.length > 0 ? ` (${result})` : ""}`;
  }
  if (event.type === "entry.posted") {
    return formatEntryNotice(event, mate, cardId, title);
  }
  return formatHolderTransition(event, mate, cardId, title);
}

async function buildAmbientBlock(client: BoardClient, mate: string): Promise<string> {
  const [charter, heldCards, domainCards, hosts, prefs, parents] = await Promise.all([
    client.getCharter(mate).catch(() => ""),
    client
      .listCards({ holder: mate, state: "open" })
      .then((page) => page.cards)
      .catch(() => []),
    client
      .listCards({ mate, state: "open" })
      .then((page) => page.cards)
      .catch(() => []),
    client.listHosts().catch(() => []),
    client.getPrefs().catch(() => ""),
    client.getParents().catch((): Record<string, string> => ({})),
  ]);

  const parent = Object.hasOwn(parents, mate) ? (parents[mate] ?? "captain") : "captain";
  const children = Object.entries(parents)
    .filter(([, p]) => p === mate)
    .map(([name]) => name)
    .toSorted();

  const parts: string[] = [
    `Mate: ${mate} (parent: ${parent}${children.length > 0 ? `, subordinates: ${children.join(", ")}` : ""})`,
  ];
  if (charter.trim().length > 0) parts.push(`Charter:\n${charter.trim()}`);
  if (heldCards.length > 0) {
    parts.push(`Cards currently held by ${mate}:\n${JSON.stringify(heldCards, null, 2)}`);
  }
  if (domainCards.length > 0) {
    parts.push(`Open cards owned by ${mate}:\n${JSON.stringify(domainCards, null, 2)}`);
  }
  if (hosts.length > 0) {
    parts.push(`Available hosts:\n${JSON.stringify(hosts, null, 2)}`);
  }
  if (prefs.trim().length > 0) {
    parts.push(`Captain preferences:\n${prefs.trim()}`);
  }
  return parts.join("\n\n");
}

async function buildReconciliationNotice(
  client: BoardClient,
  mate: string,
): Promise<string | undefined> {
  const [held, overview] = await Promise.all([
    client.listCards({ holder: mate, state: "open" }),
    client.getOverview(),
  ]);
  const completed = overview.recentDone.filter((card) => card.mate === mate).slice(0, 5);
  if (held.cards.length === 0 && completed.length === 0) return undefined;
  const lines = [
    ...held.cards.map((card) => `- #${card.id} [${card.state}] in your court: ${card.title}`),
    ...completed.map((card) => `- #${card.id} completed: ${card.title}`),
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
    state.timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function attachFleetPiAdapter(
  pi: PiExtensionApi,
  overrides: FleetPiAdapterOptions = {},
): void {
  const { client, mate } = resolveBoardClient(overrides);
  const baseDelayMs = overrides.reconnectDelayMs ?? 1500;
  let controller: AbortController | undefined;
  let ambientBlock = "";

  const wake = (content: string): void => {
    pi.sendMessage(
      { customType: "fleet", content, display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  const watchEvents = async (signal: AbortSignal, cursor: number | undefined): Promise<void> => {
    let lastEventId = cursor;
    let attempt = 0;

    while (!signal.aborted) {
      try {
        if (lastEventId === undefined) {
          const recovered = await client.latestEventId();
          const reconciliation = await buildReconciliationNotice(client, mate);
          ambientBlock = await buildAmbientBlock(client, mate);
          lastEventId = recovered;
          if (reconciliation !== undefined) wake(reconciliation);
        }
        for await (const event of client.events({
          ...(lastEventId !== undefined ? { after: lastEventId } : {}),
          holder: mate,
          signal,
        })) {
          attempt = 0;
          lastEventId = Math.max(lastEventId ?? 0, event.id);
          const notice = formatMateEvent(event, mate);
          if (notice === undefined) continue;
          wake(notice);
        }
      } catch {
        if (signal.aborted) break;
      }
      if (signal.aborted) break;
      const delayMs = Math.min(30_000, baseDelayMs * 2 ** Math.min(attempt, 4));
      attempt += 1;
      await waitAbortable(delayMs, signal);
    }
  };

  pi.on("session_start", async () => {
    const cursor = await client.latestEventId().catch(() => undefined);
    ambientBlock = await buildAmbientBlock(client, mate);
    controller = new AbortController();
    void watchEvents(controller.signal, cursor);
  });

  pi.on("before_agent_start", (event) => {
    if (ambientBlock === "") return undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Ambient Fleet Context (live at session start)\n\n${ambientBlock}`,
    };
  });

  pi.on("session_shutdown", () => {
    controller?.abort();
    controller = undefined;
  });
}

export default function fleetPiAdapter(pi: PiExtensionApi): void {
  attachFleetPiAdapter(pi);
}
