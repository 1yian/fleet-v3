import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runFleetCli } from "../src/cli.ts";
import { VERSION } from "../src/version.ts";
import { startTestServer } from "./support.ts";

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

function runBin(
  args: readonly string[],
): Promise<{ readonly exitCode: number | null; readonly output: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN_PATH, ...args],
      { encoding: "utf8", timeout: 15_000 },
      (error, stdout, stderr) => {
        const code: unknown = error === null ? 0 : Reflect.get(error, "code");
        resolve({ exitCode: typeof code === "number" ? code : null, output: `${stdout}${stderr}` });
      },
    );
  });
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function captureCli(
  argv: string[],
  boardUrl: string,
  actor = "captain",
): Promise<{ readonly out: string; readonly exitCode: number }> {
  let out = "";
  const prevCode = process.exitCode;
  process.exitCode = 0;
  try {
    await runFleetCli({
      argv,
      boardUrl,
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
  const server = await startTestServer({ parents: { jarvis: "captain", cleo: "jarvis" } });
  const { client, url } = server;

  try {
    const empty = await captureCli([], url);
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
      url,
    );
    assert.equal(dispatched.exitCode, 0);
    assert.match(dispatched.out, /Fix webhook timeout/u);

    const home = await captureCli([], url);
    assert.equal(home.exitCode, 0);
    assert.match(home.out, /counts: 1 queued \(1 open total\)/u);
    assert.match(home.out, /p620,docker/u);
    assert.match(home.out, /Fix webhook timeout/u);
    assert.match(home.out, /fleet view <id>/u);
  } finally {
    await server.stop();
  }
});

void test("rejects unknown flags loudly on stdout with exit code 2 and inline help", async () => {
  const server = await startTestServer();
  const { url } = server;

  try {
    const res = await captureCli(["cards", "--stat", "held"], url);
    assert.equal(res.exitCode, 2);
    assert.match(res.out, /unknown flag --stat/u);
    assert.match(res.out, /--state/u);
  } finally {
    await server.stop();
  }
});

void test("truncates long bodies in view by default and reveals full text with --full", async () => {
  const server = await startTestServer();
  const { client, url } = server;

  try {
    const longBody = "A".repeat(900);
    const card = await client.createCard({
      mate: "cleo",
      title: "Long card",
      body: longBody,
    });

    const truncated = await captureCli(["view", card.id], url);
    assert.equal(truncated.exitCode, 0);
    assert.match(truncated.out, /\.\.\./u);
    assert.match(truncated.out, new RegExp(`fleet view ${card.id} --full`, "u"));

    const full = await captureCli(["view", card.id, "--full"], url);
    assert.equal(full.exitCode, 0);
    assert.ok(full.out.includes(longBody));
    assert.doesNotMatch(full.out, /--full/u);
  } finally {
    await server.stop();
  }
});

void test("escalation, answer, and handoff flows work end to end, and close, cancel, and init are idempotent", async () => {
  const server = await startTestServer({ parents: { jarvis: "captain", cleo: "jarvis" } });
  const { client, url } = server;
  const dir = makeTempDir("fv3-axi-init-");

  try {
    const card = await client.createCard({ mate: "cleo", title: "Ship feature" });

    const override = await captureCli(
      ["escalate", card.id, "--reason", "Skip the parent", "--to", "captain"],
      url,
      "cleo",
    );
    assert.equal(override.exitCode, 2);
    assert.match(override.out, /unknown flag --to/u);

    const esc1 = await captureCli(
      ["escalate", card.id, "--reason", "Need Jarvis check"],
      url,
      "cleo",
    );
    assert.equal(esc1.exitCode, 0);
    assert.match(esc1.out, /holder: jarvis/u);

    const replay = await captureCli(
      ["escalate", card.id, "--reason", "Need Jarvis check"],
      url,
      "cleo",
    );
    assert.notEqual(replay.exitCode, 0, "a retried escalation cannot take the next hop");
    assert.match(replay.out, /held by jarvis/u);
    const stillWithParent = await captureCli(["view", card.id], url);
    assert.match(stillWithParent.out, /holder: jarvis/u);

    const esc2 = await captureCli(
      ["escalate", card.id, "--reason", "Approve merge?"],
      url,
      "jarvis",
    );
    assert.equal(esc2.exitCode, 0);
    assert.match(esc2.out, /holder: captain/u);

    const ans = await captureCli(["answer", card.id, "--text", "Merge it"], url, "captain");
    assert.equal(ans.exitCode, 0);
    assert.match(ans.out, /holder: cleo/u);

    const close1 = await captureCli(["close", card.id, "--result", "Merged"], url, "cleo");
    const close2 = await captureCli(["close", card.id, "--result", "Merged"], url, "cleo");
    assert.equal(close1.exitCode, 0);
    assert.equal(close2.exitCode, 0);

    const card2 = await client.createCard({ mate: "cleo", title: "Obsolete item" });
    const cancel1 = await captureCli(["cancel", card2.id, "--reason", "Duplicate"], url, "cleo");
    const cancel2 = await captureCli(["cancel", card2.id, "--reason", "Duplicate"], url, "cleo");
    assert.equal(cancel1.exitCode, 0);
    assert.equal(cancel2.exitCode, 0);

    const setCharter = await captureCli(["charter", "cleo", "--set", "Autopilot on shadow"], url);
    assert.equal(setCharter.exitCode, 0);
    const getCharter = await captureCli(["charter", "cleo"], url);
    assert.match(getCharter.out, /Autopilot on shadow/u);

    const setPrefs = await captureCli(["prefs", "--set", "No em dashes"], url);
    assert.equal(setPrefs.exitCode, 0);
    const getPrefs = await captureCli(["prefs"], url);
    assert.match(getPrefs.out, /No em dashes/u);

    const cfgPath = join(dir, "nested", "deeper", "fleet.yaml");
    const init1 = await captureCli(["init", "--config", cfgPath], url);
    const init2 = await captureCli(["init", "--config", cfgPath], url);
    assert.equal(init1.exitCode, 0);
    assert.match(init1.out, /created: true/u);
    assert.equal(init2.exitCode, 0);
    assert.match(init2.out, /already exists/u);
  } finally {
    await server.stop();
  }
});

void test("cards lists report the true total and keep open work visible behind closed history", async () => {
  const server = await startTestServer();
  const { client, url } = server;

  try {
    await client.createCard({ mate: "cleo", title: "Still open" });
    for (let i = 0; i < 3; i += 1) {
      const filler = await client.createCard({ mate: "cleo", title: `Closed ${String(i)}` });
      await client.closeCard(filler.id, {});
    }

    const openList = await captureCli(["cards", "--limit", "1"], url);
    assert.equal(openList.exitCode, 0);
    assert.match(openList.out, /count: 1 of 1 total/u);
    assert.match(openList.out, /Still open/u);

    const allList = await captureCli(["cards", "--state", "all", "--limit", "2"], url);
    assert.match(allList.out, /count: 2 of 4 total/u);
    assert.match(allList.out, /fleet cards --state all --limit 4/u);

    const filtered = await captureCli(
      ["cards", "--mate", "cleo", "--state", "all", "--fields", "project", "--limit", "2"],
      url,
    );
    assert.match(filtered.out, /fleet cards --mate cleo --state all --fields project --limit 4/u);

    const spaced = await captureCli(
      ["cards", "--state", "all", "--fields", "project, host", "--limit", "1"],
      url,
    );
    const hint = /Run `fleet (cards[^`]*)`/u.exec(spaced.out);
    assert.ok(hint?.[1] !== undefined, "a truncated list prints a continuation");
    const followed = await captureCli(hint[1].split(" "), url);
    assert.equal(followed.exitCode, 0, "the printed continuation runs as written");
    assert.match(followed.out, /count: 4 of 4 total/u);
    assert.match(followed.out, /host/u);
  } finally {
    await server.stop();
  }
});

void test("fleet serve refuses an explicit --config that does not exist", async () => {
  const missing = "/nonexistent/fleet.yaml";
  const result = await runBin(["serve", "--config", missing, "--port", "4199"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /not found/iu);
  assert.ok(result.output.includes(missing), "the diagnostic names the missing explicit path");
});

function fleetYaml(root: string, name: string, extra: readonly string[]): string {
  const path = join(root, name);
  const base = [
    "host: h1",
    "spawn:",
    "  command: [echo]",
    "repos:",
    "  demo:",
    "    path: /tmp/demo",
  ];
  writeFileSync(path, [...base, ...extra].join("\n"));
  return path;
}

function matesYaml(...items: readonly string[]): string[] {
  return [
    "mates:",
    "  items:",
    ...items.flatMap((entry) => entry.split("|").map((line) => `    ${line}`)),
  ];
}

void test("fleet refuses to launch from a config with a broken mate hierarchy or review cap", async () => {
  const root = makeTempDir("fv3-config-");
  const hierarchyCases: readonly (readonly [string, readonly string[], RegExp])[] = [
    [
      "cycle",
      matesYaml("- name: cleo|  parent: jarvis", "- name: jarvis|  parent: cleo"),
      /does not reach captain/u,
    ],
    [
      "duplicate",
      matesYaml("- name: cleo|  parent: captain", "- name: cleo|  parent: captain"),
      /duplicated/u,
    ],
    ["unrooted", matesYaml("- name: cleo|  parent: ghost"), /does not reach captain/u],
    ["punctuation", matesYaml("- name: ops.qa|  parent: captain"), /names use letters/u],
    ["reserved-runner", matesYaml("- name: runner|  parent: captain"), /reserved/u],
    ["reserved-worker", matesYaml("- name: worker|  parent: captain"), /reserved/u],
    ["reserved-captain", matesYaml("- name: captain|  parent: captain"), /reserved/u],
  ];
  for (const [name, extra, pattern] of hierarchyCases) {
    const config = fleetYaml(root, `${name}.yaml`, extra);
    const serve = await runBin(["serve", "--config", config, "--port", "4198"]);
    assert.equal(serve.exitCode, 1, `serve refuses the ${name} hierarchy`);
    assert.match(serve.output, pattern);
    const mates = await runBin(["mates", "--config", config]);
    assert.equal(mates.exitCode, 1, `mates refuses the ${name} hierarchy`);
    assert.match(mates.output, pattern);
  }

  const rounds = await runBin([
    "run",
    "--config",
    fleetYaml(root, "rounds.yaml", ["maxReviewRounds: 5"]),
  ]);
  assert.equal(rounds.exitCode, 1, "run refuses a review cap above four");
  assert.match(rounds.output, /too_big|<=4|Too big/iu);

  const filter = await runBin([
    "run",
    "--config",
    fleetYaml(root, "filter.yaml", ['matesFilter: ["ops.qa"]']),
  ]);
  assert.equal(filter.exitCode, 1, "run refuses a malformed mates filter");
  assert.match(filter.output, /names use letters/u);

  const boardOnly = join(root, "board-only.yaml");
  writeFileSync(
    boardOnly,
    ["server:", "  port: 4321", ...matesYaml("- name: cleo|  parent: captain")].join("\n"),
  );
  const noHost = await runBin(["run", "--config", boardOnly]);
  assert.equal(noHost.exitCode, 1, "run needs the execution-host fields a board-only file omits");
  assert.match(noHost.output, /host/u);
});

void test("a mate launched without an identity fails at the Pi extension entrypoint", async () => {
  const adapterUrl = pathToFileURL(
    fileURLToPath(new URL("../src/adapters/pi.ts", import.meta.url)),
  ).href;
  const env = { ...process.env };
  delete env["FLEET_MATE"];
  const result = await new Promise<{ readonly exitCode: number | null; readonly output: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m = await import(${JSON.stringify(adapterUrl)}); m.default({ on() {}, sendMessage() {} });`,
        ],
        { encoding: "utf8", timeout: 15_000, env },
        (error, stdout, stderr) => {
          const code: unknown = error === null ? 0 : Reflect.get(error, "code");
          resolve({
            exitCode: typeof code === "number" ? code : null,
            output: `${stdout}${stderr}`,
          });
        },
      );
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /requires FLEET_MATE/u);
});

