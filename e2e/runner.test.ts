import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { RunnerConfig } from "../src/config.ts";
import { runLoop } from "../src/runner/loop.ts";
import { attachFleetPiAdapter } from "../src/adapters/pi.ts";
import { cardField, createMockPi, startTestServer, waitFor } from "./support.ts";

const BIN_PATH = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

const WorkerReceiptSchema = z.object({
  card: z.string(),
  argCard: z.string(),
  epoch: z.string(),
  tokenLength: z.number(),
  legacyTask: z.null(),
  boardUrl: z.string(),
  cwd: z.string(),
  worktree: z.string(),
  branch: z.string(),
  checkedOut: z.string(),
  prompt: z.string(),
});

const AttemptReceiptSchema = z.object({
  worktree: z.string(),
  existedAtStart: z.boolean(),
  existedAtEnd: z.boolean(),
  staleStatus: z.number().nullable(),
  staleOut: z.string(),
});

const ProbeSchema = z.object({
  status: z.number().nullable(),
  out: z.string(),
});

const HerdrReceiptSchema = z.object({
  card: z.string(),
  tty: z.boolean(),
});

const HerdrPaneEntrySchema = z.object({
  workspace_id: z.string(),
  tokens: z.object({ branch: z.string() }),
});
const HerdrPaneListResultSchema = z.object({
  panes: z.array(HerdrPaneEntrySchema),
});
const HerdrPaneListSchema = z.object({ result: HerdrPaneListResultSchema });
const HerdrWorkspaceEntrySchema = z.object({
  workspace_id: z.string(),
  label: z.string(),
});
const HerdrWorkspaceResultSchema = z.object({
  workspaces: z.array(HerdrWorkspaceEntrySchema),
});
const HerdrWorkspaceListSchema = z.object({
  result: HerdrWorkspaceResultSchema,
});

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initGitRepo(root: string): string {
  const repoDir = join(root, "demo-repo");
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Fleet Test"]);
  writeFileSync(join(repoDir, "README.md"), "# demo\n");
  execFileSync("git", ["-C", repoDir, "add", "README.md"]);
  execFileSync("git", ["-C", repoDir, "commit", "-m", "init"], {
    stdio: "ignore",
  });
  return repoDir;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => {
      resolve("timeout");
    }, ms).unref();
  });
  return Promise.race([promise, timeout]);
}

function makeConfig(
  root: string,
  repoDir: string,
  overrides: Partial<RunnerConfig> = {},
): RunnerConfig {
  return {
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
      viewport: "headless",
      direnv: false,
      command: ["node", "-e", "process.exit(0)"],
    },
    verify: {
      command: ["node", "-e", "process.exit(0)"],
      respondCommand: ["node", "-e", "process.exit(0)"],
    },
    repos: {
      demo: {
        path: repoDir,
        baseBranch: "main",
        delivery: "direct-pr",
      },
    },
    ...overrides,
  };
}

