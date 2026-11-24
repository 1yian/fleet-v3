import assert from "node:assert/strict";
import { test } from "node:test";
import { board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { z } from "zod";
import { startKanbanServer } from "../src/adapters/kanban.ts";

const TaskStateSchema = z.object({ state: z.string() });
const TaskMessageSchema = z.object({
  id: z.string(),
  channel: z.string(),
  text: z.string(),
  task: TaskStateSchema.optional(),
});
const TaskEntrySchema = z.object({ message: TaskMessageSchema });
const TasksResponseSchema = z.object({ tasks: z.array(TaskEntrySchema) });

void test("kanban adapter serves UI, proxies @vercel/board tasks, and supports reply + unblock", async () => {
  const backend = local({ memory: true });
  const client = board({ backend });
  const { server, url } = await startKanbanServer({
    boardClient: client,
    host: "127.0.0.1",
    port: 0,
  });

  try {
    const htmlRes = await fetch(`${url}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Needs you/u);
    assert.match(html, /\/api\/board/u);

    const createRes = await fetch(`${url}/api/board/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "domains/cleo",
        text: "Kanban smoke task",
        labels: { project: "Cleo" },
      }),
    });
    assert.equal(createRes.status, 201);

    const listRes = await fetch(`${url}/api/board/tasks?state=all&limit=50`);
    assert.equal(listRes.status, 200);
    const listed = TasksResponseSchema.parse(await listRes.json());
    const found = listed.tasks.find((each) => each.message.text === "Kanban smoke task");
    assert.ok(found !== undefined);

    await client.tasks.block(found.message.id, "Merge PR?");

    const replyRes = await fetch(`${url}/api/board/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ re: found.message.id, text: "Approved" }),
    });
    assert.equal(replyRes.status, 201);

    const threadRes = await fetch(
      `${url}/api/board/messages/${encodeURIComponent(found.message.id)}?limit=50`,
    );
    assert.equal(threadRes.status, 200);

    const unblockRes = await fetch(
      `${url}/api/board/tasks/${encodeURIComponent(found.message.id)}/unblock`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(unblockRes.status, 200);

    const thread = await client.thread(found.message.id);
    assert.equal(thread.message.task?.state, "ready");
    assert.equal(thread.replies.length, 1);
    assert.equal(thread.replies[0]?.text, "Approved");
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await backend.close();
  }
});
