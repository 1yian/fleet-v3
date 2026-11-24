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
const CardsResponseSchema = z.object({ cards: z.array(CardSummarySchema) });

void test("kanban adapter serves UI, proxies card server API, and supports answer handback to mate", async () => {
  const store = new CardStore({ memory: true, parents: { jarvis: "captain", cleo: "jarvis" } });
  const board = await startBoardServer({
    store,
    host: "127.0.0.1",
    port: 0,
    chaseIntervalMs: 0,
  });
  const kanban = await startKanbanServer({
    boardUrl: board.url,
    host: "127.0.0.1",
    port: 0,
  });

  try {
    const htmlRes = await fetch(`${kanban.url}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Needs you/u);
    assert.match(html, /With mates/u);

    const createRes = await fetch(`${kanban.url}/api/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mate: "cleo",
        title: "Kanban smoke card",
        project: "Cleo",
      }),
    });
    assert.equal(createRes.status, 201);

    const listRes = await fetch(`${kanban.url}/api/cards?state=all&limit=50`);
    assert.equal(listRes.status, 200);
    const listed = CardsResponseSchema.parse(await listRes.json());
    const found = listed.cards.find((each) => each.title === "Kanban smoke card");
    assert.ok(found !== undefined);

    store.escalateCard(found.id, { reason: "Merge PR?", to: "captain", actor: "jarvis" });

    const answerRes = await fetch(
      `${kanban.url}/api/cards/${encodeURIComponent(found.id)}/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Approved", actor: "captain" }),
      },
    );
    assert.equal(answerRes.status, 200);

    const thread = store.getThread(found.id);
    assert.equal(thread.card.state, "held");
    assert.equal(thread.card.holder, "cleo");
    assert.ok(thread.entries.some((entry) => entry.kind === "answer" && entry.text === "Approved"));
  } finally {
    await new Promise<void>((resolve) => {
      kanban.server.close(() => {
        resolve();
      });
    });
    await board.stop();
    store.close();
  }
});