void test("mate CLI defaults dispatch --mate to self, scopes reads to subtree, and supports snooze", async () => {
  const server = await startTestServer({
    parents: { jarvis: "captain", cleo: "jarvis", cnp: "jarvis" },
  });
  const { url } = server;

  try {
    const delegated = await captureCli(
      ["dispatch", "--mate", "cleo", "--title", "Cleo inline task"],
      url,
      "jarvis",
    );
    assert.equal(delegated.exitCode, 0);

    const selfWorker = await captureCli(
      ["dispatch", "--project", "Cleo", "--host", "p620", "--title", "Self worker task"],
      url,
      "cleo",
    );
    assert.equal(selfWorker.exitCode, 0);
    assert.match(selfWorker.out, /mate: cleo/u);
    assert.match(selfWorker.out, /state: queued/u);

    const cnpTask = await captureCli(
      ["dispatch", "--mate", "cnp", "--title", "CNP private task"],
      url,
      "jarvis",
    );
    assert.equal(cnpTask.exitCode, 0);

    const cleoCards = await captureCli(["cards"], url, "cleo");
    assert.equal(cleoCards.exitCode, 0);
    assert.match(cleoCards.out, /Cleo inline task/u);
    assert.ok(!cleoCards.out.includes("CNP private task"), "cleo CLI never sees cnp cards");

    const snoozed = await captureCli(
      ["snooze", "1", "--for", "15m", "--reason", "Waiting on external review"],
      url,
      "cleo",
    );
    assert.equal(snoozed.exitCode, 0);
    assert.match(snoozed.out, /snoozeUntil:/u);

    const viewed = await captureCli(["view", "1"], url, "cleo");
    assert.equal(viewed.exitCode, 0);
    assert.match(viewed.out, /snoozeUntil:/u);
  } finally {
    await server.stop();
  }
});
