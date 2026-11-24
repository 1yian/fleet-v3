import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { board, type Board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
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
  boardClient: Board,
): Promise<{ readonly out: string; readonly exitCode: number }> {
  let out = "";
  const prevCode = process.exitCode;
  process.exitCode = 0;
  try {
    await runFleetCli({
      argv,
      boardClient,
      boardUrl: "https://test.board.local/api/board",
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

void test("home view returns TOON live counts, hosts, open tasks, and contextual help", async () => {
  const backend = local({ memory: true });
  const client = board({ backend });

  try {
    const empty = await captureCli([], client);
    assert.equal(empty.exitCode, 0);
    assert.match(empty.out, /description: Coordinate parallel multi-machine agents/u);
    assert.match(empty.out, /counts: 0 open tasks/u);
    assert.match(empty.out, /tasks: 0 open tasks found/u);

    await client.post("meta", {
      text: "host=p620 mode=docker repos=Cleo,fleet-v3",
      labels: { kind: "host", host: "p620" },
      noSync: true,
    });
    const dispatched = await captureCli(
      [
        "dispatch",
        "--channel",
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
    assert.match(home.out, /counts: 1 ready \(1 open total\)/u);
    assert.match(home.out, /p620,docker/u);
    assert.match(home.out, /Fix webhook timeout/u);
    assert.match(home.out, /fleet view <id>/u);
  } finally {
    await backend.close();
  }
});

void test("rejects unknown flags loudly on stdout with exit code 2 and inline help", async () => {
  const backend = local({ memory: true });
  const client = board({ backend });

  try {
    const res = await captureCli(["tasks", "--stat", "blocked"], client);
    assert.equal(res.exitCode, 2);
    assert.match(res.out, /unknown flag --stat/u);
    assert.match(res.out, /--state/u);
  } finally {
    await backend.close();
  }
});

void test("truncates long bodies in view by default and reveals full text with --full", async () => {
  const backend = local({ memory: true });
  const client = board({ backend });

  try {
    const longBody = "A".repeat(900);
    const { task } = await client.tasks.create("cleo", { text: `Long task\n\n${longBody}` });

    const truncated = await captureCli(["view", task.id], client);
    assert.equal(truncated.exitCode, 0);
    assert.match(truncated.out, /truncated, \d+ chars total/u);
    assert.match(truncated.out, new RegExp(`fleet view ${task.id} --full`, "u"));

    const full = await captureCli(["view", task.id, "--full"], client);
    assert.equal(full.exitCode, 0);
    assert.ok(full.out.includes(longBody));
    assert.doesNotMatch(full.out, /--full/u);
  } finally {
    await backend.close();
  }
});

void test("block, unblock, cancel, charter, prefs, and init mutations are idempotent", async () => {
  const backend = local({ memory: true });
  const client = board({ backend });
  const dir = makeTempDir("fleet-v3-axi-");

  try {
    const { task } = await client.tasks.create("cleo", { text: "Check idempotency" });

    const b1 = await captureCli(["block", task.id, "--reason", "Approve merge?"], client);
    assert.equal(b1.exitCode, 0);
    assert.match(b1.out, /state: blocked/u);

    const b2 = await captureCli(["block", task.id, "--reason", "Approve merge?"], client);
    assert.equal(b2.exitCode, 0);
    assert.match(b2.out, /already blocked \(no-op\)/u);

    const u1 = await captureCli(["unblock", task.id, "--reply", "merge"], client);
    assert.equal(u1.exitCode, 0);
    assert.match(u1.out, /state: ready/u);

    const u2 = await captureCli(["unblock", task.id], client);
    assert.equal(u2.exitCode, 0);
    assert.match(u2.out, /already ready \(no-op\)/u);

    const c1 = await captureCli(["cancel", task.id, "--reason", "Superseded"], client);
    assert.equal(c1.exitCode, 0);
    assert.match(c1.out, /state: canceled/u);

    const c2 = await captureCli(["cancel", task.id, "--reason", "Superseded"], client);
    assert.equal(c2.exitCode, 0);
    assert.match(c2.out, /already canceled \(no-op\)/u);

    const setCharter = await captureCli(["charter", "cleo", "--set", "Ask before merge."], client);
    assert.equal(setCharter.exitCode, 0);
    const readCharter = await captureCli(["charter", "cleo"], client);
    assert.equal(readCharter.exitCode, 0);
    assert.match(readCharter.out, /Ask before merge\./u);

    const setPrefs = await captureCli(["prefs", "--set", "Minimal diffs only."], client);
    assert.equal(setPrefs.exitCode, 0);
    const readPrefs = await captureCli(["prefs"], client);
    assert.equal(readPrefs.exitCode, 0);
    assert.match(readPrefs.out, /Minimal diffs only\./u);

    const cfgPath = join(dir, "fleet.yaml");
    const i1 = await captureCli(["init", "--config", cfgPath], client);
    assert.equal(i1.exitCode, 0);
    assert.match(i1.out, /created: true/u);

    const i2 = await captureCli(["init", "--config", cfgPath], client);
    assert.equal(i2.exitCode, 0);
    assert.match(i2.out, /already exists \(no-op\)/u);
  } finally {
    await backend.close();
  }
});
