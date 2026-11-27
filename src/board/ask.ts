import type { BoardClient } from "./client.ts";
import type { Card, Entry } from "./types.ts";

export interface DecisionBrief {
  readonly evidence: string;
  readonly consequence: string;
  readonly recommendation: string;
}

export interface CaptainDecision {
  readonly card: Card;
  readonly text: string;
}

const SHOWN_TEXT = "Shown to captain";

function askEntryText(brief: DecisionBrief): string {
  return [
    `Evidence: ${brief.evidence.trim()}`,
    `Consequence: ${brief.consequence.trim()}`,
    `Recommendation: ${brief.recommendation.trim()}`,
  ].join("\n");
}

export function askCaptain(
  client: BoardClient,
  input: { readonly mate: string; readonly title: string } & DecisionBrief,
): Promise<Card> {
  return client.askCard({
    mate: input.mate,
    title: input.title,
    brief: askEntryText(input),
    actor: input.mate,
  });
}

function lastShownRank(entries: readonly Entry[]): number {
  return entries
    .filter((entry) => entry.internal && entry.kind === "status" && entry.text === SHOWN_TEXT)
    .reduce((latest, entry) => Math.max(latest, Number(entry.id)), 0);
}

function evidenceOf(entries: readonly Entry[]): string | undefined {
  const source = entries.findLast((entry) => entry.kind === "ask" || entry.kind === "escalation");
  if (source === undefined) return undefined;
  return source.kind === "ask" ? source.text : `Evidence: ${source.text}`;
}

function decisionText(card: Card, entries: readonly Entry[], waiting: number): string {
  const lines = [`Decision #${card.id} from ${card.mate}`];
  const evidence = evidenceOf(entries);
  if (evidence !== undefined) lines.push(evidence);
  lines.push(
    `Ask: ${card.title}`,
    "",
    `Reply with your answer. It is recorded on card #${card.id}.`,
  );
  if (waiting > 0) lines.push("", `+${String(waiting)} more waiting`);
  return lines.join("\n");
}

export async function nextCaptainDecision(
  client: BoardClient,
  actor: string,
  scope: string | undefined,
): Promise<CaptainDecision | null> {
  const page = await client.listCards({
    holder: "captain",
    state: "held",
    ...(scope !== undefined ? { scope } : {}),
  });
  if (page.cards.length === 0) return null;
  const threads = await Promise.all(page.cards.map((card) => client.getThread(card.id, scope)));
  const [first] = threads
    .map((thread) => ({ thread, rank: lastShownRank(thread.entries) }))
    .toSorted((a, b) => a.rank - b.rank || Number(a.thread.card.id) - Number(b.thread.card.id));
  if (first === undefined) return null;
  const { card, entries } = first.thread;
  await client.postEntry(card.id, { by: actor, text: SHOWN_TEXT, internal: true, kind: "status" });
  return { card, text: decisionText(card, entries, threads.length - 1) };
}