function isCommandAvailable(bin: string, args: readonly string[]): boolean {
  try {
    execFileSync(bin, [...args], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function listed(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

function tryExecSilent(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

void test("claims queued card, runs isolated worktree worker, advertises host, completes, and cleans up", async () => {
  const root = makeTempDir("fleet-v3-e2e-");
  const repoDir = initGitRepo(root);
  const receiptPath = join(root, "worker-receipt.json");
  const server = await startTestServer();
  const { client } = server;

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: `Déjà vu: fix /../ @{} ${"x".repeat(100)}`,
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });

    const workerScript = `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({
        card: process.env.FLEET_CARD,
        argCard: process.argv[1],
        epoch: process.env.FLEET_CLAIM_EPOCH,
        tokenLength: (process.env.FLEET_CLAIM_TOKEN ?? "").length,
        legacyTask: process.env.BOARD_TASK ?? null,
        boardUrl: process.env.BOARD_URL,
        cwd: process.cwd(),
        worktree: process.env.FLEET_WORKTREE,
        branch: process.env.FLEET_BRANCH,
        checkedOut: require("node:child_process")
          .execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" })
          .trim(),
        prompt: process.env.FLEET_PROMPT,
      }));
    `;

    const config = makeConfig(root, repoDir, {
      boardUrl: server.url,
      spawn: {
        mode: "local",
        viewport: "headless",
        direnv: false,
        command: ["node", "-e", workerScript, "{card}"],
      },
    });

    const handled = await runLoop(client, config, { once: true });
    assert.equal(handled, 1);

    const receipt = WorkerReceiptSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8")));
    assert.equal(receipt.card, card.id);
    assert.equal(receipt.argCard, card.id);
    assert.equal(receipt.epoch, "1");
    assert.equal(receipt.boardUrl, server.url, "workers always target the claiming board");
    assert.ok(receipt.tokenLength >= 32, "worker receives its claim fencing token");
    assert.equal(
      receipt.checkedOut,
      receipt.branch,
      "the worktree has its advertised branch checked out",
    );
    const checkoutName = basename(receipt.worktree);
    assert.equal(checkoutName, "c-1-a1");
    assert.equal(receipt.branch, "c-1-a1");
    const repoBranches = execFileSync("git", ["-C", repoDir, "branch", "--list", "c-*"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.replace(/^[*+ ]+/u, "").trim())
      .filter((line) => line.length > 0);
    assert.deepEqual(repoBranches, [receipt.branch], "git holds exactly the advertised branch");
    assert.notEqual(receipt.worktree, repoDir);
    assert.equal(existsSync(receipt.worktree), false);

    const thread = await client.getThread(card.id);
    assert.equal(thread.card.state, "done");

    const hosts = await client.listHosts();
    const advertised = hosts.find((each) => each.host === "test-host");
    assert.ok(advertised !== undefined);
    assert.deepEqual(advertised.repos, ["demo"]);
  } finally {
    await server.stop();
  }
});

void test("worker handoff goes through the fenced fleet CLI and survives exit 0", async () => {
  const root = makeTempDir("fleet-v3-handoff-");
  const repoDir = initGitRepo(root);
  const server = await startTestServer();
  const { client } = server;

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Need missing API key",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });

    const closeProbe = join(root, "close-probe.json");
    const workerScript = `
      const { execFileSync, spawnSync } = require("node:child_process");
      const bin = ${JSON.stringify(BIN_PATH)};
      const attempt = spawnSync(process.execPath, [bin, "close", process.env.FLEET_CARD, "--result", "all done"], { encoding: "utf8" });
      require("node:fs").writeFileSync(${JSON.stringify(closeProbe)}, JSON.stringify({
        status: attempt.status,
        out: attempt.stdout + attempt.stderr,
      }));
      execFileSync(process.execPath, [
        bin, "handoff", process.env.FLEET_CARD,
        "--text", "Missing API key; returning to mate",
      ], { stdio: "inherit" });
    `;

    const config = makeConfig(root, repoDir, {
      boardUrl: server.url,
      spawn: {
        mode: "local",
        viewport: "headless",
        direnv: false,
        command: ["node", "-e", workerScript],
      },
    });

    const cleoPane = createMockPi();
    attachFleetPiAdapter(cleoPane.api, { boardUrl: server.url, mate: "cleo" });
    await cleoPane.emitStart();

    try {
      const handled = await runLoop(client, config, { once: true });
      assert.equal(handled, 1);

      const thread = await client.getThread(card.id);
      assert.equal(thread.card.state, "held", "must not overwrite worker handoff with done");
      assert.equal(thread.card.holder, "cleo");
      assert.ok(
        thread.entries.some(
          (entry) =>
            entry.by === "worker:cleo" && entry.text === "Missing API key; returning to mate",
        ),
        "worker writes are attributed to a worker actor, not the home mate",
      );

      const probe = ProbeSchema.parse(JSON.parse(readFileSync(closeProbe, "utf8")));
      assert.notEqual(probe.status, 0, "a worker cannot close its own card");
      assert.match(probe.out, /exiting cleanly/u);

      assert.ok(
        await waitFor(() =>
          cleoPane.delivered.some(
            (text) => text.includes("handed to you") && text.includes("Missing API key"),
          ),
        ),
        "the home mate's pane is woken by the worker handoff",
      );
    } finally {
      await cleoPane.emitShutdown();
    }
  } finally {
    await server.stop();
  }
});

void test("a requeued card runs its next attempt in its own workspace while the superseded worker winds down", async () => {
  const root = makeTempDir("fleet-v3-overlap-");
  const repoDir = initGitRepo(root);
  const receiptDir = join(root, "receipts");
  mkdirSync(receiptDir);
  const server = await startTestServer();
  const { client } = server;
  const controller = new AbortController();
  let loop: Promise<number> = Promise.resolve(0);

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Handed back then retried",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });

    const workerScript = `
      const fs = require("node:fs");
      const { execFileSync, spawnSync } = require("node:child_process");
      const epoch = process.env.FLEET_CLAIM_EPOCH;
      const worktree = process.env.FLEET_WORKTREE;
      const existedAtStart = fs.existsSync(worktree);
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const startedMarker = ${JSON.stringify(receiptDir)} + "/e2-started";
      (async () => {
        let stale = { status: null, out: "" };
        if (epoch === "1") {
          execFileSync(process.execPath, [
            ${JSON.stringify(BIN_PATH)}, "handoff", process.env.FLEET_CARD, "--text", "first attempt hands back",
          ], { stdio: "inherit" });
          for (let i = 0; i < 200 && !fs.existsSync(startedMarker); i += 1) await sleep(50);
          const attempt = spawnSync(process.execPath, [
            ${JSON.stringify(BIN_PATH)}, "reply", process.env.FLEET_CARD, "--text", "stale reply from attempt 1",
          ], { encoding: "utf8" });
          stale = { status: attempt.status, out: attempt.stdout + attempt.stderr };
          await sleep(1000);
        } else {
          fs.writeFileSync(startedMarker, "1");
          await sleep(2500);
        }
        fs.writeFileSync(${JSON.stringify(receiptDir)} + "/e" + epoch + ".json", JSON.stringify({
          worktree,
          existedAtStart,
          existedAtEnd: fs.existsSync(worktree),
          staleStatus: stale.status,
          staleOut: stale.out,
        }));
      })();
    `;

    const config = makeConfig(root, repoDir, {
      boardUrl: server.url,
      concurrency: 2,
      spawn: {
        mode: "local",
        viewport: "headless",
        direnv: false,
        command: ["node", "-e", workerScript],
      },
    });

    loop = runLoop(client, config, { signal: controller.signal });

    assert.ok(
      await waitFor(async () => (await cardField(client, card.id, "state")) === "held", 10_000),
      "first attempt must hand the card back",
    );
    await client.queueCard(card.id, {});

    assert.ok(
      await waitFor(() => existsSync(join(receiptDir, "e2.json")), 15_000),
      "second attempt must run to completion",
    );
    assert.ok(await waitFor(() => existsSync(join(receiptDir, "e1.json")), 5000));
    const readReceipt = (name: string): z.infer<typeof AttemptReceiptSchema> => {
      const raw: unknown = JSON.parse(readFileSync(join(receiptDir, name), "utf8"));
      return AttemptReceiptSchema.parse(raw);
    };
    const first = readReceipt("e1.json");
    const second = readReceipt("e2.json");
    assert.equal(basename(first.worktree), `c-${card.id}-a1`);
    assert.equal(basename(second.worktree), `c-${card.id}-a2`);
    assert.equal(second.existedAtStart, true);
    assert.equal(second.existedAtEnd, true, "cleaning up attempt 1 must not remove attempt 2");
    assert.notEqual(first.staleStatus, 0, "the superseded worker's CLI write must fail");
    assert.match(first.staleOut, /no longer valid/u);
    const thread = await client.getThread(card.id);
    assert.ok(
      !thread.entries.some((entry) => entry.text === "stale reply from attempt 1"),
      "the CLI forwards its fence so a superseded worker cannot write to the thread",
    );

    assert.ok(
      await waitFor(async () => (await cardField(client, card.id, "state")) === "done", 10_000),
    );
    assert.equal(await cardField(client, card.id, "epoch"), 2);
  } finally {
    controller.abort();
    await loop;
    await server.stop();
  }
});

void test("caps no-mistakes verification at 4 rounds and hands back to mate without force-shipping", async () => {
  const root = makeTempDir("fleet-v3-e2e-");
  const repoDir = initGitRepo(root);
  const roundsLog = join(root, "rounds.log");
  const server = await startTestServer();
  const { client } = server;

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Change that never converges in review",
      host: "test-host",
      project: "demo",
      delivery: "no-mistakes",
    });

    const failVerify = `
      const fs = require("node:fs");
      fs.appendFileSync(${JSON.stringify(roundsLog)}, process.env.FLEET_REVIEW_ROUND + "\\n");
      console.error("findings: reviewer raised another nitpick");
      process.exit(1);
    `;

    const config = makeConfig(root, repoDir, {
      maxReviewRounds: 4,
      verify: {
        command: ["node", "-e", failVerify],
        respondCommand: ["node", "-e", failVerify],
      },
    });

    const handled = await runLoop(client, config, { once: true });
    assert.equal(handled, 1);

    const rounds = readFileSync(roundsLog, "utf8").trim().split("\n");
    assert.deepEqual(rounds, ["1", "2", "3", "4"]);

    const thread = await client.getThread(card.id);
    assert.equal(thread.card.state, "held");
    assert.equal(thread.card.holder, "cleo");
    assert.ok(
      thread.entries.some((entry) => /stopped at round 4\/4/iu.test(entry.text)),
      "expected 4-round handback summary in thread",
    );
  } finally {
    await server.stop();
  }
});

