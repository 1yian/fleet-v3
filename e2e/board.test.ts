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
          token: claim1.workerToken,
          text: "stale worker handoff",
        }),
      rejectsWith(409, "claim_lost"),
    );
    await assert.rejects(
      () =>
        client.postEntry(prereq.id, {
          epoch: 1,
          token: claim1.workerToken,
          text: "stale worker reply",
        }),
      rejectsWith(409, "claim_lost"),
    );
    await assert.rejects(
      () => client.cancelCard(prereq.id, { epoch: 1, token: claim1.workerToken, reason: "stale" }),
      rejectsWith(409, "claim_lost"),
    );
    assert.equal(await cardField(client, prereq.id, "state"), "running");

    await assert.rejects(
      () =>
        client.finishClaim(prereq.id, {
          epoch: 2,
          token: claim2.workerToken,
          outcome: "done",
          summary: "worker tries to complete its own card",
        }),
      rejectsWith(409, "claim_lost"),
      "the worker's fence confers no runner completion authority",
    );
    await assert.rejects(
      () => client.renewClaim(prereq.id, { epoch: 2, token: claim2.workerToken, leaseSeconds: 60 }),
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
    await client.postEntry(prereq.id, { text: "jarvis side note", by: "jarvis" });
    assert.ok(
      await waitFor(() =>
        jarvisWatch.events.some(
          (ev) => ev.type === "entry.posted" && ev.payload["text"] === "jarvis side note",
        ),
      ),
    );
    assert.equal(
      cleoWatch.events.some(
        (ev) => ev.type === "entry.posted" && ev.payload["text"] === "jarvis side note",
      ),
      false,
      "a holder-filtered stream carries only events addressed to that holder",
    );

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
    const grandchild = await client.createCard({
      mate: "cleo",
      title: "Depends on the orphan",
      host: "maverick",
      project: "Cleo",
      needs: [orphan.id],
    });
    assert.equal(grandchild.state, "waiting");
    const reassigned = await client.createCard({
      mate: "cleo",
      title: "Reassigned before its prerequisite died",
      host: "maverick",
      project: "Cleo",
      needs: [doomedPrereq.id],
    });
    await client.handoffCard(reassigned.id, { to: "jarvis", text: "Take a look" });
    await client.cancelCard(doomedPrereq.id, { reason: "Superseded", actor: "cleo" });
    for (const [id, holder] of [
      [orphan.id, "cleo"],
      [reassigned.id, "jarvis"],
    ] as const) {
      const after = await client.getThread(id);
      assert.equal(after.card.state, "held");
      assert.equal(after.card.holder, holder);
      assert.ok(
        after.entries.some((entry) => /was canceled/u.test(entry.text)),
        `card #${id} must be told its prerequisite was canceled`,
      );
    }
    assert.equal(await cardField(client, grandchild.id, "state"), "waiting");
    await assert.rejects(
      () => client.queueCard(orphan.id, {}),
      rejectsWith(409, "unmet_needs"),
      "a card whose prerequisite was canceled can only be closed or canceled",
    );
    await assert.rejects(
      () =>
        client.createCard({
          mate: "cleo",
          title: "Needs the canceled card",
          needs: [doomedPrereq.id],
        }),
      rejectsWith(400, "invalid_needs"),
    );
    await client.closeCard(orphan.id, { result: "Resolved by hand", actor: "cleo" });
    assert.equal(
      await cardField(client, grandchild.id, "state"),
      "queued",
      "closing the held dependent unblocks its own dependent",
    );

    const staleCard = await client.createCard({
      mate: "jarvis",
      title: "Untouched executive item",
    });
    assert.equal(staleCard.holder, "jarvis");

    now += 400_000;
    await client.postEntry(staleCard.id, {
      text: "coordination note",
      by: "jarvis",
      internal: true,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    assert.equal(
      jarvisWatch.events.some((ev) => ev.type === "chase.due"),
      false,
      "a card younger than the stale threshold is not chased",
    );

    now += 250_000;
    const chased = (
      events: typeof jarvisWatch.events,
      holder: string,
      cardId: string,
      state: string,
    ): boolean =>
      events.some(
        (ev) =>
          ev.type === "chase.due" &&
          ev.holder === holder &&
          Array.isArray(ev.payload["cards"]) &&
          ev.payload["cards"].some(
            (entry: unknown) =>
              typeof entry === "object" &&
              entry !== null &&
              Reflect.get(entry, "id") === cardId &&
              Reflect.get(entry, "state") === state,
          ),
      );
    assert.ok(
      await waitFor(() => chased(jarvisWatch.events, "jarvis", staleCard.id, "held")),
      "the card held by jarvis since creation is chased although its thread saw recent replies",
    );
    assert.ok(
      await waitFor(() => chased(cleoWatch.events, "cleo", dependent.id, "queued")),
      "the unclaimed queued dependent is chased to its home mate",
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

void test("claim fences also guard queue and close, hosts outlive advertisement history, and execution holders are reserved names", async () => {
  const server = await startTestServer({ parents: { cleo: "captain" } });
  const { client } = server;

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Fenced writes",
      host: "h1",
      project: "Cleo",
    });
    const queuedPage = await client.listCards({ holder: "runner" });
    assert.deepEqual(
      queuedPage.cards.map((each) => each.id),
      [card.id],
      "execution holders are valid read filters",
    );
    const claim = await client.claimNext({
      host: "h1",
      leaseSeconds: 60,
      claimBy: "runner-h1",
    });
    assert.ok(claim !== null);
    const fence = { epoch: claim.epoch, token: claim.workerToken };
    const runningPage = await client.listCards({ holder: "worker" });
    assert.deepEqual(
      runningPage.cards.map((each) => each.id),
      [card.id],
    );

    await assert.rejects(
      () => client.closeCard(card.id, { ...fence, result: "shipped without verification" }),
      rejectsWith(409, "worker_close_rejected"),
    );
    assert.equal(await cardField(client, card.id, "state"), "running");

    const handed = await client.handoffCard(card.id, { ...fence, text: "Stuck" });
    assert.equal(handed.holder, "cleo");
    await assert.rejects(
      () => client.queueCard(card.id, fence),
      rejectsWith(409, "claim_lost"),
      "a worker whose claim ended cannot put the card back on the runner queue",
    );
    assert.equal(await cardField(client, card.id, "state"), "held");
    const requeued = await client.queueCard(card.id, {});
    assert.equal(requeued.state, "queued");

    await client.advertiseHost({
      host: "first",
      mode: "local",
      viewport: "headless",
      repos: ["a"],
    });
    for (let i = 0; i < 210; i += 1) {
      await client.advertiseHost({
        host: "second",
        mode: "local",
        viewport: "headless",
        repos: ["b"],
      });
    }
    const hosts = await client.listHosts();
    assert.deepEqual(
      hosts.map((each) => each.host),
      ["first", "second"],
    );

    const inherited = await client.createCard({ mate: "constructor", title: "Unconfigured mate" });
    const escalated = await client.escalateCard(inherited.id, { reason: "Needs the captain" });
    assert.equal(escalated.holder, "captain", "unconfigured mates escalate straight to captain");

    for (const mate of ["runner", "worker", "captain"]) {
      await assert.rejects(
        () => client.createCard({ mate, title: "Reserved identity" }),
        rejectsWith(400, "validation_error"),
      );
    }
    await assert.rejects(
      () => client.handoffCard(card.id, { to: "runner" }),
      rejectsWith(400, "validation_error"),
    );
  } finally {
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
    await client.postEntry(noisy.id, { text: "ping @cleo about this", by: "other" });
    const mine = await client.createCard({ mate: "cleo", title: "Card for the quiet mate" });

    const watch = watchEvents(client, { after: cursor, holder: "cleo" });
    try {
      assert.ok(
        await waitFor(() => watch.events.some((ev) => ev.cardId === mine.id)),
        "the card created after 520 unrelated events must still be replayed",
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      assert.ok(
        !watch.events.some((ev) => ev.cardId === noisy.id),
        "a mention on another mate's card is not a routing path; only ownership transfer wakes a mate",
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
    const old = await client.createCard({ mate: "cleo", title: "Old captain item" });
    await client.handoffCard(old.id, { to: "captain" });
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
    assert.equal(overview.recentDone.length, 50, "recent done cards are capped");
    assert.ok(
      overview.recentDone.every((card) => card.state === "done" && card.id !== old.id),
      "open and done views come from one snapshot and never overlap",
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

void test("recent done follows completion time, escalation needs a held card, and foreign browser writes are refused", async () => {
  const server = await startTestServer({
    parents: { cleo: "captain" },
    now: () => 1_700_000_000_000,
  });
  const { client } = server;

  try {
    const oldest = await client.createCard({ mate: "cleo", title: "Closed last" });
    for (let i = 0; i < 52; i += 1) {
      const filler = await client.createCard({ mate: "cleo", title: `Filler ${String(i)}` });
      await client.closeCard(filler.id, {});
    }
    await client.closeCard(oldest.id, { result: "finally" });
    const overview = await client.getOverview();
    assert.equal(overview.recentDone.length, 50);
    assert.equal(
      overview.recentDone[0]?.id,
      oldest.id,
      "the most recently completed card leads the done column even with an old id",
    );

    const handed = await client.createCard({
      mate: "cleo",
      title: "Worker target",
      host: "h1",
      project: "Cleo",
    });
    const handoffClaim = await client.claimNext({
      host: "h1",
      leaseSeconds: 60,
      claimBy: "runner-h1",
    });
    assert.ok(handoffClaim !== null);
    assert.equal(handoffClaim.card.id, handed.id);
    await assert.rejects(
      () =>
        client.handoffCard(handed.id, {
          epoch: handoffClaim.epoch,
          token: handoffClaim.workerToken,
          to: "captain",
        }),
      rejectsWith(400, "invalid_target"),
      "a worker can only hand back to the home mate",
    );
    const back = await client.handoffCard(handed.id, {
      epoch: handoffClaim.epoch,
      token: handoffClaim.workerToken,
      to: "cleo",
    });
    assert.equal(back.holder, "cleo");

    const queued = await client.createCard({
      mate: "cleo",
      title: "Queued work",
      host: "h1",
      project: "Cleo",
    });
    await assert.rejects(
      () => client.escalateCard(queued.id, { reason: "skip the mate" }),
      rejectsWith(409, "invalid_state"),
    );
    assert.equal(await cardField(client, queued.id, "holder"), "runner");

    const foreign = await fetch(`${server.url}/api/cards/${queued.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ reason: "cross-site" }),
    });
    assert.equal(foreign.status, 403);
    await foreign.text();
    const plain = await fetch(`${server.url}/api/cards/${queued.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ reason: "simple request" }),
    });
    assert.equal(plain.status, 415);
    await plain.text();
    assert.equal(await cardField(client, queued.id, "state"), "queued");
  } finally {
    await server.stop();
  }
});

void test("unified dispatch guards, subtree scoping, parent wake on close/cancel, snooze, and 3x parent chase", async () => {
  let now = 1_700_000_000_000;
  const server = await startTestServer({
    parents: { jarvis: "captain", cleo: "jarvis", cnp: "jarvis", ops: "boss", boss: "captain" },
    now: () => now,
    chaseIntervalMs: 40,
    staleAfterMs: 120_000,
  });
  const { client } = server;
  const jarvisEvents = watchEvents(client, { after: 0, holder: "jarvis" });
  const cleoEvents = watchEvents(client, { after: 0, holder: "cleo" });
  const opsEvents = watchEvents(client, { after: 0, holder: "ops" });
  const bossEvents = watchEvents(client, { after: 0, holder: "boss" });

  try {
    await assert.rejects(
      () =>
        client.createCard({ mate: "cleo", title: "Half target", project: "Cleo", actor: "cleo" }),
      rejectsWith(400, "missing_target"),
    );
    await assert.rejects(
      () =>
        client.createCard({
          mate: "cleo",
          title: "Cross-domain worker",
          project: "Cleo",
          host: "p620",
          actor: "jarvis",
        }),
      rejectsWith(400, "invalid_dispatch"),
    );
    await assert.rejects(
      () => client.createCard({ mate: "cnp", title: "Sibling hijack", actor: "cleo" }),
      rejectsWith(403, "out_of_scope"),
    );

    const delegated = await client.createCard({
      mate: "cleo",
      title: "Check Hayward Kia transfer",
      actor: "jarvis",
    });
    assert.equal(delegated.state, "held");
    assert.equal(delegated.holder, "cleo");

    const cnpCard = await client.createCard({
      mate: "cnp",
      title: "CNP terraform audit",
      actor: "jarvis",
    });

    const crossed = await client.createCard({
      mate: "cleo",
      title: "Handed outside the subtree",
      actor: "jarvis",
    });
    await client.handoffCard(crossed.id, { to: "ops", actor: "captain" });

    const cleoScoped = await client.listCards({ scope: "cleo" });
    assert.deepEqual(
      cleoScoped.cards.map((c) => c.id),
      [crossed.id, delegated.id].toSorted((a, b) => Number(b) - Number(a)),
      "cleo only sees its own subtree",
    );
    const jarvisScoped = await client.listCards({ scope: "jarvis" });
    assert.equal(jarvisScoped.total, 3, "jarvis sees its entire subtree");
    await assert.rejects(
      () => client.getThread(cnpCard.id, "cleo"),
      (err: unknown) =>
        rejectsWith(403, "out_of_scope")(err) &&
        err instanceof Error &&
        err.message === `Mate "cleo" cannot access card #${cnpCard.id}`,
    );
    await assert.rejects(
      () => client.closeCard(cnpCard.id, { actor: "cleo", result: "nope" }),
      rejectsWith(403, "out_of_scope"),
    );

    const snoozed = await client.snoozeCard(delegated.id, {
      until: now + 300_000,
      reason: "Waiting on Stripe support",
      actor: "cleo",
    });
    assert.equal(snoozed.snoozeUntil, now + 300_000);
    await assert.rejects(
      () =>
        client.snoozeCard(delegated.id, {
          until: 8_640_000_000_000_001,
          actor: "cleo",
        }),
      rejectsWith(400, "invalid_snooze"),
    );

    now += 150_000;
    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });
    assert.ok(
      !cleoEvents.events.some((ev) => ev.type === "chase.due"),
      "snoozed card suppresses chase.due until snooze expires",
    );

    await client.postEntry(delegated.id, {
      text: "Support replied",
      by: "jarvis",
    });
    const woke = await client.getThread(delegated.id);
    assert.equal(woke.card.snoozeUntil, null, "non-internal reply clears snooze");
    await client.snoozeCard(delegated.id, { until: now + 300_000, actor: "cleo" });
    await client.postEntry(delegated.id, { text: "Back on it", by: "cleo" });
    const afterHolderReply = await client.getThread(delegated.id);
    assert.equal(
      afterHolderReply.card.snoozeUntil,
      null,
      "the holder's own public update also clears snooze",
    );

    now += 250_000;
    assert.equal(
      await waitFor(
        () =>
          cleoEvents.events.some(
            (ev) => ev.type === "chase.due" && JSON.stringify(ev.payload).includes(delegated.id),
          ) &&
          jarvisEvents.events.some(
            (ev) =>
              ev.type === "chase.due" &&
              JSON.stringify(ev.payload).includes('"stalledChild":"cleo"') &&
              JSON.stringify(ev.payload).includes(`"id":"${delegated.id}"`),
          ) &&
          opsEvents.events.some(
            (ev) => ev.type === "chase.due" && JSON.stringify(ev.payload).includes(crossed.id),
          ),
        2000,
      ),
      true,
      "the stalled delegated card chases its holder and parent",
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    assert.ok(
      !bossEvents.events.some((ev) => ev.type === "chase.due"),
      "a parent outside the card's subtree is not chased about it",
    );

    await client.closeCard(delegated.id, { result: "Fixed inline", actor: "cleo" });
    await client.cancelCard(cnpCard.id, { reason: "Superseded", actor: "cnp" });
    assert.equal(
      await waitFor(
        () =>
          jarvisEvents.events.some(
            (ev) => ev.type === "card.done" && ev.cardId === delegated.id && ev.holder === "jarvis",
          ) &&
          jarvisEvents.events.some(
            (ev) =>
              ev.type === "card.canceled" && ev.cardId === cnpCard.id && ev.holder === "jarvis",
          ),
        2000,
      ),
      true,
      "closing or canceling delegated cards wakes the creator",
    );
    assert.ok(
      cleoEvents.events.some((ev) => ev.type === "card.created" && ev.cardId === delegated.id),
    );
  } finally {
    await jarvisEvents.stop();
    await cleoEvents.stop();
    await opsEvents.stop();
    await bossEvents.stop();
    await server.stop();
  }
});

void test("a mate connecting to a restarted board is chased at once and out-of-scope probes learn nothing about card state", async () => {
  let now = 1_700_000_000_000;
  const server = await startTestServer({
    parents: { jarvis: "captain", cleo: "jarvis", cnp: "jarvis" },
    now: () => now,
    staleAfterMs: 120_000,
  });
  const { client } = server;

  try {
    const stalled = await client.createCard({
      mate: "cleo",
      title: "Stalled before restart",
      actor: "jarvis",
    });
    const snoozed = await client.createCard({
      mate: "cleo",
      title: "Deferred before restart",
      actor: "jarvis",
    });
    await client.snoozeCard(snoozed.id, { until: now + 3_600_000, actor: "cleo" });
    now += 130_000;

    const fresh = watchEvents(client, { holder: "cleo" });
    const stale = await waitFor(() => fresh.events.some((ev) => ev.type === "chase.due"), 2000);
    await fresh.stop();
    assert.equal(stale, true, "a new subscription gets its T=0 chase without any cursor");
    const chase = fresh.events.find((ev) => ev.type === "chase.due");
    assert.equal(chase?.holder, "cleo");
    const chased = JSON.stringify(chase?.payload);
    assert.ok(chased.includes(`"id":"${stalled.id}"`));
    assert.ok(!chased.includes(`"id":"${snoozed.id}"`), "snoozed cards are not chased");

    const quiet = watchEvents(client, { holder: "jarvis" });
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    await quiet.stop();
    assert.ok(
      !quiet.events.some((ev) => ev.type === "chase.due"),
      "a mate with nothing stale is not chased",
    );

    const queued = await client.createCard({
      mate: "cnp",
      title: "Queued sibling work",
      host: "h1",
      project: "CNP",
    });
    const finished = await client.createCard({ mate: "cnp", title: "Finished sibling work" });
    await client.closeCard(finished.id, { result: "done" });
    const denied =
      (id: string): ((err: unknown) => boolean) =>
      (err) =>
        rejectsWith(403, "out_of_scope")(err) &&
        err instanceof Error &&
        err.message === `Mate "cleo" cannot access card #${id}`;
    await assert.rejects(
      () => client.snoozeCard(queued.id, { until: now + 60_000, actor: "cleo" }),
      denied(queued.id),
    );
    await assert.rejects(
      () => client.escalateCard(queued.id, { reason: "peek", actor: "cleo" }),
      denied(queued.id),
    );
    await assert.rejects(
      () => client.handoffCard(finished.id, { to: "cleo", actor: "cleo" }),
      denied(finished.id),
    );
    await assert.rejects(
      () => client.answerCard(finished.id, { text: "peek", actor: "cleo" }),
      denied(finished.id),
    );
  } finally {
    await server.stop();
  }
});
