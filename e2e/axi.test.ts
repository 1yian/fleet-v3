import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalBoardClient, type BoardClient } from "../src/board/client.ts";
import { CardStore } from "../src/board/store.ts";
import { runFleetCli } from "../src/cli.ts";
import { VERSION } from "../src/version.ts";

const BIN_PATH = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const tempDirs: string[] = [];

function execBin(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [BIN_PATH, ...args], { encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        reject(new Error(error.message, { cause: error }));
        return;
      }
      resolve(stdout);
    });
  });
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function captureCli(
  argv: string[],
  boardClient: BoardClient,
  actor = "captain",
): Promise<{ readonly out: string; readonly exitCode: number }> {
  let out = "";
  const prevCode = process.exitCode;
  process.exitCode = 0;
  try {
    await runFleetCli({
      argv,
      boardClient,
      boardUrl: "http://127.0.0.1:4100",
      actor,
      stdout: {
        write(chunk: string) {
          out += chunk;
          return true;
        },
      },
    });
    const code = typeof process.exitCode === "number" ? process.exitCode : 0;
    return { out, exitCode: code };
  } finally {
    process.exitCode = prevCode;
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

void test("fast-path --version / -v / -V prints bare version and exits 0", async () => {
  for (const flag of ["--version", "-v", "-V"]) {
    const stdout = await execBin([flag]);
    assert.equal(stdout.trim(), VERSION);
  }
});

void test("home view returns TOON live counts, hosts, open cards, and contextual help", async () => {
  const store = new CardStore({ memory: true, parents: { jarvis: "captain", cleo: "jarvis" } });
  const client = createLocalBoardClient(store);

  try {
    const empty = await captureCli([], client);
    assert.equal(empty.exitCode, 0);
    assert.match(empty.out, /counts: 0 open cards/u);
    assert.match(empty.out, /cards: 0 open cards/u);

    await client.advertiseHost({
      host: "p620",
      mode: "docker",
      viewport: "headless",
      repos: ["Cleo", "fleet-v3"],
    });
    const dispatched = await captureCli(
      [
        "dispatch",
        "--mate",
        "cleo",
        "--title",
        "Fix webhook timeout",
        "--project",
        "Cleo",
        "--host",
        "p620",
      ],
      client,
    );
    assert.equal(dispatched.exitCode, 0);
    assert.match(dispatched.out, /Fix webhook timeout/u);

    const home = await captureCli([], client);
    assert.equal(home.exitCode, 0);
    assert.match(home.out, /counts: 1 queued \(1 open total\)/u);
    assert.match(home.out, /p620,docker/u);
    assert.match(home.out, /Fix webhook timeout/u);
    assert.match(home.out, /fleet view <id>/u);
  } finally {
    store.close();
  }
});

void test("rejects unknown flags loudly on stdout with exit code 2 and inline help", async () => {
  const store = new CardStore({ memory: true });
  const client = createLocalBoardClient(store);

  try {
    const res = await captureCli(["cards", "--stat", "held"], client);
    assert.equal(res.exitCode, 2);
    assert.match(res.out, /unknown flag --stat/u);
    assert.match(res.out, /--state/u);
  } finally {
    store.close();
  }
});

void test("truncates long bodies in view by default and reveals full text with --full", async () => {
  const store = new CardStore({ memory: true });
  const client = createLocalBoardClient(store);

  try {
    const longBody = "A".repeat(900);
    const card = await client.createCard({
      mate: "cleo",
      title: "Long card",
      body: longBody,
    });

    const truncated = await captureCli(["view", card.id], client);
    assert.equal(truncated.exitCode, 0);
    assert.match(truncated.out, /\.\.\./u);
    assert.match(truncated.out, new RegExp(`fleet view ${card.id} --full`, "u"));

    const full = await captureCli(["view", card.id, "--full"], client);
    assert.equal(full.exitCode, 0);
    assert.ok(full.out.includes(longBody));
    assert.doesNotMatch(full.out, /--full/u);
  } finally {
    store.close();
  }
});

void test("escalate, answer, handoff, close, cancel, charter, prefs, and init mutations are idempotent", async () => {
  const store = new CardStore({ memory: true, parents: { jarvis: "captain", cleo: "jarvis" } });
  const client = createLocalBoardClient(store);
  const dir = makeTempDir("fv3-axi-init-");

  try {
    const card = await client.createCard({ mate: "cleo", title: "Ship feature" });

    const esc1 = await captureCli(
      ["escalate", card.id, "--reason", "Need Jarvis check"],
      client,
      "cleo",
    );
    assert.equal(esc1.exitCode, 0);
    assert.match(esc1.out, /holder: jarvis/u);

    const esc2 = await captureCli(
      ["escalate", card.id, "--reason", "Approve merge?"],
      client,
      "jarvis",
    );
    assert.equal(esc2.exitCode, 0);
    assert.match(esc2.out, /holder: captain/u);

    const ans = await captureCli(["answer", card.id, "--text", "Merge it"], client, "captain");
    assert.equal(ans.exitCode, 0);
    assert.match(ans.out, /holder: cleo/u);

    const close1 = await captureCli(["close", card.id, "--result", "Merged"], client, "cleo");
    const close2 = await captureCli(["close", card.id, "--result", "Merged"], client, "cleo");
    assert.equal(close1.exitCode, 0);
    assert.equal(close2.exitCode, 0);

    const card2 = await client.createCard({ mate: "cleo", title: "Obsolete item" });
    const cancel1 = await captureCli(["cancel", card2.id, "--reason", "Duplicate"], client, "cleo");
    const cancel2 = await captureCli(["cancel", card2.id, "--reason", "Duplicate"], client, "cleo");
    assert.equal(cancel1.exitCode, 0);
    assert.equal(cancel2.exitCode, 0);

    const setCharter = await captureCli(
      ["charter", "cleo", "--set", "Autopilot on shadow"],
      client,
    );
    assert.equal(setCharter.exitCode, 0);
    const getCharter = await captureCli(["charter", "cleo"], client);
    assert.match(getCharter.out, /Autopilot on shadow/u);

    const setPrefs = await captureCli(["prefs", "--set", "No em dashes"], client);
    assert.equal(setPrefs.exitCode, 0);
    const getPrefs = await captureCli(["prefs"], client);
    assert.match(getPrefs.out, /No em dashes/u);

    const cfgPath = join(dir, "fleet.yaml");
    const init1 = await captureCli(["init", "--config", cfgPath], client);
    const init2 = await captureCli(["init", "--config", cfgPath], client);
    assert.equal(init1.exitCode, 0);
    assert.match(init1.out, /created: true/u);
    assert.equal(init2.exitCode, 0);
    assert.match(init2.out, /already exists/u);
  } finally {
    store.close();
  }
});
