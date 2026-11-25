import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { attachFleetPiAdapter } from "../src/adapters/pi.ts";
import { loadConfig, loadFleetConfig, type RunnerConfig } from "../src/config.ts";
import { ensureMatesUp, listMates, stopMates } from "../src/mates.ts";
import { createMockPi, startTestServer, waitFor } from "./support.ts";

const RecordedEnvSchema = z.object({
  mate: z.string(),
  optchat: z.string(),
});

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function isCommandAvailable(bin: string, args: readonly string[]): boolean {
  try {
    execFileSync(bin, args, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function tryExecSilent(bin: string, args: readonly string[], timeout = 5000): boolean {
  try {
    execFileSync(bin, args, { stdio: "ignore", timeout });
    return true;
  } catch {
    return false;
  }
}

function matesYaml(...items: readonly string[]): string[] {
  return [
    "mates:",
    "  items:",
    ...items.flatMap((entry) => entry.split("|").map((line) => `    ${line}`)),
  ];
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

void test("unified Pi mate adapter scopes ambient context and wakes on escalations, answers, and chase", async () => {
  let now = 1_700_000_000_000;
  const server = await startTestServer({
    parents: { jarvis: "captain", cleo: "jarvis", other: "jarvis" },
    now: () => now,
    chaseIntervalMs: 50,
  });
  const { client, url } = server;

  try {
    await client.setCharter("cleo", "Cleo owns voice AI product work.");
    const cleoCard = await client.createCard({
      mate: "cleo",
      title: "Check Hayward transfer rate",
      actor: "captain",
    });
    const otherCard = await client.createCard({
      mate: "other",
      title: "Unrelated domain card",
      actor: "captain",
    });

    const cleoMock = createMockPi();
    const jarvisMock = createMockPi();
    attachFleetPiAdapter(cleoMock.api, { boardUrl: url, mate: "cleo" });
    attachFleetPiAdapter(jarvisMock.api, { boardUrl: url, mate: "jarvis" });

    await cleoMock.emitStart();
    await jarvisMock.emitStart();

    const prompt1 = await cleoMock.emitBeforeStart("BASE");
    const prompt2 = await cleoMock.emitBeforeStart("BASE");
    assert.ok(prompt1 !== undefined);
    assert.equal(prompt1.systemPrompt, prompt2?.systemPrompt, "ambient prompt stays cache-stable");
    assert.ok(prompt1.systemPrompt.includes("Mate: cleo (parent: jarvis)"));
    assert.ok(prompt1.systemPrompt.includes("Cleo owns voice AI product work."));
    assert.ok(prompt1.systemPrompt.includes("Check Hayward transfer rate"));
    assert.ok(!prompt1.systemPrompt.includes("Unrelated domain card"));

    const jarvisPrompt = await jarvisMock.emitBeforeStart("BASE");
    assert.ok(jarvisPrompt !== undefined);
    assert.ok(
      jarvisPrompt.systemPrompt.includes(
        "Mate: jarvis (parent: captain, subordinates: cleo, other)",
      ),
    );

    await delay(40);

    await client.postEntry(otherCard.id, { text: "Noise in another domain", by: "other" });
    await client.escalateCard(cleoCard.id, { reason: "Need Jarvis decision", actor: "cleo" });
    await client.postEntry(otherCard.id, { text: "Hey @cleo can you cross-check?", by: "other" });
    const secondCard = await client.createCard({
      mate: "cleo",
      title: "Second Hayward check",
      actor: "jarvis",
    });
    await client.escalateCard(secondCard.id, { reason: "Approve the plan?", actor: "cleo" });
    await client.answerCard(secondCard.id, { text: "Go ahead with the plan", actor: "jarvis" });
    await client.closeCard(secondCard.id, {
      result: "Shipped Hayward check inline",
      actor: "cleo",
    });

    now += 650_000;

    await waitFor(
      () =>
        jarvisMock.delivered.some((text) => text.includes("Cards needing attention")) &&
        jarvisMock.delivered.some((text) => text.includes("Shipped Hayward check inline")) &&
        cleoMock.delivered.some((text) => text.includes("Go ahead with the plan")),
      5000,
    );
    await cleoMock.emitShutdown();
    await jarvisMock.emitShutdown();

    assert.ok(jarvisMock.delivered.some((text) => text.includes("Need Jarvis decision")));
    assert.ok(jarvisMock.delivered.some((text) => text.includes("Cards needing attention")));
    assert.ok(
      jarvisMock.delivered.some((text) => text.includes("Shipped Hayward check inline")),
      "closing a card delegated by jarvis wakes jarvis with the result",
    );
    const completionIndex = jarvisMock.delivered.findIndex((text) =>
      text.includes("Shipped Hayward check inline"),
    );
    assert.equal(
      jarvisMock.woke[completionIndex],
      true,
      "a delegated completion triggers a Pi turn",
    );
    assert.ok(!jarvisMock.delivered.some((text) => text.includes("Noise in another domain")));

    const answerIndex = cleoMock.delivered.findIndex((text) =>
      text.includes("Go ahead with the plan"),
    );
    assert.notEqual(answerIndex, -1);
    assert.equal(cleoMock.woke[answerIndex], true, "a holder transfer must trigger a Pi turn");
    assert.ok(
      !cleoMock.delivered.some((text) => text.includes("cross-check")),
      "a mention on another mate's card does not wake cleo",
    );
    assert.ok(!cleoMock.delivered.some((text) => text.includes("Noise in another domain")));
  } finally {
    await server.stop();
  }
});

void test("a mate pane started during a board outage is reconciled once the board returns", async () => {
  const dataDir = makeTempDir("fv3-outage-");
  const parents = { cleo: "jarvis", jarvis: "captain" };
  const seed = await startTestServer({ dataDir, parents });
  const port = Number(new URL(seed.url).port);
  const waiting = await seed.client.createCard({ mate: "cleo", title: "Waiting on Jarvis" });
  await seed.client.escalateCard(waiting.id, { reason: "Decide?", actor: "cleo" });
  const finished = await seed.client.createCard({
    mate: "jarvis",
    title: "Finished during outage",
  });
  await seed.client.closeCard(finished.id, { result: "ok" });
  const delegated = await seed.client.createCard({
    mate: "cleo",
    title: "Delegated then withdrawn",
    actor: "jarvis",
  });
  await seed.client.cancelCard(delegated.id, { reason: "Superseded", actor: "cleo" });
  await seed.stop();

  const pane = createMockPi();
  attachFleetPiAdapter(pane.api, { boardUrl: seed.url, mate: "jarvis", reconnectDelayMs: 50 });
  await pane.emitStart();
  const revived = await startTestServer({ dataDir, port, parents });

  try {
    assert.ok(
      await waitFor(
        () =>
          pane.delivered.some(
            (text) =>
              text.includes("reachable again") &&
              text.includes("Waiting on Jarvis") &&
              text.includes("Finished during outage") &&
              text.includes("Delegated then withdrawn"),
          ),
        8000,
      ),
      "the mate learns what it missed instead of tailing from the new head",
    );
    assert.ok(pane.woke.every(Boolean), "reconciliation wakes a turn");
  } finally {
    await pane.emitShutdown();
    await revived.stop();
  }
});

void test("Pi mate adapter refuses to start without a configured mate identity", () => {
  const previous = process.env["FLEET_MATE"];
  delete process.env["FLEET_MATE"];
  try {
    assert.throws(() => {
      attachFleetPiAdapter(createMockPi().api, { boardUrl: "http://127.0.0.1:1" });
    }, /requires FLEET_MATE/u);
  } finally {
    if (previous !== undefined) process.env["FLEET_MATE"] = previous;
  }
});

void test("config load rejects cyclic, duplicated, or unrooted mate hierarchies and review caps above four", () => {
  const root = makeTempDir("fv3-config-");
  const base = [
    "host: h1",
    "spawn:",
    "  command: [echo]",
    "repos:",
    "  demo:",
    "    path: /tmp/demo",
  ];
  const write = (name: string, extra: readonly string[]): string => {
    const path = join(root, name);
    writeFileSync(path, [...base, ...extra].join("\n"));
    return path;
  };

  assert.doesNotThrow(() =>
    loadConfig(
      write(
        "ok.yaml",
        matesYaml("- name: jarvis|  parent: captain", "- name: cleo|  parent: jarvis"),
      ),
    ),
  );
  assert.throws(
    () =>
      loadConfig(
        write(
          "cycle.yaml",
          matesYaml("- name: cleo|  parent: jarvis", "- name: jarvis|  parent: cleo"),
        ),
      ),
    /does not reach captain/u,
  );
  assert.throws(
    () =>
      loadConfig(
        write(
          "dup.yaml",
          matesYaml("- name: cleo|  parent: captain", "- name: cleo|  parent: captain"),
        ),
      ),
    /duplicated/u,
  );
  assert.throws(
    () => loadConfig(write("missing-parent.yaml", matesYaml("- name: cleo|  parent: ghost"))),
    /does not reach captain/u,
  );
  assert.throws(
    () => loadConfig(write("punctuation.yaml", matesYaml("- name: ops.qa|  parent: captain"))),
    /names use letters/u,
  );
  for (const reserved of ["runner", "worker", "captain"]) {
    assert.throws(
      () =>
        loadConfig(write(`${reserved}.yaml`, matesYaml(`- name: ${reserved}|  parent: captain`))),
      /reserved/u,
    );
  }
  const boardOnly = join(root, "board-only.yaml");
  writeFileSync(
    boardOnly,
    ["server:", "  port: 4321", ...matesYaml("- name: cleo|  parent: captain")].join("\n"),
  );
  const board = loadFleetConfig(boardOnly);
  assert.equal(board.server?.port, 4321);
  assert.equal(board.mates?.items[0]?.name, "cleo");
  assert.throws(() => loadConfig(boardOnly), /host/u);
  const shared = loadFleetConfig(
    write("shared.yaml", matesYaml("- name: jarvis|  parent: captain")),
  );
  assert.equal(shared.mates?.items[0]?.name, "jarvis", "one shared file serves every entry point");
  assert.throws(
    () => loadConfig(write("filter.yaml", ['matesFilter: ["ops.qa"]'])),
    /names use letters/u,
  );
  assert.throws(
    () => loadConfig(write("rounds.yaml", ["maxReviewRounds: 5"])),
    /too_big|<=4|Too big/iu,
  );
});

void test("fleet mates up idempotently manages permanent interactive panes in Herdr", async (t) => {
  if (!isCommandAvailable("herdr", ["--version"])) {
    t.skip("herdr CLI is not available");
    return;
  }

  const root = makeTempDir("fv3-mates-herdr-");
  const session = `fv3m${Date.now().toString(36).slice(-5)}`;
  const server = spawn("herdr", ["--session", session, "server"], { stdio: "ignore" });
  const envDump = join(root, "cleo-env.json");
  const sleeperScript = `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(envDump)}, JSON.stringify({
  mate: process.env.FLEET_MATE,
  optchat: process.env.YPI_OPTCHAT_CONFIG,
}));
setInterval(() => {}, 1000);`;

  const config: RunnerConfig = {
    host: "test-host",
    boardUrl: "http://127.0.0.1:4100",
    matesFilter: [],
    workspacesRoot: join(root, "workspaces"),
    concurrency: 1,
    leaseSeconds: 60,
    idleTimeoutSeconds: 10,
    maxWallSeconds: 30,
    maxAttempts: 3,
    maxReviewRounds: 4,
    pollWaitSeconds: 1,
    spawn: {
      mode: "local",
      viewport: "herdr",
      direnv: false,
      command: ["true"],
    },
    verify: {
      command: ["true"],
      respondCommand: ["true"],
    },
    mates: {
      workspace: "mates",
      session,
      stateDir: join(root, "mates-state"),
      env: {
        YPI_OPTCHAT_CONFIG: "{stateDir}/optchat.json",
      },
      command: [process.execPath, "-e", sleeperScript],
      items: [
        {
          name: "cleo",
          parent: "jarvis",
          cwd: join(root, "cleo-dir"),
          autoStart: true,
          env: {},
        },
        {
          name: "quiet",
          parent: "jarvis",
          cwd: join(root, "quiet-dir"),
          autoStart: false,
          env: {},
        },
      ],
    },
    repos: {},
  };

  try {
    let ready = false;
    for (let i = 0; i < 30; i += 1) {
      if (tryExecSilent("herdr", ["--session", session, "workspace", "list"])) {
        ready = true;
        break;
      }
      await delay(100);
    }
    assert.equal(ready, true, "isolated herdr server did not start");

    const first = await ensureMatesUp(config);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.name, "cleo");
    assert.equal(first[0]?.parent, "jarvis");
    assert.equal(first[0]?.action, "started");
    const cleoPaneId = first[0]?.paneId;
    assert.ok(cleoPaneId !== undefined);

    const deadline = Date.now() + 8000;
    let recordedRaw: string | undefined;
    while (Date.now() < deadline) {
      try {
        recordedRaw = readFileSync(envDump, "utf8");
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(recordedRaw !== undefined, "permanent mate pane must launch its command with env");
    const recorded = RecordedEnvSchema.parse(JSON.parse(recordedRaw));
    assert.equal(recorded.mate, "cleo");
    assert.equal(recorded.optchat, join(root, "mates-state", "cleo", "optchat.json"));

    const second = await ensureMatesUp(config);
    assert.equal(second.length, 1);
    assert.equal(second[0]?.action, "already-running");
    assert.equal(second[0]?.paneId, cleoPaneId);

    const statuses = await listMates(config);
    assert.equal(statuses.find((entry) => entry.name === "cleo")?.status, "running");
    assert.equal(statuses.find((entry) => entry.name === "quiet")?.status, "stopped");

    const onDemand = await ensureMatesUp(config, { name: "quiet" });
    assert.equal(onDemand.length, 1);
    assert.equal(onDemand[0]?.name, "quiet");
    assert.equal(onDemand[0]?.action, "started");

    const stopped = await stopMates(config, { all: true });
    assert.equal(stopped.length, 2);
    assert.ok(stopped.every((entry) => entry.action === "stopped"));

    const afterStop = await listMates(config);
    assert.ok(afterStop.every((entry) => entry.status === "stopped"));
  } finally {
    tryExecSilent("herdr", ["--session", session, "server", "stop"]);
    server.kill("SIGTERM");
  }
});
