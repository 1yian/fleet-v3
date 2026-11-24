import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { attachFleetPiAdapter, type PiExtensionApi } from "../src/adapters/pi.ts";
import { createLocalBoardClient } from "../src/board/client.ts";
import { CardStore } from "../src/board/store.ts";
import type { RunnerConfig } from "../src/config.ts";
import { ensureMatesUp, listMates, stopMates } from "../src/mates.ts";

const RecordedEnvSchema = z.object({
  mate: z.string(),
  parent: z.string(),
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

function createMockPi(): {
  readonly api: PiExtensionApi;
  readonly delivered: string[];
  readonly emitStart: () => Promise<void>;
  readonly emitShutdown: () => Promise<void>;
  readonly emitBeforeStart: (systemPrompt: string) => Promise<{ systemPrompt: string } | undefined>;
} {
  const handlers: {
    start?: () => Promise<void> | void;
    shutdown?: () => Promise<void> | void;
    beforeStart?: (event: {
      readonly systemPrompt: string;
    }) => Promise<{ systemPrompt: string } | undefined> | { systemPrompt: string } | undefined;
  } = {};
  const delivered: string[] = [];

  const on: PiExtensionApi["on"] = (event: string, handler: (...args: never[]) => unknown) => {
    if (event === "session_start") {
      handlers.start = () => {
        const result: unknown = Reflect.apply(handler, undefined, []);
        return result instanceof Promise ? result.then(() => undefined) : undefined;
      };
      return;
    }
    if (event === "session_shutdown") {
      handlers.shutdown = () => {
        const result: unknown = Reflect.apply(handler, undefined, []);
        return result instanceof Promise ? result.then(() => undefined) : undefined;
      };
      return;
    }
    if (event === "before_agent_start") {
      handlers.beforeStart = async (ev) => {
        const raw: unknown = await Promise.resolve(Reflect.apply(handler, undefined, [ev]));
        if (typeof raw === "object" && raw !== null && "systemPrompt" in raw) {
          const prompt: unknown = Reflect.get(raw, "systemPrompt");
          if (typeof prompt === "string") return { systemPrompt: prompt };
        }
        return undefined;
      };
    }
  };

  return {
    api: {
      on,
      sendMessage(message) {
        delivered.push(message.content);
      },
    },
    delivered,
    async emitStart() {
      await handlers.start?.();
    },
    async emitShutdown() {
      await handlers.shutdown?.();
    },
    emitBeforeStart(systemPrompt: string) {
      return Promise.resolve(handlers.beforeStart?.({ systemPrompt }));
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

void test("unified Pi mate adapter scopes ambient context and wakes on escalations, answers, mentions, and chase", async () => {
  let now = 1_700_000_000_000;
  const store = new CardStore({
    memory: true,
    parents: { jarvis: "captain", cleo: "jarvis", other: "jarvis" },
    now: () => now,
  });
  const client = createLocalBoardClient(store);

  try {
    store.setCharter("cleo", "Cleo owns voice AI product work.");
    const cleoCard = store.createCard({
      mate: "cleo",
      title: "Check Hayward transfer rate",
      project: "Cleo",
      actor: "captain",
    });
    const otherCard = store.createCard({
      mate: "other",
      title: "Unrelated domain card",
      project: "other",
      actor: "captain",
    });

    const cleoMock = createMockPi();
    const jarvisMock = createMockPi();
    attachFleetPiAdapter(cleoMock.api, { client, mate: "cleo" });
    attachFleetPiAdapter(jarvisMock.api, { client, mate: "jarvis" });

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

    store.postEntry(otherCard.id, { text: "Noise in another domain", by: "other" });
    store.escalateCard(cleoCard.id, { reason: "Need Jarvis decision", actor: "cleo" });
    store.postEntry(otherCard.id, { text: "Hey @cleo can you cross-check?", by: "other" });

    now += 650_000;
    store.sweepStale(600_000);

    const deadline = Date.now() + 3000;
    while (
      (jarvisMock.delivered.length < 2 || cleoMock.delivered.length === 0) &&
      Date.now() < deadline
    ) {
      await delay(25);
    }
    await cleoMock.emitShutdown();
    await jarvisMock.emitShutdown();

    assert.ok(jarvisMock.delivered.some((text) => text.includes("Need Jarvis decision")));
    assert.ok(jarvisMock.delivered.some((text) => text.includes("Cards waiting in your court")));
    assert.ok(!jarvisMock.delivered.some((text) => text.includes("Noise in another domain")));

    assert.ok(cleoMock.delivered.some((text) => text.includes("Hey @cleo can you cross-check?")));
    assert.ok(!cleoMock.delivered.some((text) => text.includes("Noise in another domain")));
  } finally {
    store.close();
  }
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
  parent: process.env.FLEET_PARENT,
  optchat: process.env.YPI_OPTCHAT_CONFIG,
}));
setInterval(() => {}, 1000);`;

  const config: RunnerConfig = {
    host: "test-host",
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
    assert.equal(recorded.parent, "jarvis");
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
