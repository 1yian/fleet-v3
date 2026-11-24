import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { z } from "zod";
import { createHttpBoardClient, createLocalBoardClient } from "../src/board/client.ts";
import { startBoardServer } from "../src/board/server.ts";
import { CardStore } from "../src/board/store.ts";
import type { RunnerConfig } from "../src/config.ts";
import { runLoop } from "../src/runner/loop.ts";
import { buildWorkerArgv } from "../src/runner/spawn.ts";

const WorkerReceiptSchema = z.object({
  card: z.string(),
  cwd: z.string(),
  worktree: z.string(),
  branch: z.string(),
  prompt: z.string(),
});

const HerdrReceiptSchema = z.object({
  card: z.string(),
  tty: z.boolean(),
});

const HerdrPaneEntrySchema = z.object({ pane_id: z.string() });
const HerdrPaneListResultSchema = z.object({ panes: z.array(HerdrPaneEntrySchema) });
const HerdrPaneListSchema = z.object({ result: HerdrPaneListResultSchema });

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
  execFileSync("git", ["-C", repoDir, "commit", "-m", "init"], { stdio: "ignore" });
  return repoDir;
}

function makeConfig(
  root: string,
  repoDir: string,
  overrides: Partial<RunnerConfig> = {},
): RunnerConfig {
  return {
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
  const store = new CardStore({ memory: true });
  const client = createLocalBoardClient(store);

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Implement demo change",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });

    const workerScript = `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({
        card: process.env.FLEET_CARD,
        cwd: process.cwd(),
        worktree: process.env.FLEET_WORKTREE,
        branch: process.env.FLEET_BRANCH,
        prompt: process.env.FLEET_PROMPT,
      }));
    `;

    const config = makeConfig(root, repoDir, {
      spawn: {
        mode: "local",
        viewport: "headless",
        direnv: false,
        command: ["node", "-e", workerScript],
      },
    });

    const handled = await runLoop(client, config, { once: true });
    assert.equal(handled, 1);

    const receipt = WorkerReceiptSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8")));
    assert.equal(receipt.card, card.id);
    assert.equal(receipt.branch, `fleet/t-${card.id}`);
    assert.notEqual(receipt.worktree, repoDir);
    assert.equal(existsSync(receipt.worktree), false);

    const thread = await client.getThread(card.id);
    assert.equal(thread.card.state, "done");

    const hosts = await client.listHosts();
    const advertised = hosts.find((each) => each.host === "test-host");
    assert.ok(advertised !== undefined);
    assert.deepEqual(advertised.repos, ["demo"]);
  } finally {
    store.close();
  }
});

void test("preserves mate handoff when a stuck worker hands the card back before exiting 0", async () => {
  const root = makeTempDir("fleet-v3-handoff-");
  const repoDir = initGitRepo(root);
  const store = new CardStore({ memory: true });
  const started = await startBoardServer({
    store,
    host: "127.0.0.1",
    port: 0,
    chaseIntervalMs: 0,
  });
  const client = createHttpBoardClient(started.url);

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Need missing API key",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });

    const workerScript = `
      fetch(process.env.BOARD_URL + "/api/cards/" + process.env.FLEET_CARD + "/handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Missing API key; returning to mate", actor: "worker" }),
      }).then(() => process.exit(0));
    `;

    const config = makeConfig(root, repoDir, {
      boardUrl: started.url,
      spawn: {
        mode: "local",
        viewport: "headless",
        direnv: false,
        command: ["node", "-e", workerScript],
      },
    });

    const handled = await runLoop(client, config, { once: true });
    assert.equal(handled, 1);

    const thread = await client.getThread(card.id);
    assert.equal(thread.card.state, "held", "must not overwrite worker handoff with done");
    assert.equal(thread.card.holder, "cleo");
  } finally {
    await started.stop();
    store.close();
  }
});

void test("caps no-mistakes verification at 4 rounds and hands back to mate without force-shipping", async () => {
  const root = makeTempDir("fleet-v3-e2e-");
  const repoDir = initGitRepo(root);
  const roundsLog = join(root, "rounds.log");
  const store = new CardStore({ memory: true });
  const client = createLocalBoardClient(store);

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
    store.close();
  }
});

