import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, test } from "node:test";
import type { BoardClient } from "../src/board/client.ts";
import { runFleetCli } from "../src/cli.ts";
import type { RunnerConfig } from "../src/config.ts";
import { runLoop } from "../src/runner/loop.ts";
import { startTestServer, waitFor } from "./support.ts";

const PR_URL = "https://github.com/acme/demo/pull/7";
const GREEN = [{ status: "COMPLETED", conclusion: "SUCCESS" }];
const tempDirs: string[] = [];
delete process.env["FLEET_CLAIM_EPOCH"];
delete process.env["FLEET_CLAIM_TOKEN"];
const savedEnv = { ...process.env };

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function pullRequest(state: string, checks: readonly object[] = GREEN): string {
  return JSON.stringify({ url: PR_URL, state, statusCheckRollup: checks });
}

function installFakeGh(root: string): string {
  const bin = join(root, "bin");
  const log = join(root, "gh.log");
  mkdirSync(bin);
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
if (args[1] === "list") process.stdout.write("[" + (process.env.FAKE_GH_PR ?? "") + "]");
if (args[1] === "view") {
  const pr = JSON.parse(process.env.FAKE_GH_PR ?? "{}");
  process.stdout.write(args.includes("--jq") ? String(pr.state) : JSON.stringify(pr));
}
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  process.env["PATH"] = `${bin}${delimiter}${savedEnv["PATH"] ?? ""}`;
  return log;
}

function initGitRepo(root: string): string {
  const repoDir = join(root, "demo-repo");
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Fleet Test"]);
  writeFileSync(join(repoDir, "README.md"), "# demo\n");
  execFileSync("git", ["-C", repoDir, "add", "README.md"]);
  execFileSync("git", ["-C", repoDir, "commit", "-m", "init"], { stdio: "ignore" });
  mkdirSync(join(root, "projects", "demo"), { recursive: true });
  execFileSync("git", ["clone", "--no-local", repoDir, join(root, "projects", "demo", "repo")], {
    stdio: "ignore",
  });
  return repoDir;
}

function makeConfig(root: string, repoDir: string, boardUrl: string, yolo: boolean): RunnerConfig {
  return {
    host: "test-host",
    boardUrl,
    matesFilter: [],
    workspacesRoot: join(root, "workspaces"),
    projectsRoot: join(root, "projects"),
    concurrency: 1,
    leaseSeconds: 60,
    idleTimeoutSeconds: 10,
    maxWallSeconds: 30,
    maxAttempts: 3,
    maxReviewRounds: 4,
    pollWaitSeconds: 1,
    prPollSeconds: 1,
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
    repos: { demo: { remote: repoDir, baseBranch: "main", delivery: "direct-pr", yolo } },
  };
}

async function stateOf(client: BoardClient, id: string): Promise<string> {
  const thread = await client.getThread(id);
  return thread.card.state;
}

async function captureCli(
  argv: string[],
  boardUrl: string,
): Promise<{ readonly out: string; readonly exitCode: number }> {
  let out = "";
  const prevCode = process.exitCode;
  process.exitCode = 0;
  try {
    await runFleetCli({
      argv,
      boardUrl,
      actor: "captain",
      stdout: {
        write(chunk: string) {
          out += chunk;
          return true;
        },
      },
    });
    return { out, exitCode: typeof process.exitCode === "number" ? process.exitCode : 0 };
  } finally {
    process.exitCode = prevCode;
  }
}