void test("returns card to mate once crashed or expired attempts exceed maxAttempts, while clean releases are free", async () => {
  const root = makeTempDir("fleet-v3-e2e-");
  const repoDir = initGitRepo(root);
  const ranMarker = join(root, "should-not-run");
  let now = 1_700_000_000_000;
  const server = await startTestServer({ now: () => now });
  const { client } = server;
  const workerConfig = makeConfig(root, repoDir, {
    maxAttempts: 3,
    spawn: {
      mode: "local",
      viewport: "headless",
      direnv: false,
      command: [
        "node",
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(ranMarker)}, "1")`,
      ],
    },
  });

  try {
    const released = await client.createCard({
      mate: "cleo",
      title: "Cleanly interrupted card",
      host: "test-host",
      project: "demo",
    });
    for (let i = 0; i < 3; i += 1) {
      const prior = await client.claimNext({
        host: "test-host",
        leaseSeconds: 60,
        claimBy: "runner-test-host",
      });
      assert.ok(prior !== null);
      await client.releaseClaim(released.id, {
        epoch: prior.epoch,
        token: prior.token,
      });
    }
    await runLoop(client, workerConfig, { once: true });
    assert.equal(existsSync(ranMarker), true, "clean releases do not spend the retry budget");
    assert.equal(await cardField(client, released.id, "state"), "done");
    rmSync(ranMarker);

    const flaky = await client.createCard({
      mate: "cleo",
      title: "Flaky card",
      host: "test-host",
      project: "demo",
    });
    for (let i = 0; i < 3; i += 1) {
      const crashed = await client.claimNext({
        host: "test-host",
        leaseSeconds: 5,
        claimBy: "runner-test-host",
      });
      assert.ok(crashed !== null);
      now += 10_000;
    }

    await runLoop(client, workerConfig, { once: true });

    assert.equal(existsSync(ranMarker), false);
    const thread = await client.getThread(flaky.id);
    assert.equal(thread.card.state, "held");
    assert.equal(thread.card.holder, "cleo");
    const epochBeforeRetry = thread.card.epoch;
    assert.ok(
      thread.entries.some((entry) => /fleet queue/u.test(entry.text)),
      "the retry cap summary points to fleet queue after fixing the blocker",
    );

    const requeued = await client.queueCard(flaky.id, { actor: "cleo" });
    assert.equal(requeued.state, "queued");
    assert.equal(requeued.attempts, 0, "re-queuing a held card resets retry attempts");
    assert.equal(requeued.epoch, epochBeforeRetry, "re-queuing preserves monotonic epoch");

    await runLoop(client, workerConfig, { once: true });
    assert.equal(existsSync(ranMarker), true, "the retried card runs after attempts reset");
    const finished = await client.getThread(flaky.id);
    assert.equal(finished.card.state, "done");
    assert.ok(
      finished.card.epoch > epochBeforeRetry,
      "the retry claim strictly increments the fencing epoch",
    );
  } finally {
    await server.stop();
  }
});

void test("kills entire worker process group on idle timeout leaving no orphan grandchild", async () => {
  const root = makeTempDir("fleet-v3-e2e-");
  const repoDir = initGitRepo(root);
  const childPidFile = join(root, "grandchild.pid");
  const server = await startTestServer();
  const { client } = server;

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Hanging worker",
      host: "test-host",
      project: "demo",
    });

    const hangScript = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const grand = spawn("sleep", ["60"], { stdio: "ignore" });
      fs.writeFileSync(${JSON.stringify(childPidFile)}, String(grand.pid));
      setInterval(() => {}, 10000);
    `;

    const config = makeConfig(root, repoDir, {
      idleTimeoutSeconds: 1,
      maxWallSeconds: 5,
      spawn: {
        mode: "local",
        viewport: "headless",
        direnv: false,
        command: ["node", "-e", hangScript],
      },
    });

    await runLoop(client, config, { once: true });

    const thread = await client.getThread(card.id);
    assert.equal(thread.card.state, "held");
    assert.equal(thread.card.holder, "cleo");

    const grandchildPid = Number(readFileSync(childPidFile, "utf8").trim());
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" });
  } finally {
    await server.stop();
  }
});

void test("runs real isolated card inside Apple container micro-VM with worktree gitCommonDir and inherited env", async (t) => {
  if (!isCommandAvailable("container", ["system", "status"])) {
    t.skip("Apple container runtime not running on this host");
    return;
  }

  const root = makeTempDir("fleet-v3-apple-container-");
  const secretDir = makeTempDir("fleet-v3-apple-secret-");
  const outDir = makeTempDir("fleet-v3-apple-out-");
  const repoDir = initGitRepo(root);
  const receiptFile = join(secretDir, "secret.txt");
  writeFileSync(receiptFile, "cred-payload\n");
  const hostOutPath = join(outDir, "container-out.txt");
  const prevInherited = process.env["FLEET_E2E_INHERITED"];
  process.env["FLEET_E2E_INHERITED"] = "inherited-ok";

  const server = await startTestServer();
  const { client } = server;

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Verify container worker isolation",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });

    const script = [
      "set -eu",
      'gitdir=$(sed "s/^gitdir: //" .git)',
      'test -f "$gitdir/HEAD"',
      'printf "%s|%s|%s|%s" "$FLEET_CARD" "$FLEET_E2E_INHERITED" "$(cat /run/secret.txt)" "$(cat "$gitdir/HEAD")" > "$FLEET_E2E_OUT"',
    ].join("; ");

    const config = makeConfig(root, repoDir, {
      idleTimeoutSeconds: 30,
      maxWallSeconds: 60,
      spawn: {
        mode: "container",
        viewport: "headless",
        direnv: false,
        command: ["sh", "-c", script],
        container: {
          image: "docker.io/library/alpine:latest",
          ssh: false,
          inheritEnv: ["FLEET_E2E_INHERITED"],
          mounts: [`${receiptFile}:/run/secret.txt:ro`, `${outDir}:/out`],
          extraArgs: ["-e", "FLEET_E2E_OUT=/out/container-out.txt"],
        },
      },
    });

    const handled = await runLoop(client, config, { once: true });
    assert.equal(handled, 1);

    const thread = await client.getThread(card.id);
    assert.equal(
      thread.card.state,
      "done",
      thread.entries.map((entry) => entry.text).join("\n---\n"),
    );

    const observed = readFileSync(hostOutPath, "utf8").trim();
    const [observedCard, inherited, secret, headRef] = observed.split("|");
    assert.equal(observedCard, card.id);
    assert.equal(inherited, "inherited-ok");
    assert.equal(secret, "cred-payload");
    const repoBranches = execFileSync("git", ["-C", repoDir, "branch", "--list", "c-*"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.replace(/^[*+ ]+/u, "").trim())
      .filter((line) => line.length > 0);
    assert.equal(repoBranches.length, 1);
    assert.equal(headRef, `ref: refs/heads/${repoBranches[0] ?? ""}`);
  } finally {
    if (prevInherited === undefined) delete process.env["FLEET_E2E_INHERITED"];
    else process.env["FLEET_E2E_INHERITED"] = prevInherited;
    await server.stop();
  }
});

void test("runs workers inside live herdr panes in an isolated session, closing on success and keeping on failure", async (t) => {
  if (!isCommandAvailable("herdr", ["--version"])) {
    t.skip("herdr binary not installed on this host");
    return;
  }

  const root = makeTempDir("fleet-v3-herdr-");
  const repoDir = initGitRepo(root);
  const receiptPath = join(root, "herdr-receipt.json");
  const sessionName = `fv3t${Date.now().toString(36).slice(-5)}`;
  const herdrServer = spawn("herdr", ["--session", sessionName, "server"], {
    stdio: "ignore",
  });
  const herdrExec = (...args: readonly string[]): string =>
    execFileSync("herdr", ["--session", sessionName, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });

  const server = await startTestServer();
  const { client } = server;

  try {
    let ready = false;
    for (let i = 0; i < 30; i += 1) {
      try {
        herdrExec("workspace", "list");
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
      }
    }
    assert.equal(ready, true, "isolated herdr server did not start");

    const okCard = await client.createCard({
      mate: "cleo",
      title: "Run inside herdr pane and succeed",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });

    const okScript = `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({
        card: process.env.FLEET_CARD,
        tty: Boolean(process.stdout.isTTY),
      }));
    `;

    const baseHerdrSpawn = {
      mode: "local" as const,
      viewport: "herdr" as const,
      direnv: false,
      herdr: {
        session: sessionName,
        keepPane: "on-failure" as const,
      },
    };

    const okConfig = makeConfig(root, repoDir, {
      spawn: { ...baseHerdrSpawn, command: ["node", "-e", okScript] },
    });

    const handledOk = await runLoop(client, okConfig, { once: true });
    assert.equal(handledOk, 1);

    const okThread = await client.getThread(okCard.id);
    assert.equal(okThread.card.state, "done");
    assert.ok(
      okThread.entries.some((entry) => /herdr w\d+:p\d+/u.test(entry.text)),
      "expected herdr pane ID in claim entry",
    );

    const receipt = HerdrReceiptSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8")));
    assert.equal(receipt.card, okCard.id);
    assert.equal(receipt.tty, true, "herdr pane must provide a live TTY");

    const panesAfterSuccess = HerdrPaneListSchema.parse(JSON.parse(herdrExec("pane", "list")));
    assert.equal(
      panesAfterSuccess.result.panes.length,
      0,
      "keepPane: on-failure must close pane after success",
    );

    const failCard = await client.createCard({
      mate: "cleo",
      title: `Déjà vu: ${"x".repeat(100)} extra words and fail`,
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });

    const failConfig = makeConfig(root, repoDir, {
      spawn: {
        ...baseHerdrSpawn,
        command: ["node", "-e", "console.error('boom'); process.exit(2);"],
      },
    });

    const handledFail = await runLoop(client, failConfig, { once: true });
    assert.equal(handledFail, 1);

    const failThread = await client.getThread(failCard.id);
    assert.equal(failThread.card.state, "held");
    assert.equal(failThread.card.holder, "cleo");

    const panesAfterFail = HerdrPaneListSchema.parse(JSON.parse(herdrExec("pane", "list")));
    assert.equal(
      panesAfterFail.result.panes.length,
      1,
      "keepPane: on-failure must keep failed pane open for inspection",
    );

    const crashCard = await client.createCard({
      mate: "cleo",
      title: "Fix /... those 🧪 five words please",
      host: "test-host",
      project: "demo",
      delivery: "no-mistakes",
    });
    const crashConfig = makeConfig(root, repoDir, {
      spawn: { ...baseHerdrSpawn, command: ["node", "-e", "process.exit(0)"] },
      verify: {
        command: ["fleet-e2e-no-such-verifier"],
        respondCommand: ["fleet-e2e-no-such-verifier"],
      },
    });
    await runLoop(client, crashConfig, { once: true });
    assert.equal(await cardField(client, crashCard.id, "state"), "held");
    const panesAfterCrash = HerdrPaneListSchema.parse(JSON.parse(herdrExec("pane", "list")));
    assert.equal(
      panesAfterCrash.result.panes.length,
      2,
      "a runner exception counts as a failure and keeps the pane open",
    );
    const {
      result: { workspaces },
    } = HerdrWorkspaceListSchema.parse(JSON.parse(herdrExec("workspace", "list")));
    const labels = new Map(
      workspaces.map((workspace) => [workspace.workspace_id, workspace.label]),
    );
    assert.deepEqual(panesAfterCrash.result.panes.map((pane) => pane.tokens.branch).toSorted(), [
      `c-${failCard.id}-a1`,
      `c-${crashCard.id}-a1`,
    ]);
    for (const pane of panesAfterCrash.result.panes) {
      const expected =
        pane.tokens.branch === `c-${failCard.id}-a1`
          ? `d-j-vu-${"x".repeat(33)}`
          : "fix-those-five-words";
      assert.equal(labels.get(pane.workspace_id), expected);
    }

    const cjkCard = await client.createCard({
      mate: "cleo",
      title: "修复登录",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });
    await runLoop(client, failConfig, { once: true });
    const panesAfterCjk = HerdrPaneListSchema.parse(JSON.parse(herdrExec("pane", "list")));
    const cjkPane = panesAfterCjk.result.panes.find(
      (pane) => pane.tokens.branch === `c-${cjkCard.id}-a1`,
    );
    assert.ok(cjkPane !== undefined, "the non-ASCII card keeps its failed pane open");
    const cjkWorkspaces = HerdrWorkspaceListSchema.parse(JSON.parse(herdrExec("workspace", "list")))
      .result.workspaces;
    const cjkLabels = new Map(
      cjkWorkspaces.map((workspace) => [workspace.workspace_id, workspace.label]),
    );
    assert.equal(cjkLabels.get(cjkPane.workspace_id), `c-${cjkCard.id}`);
  } finally {
    tryExecSilent(() => {
      herdrExec("server", "stop");
    });
    herdrServer.kill("SIGTERM");
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    tryExecSilent(() => {
      execFileSync("herdr", ["session", "delete", sessionName], {
        stdio: "ignore",
        timeout: 5000,
      });
    });
    await server.stop();
  }
});

void test("a worker executable that cannot start hands the card back to its mate instead of stranding the claim", async () => {
  const root = makeTempDir("fleet-v3-spawn-failure-");
  const repoDir = initGitRepo(root);
  const server = await startTestServer();
  const { client } = server;

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Worker binary is missing",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });
    const config = makeConfig(root, repoDir, {
      spawn: {
        mode: "local",
        viewport: "headless",
        direnv: false,
        command: ["fleet-e2e-no-such-worker-binary"],
      },
    });

    await runLoop(client, config, { once: true });

    const thread = await client.getThread(card.id);
    assert.equal(thread.card.state, "held");
    assert.equal(thread.card.holder, "cleo");
    assert.ok(
      thread.entries.some((entry) => /failed before the worker could finish/u.test(entry.text)),
    );
  } finally {
    await server.stop();
  }
});