void test("returns card to mate instead of crash-looping once claim epoch exceeds maxAttempts", async () => {
  const root = makeTempDir("fleet-v3-e2e-");
  const repoDir = initGitRepo(root);
  const ranMarker = join(root, "should-not-run");
  const store = new CardStore({ memory: true });
  const client = createLocalBoardClient(store);

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Flaky card",
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
      await client.releaseClaim(card.id, { epoch: prior.epoch, token: prior.token });
    }

    const config = makeConfig(root, repoDir, {
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

    await runLoop(client, config, { once: true });

    assert.equal(existsSync(ranMarker), false);
    const thread = await client.getThread(card.id);
    assert.equal(thread.card.state, "held");
    assert.equal(thread.card.holder, "cleo");
    assert.equal(thread.card.labels["return_kind"], "retry_cap");
  } finally {
    store.close();
  }
});

void test("kills entire worker process group on idle timeout leaving no orphan grandchild", async () => {
  const root = makeTempDir("fleet-v3-e2e-");
  const repoDir = initGitRepo(root);
  const childPidFile = join(root, "grandchild.pid");
  const store = new CardStore({ memory: true });
  const client = createLocalBoardClient(store);

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
    store.close();
  }
});

void test("builds container and docker worker argv with gitCommonDir, expanded mounts, inherited env, ssh, and tty", () => {
  const root = makeTempDir("fleet-v3-argv-");
  const repoDir = initGitRepo(root);
  const prevSecret = process.env["FLEET_TEST_SECRET"];
  process.env["FLEET_TEST_SECRET"] = "top-secret-token";

  try {
    const containerCfg = makeConfig(root, repoDir, {
      spawn: {
        mode: "container",
        viewport: "herdr",
        direnv: false,
        command: ["ypi", "--auto-exit", "card {card}"],
        container: {
          image: "fleet-worker:latest",
          ssh: true,
          cpus: 4,
          memory: "8G",
          inheritEnv: ["FLEET_TEST_SECRET"],
          mounts: ["~/.pi/agent/auth.json:/root/.pi/agent/auth.json:ro"],
          extraArgs: [],
        },
      },
    });

    const argv = buildWorkerArgv({
      config: containerCfg,
      taskId: "42",
      worktreePath: "/tmp/wt/t-42",
      gitCommonDir: "/tmp/repo/.git",
      tmpDir: "/tmp/tmp/t-42",
      promptPath: "/tmp/worker.md",
      env: { FLEET_CARD: "42" },
      tty: true,
      containerName: "fleet-mac-t-42-a1-abcd",
    });

    assert.equal(argv[0], "container");
    assert.ok(argv.includes("-i"));
    assert.ok(argv.includes("-t"));
    assert.ok(argv.includes("--ssh"));
    assert.ok(argv.includes("fleet-mac-t-42-a1-abcd"));
    assert.ok(argv.includes("/tmp/repo/.git:/tmp/repo/.git"));
    const expectedAuthMount = `${join(homedir(), ".pi/agent/auth.json")}:/root/.pi/agent/auth.json:ro`;
    assert.ok(argv.includes(expectedAuthMount));
    assert.ok(argv.includes("FLEET_TEST_SECRET=top-secret-token"));
    assert.ok(argv.includes("FLEET_CARD=42"));
    assert.equal(argv.at(-1), "card 42");
  } finally {
    if (prevSecret === undefined) delete process.env["FLEET_TEST_SECRET"];
    else process.env["FLEET_TEST_SECRET"] = prevSecret;
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

  const store = new CardStore({ memory: true });
  const client = createLocalBoardClient(store);

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
    assert.equal(
      observed,
      `${card.id}|inherited-ok|cred-payload|ref: refs/heads/fleet/t-${card.id}`,
    );
  } finally {
    if (prevInherited === undefined) delete process.env["FLEET_E2E_INHERITED"];
    else process.env["FLEET_E2E_INHERITED"] = prevInherited;
    store.close();
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
  const server = spawn("herdr", ["--session", sessionName, "server"], { stdio: "ignore" });
  const herdrExec = (...args: readonly string[]): string =>
    execFileSync("herdr", ["--session", sessionName, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });

  const store = new CardStore({ memory: true });
  const client = createLocalBoardClient(store);

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
        workspace: "workers",
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
      title: "Run inside herdr pane and fail",
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
  } finally {
    tryExecSilent(() => {
      herdrExec("server", "stop");
    });
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    tryExecSilent(() => {
      execFileSync("herdr", ["session", "delete", sessionName], { stdio: "ignore", timeout: 5000 });
    });
    store.close();
  }
});