afterEach(() => {
  process.env["PATH"] = savedEnv["PATH"];
  delete process.env["FAKE_GH_PR"];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

void test("a PR card is held for the captain, refuses Done until merged, and closes itself on a verified merge", async () => {
  const root = makeTempDir("fleet-v3-merge-gate-");
  const log = installFakeGh(root);
  const repoDir = initGitRepo(root);
  const server = await startTestServer({ parents: { cleo: "captain" } });
  const { client } = server;

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Ship the demo change",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });
    process.env["FAKE_GH_PR"] = pullRequest("OPEN");
    await runLoop(client, makeConfig(root, repoDir, server.url, false), { once: true });

    const held = await client.getThread(card.id);
    assert.equal(held.card.state, "held");
    assert.equal(held.card.holder, "captain", "the merge question routes up to the captain");
    assert.equal(held.card.pr, PR_URL);
    const question = held.entries.at(-1);
    assert.equal(question?.kind, "escalation");
    assert.match(question?.text ?? "", /merge/u);
    assert.match(question?.text ?? "", /changes/u);
    assert.match(question?.text ?? "", /close PR/u);
    const needsCaptain = await client.listCards({ holder: "captain", state: "held" });
    assert.deepEqual(
      needsCaptain.cards.map((each) => each.id),
      [card.id],
    );

    const refused = await captureCli(["close", card.id, "--result", "done"], server.url);
    assert.notEqual(refused.exitCode, 0);
    assert.match(refused.out, /unmerged PR/u);
    assert.equal(await stateOf(client, card.id), "held");

    await client.answerCard(card.id, { text: "changes: rename the helper", actor: "captain" });
    const reworked = await client.getThread(card.id);
    assert.equal(reworked.card.holder, "cleo", "request changes returns the card to its mate");
    await client.queueCard(card.id, { actor: "cleo" });
    await runLoop(client, makeConfig(root, repoDir, server.url, false), { once: true });
    const second = await client.getThread(card.id);
    assert.equal(second.card.state, "held");
    assert.equal(second.card.holder, "captain", "the reworked PR returns to the captain");

    await client.answerCard(card.id, { text: "merge", actor: "captain" });
    process.env["FAKE_GH_PR"] = pullRequest("MERGED");
    const controller = new AbortController();
    const loop = runLoop(client, makeConfig(root, repoDir, server.url, false), {
      signal: controller.signal,
    });
    const closed = await waitFor(async () => (await stateOf(client, card.id)) === "done");
    controller.abort();
    await loop;
    assert.equal(closed, true, "a verified merge closes the card automatically");
    const closedThread = await client.getThread(card.id);
    assert.match(closedThread.card.result, /PR merged/u);
    assert.match(readFileSync(log, "utf8"), /pr view/u);
  } finally {
    await server.stop();
  }
});

void test("closing the PR needs the captain's words, closes it on GitHub, and ends the card as not landed", async () => {
  const root = makeTempDir("fleet-v3-merge-gate-");
  const log = installFakeGh(root);
  const repoDir = initGitRepo(root);
  const server = await startTestServer();
  const { client } = server;

  try {
    const card = await client.createCard({
      mate: "cleo",
      title: "Experimental change",
      host: "test-host",
      project: "demo",
      delivery: "direct-pr",
    });
    process.env["FAKE_GH_PR"] = pullRequest("OPEN");
    await runLoop(client, makeConfig(root, repoDir, server.url, false), { once: true });

    const withoutWords = await captureCli(
      ["cancel", card.id, "--reason", "not wanted"],
      server.url,
    );
    assert.notEqual(withoutWords.exitCode, 0);
    assert.match(withoutWords.out, /captain's words/u);
    assert.equal(await stateOf(client, card.id), "held");
    assert.doesNotMatch(readFileSync(log, "utf8"), /pr close/u);

    const dropped = await captureCli(
      ["cancel", card.id, "--reason", "not wanted", "--words", "drop it, we do not need this"],
      server.url,
    );
    assert.equal(dropped.exitCode, 0);
    const thread = await client.getThread(card.id);
    assert.equal(thread.card.state, "canceled");
    assert.equal(thread.card.result, "not wanted");
    assert.match(thread.entries.at(-1)?.text ?? "", /drop it, we do not need this/u);
    assert.match(readFileSync(log, "utf8"), /pr close/u);
  } finally {
    await server.stop();
  }
});

void test("yolo routes only a green PR to the mate; a red PR still goes to the captain", async () => {
  const root = makeTempDir("fleet-v3-merge-gate-");
  installFakeGh(root);
  const repoDir = initGitRepo(root);
  const server = await startTestServer();
  const { client } = server;

  try {
    const create = (title: string): Promise<{ readonly id: string }> =>
      client.createCard({
        mate: "cleo",
        title,
        host: "test-host",
        project: "demo",
        delivery: "direct-pr",
      });
    const green = await create("Green change");
    process.env["FAKE_GH_PR"] = pullRequest("OPEN", GREEN);
    await runLoop(client, makeConfig(root, repoDir, server.url, true), { once: true });
    const greenThread = await client.getThread(green.id);
    assert.equal(greenThread.card.holder, "cleo");
    assert.match(
      greenThread.entries.at(-1)?.text ?? "",
      /destructive, irreversible, or security-sensitive/u,
    );

    const red = await create("Red change");
    process.env["FAKE_GH_PR"] = pullRequest("OPEN", [
      { status: "COMPLETED", conclusion: "FAILURE" },
    ]);
    await runLoop(client, makeConfig(root, repoDir, server.url, true), { once: true });
    const redThread = await client.getThread(red.id);
    assert.equal(redThread.card.holder, "captain");
  } finally {
    await server.stop();
  }
});
