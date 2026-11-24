import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BoardError } from "../src/board/types.ts";
import { cardField, startTestServer, waitFor, watchEvents } from "./support.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function rejectsWith(status: number, code: string): (err: unknown) => boolean {
  return (err) => err instanceof BoardError && err.status === status && err.code === code;
}

void test("card server enforces recursive escalation, home-mate answers, dependencies, fencing, and stateless chase over HTTP + SSE", async () => {
  const dataDir = makeTempDir("fv3-card-server-");
  let now = 1_700_000_000_000;
  const server = await startTestServer({
    dataDir,
    parents: { jarvis: "captain", cleo: "jarvis", direct: "captain" },
    now: () => now,
    chaseIntervalMs: 50,
  });
  const { client } = server;
  const jarvisWatch = watchEvents(client, { after: 0, holder: "jarvis" });
  const cleoWatch = watchEvents(client, { after: 0, holder: "cleo" });

  try {
    await client.setCharter("cleo", "Cleo owns voice AI. Ask before team PR merge.");
    await client.setPrefs("Prefer short, evidence-first summaries.");
    assert.equal(
      readFileSync(join(dataDir, "charters", "cleo.md"), "utf8"),
      "Cleo owns voice AI. Ask before team PR merge.",
    );
    assert.equal(
      readFileSync(join(dataDir, "prefs.md"), "utf8"),
      "Prefer short, evidence-first summaries.",
    );
    assert.equal(existsSync(join(dataDir, "fleet.db")), true);
    await assert.rejects(() => client.getCharter("../escape"), rejectsWith(400, "invalid_mate"));

    const prereq = await client.createCard({
      mate: "cleo",
      title: "Migrate schema first",
      host: "maverick",
      project: "Cleo",
      delivery: "no-mistakes",
    });
    assert.equal(prereq.state, "queued");
    assert.equal(prereq.holder, "runner");

    const dependent = await client.createCard({
      mate: "cleo",
      title: "Deploy after migration",
      host: "maverick",
      project: "Cleo",
      needs: [prereq.id],
    });
    assert.equal(dependent.state, "waiting");
    assert.equal(dependent.holder, "cleo");
    await assert.rejects(
      () => client.queueCard(dependent.id, {}),
      rejectsWith(409, "unmet_needs"),
      "a card with open prerequisites cannot be queued by hand",
    );

    const claim1 = await client.claimNext({
      host: "maverick",
      leaseSeconds: 60,
      claimBy: "runner-maverick",
    });
    assert.ok(claim1 !== null);
    assert.equal(claim1.card.id, prereq.id);
    assert.equal(claim1.epoch, 1);

    await assert.rejects(
      () => client.renewClaim(prereq.id, { epoch: 1, token: "wrong-token", leaseSeconds: 60 }),
      rejectsWith(409, "claim_lost"),
    );

    now += 61_000;
    const claim2 = await client.claimNext({
      host: "maverick",
      leaseSeconds: 60,
      claimBy: "runner-maverick",
    });
    assert.ok(claim2 !== null);
    assert.equal(claim2.card.id, prereq.id);
    assert.equal(claim2.epoch, 2);

    await assert.rejects(
      () =>
        client.handoffCard(prereq.id, {
          epoch: 1,
          token: claim1.token,
          text: "stale worker handoff",
        }),
      rejectsWith(409, "claim_lost"),
    );
    await assert.rejects(
      () =>
        client.postEntry(prereq.id, { epoch: 1, token: claim1.token, text: "stale worker reply" }),
      rejectsWith(409, "claim_lost"),
    );
    await assert.rejects(
      () => client.closeCard(prereq.id, { epoch: 1, token: claim1.token, result: "stale" }),
      rejectsWith(409, "claim_lost"),
    );
    assert.equal(await cardField(client, prereq.id, "state"), "running");

    await assert.rejects(
      () =>
        client.finishClaim(prereq.id, {
          epoch: 1,
          token: claim1.token,
          outcome: "done",
          summary: "stale finish",
        }),
      rejectsWith(409, "claim_lost"),
    );

    const returned = await client.finishClaim(prereq.id, {
      epoch: 2,
      token: claim2.token,
      outcome: "needs_mate",
      summary: "Needs merge sign-off",
    });
    assert.equal(returned.state, "held");
    assert.equal(returned.holder, "cleo");

    const toJarvis = await client.escalateCard(prereq.id, {
      reason: "Need cross-domain release timing check",
      actor: "cleo",
    });
    assert.equal(toJarvis.holder, "jarvis");

    const toCaptain = await client.escalateCard(prereq.id, {
      reason: "Approve prod migration window?",
      actor: "jarvis",
    });
    assert.equal(toCaptain.holder, "captain");

    const overview = await client.getOverview();
    assert.equal(overview.counts.needsCaptain, 1);

    const answered = await client.answerCard(prereq.id, {
      text: "Approved for tonight",
      actor: "captain",
    });
    assert.equal(answered.state, "held", "answering hands back to mate instead of blindly running");
    assert.equal(answered.holder, "cleo");

    const closed = await client.closeCard(prereq.id, {
      result: "Merged and deployed",
      actor: "cleo",
    });
    assert.equal(closed.state, "done");

    const depAfter = await client.getThread(dependent.id);
    assert.equal(depAfter.card.state, "queued");
    assert.equal(depAfter.card.holder, "runner");

    const doomedPrereq = await client.createCard({ mate: "cleo", title: "Doomed prerequisite" });
    const orphan = await client.createCard({
      mate: "cleo",
      title: "Depends on doomed work",
      host: "maverick",
      project: "Cleo",
      needs: [doomedPrereq.id],
    });
    assert.equal(orphan.state, "waiting");
    await client.cancelCard(doomedPrereq.id, { reason: "Superseded", actor: "cleo" });
    const orphanAfter = await client.getThread(orphan.id);
    assert.equal(orphanAfter.card.state, "held");
    assert.equal(orphanAfter.card.holder, "cleo");
    assert.ok(orphanAfter.entries.some((entry) => /was canceled/u.test(entry.text)));

    const staleCard = await client.createCard({
      mate: "jarvis",
      title: "Untouched executive item",
    });
    assert.equal(staleCard.holder, "jarvis");

    now += 650_000;
    assert.ok(
      await waitFor(() =>
        jarvisWatch.events.some((ev) => ev.type === "chase.due" && ev.holder === "jarvis"),
      ),
      "periodic chase must notify the holder of a stale held card",
    );
    assert.ok(
      await waitFor(() =>
        cleoWatch.events.some((ev) => ev.type === "chase.due" && ev.holder === "cleo"),
      ),
      "periodic chase must notify the mate when a queued card sits unclaimed",
    );
    assert.ok(
      jarvisWatch.events.some((ev) => ev.type === "card.escalated" && ev.holder === "jarvis"),
    );
  } finally {
    await jarvisWatch.stop();
    await cleoWatch.stop();
    await server.stop();
  }
});