void test("shutdown during worktree setup releases the claim without launching the worker", async () => {
  const root = makeTempDir("fleet-v3-shutdown-");
  const repoDir = initGitRepo(root);
  const setupMarker = join(root, "setup-started");
  const workerMarker = join(root, "worker-launched");
  const hookPath = join(repoDir, ".git", "hooks", "post-checkout");
  writeFileSync(hookPath, `#!/bin/sh\ntouch "${setupMarker}"\nsleep 1\n`);
  chmodSync(hookPath, 0o755);
  const server = await startTestServer();
  const { client } = server;
  const controller = new AbortController();

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Interrupted during checkout",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });
    const config = makeConfig(root, repoDir, {
      spawn: {
        mode: "local",
        viewport: "headless",
        direnv: false,
        command: [
          "node",
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(workerMarker)}, "1")`,
        ],
      },
    });

    const run = runLoop(client, config, {
      once: true,
      signal: controller.signal,
    });
    assert.ok(await waitFor(() => existsSync(setupMarker), 10_000), "worktree setup must start");
    controller.abort();
    await run;

    assert.equal(existsSync(workerMarker), false, "no worker may launch after shutdown");
    assert.equal(await cardField(client, card.id, "state"), "queued");
  } finally {
    await server.stop();
  }
});

void test("a repo envrc cannot redirect the worker's board or claim fence under direnv", async () => {
  const root = makeTempDir("fleet-v3-direnv-");
  const repoDir = initGitRepo(root);
  const receiptPath = join(root, "direnv-receipt.json");
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const fakeDirenv = join(binDir, "direnv");
  writeFileSync(
    fakeDirenv,
    '#!/bin/sh\nshift 2\nBOARD_URL=http://bogus.invalid FLEET_CLAIM_EPOCH=99 exec "$@"\n',
  );
  chmodSync(fakeDirenv, 0o755);
  writeFileSync(join(root, ".envrc"), "export BOARD_URL=http://bogus.invalid\n");
  const previousPath = process.env["PATH"];
  process.env["PATH"] = `${binDir}:${previousPath ?? ""}`;
  const server = await startTestServer();
  const { client } = server;

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Envrc tries to hijack the worker",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });
    const workerScript = `
      require("node:fs").writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({
        boardUrl: process.env.BOARD_URL,
        epoch: process.env.FLEET_CLAIM_EPOCH,
      }));
    `;
    const config = makeConfig(root, repoDir, {
      boardUrl: server.url,
      spawn: {
        mode: "local",
        viewport: "headless",
        direnv: true,
        command: ["node", "-e", workerScript],
      },
    });

    await runLoop(client, config, { once: true });

    const receipt = z
      .object({ boardUrl: z.string(), epoch: z.string() })
      .parse(JSON.parse(readFileSync(receiptPath, "utf8")));
    assert.equal(receipt.boardUrl, server.url);
    assert.equal(receipt.epoch, "1");
    assert.equal(await cardField(client, card.id, "state"), "done");
  } finally {
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
    await server.stop();
  }
});

void test("a failed worktree setup leaves no scratch directory or branch behind", async () => {
  const root = makeTempDir("fleet-v3-setup-failure-");
  const repoDir = initGitRepo(root);
  const server = await startTestServer();
  const { client } = server;

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Base branch is missing",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });
    const config = makeConfig(root, repoDir, {
      repos: {
        demo: {
          path: repoDir,
          baseBranch: "no-such-branch",
          delivery: "direct-pr",
        },
      },
    });

    await runLoop(client, config, { once: true });

    assert.equal(await cardField(client, card.id, "state"), "held");
    const scratchRoot = join(root, "workspaces", "cleo", "demo", "tmp");
    assert.deepEqual(
      existsSync(scratchRoot) ? readdirSync(scratchRoot) : [],
      [],
      "the failed attempt's scratch directory is removed",
    );
    const branches = execFileSync("git", ["-C", repoDir, "branch", "--list", "c-*"], {
      encoding: "utf8",
    });
    assert.equal(branches.trim(), "");
  } finally {
    await server.stop();
  }
});

void test("a checkout whose post-checkout hook fails leaves no worktree, scratch directory, or branch", async () => {
  const root = makeTempDir("fleet-v3-hook-failure-");
  const repoDir = initGitRepo(root);
  const hookPath = join(repoDir, ".git", "hooks", "post-checkout");
  writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
  chmodSync(hookPath, 0o755);
  const server = await startTestServer();
  const { client } = server;

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Checkout hook rejects the worktree",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });
    await runLoop(client, makeConfig(root, repoDir, {}), { once: true });

    assert.equal(await cardField(client, card.id, "state"), "held");
    const projectRoot = join(root, "workspaces", "cleo", "demo");
    assert.deepEqual(listed(join(projectRoot, "tmp")), []);
    assert.deepEqual(listed(join(projectRoot, "worktrees")), []);
    const worktrees = execFileSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
    assert.equal(worktrees.split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
    const branches = execFileSync("git", ["-C", repoDir, "branch", "--list", "c-*"], {
      encoding: "utf8",
    });
    assert.equal(branches.trim(), "");
  } finally {
    await server.stop();
  }
});

void test("a checkout Git refuses to remove is reported with its path, after a failed setup and after a finished claim", async () => {
  const hookRoot = makeTempDir("fleet-v3-untracked-hook-");
  const hookRepo = initGitRepo(hookRoot);
  const hookPath = join(hookRepo, ".git", "hooks", "post-checkout");
  writeFileSync(hookPath, "#!/bin/sh\necho junk > untracked.txt\nexit 1\n");
  chmodSync(hookPath, 0o755);
  const setupBoard = await startTestServer();
  try {
    const card = await setupBoard.client.createCard({
      mate: "cleo",
      title: "Hook leaves an untracked file",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });
    await runLoop(setupBoard.client, makeConfig(hookRoot, hookRepo), { once: true });
    const left = join(hookRoot, "workspaces", "cleo", "demo", "worktrees", "c-1-a1");
    assert.equal(await cardField(setupBoard.client, card.id, "state"), "held");
    assert.ok(existsSync(join(left, "untracked.txt")), "the unforced rollback leaves the checkout");
    const { entries } = await setupBoard.client.getThread(card.id);
    const report = entries.map((entry) => entry.text).join("\n");
    assert.ok(report.includes("git worktree add"), "the setup failure is reported");
    assert.ok(
      report.includes(`left the checkout at ${left}`),
      "the cleanup failure names the left-behind path",
    );
  } finally {
    await setupBoard.stop();
  }

  const lockRoot = makeTempDir("fleet-v3-locked-checkout-");
  const lockRepo = initGitRepo(lockRoot);
  const lockBoard = await startTestServer();
  try {
    const card = await lockBoard.client.createCard({
      mate: "cleo",
      title: "Worker locks its checkout",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });
    const lockWorker =
      'const wt = process.env.FLEET_WORKTREE; require("node:child_process").execFileSync("git", ["-C", wt, "worktree", "lock", wt]);';
    await runLoop(
      lockBoard.client,
      makeConfig(lockRoot, lockRepo, {
        spawn: {
          mode: "local",
          viewport: "headless",
          direnv: false,
          command: ["node", "-e", lockWorker],
        },
      }),
      { once: true },
    );
    assert.equal(await cardField(lockBoard.client, card.id, "state"), "done");
    const { entries } = await lockBoard.client.getThread(card.id);
    assert.ok(
      entries.some(
        (entry) =>
          entry.text.includes("could not clean up the checkout") &&
          entry.text.includes("left the checkout at"),
      ),
      "teardown failure is reported on the card after the claim finished",
    );
  } finally {
    await lockBoard.stop();
  }
});

void test("a branch left from an earlier board is never overwritten or deleted by a new attempt", async () => {
  const root = makeTempDir("fleet-v3-branch-");
  const repoDir = initGitRepo(root);
  const retained = "c-1-a1";
  execFileSync("git", ["-C", repoDir, "branch", retained]);
  const retainedSha = execFileSync("git", ["-C", repoDir, "rev-parse", retained], {
    encoding: "utf8",
  }).trim();
  writeFileSync(join(repoDir, "next.txt"), "advance main\n");
  execFileSync("git", ["-C", repoDir, "add", "next.txt"]);
  execFileSync("git", ["-C", repoDir, "commit", "-m", "advance"], {
    stdio: "ignore",
  });
  const receiptPath = join(root, "branch-receipt.json");

  const failing = await startTestServer();
  try {
    const card = await failing.client.createCard({
      mate: "cleo",
      title: "Fresh board card 1, missing base",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });
    assert.equal(card.id, "1");
    const config = makeConfig(root, repoDir, {
      repos: {
        demo: {
          path: repoDir,
          baseBranch: "no-such-branch",
          delivery: "direct-pr",
        },
      },
    });
    await runLoop(failing.client, config, { once: true });
  } finally {
    await failing.stop();
  }
  const afterFailure = execFileSync("git", ["-C", repoDir, "rev-parse", retained], {
    encoding: "utf8",
  }).trim();
  assert.equal(
    afterFailure,
    retainedSha,
    "a failed attempt must not delete a branch it never created",
  );

  const succeeding = await startTestServer();
  try {
    await succeeding.client.createCard({
      mate: "cleo",
      title: "Fresh board card 1, healthy",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });
    const config = makeConfig(root, repoDir, {
      spawn: {
        mode: "local",
        viewport: "headless",
        direnv: false,
        command: [
          "node",
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(receiptPath)}, process.env.FLEET_BRANCH)`,
        ],
      },
    });
    await runLoop(succeeding.client, config, { once: true });
  } finally {
    await succeeding.stop();
  }
  const used = readFileSync(receiptPath, "utf8");
  assert.notEqual(used, retained, "the new attempt takes its own branch");
  assert.ok(used.startsWith(`${retained}-`));
  const afterSuccess = execFileSync("git", ["-C", repoDir, "rev-parse", retained], {
    encoding: "utf8",
  }).trim();
  assert.equal(afterSuccess, retainedSha, "the earlier branch keeps its commit");
});

