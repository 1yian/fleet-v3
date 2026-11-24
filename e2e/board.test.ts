import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createHttpBoardClient } from "../src/board/client.ts";
import { startBoardServer } from "../src/board/server.ts";
import { CardStore } from "../src/board/store.ts";
import { BoardError, type BoardEvent } from "../src/board/types.ts";

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

void test("card server enforces recursive mate escalation, captain answer handback, dependencies, fencing, and chase over HTTP + SSE", async () => {
  const dataDir = makeTempDir("fv3-card-server-");
  let now = 1_700_000_000_000;
  const store = new CardStore({
    dataDir,
    parents: { jarvis: "captain", cleo: "jarvis", direct: "captain" },
    now: () => now,
  });
  const started = await startBoardServer({
    store,
    host: "127.0.0.1",
    port: 0,
    chaseIntervalMs: 0,
  });
  const client = createHttpBoardClient(started.url);

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

    const sseController = new AbortController();
    const receivedEvents: BoardEvent[] = [];
    const sseLoop = (async () => {
      try {
        for await (const ev of client.events({
          after: 0,
          holder: "jarvis",
          signal: sseController.signal,
        })) {
          receivedEvents.push(ev);
        }
      } catch {
        receivedEvents.push();
      }
    })();

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

    const claim1 = await client.claimNext({
      host: "maverick",
      leaseSeconds: 60,
      claimBy: "runner-maverick",
    });
    assert.ok(claim1 !== null);
    assert.equal(claim1.card.id, prereq.id);
    assert.equal(claim1.epoch, 1);

    await assert.rejects(
      () =>
        client.renewClaim(prereq.id, {
          epoch: 1,
          token: "wrong-token",
          leaseSeconds: 60,
        }),
      (err: unknown) =>
        err instanceof BoardError && err.status === 409 && err.code === "claim_lost",
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
        client.finishClaim(prereq.id, {
          epoch: 1,
          token: claim1.token,
          outcome: "done",
          summary: "stale finish",
        }),
      (err: unknown) => err instanceof BoardError && err.status === 409,
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
    assert.equal(toJarvis.state, "held");
    assert.equal(toJarvis.holder, "jarvis");

    const toCaptain = await client.escalateCard(prereq.id, {
      reason: "Approve prod migration window?",
      actor: "jarvis",
    });
    assert.equal(toCaptain.state, "held");
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
    assert.equal(
      depAfter.card.state,
      "queued",
      "dependent unblocks automatically once prereq closes",
    );
    assert.equal(depAfter.card.holder, "runner");

    const staleCard = await client.createCard({
      mate: "jarvis",
      title: "Untouched executive item",
    });
    assert.equal(staleCard.state, "held");
    assert.equal(staleCard.holder, "jarvis");

    now += 650_000;
    const chased = store.sweepStale(600_000);
    assert.ok(
      chased.some((ev) => ev.type === "chase.due" && ev.holder === "jarvis"),
      "stateless chase must emit chase.due for stale held mate cards",
    );
    assert.ok(
      chased.some((ev) => ev.type === "chase.due" && ev.holder === "cleo"),
      "stateless chase must notify mate when a queued card sits unclaimed",
    );

    const deadline = Date.now() + 2000;
    while (
      !receivedEvents.some((ev) => ev.type === "chase.due" && ev.holder === "jarvis") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    sseController.abort();
    await sseLoop;

    assert.ok(receivedEvents.some((ev) => ev.type === "card.escalated" && ev.holder === "jarvis"));
    assert.ok(receivedEvents.some((ev) => ev.type === "chase.due" && ev.holder === "jarvis"));
  } finally {
    await started.stop();
    store.close();
  }
});
