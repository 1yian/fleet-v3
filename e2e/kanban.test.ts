import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { startKanbanServer } from "../src/adapters/kanban.ts";
import { startBoardServer } from "../src/board/server.ts";
import { CardStore } from "../src/board/store.ts";

const CardSummarySchema = z.object({
  id: z.string(),
  mate: z.string(),
  title: z.string(),
  state: z.string(),
  holder: z.string(),
});
const CardsResponseSchema = z.object({ cards: z.array(CardSummarySchema), total: z.number() });
const CardResponseSchema = z.object({ card: CardSummarySchema });

async function fetchCards(url: string): Promise<z.infer<typeof CardsResponseSchema>> {
  const res = await fetch(url);
  return CardsResponseSchema.parse(await res.json());
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

void test("kanban proxy exposes the card server API so a held captain card is answered back to its home mate", async () => {
  const store = new CardStore({ memory: true, parents: { jarvis: "captain", cleo: "jarvis" } });
  const board = await startBoardServer({
    store,
    host: "127.0.0.1",
    port: 0,
    chaseIntervalMs: 3_600_000,
    staleAfterMs: 600_000,
  });
  const kanban = await startKanbanServer({ boardUrl: board.url, host: "127.0.0.1", port: 0 });
  const stream = new AbortController();

  try {
    const cardServerRoot = await fetch(`${board.url}/`);
    assert.equal(cardServerRoot.status, 404, "the card server serves no UI");
    await cardServerRoot.text();

    const foreign = await fetch(`${kanban.url}/api/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ mate: "cleo", title: "Cross-site card" }),
    });
    assert.equal(foreign.status, 403, "browser writes from another origin never reach the board");
    await foreign.text();

    const created = await postJson(`${kanban.url}/api/cards`, {
      mate: "cleo",
      title: "Kanban smoke card",
    });
    assert.equal(created.status, 201);
    const card = CardResponseSchema.parse(await created.json()).card;

    const toJarvis = await postJson(`${kanban.url}/api/cards/${card.id}/escalate`, {
      reason: "Need a second opinion",
      actor: "cleo",
      to: "captain",
    });
    assert.equal(CardResponseSchema.parse(await toJarvis.json()).card.holder, "jarvis");

    const toCaptain = await postJson(`${kanban.url}/api/cards/${card.id}/escalate`, {
      reason: "Merge PR?",
      actor: "jarvis",
    });
    assert.equal(CardResponseSchema.parse(await toCaptain.json()).card.holder, "captain");

    const needsYou = await fetchCards(`${kanban.url}/api/cards?holder=captain`);
    assert.deepEqual(
      needsYou.cards.map((each) => each.id),
      [card.id],
    );

    const events = await fetch(`${kanban.url}/api/events`, { signal: stream.signal });
    assert.equal(events.status, 200);

    const answerRes = await postJson(
      `${kanban.url}/api/cards/${encodeURIComponent(card.id)}/answer`,
      { text: "Approved", actor: "captain", to: "jarvis" },
    );
    assert.equal(answerRes.status, 200);
    const answered = CardResponseSchema.parse(await answerRes.json()).card;
    assert.equal(answered.state, "held");
    assert.equal(answered.holder, "cleo", "answers always return to the home mate");

    const remaining = await fetchCards(`${kanban.url}/api/cards?holder=captain`);
    assert.equal(remaining.total, 0);

    const shutdown = await Promise.race([
      kanban.stop().then(() => "stopped"),
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve("hung");
        }, 3000);
      }),
    ]);
    assert.equal(shutdown, "stopped", "an open SSE stream must not block proxy shutdown");
  } finally {
    stream.abort();
    await kanban.stop();
    await board.stop();
    store.close();
  }
});