void test("event delivery stays ordered and complete for runners long-polling while prerequisites close", async () => {
  const server = await startTestServer({ parents: { cleo: "captain" } });
  const { client } = server;
  const watch = watchEvents(client, { after: 0 });

  try {
    const prereq = await client.createCard({ mate: "cleo", title: "Prerequisite" });
    const first = await client.createCard({
      mate: "cleo",
      title: "First dependent",
      host: "maverick",
      project: "Cleo",
      needs: [prereq.id],
    });
    const second = await client.createCard({
      mate: "cleo",
      title: "Second dependent",
      host: "maverick",
      project: "Cleo",
      needs: [prereq.id],
    });

    const poll = client.claimNext({
      host: "maverick",
      leaseSeconds: 60,
      claimBy: "runner-maverick",
      waitSeconds: 10,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    await client.closeCard(prereq.id, { result: "done" });

    const claimed = await poll;
    assert.ok(claimed !== null);
    assert.equal(claimed.card.id, first.id);

    assert.ok(
      await waitFor(() =>
        watch.events.some(
          (ev) =>
            ev.type === "card.queued" &&
            ev.cardId === second.id &&
            ev.payload["unblockedBy"] === prereq.id,
        ),
      ),
      "every committed unblock event reaches subscribers even when a claim is published in between",
    );
    const ids = watch.events.map((ev) => ev.id);
    assert.deepEqual(
      ids,
      ids.toSorted((a, b) => a - b),
      "events are delivered in commit order",
    );
  } finally {
    await watch.stop();
    await server.stop();
  }
});

void test("SSE reconnect replays the full backlog so a quiet mate never misses its card behind unrelated history", async () => {
  const server = await startTestServer();
  const { client } = server;

  try {
    const cursor = await client.latestEventId();
    const noisy = await client.createCard({ mate: "other", title: "Noisy card" });
    for (let i = 0; i < 520; i += 1) {
      await client.postEntry(noisy.id, { text: `note ${String(i)}`, by: "other", internal: true });
    }
    await client.postEntry(noisy.id, { text: "ping @cleo-ops about this", by: "other" });
    const mine = await client.createCard({ mate: "cleo", title: "Card for the quiet mate" });
    await client.postEntry(noisy.id, { text: "ping @cleo please", by: "other" });

    const watch = watchEvents(client, { after: cursor, holder: "cleo" });
    try {
      assert.ok(
        await waitFor(() => watch.events.some((ev) => ev.cardId === mine.id)),
        "the card created after 520 unrelated events must still be replayed",
      );
      assert.ok(
        await waitFor(() =>
          watch.events.some(
            (ev) => ev.type === "entry.posted" && ev.payload["text"] === "ping @cleo please",
          ),
        ),
      );
      assert.ok(
        !watch.events.some(
          (ev) => ev.type === "entry.posted" && ev.payload["text"] === "ping @cleo-ops about this",
        ),
        "a mention of a different mate name must not wake cleo",
      );
    } finally {
      await watch.stop();
    }

    await assert.rejects(
      () => client.createCard({ mate: "ops.qa", title: "Punctuation in identity" }),
      rejectsWith(400, "validation_error"),
    );
  } finally {
    await server.stop();
  }
});

void test("open cards stay visible and counted regardless of how much terminal history exists", async () => {
  const server = await startTestServer({ parents: { cleo: "captain" } });
  const { client } = server;

  try {
    const old = await client.createCard({
      mate: "cleo",
      title: "Old captain item",
      holder: "captain",
    });
    for (let i = 0; i < 210; i += 1) {
      const filler = await client.createCard({ mate: "cleo", title: `Filler ${String(i)}` });
      await client.closeCard(filler.id, {});
    }

    const overview = await client.getOverview();
    assert.equal(overview.counts.open, 1);
    assert.equal(overview.counts.done, 210);
    assert.equal(overview.counts.total, 211);
    assert.equal(overview.counts.needsCaptain, 1);
    assert.deepEqual(
      overview.cards.map((card) => card.id),
      [old.id],
    );

    const page = await client.listCards({ state: "all", limit: 5 });
    assert.equal(page.cards.length, 5);
    assert.equal(page.total, 211);
    const mine = await client.listCards({ holder: "captain" });
    assert.deepEqual(
      mine.cards.map((card) => card.id),
      [old.id],
    );
  } finally {
    await server.stop();
  }
});

void test("stopping the card server ends open SSE streams instead of hanging shutdown", async () => {
  const server = await startTestServer();
  const controller = new AbortController();
  const received = (async () => {
    for await (const event of server.client.events({ signal: controller.signal })) {
      void event;
    }
  })();

  try {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    const outcome = await Promise.race([
      server.stop().then(() => "stopped"),
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve("hung");
        }, 3000);
      }),
    ]);
    assert.equal(outcome, "stopped");
    await received.catch(() => undefined);
  } finally {
    controller.abort();
  }
});
