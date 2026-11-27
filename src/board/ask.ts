import type { BoardClient } from "./client.ts";
import { BoardError, type Card } from "./types.ts";

export interface AskResult {
  readonly card: Card;
  readonly chatText: string;
}

function chatTextFor(card: Card, brief: string): string {
  return [
    `Decision #${card.id} - ${card.title}`,
    "",
    brief,
    "",
    `Reply with your answer. It is recorded on card #${card.id}, which closes it.`,
  ].join("\n");
}

export async function askCaptain(
  client: BoardClient,
  input: { readonly mate: string; readonly title: string; readonly brief: string },
): Promise<AskResult> {
  const card = await client.askCard({ ...input, actor: input.mate });
  return { card, chatText: chatTextFor(card, input.brief.trim()) };
}

export async function showAsk(client: BoardClient, id: string, actor: string): Promise<AskResult> {
  const { card, entries } = await client.getThread(id, actor);
  const ask = entries.find((entry) => entry.kind === "ask");
  if (ask === undefined || card.state !== "held" || card.holder !== "captain") {
    throw new BoardError(409, "not_open_ask", `Card #${id} is not an open captain ask`);
  }
  await client.postEntry(id, {
    by: actor,
    text: "Shown to captain",
    internal: true,
    kind: "status",
  });
  return { card, chatText: chatTextFor(card, ask.text) };
}
