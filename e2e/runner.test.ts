import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { z } from "zod";
import type { RunnerConfig } from "../src/config.ts";
import { runLoop } from "../src/runner/loop.ts";
import { buildWorkerArgv } from "../src/runner/spawn.ts";

const WorkerReceiptSchema = z.object({
  task: z.string(),
  cwd: z.string(),
  worktree: z.string(),
  branch: z.string(),
  prompt: z.string(),
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
    from: [],
    channels: ["cleo"],
    metaChannel: "meta",
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

void test("claims ready task, runs isolated worktree worker, advertises host, completes, and cleans up", async () => {
  const root = makeTempDir("fleet-v3-e2e-");
  const repoDir = initGitRepo(root);
  const receiptPath = join(root, "worker-receipt.json");
  const backend = local({ memory: true });
  const client = board({ backend });

  try {
    const { task } = await client.tasks.create("cleo", {
      text: "Implement demo change",
      labels: { host: "test-host", project: "demo", delivery: "direct-pr" },
    });

    const workerScript = `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({
        task: process.env.BOARD_TASK,
        cwd: process.cwd(),
        worktree: process.env.FLEET_WORKTREE,
        branch: process.env.FLEET_BRANCH,
        prompt: process.env.FLEET_PROMPT,
      }));
    `;

    const me = await client.me();
    const config = makeConfig(root, repoDir, {
      from: [me.principal],
      spawn: {
        mode: "local",
        viewport: "headless",
        direnv: false,
        command: ["node", "-e", workerScript],
      },
    });

    const handled = await runLoop(client.as("runner-test-host"), config, { once: true });
    assert.equal(handled, 1);

    const receipt = WorkerReceiptSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8")));
    assert.equal(receipt.task, task.id);
    assert.equal(receipt.branch, `fleet/t-${task.id}`);
    assert.notEqual(receipt.worktree, repoDir);
    assert.equal(existsSync(receipt.worktree), false);

    const thread = await client.thread(task.id);
    assert.equal(thread.message.task?.state, "completed");

    const meta = await client.channel("meta").messages();
    const hostPost = meta.messages.find((msg) => msg.labels["kind"] === "host");
    assert.ok(hostPost !== undefined);
    assert.match(hostPost.text, /host=test-host.*repos=demo/u);
  } finally {
    await backend.close();
  }
});

void test("caps no-mistakes verification at 4 rounds and hands back without force-shipping", async () => {
  const root = makeTempDir("fleet-v3-e2e-");
  const repoDir = initGitRepo(root);
  const roundsLog = join(root, "rounds.log");
  const backend = local({ memory: true });
  const client = board({ backend });

  try {
    const { task } = await client.tasks.create("cleo", {
      text: "Change that never converges in review",
      labels: { host: "test-host", project: "demo", delivery: "no-mistakes" },
    });

    const failVerify = `
      const fs = require("node:fs");
      fs.appendFileSync(${JSON.stringify(roundsLog)}, process.env.FLEET_REVIEW_ROUND + "\\n");
      console.error("findings: reviewer raised another nitpick");
      process.exit(1);
    `;

    const me = await client.me();
    const config = makeConfig(root, repoDir, {
      from: [me.principal],
      maxReviewRounds: 4,
      verify: {
        command: ["node", "-e", failVerify],
        respondCommand: ["node", "-e", failVerify],
      },
    });

    const handled = await runLoop(client.as("runner-test-host"), config, { once: true });
    assert.equal(handled, 1);

    const rounds = readFileSync(roundsLog, "utf8").trim().split("\n");
    assert.deepEqual(rounds, ["1", "2", "3", "4"]);

    const thread = await client.thread(task.id);
    assert.equal(thread.message.task?.state, "failed");
    assert.ok(
      thread.replies.some((reply) => /stopped at round 4\/4/iu.test(reply.text)),
      "expected 4-round handback summary in thread",
    );
  } finally {
    await backend.close();
  }
});

void test("blocks task instead of crash-looping once claim epoch exceeds maxAttempts", async () => {
  const root = makeTempDir("fleet-v3-e2e-");
  const repoDir = initGitRepo(root);
  const ranMarker = join(root, "should-not-run");
  const backend = local({ memory: true });
  const client = board({ backend });

  try {
    const { task } = await client.tasks.create("cleo", {
      text: "Flaky task",
      labels: { host: "test-host", project: "demo" },
    });

    for (let i = 0; i < 3; i += 1) {
      const prior = await client.tasks.claim(task.id, { lease: 60 });
      await prior.release();
    }

    const me = await client.me();
    const config = makeConfig(root, repoDir, {
      from: [me.principal],
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

    await runLoop(client.as("runner-test-host"), config, { once: true });

    assert.equal(existsSync(ranMarker), false);
    const thread = await client.thread(task.id);
    assert.equal(thread.message.task?.state, "blocked");
  } finally {
    await backend.close();
  }
});

void test("kills entire worker process group on idle timeout leaving no orphan grandchild", async () => {
  const root = makeTempDir("fleet-v3-e2e-");
  const repoDir = initGitRepo(root);
  const childPidFile = join(root, "grandchild.pid");
  const backend = local({ memory: true });
  const client = board({ backend });

  try {
    const { task } = await client.tasks.create("cleo", {
      text: "Hanging worker",
      labels: { host: "test-host", project: "demo" },
    });

    const hangScript = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const grand = spawn("sleep", ["60"], { stdio: "ignore" });
      fs.writeFileSync(${JSON.stringify(childPidFile)}, String(grand.pid));
      setInterval(() => {}, 10000);
    `;

    const me = await client.me();
    const config = makeConfig(root, repoDir, {
      from: [me.principal],
      idleTimeoutSeconds: 1,
      maxWallSeconds: 5,
      spawn: {
        mode: "local",
        viewport: "headless",
        direnv: false,
        command: ["node", "-e", hangScript],
      },
    });

    await runLoop(client.as("runner-test-host"), config, { once: true });

    const thread = await client.thread(task.id);
    assert.equal(thread.message.task?.state, "failed");

    const grandchildPid = Number(readFileSync(childPidFile, "utf8").trim());
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" });
  } finally {
    await backend.close();
  }
});

function isCommandAvailable(bin: string, args: readonly string[]): boolean {
  try {
    execFileSync(bin, [...args], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

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
        command: ["ypi", "--print", "task {task}"],
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
      env: { BOARD_TASK: "42" },
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
    assert.ok(argv.includes("BOARD_TASK=42"));
    assert.equal(argv.at(-1), "task 42");
  } finally {
    if (prevSecret === undefined) delete process.env["FLEET_TEST_SECRET"];
    else process.env["FLEET_TEST_SECRET"] = prevSecret;
  }
});

void test("runs real isolated task inside Apple container micro-VM with worktree gitCommonDir and inherited env", async (t) => {
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

  const backend = local({ memory: true });
  const client = board({ backend });

  try {
    const { task } = await client.tasks.create("cleo", {
      text: "Verify container worker isolation",
      labels: { host: "test-host", project: "demo", delivery: "direct-pr" },
    });

    const script = [
      "set -eu",
      'gitdir=$(sed "s/^gitdir: //" .git)',
      'test -f "$gitdir/HEAD"',
      'printf "%s|%s|%s|%s" "$BOARD_TASK" "$FLEET_E2E_INHERITED" "$(cat /run/secret.txt)" "$(cat "$gitdir/HEAD")" > "$FLEET_E2E_OUT"',
    ].join("; ");

    const me = await client.me();
    const config = makeConfig(root, repoDir, {
      from: [me.principal],
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

    const handled = await runLoop(client.as("runner-test-host"), config, { once: true });
    assert.equal(handled, 1);

    const thread = await client.thread(task.id);
    assert.equal(
      thread.message.task?.state,
      "completed",
      thread.replies.map((reply) => reply.text).join("\n---\n"),
    );

    const observed = readFileSync(hostOutPath, "utf8").trim();
    assert.equal(
      observed,
      `${task.id}|inherited-ok|cred-payload|ref: refs/heads/fleet/t-${task.id}`,
    );
  } finally {
    if (prevInherited === undefined) delete process.env["FLEET_E2E_INHERITED"];
    else process.env["FLEET_E2E_INHERITED"] = prevInherited;
    await backend.close();
  }
});

const HerdrPaneEntrySchema = z.object({ pane_id: z.string() });
const HerdrPaneListResultSchema = z.object({ panes: z.array(HerdrPaneEntrySchema) });
const HerdrPaneListSchema = z.object({ result: HerdrPaneListResultSchema });

function tryExecSilent(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

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

  const backend = local({ memory: true });
  const client = board({ backend });

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

    const me = await client.me();
    const okTask = await client.tasks.create("cleo", {
      text: "Run inside herdr pane and succeed",
      labels: { host: "test-host", project: "demo", delivery: "direct-pr" },
    });

    const okScript = `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({
        task: process.env.BOARD_TASK,
        tty: Boolean(process.stdout.isTTY),
      }));
    `;

    const baseHerdrSpawn = {
      mode: "local" as const,
      viewport: "herdr" as const,
      direnv: false,
      herdr: {
        workspace: "fleet",
        session: sessionName,
        keepPane: "on-failure" as const,
      },
    };

    const okConfig = makeConfig(root, repoDir, {
      from: [me.principal],
      spawn: { ...baseHerdrSpawn, command: ["node", "-e", okScript] },
    });

    const handledOk = await runLoop(client.as("runner-test-host"), okConfig, { once: true });
    assert.equal(handledOk, 1);

    const okThread = await client.thread(okTask.task.id);
    assert.equal(okThread.message.task?.state, "completed");
    assert.ok(
      okThread.replies.some((reply) => /herdr w\d+:p\d+/u.test(reply.text)),
      "expected herdr pane ID in claim reply",
    );

    const receipt = z
      .object({ task: z.string(), tty: z.boolean() })
      .parse(JSON.parse(readFileSync(receiptPath, "utf8")));
    assert.equal(receipt.task, okTask.task.id);
    assert.equal(receipt.tty, true, "herdr pane must provide a live TTY");

    const panesAfterSuccess = HerdrPaneListSchema.parse(JSON.parse(herdrExec("pane", "list")));
    assert.equal(
      panesAfterSuccess.result.panes.length,
      0,
      "keepPane: on-failure must close pane after success",
    );

    const failTask = await client.tasks.create("cleo", {
      text: "Run inside herdr pane and fail",
      labels: { host: "test-host", project: "demo", delivery: "direct-pr" },
    });

    const failConfig = makeConfig(root, repoDir, {
      from: [me.principal],
      spawn: {
        ...baseHerdrSpawn,
        command: ["node", "-e", "console.error('boom'); process.exit(2);"],
      },
    });

    const handledFail = await runLoop(client.as("runner-test-host"), failConfig, { once: true });
    assert.equal(handledFail, 1);

    const failThread = await client.thread(failTask.task.id);
    assert.equal(failThread.message.task?.state, "failed");

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
    await backend.close();
  }
});
