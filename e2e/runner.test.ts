import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import type { RunnerConfig } from "../src/config.ts";
import { runLoop } from "../src/runner/loop.ts";

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

test("claims ready task, runs isolated worktree worker, advertises host, completes, and cleans up", async () => {
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
      spawn: { mode: "local", direnv: false, command: ["node", "-e", workerScript] },
    });

    const handled = await runLoop(client.as("runner-test-host"), config, { once: true });
    assert.equal(handled, 1);

    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, string>;
    assert.equal(receipt["task"], task.id);
    assert.equal(receipt["branch"], `fleet/t-${task.id}`);
    assert.ok(receipt["worktree"] !== undefined && receipt["worktree"] !== repoDir);
    assert.equal(existsSync(receipt["worktree"]), false);

    const thread = await client.thread(task.id);
    assert.equal(thread.message.task?.state, "completed");

    const meta = await client.channel("meta").messages();
    const hostPost = meta.messages.find((msg) => msg.labels["kind"] === "host");
    assert.ok(hostPost !== undefined);
    assert.match(hostPost.text, /host=test-host.*repos=demo/);
  } finally {
    await backend.close();
  }
});

test("caps no-mistakes verification at 4 rounds and hands back without force-shipping", async () => {
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
      thread.replies.some((reply) => /stopped at round 4\/4/i.test(reply.text)),
      "expected 4-round handback summary in thread",
    );
  } finally {
    await backend.close();
  }
});

test("blocks task instead of crash-looping once claim epoch exceeds maxAttempts", async () => {
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
        direnv: false,
        command: ["node", "-e", `require("node:fs").writeFileSync(${JSON.stringify(ranMarker)}, "1")`],
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

test("kills entire worker process group on idle timeout leaving no orphan grandchild", async () => {
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
      spawn: { mode: "local", direnv: false, command: ["node", "-e", hangScript] },
    });

    await runLoop(client.as("runner-test-host"), config, { once: true });

    const thread = await client.thread(task.id);
    assert.equal(thread.message.task?.state, "failed");

    const grandchildPid = Number(readFileSync(childPidFile, "utf8").trim());
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
    await new Promise((r) => setTimeout(r, 150));
    assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" });
  } finally {
    await backend.close();
  }
});