async function runOneCard(root: string, repoDir: string, receiptPath: string): Promise<void> {
  const config = makeConfig(root, repoDir, {
    spawn: {
      mode: "local",
      viewport: "headless",
      direnv: false,
      command: [
        "node",
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(receiptPath)}, process.env.FLEET_BRANCH)`,
      ],
    },
  });
  const board = await startTestServer();
  try {
    await board.client.createCard({
      mate: "cleo",
      title: "Namespace conflict card",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });
    await runLoop(board.client, config, { once: true });
  } finally {
    await board.stop();
  }
}

void test("a branch name blocked by a ref namespace conflict takes a suffix, while a Git lock failure does not", async () => {
  const conflictRoot = makeTempDir("fleet-v3-namespace-");
  const conflictRepo = initGitRepo(conflictRoot);
  const conflictReceipt = join(conflictRoot, "receipt.txt");
  execFileSync("git", ["-C", conflictRepo, "branch", "c-1-a1/topic"]);
  await runOneCard(conflictRoot, conflictRepo, conflictReceipt);
  assert.match(readFileSync(conflictReceipt, "utf8"), /^c-1-a1-[a-zA-Z0-9]{6}$/u);

  const lockRoot = makeTempDir("fleet-v3-lock-");
  const lockRepo = initGitRepo(lockRoot);
  const lockReceipt = join(lockRoot, "receipt.txt");
  execFileSync("git", ["-C", lockRepo, "branch", "c-1-a1/topic"]);
  writeFileSync(join(lockRepo, ".git", "refs", "heads", "c-1-a1.lock"), "");
  await runOneCard(lockRoot, lockRepo, lockReceipt);
  assert.equal(existsSync(lockReceipt), false, "a Git lock failure must not start a worker");
  const branches = execFileSync("git", ["-C", lockRepo, "branch", "--list", "c-*"], {
    encoding: "utf8",
  });
  assert.equal(
    branches.trim(),
    "c-1-a1/topic",
    "a Git lock failure must not be hidden behind a suffix",
  );
});

void test("runner processes on different repos sharing a checkout root never take one checkout name, even before the path exists", async () => {
  const root = makeTempDir("fleet-v3-shared-root-");
  mkdirSync(join(root, "a"));
  mkdirSync(join(root, "b"));
  const repoA = initGitRepo(join(root, "a"));
  const repoB = initGitRepo(join(root, "b"));
  const holding = join(root, "a-holding");
  const release = join(root, "release");
  const hook = join(repoA, ".git", "hooks", "reference-transaction");
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      '[ "$1" = prepared ] || exit 0',
      "grep -q ' refs/heads/c-1-a1$' || exit 0",
      `touch ${JSON.stringify(holding)}`,
      `while [ ! -e ${JSON.stringify(release)} ]; do sleep 0.05; done`,
      "",
    ].join("\n"),
  );
  chmodSync(hook, 0o755);

  const boardA = await startTestServer();
  const boardB = await startTestServer();
  const children: ChildProcess[] = [];
  const runners: Promise<number | null>[] = [];
  try {
    const startRunner = (
      name: string,
      board: typeof boardA,
      repoDir: string,
    ): { readonly receipt: string; readonly exited: Promise<number | null> } => {
      const receipt = join(root, `${name}.branch`);
      const configPath = join(root, `${name}.yaml`);
      const writeReceipt = `require("node:fs").writeFileSync(${JSON.stringify(receipt)}, process.env.FLEET_BRANCH)`;
      const config = makeConfig(root, repoDir, {
        boardUrl: board.url,
        spawn: {
          mode: "local",
          viewport: "headless",
          direnv: false,
          command: ["node", "-e", writeReceipt],
        },
      });
      writeFileSync(configPath, JSON.stringify(config));
      const child = spawn(process.execPath, [BIN_PATH, "run", "--once", "--config", configPath], {
        stdio: "ignore",
      });
      const exited = new Promise<number | null>((resolve) => {
        child.once("close", resolve);
      });
      children.push(child);
      runners.push(exited);
      return { receipt, exited };
    };

    for (const board of [boardA, boardB]) {
      await board.client.createCard({
        mate: "cleo",
        title: "Card one on its own board",
        host: "test-host",
        project: "demo",
        delivery: "direct-pr",
      });
    }

    const first = startRunner("a", boardA, repoA);
    assert.ok(await waitFor(() => existsSync(holding), 15_000), "runner A reached branch setup");
    assert.equal(
      existsSync(join(root, "workspaces", "cleo", "demo", "worktrees", "c-1-a1")),
      false,
      "the checkout path does not exist while runner A holds its name",
    );

    const second = startRunner("b", boardB, repoB);
    assert.equal(
      await within(second.exited, 20_000),
      0,
      "runner B finishes without waiting for runner A's reservation",
    );
    assert.match(readFileSync(second.receipt, "utf8"), /^c-1-a1-[a-zA-Z0-9]{6}$/u);
    const refsInB = execFileSync("git", ["-C", repoB, "branch", "--list", "c-1-a1"], {
      encoding: "utf8",
    });
    assert.equal(refsInB.trim(), "", "runner B never took the canonical name in its own repo");

    writeFileSync(release, "");
    assert.equal(await within(first.exited, 20_000), 0, "runner A finishes once released");
    assert.equal(readFileSync(first.receipt, "utf8"), "c-1-a1");
    assert.equal(await cardField(boardA.client, "1", "state"), "done");
    assert.equal(await cardField(boardB.client, "1", "state"), "done");
  } finally {
    writeFileSync(release, "");
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(runners);
    await boardA.stop();
    await boardB.stop();
  }
});

void test("a checkout another repo creates at the reserved path survives this attempt's failed worktree add", async () => {
  const root = makeTempDir("fleet-v3-late-occupant-");
  mkdirSync(join(root, "a"));
  mkdirSync(join(root, "b"));
  const repoA = initGitRepo(join(root, "a"));
  const repoB = initGitRepo(join(root, "b"));
  const occupied = join(root, "workspaces", "cleo", "demo", "worktrees", "c-1-a1");
  const hook = join(repoA, ".git", "hooks", "reference-transaction");
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      '[ "$1" = prepared ] || exit 0',
      "grep -q ' refs/heads/c-1-a1$' || exit 0",
      `[ ! -e ${JSON.stringify(occupied)} ] || exit 0`,
      `env -i PATH="$PATH" HOME="$HOME" git -C ${JSON.stringify(repoB)} worktree add -q -b other ${JSON.stringify(occupied)}`,
      `echo uncommitted > ${JSON.stringify(join(occupied, "dirty.txt"))}`,
      "",
    ].join("\n"),
  );
  chmodSync(hook, 0o755);

  const board = await startTestServer();
  try {
    await board.client.createCard({
      mate: "cleo",
      title: "Late occupant card",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });
    await runLoop(board.client, makeConfig(root, repoA), { once: true });
  } finally {
    await board.stop();
  }

  assert.equal(readFileSync(join(occupied, "dirty.txt"), "utf8"), "uncommitted\n");
  assert.ok(existsSync(join(occupied, "README.md")), "the other repo's checkout is intact");
  const worktreesOfB = execFileSync("git", ["-C", repoB, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  });
  assert.ok(worktreesOfB.includes("refs/heads/other"));
  const branchesOfA = execFileSync("git", ["-C", repoA, "branch", "--list", "c-*"], {
    encoding: "utf8",
  });
  assert.equal(branchesOfA.trim(), "", "the failed attempt's own branch is removed");
});

void test("runners on one host serving different boards never share a checkout, scratch directory, or branch", async () => {
  const root = makeTempDir("fleet-v3-shared-host-");
  const repoDir = initGitRepo(root);
  const receiptDir = join(root, "receipts");
  mkdirSync(receiptDir);
  const boardA = await startTestServer();
  const boardB = await startTestServer();

  try {
    for (const board of [boardA, boardB]) {
      const card = await board.client.createCard({
        mate: "cleo",
        title: "Card one on its own board",
        host: "test-host",
        project: "demo",
        delivery: "direct-pr",
      });
      assert.equal(card.id, "1");
    }
    const workerScript = `
      const fs = require("node:fs");
      const marker = ${JSON.stringify(receiptDir)} + "/" + process.env.BOARD_URL.split(":").pop();
      const head = () => require("node:child_process")
        .execFileSync("git", ["-C", process.env.FLEET_WORKTREE, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" })
        .trim();
      fs.writeFileSync(marker + ".start", JSON.stringify({
        worktree: process.env.FLEET_WORKTREE,
        branch: process.env.FLEET_BRANCH,
        tmp: process.env.TMPDIR,
        head: head(),
      }));
      setTimeout(() => {
        fs.writeFileSync(marker + ".end", JSON.stringify({
          worktree: fs.existsSync(process.env.FLEET_WORKTREE),
          tmp: fs.existsSync(process.env.TMPDIR),
          head: head(),
        }));
      }, 1200);
    `;
    const configFor = (board: typeof boardA): RunnerConfig =>
      makeConfig(root, repoDir, {
        boardUrl: board.url,
        spawn: {
          mode: "local",
          viewport: "headless",
          direnv: false,
          command: ["node", "-e", workerScript],
        },
      });

    await Promise.all([
      runLoop(boardA.client, configFor(boardA), { once: true }),
      runLoop(boardB.client, configFor(boardB), { once: true }),
    ]);

    const read = (name: string): unknown =>
      JSON.parse(readFileSync(join(receiptDir, name), "utf8"));
    const Start = z.object({
      worktree: z.string(),
      branch: z.string(),
      tmp: z.string(),
      head: z.string(),
    });
    const End = z.object({
      worktree: z.boolean(),
      tmp: z.boolean(),
      head: z.string(),
    });
    const portA = new URL(boardA.url).port;
    const portB = new URL(boardB.url).port;
    const startA = Start.parse(read(`${portA}.start`));
    const startB = Start.parse(read(`${portB}.start`));
    assert.notEqual(startA.worktree, startB.worktree);
    const branches = [startA.branch, startB.branch].toSorted();
    assert.equal(branches[0], "c-1-a1");
    assert.match(branches[1] ?? "", /^c-1-a1-[a-zA-Z0-9]{6}$/u);
    assert.notEqual(startA.tmp, startB.tmp);
    assert.equal(startA.head, startA.branch);
    assert.equal(startB.head, startB.branch);
    assert.deepEqual(End.parse(read(`${portA}.end`)), {
      worktree: true,
      tmp: true,
      head: startA.branch,
    });
    assert.deepEqual(End.parse(read(`${portB}.end`)), {
      worktree: true,
      tmp: true,
      head: startB.branch,
    });
    assert.equal(await cardField(boardA.client, "1", "state"), "done");
    assert.equal(await cardField(boardB.client, "1", "state"), "done");
  } finally {
    await boardA.stop();
    await boardB.stop();
  }
});
