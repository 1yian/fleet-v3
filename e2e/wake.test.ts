import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { attachFleetPiAdapter } from "../src/adapters/pi.ts";
import { loadFleetConfig } from "../src/config.ts";
import { ensureMatesUp, listMates } from "../src/mates.ts";
import { createMockPi, startTestServer, waitFor, type TestServer } from "./support.ts";

const BIN_PATH = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(deadline);
      resolve(code);
    });
  });
}

function runBinOnce(
  args: readonly string[],
  envOverrides: Readonly<Record<string, string>> = {},
  omitKeys: readonly string[] = [],
): Promise<{
  readonly exitCode: number | null;
  readonly output: string;
  readonly stdout: string;
}> {
  const omitted = new Set(omitKeys);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!omitted.has(k) && v !== undefined) env[k] = v;
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    env[k] = v;
  }
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN_PATH, ...args],
      { encoding: "utf8", timeout: 15_000, env },
      (error, stdout, stderr) => {
        const code: unknown = error === null ? 0 : Reflect.get(error, "code");
        resolve({
          exitCode: typeof code === "number" ? code : null,
          output: `${stdout}${stderr}`,
          stdout,
        });
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChannelPush(message: Record<string, unknown>): boolean {
  return message["method"] === "notifications/claude/channel";
}

function strField(obj: Readonly<Record<string, unknown>> | undefined, key: string): string {
  const val = obj?.[key];
  return typeof val === "string" ? val : "";
}

const FLEET_PARENTS = { "1stmate": "captain", cleo: "1stmate" };
const WAKE_ENVELOPE_KEYS = ["actor", "cardId", "eventType", "mate", "notice"];

async function startServerWithStaleCard(title: string): Promise<TestServer> {
  const clock = { now: 1000 };
  const server = await startTestServer({ parents: FLEET_PARENTS, now: () => clock.now });
  await server.client.createCard({ mate: "cleo", title, actor: "1stmate" });
  clock.now = 10_000_000;
  return server;
}

void test("fleet watch streams filtered NDJSON wakes and rejects invalid flags", async () => {
  const server = await startServerWithStaleCard("Stale seed card");

  try {
    const missingMate = await runBinOnce(["watch"], { BOARD_URL: server.url }, ["FLEET_MATE"]);
    assert.equal(missingMate.exitCode, 2);
    assert.match(missingMate.output, /FLEET_MATE|--mate/u);

    const badMate = await runBinOnce(["watch", "--mate", "captain"], {
      BOARD_URL: server.url,
    });
    assert.equal(badMate.exitCode, 2);

    const headerWithoutWebhook = await runBinOnce(
      ["watch", "--mate", "cleo", "--header", "X-Auth: abc"],
      { BOARD_URL: server.url },
    );
    assert.equal(headerWithoutWebhook.exitCode, 2);
    assert.match(headerWithoutWebhook.output, /--webhook/u);

    const badUrl = await runBinOnce(
      ["watch", "--mate", "cleo", "--webhook", "ftp://example.com/hook"],
      { BOARD_URL: server.url },
    );
    assert.equal(badUrl.exitCode, 2);
    assert.match(badUrl.output, /http:\/\/ or https:\/\//u);

    const hookUrl = "http://127.0.0.1:9/hook";
    const badHeaders = [
      "Authorization: Bearer \u{1F511}",
      "Content-Type: text/plain",
      "content-type: text/plain",
    ];
    for (const header of badHeaders) {
      const result = await runBinOnce(
        ["watch", "--mate", "cleo", "--webhook", hookUrl, "--header", header],
        { BOARD_URL: server.url },
      );
      assert.equal(result.exitCode, 2);
      assert.equal(result.output.includes("\u{1F511}"), false);
    }

    const credentialedUrl = await runBinOnce(
      ["watch", "--mate", "cleo", "--webhook", "https://user:hunter2@example.com/hook?token=abc"],
      { BOARD_URL: server.url },
    );
    assert.equal(credentialedUrl.exitCode, 2);
    assert.equal(credentialedUrl.output.includes("hunter2"), false);
    assert.equal(credentialedUrl.output.includes("token=abc"), false);

    const channelWithoutMate = await runBinOnce(["channel"], { BOARD_URL: server.url }, [
      "FLEET_MATE",
    ]);
    assert.equal(channelWithoutMate.exitCode, 2);
    assert.equal(channelWithoutMate.stdout, "");
    assert.match(channelWithoutMate.output, /FLEET_MATE|--mate/u);

    const child = spawn(process.execPath, [BIN_PATH, "watch", "--mate", "cleo"], {
      env: { ...process.env, BOARD_URL: server.url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const received: Record<string, unknown>[] = [];
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) received.push(parsed);
    });

    try {
      await waitFor(() => received.length > 0);
      assert.equal(strField(received[0], "eventType"), "chase.due");
      assert.match(strField(received[0], "notice"), /Stale seed card/u);

      const card = await server.client.createCard({
        mate: "cleo",
        title: "Watch NDJSON card",
        actor: "1stmate",
      });
      await waitFor(() => received.length > 1);
      const created = received[1];
      assert.deepEqual(Object.keys(created ?? {}).toSorted(), WAKE_ENVELOPE_KEYS);
      assert.equal(strField(created, "mate"), "cleo");
      assert.equal(strField(created, "eventType"), "card.created");
      assert.equal(strField(created, "cardId"), card.id);
      assert.equal(strField(created, "actor"), "1stmate");
      assert.match(strField(created, "notice"), /Watch NDJSON card/u);

      await server.client.postEntry(card.id, {
        by: "cleo",
        text: "Self note should not wake cleo",
      });
      await server.client.postEntry(card.id, {
        by: "1stmate",
        text: "Internal note should not wake cleo",
        internal: true,
      });
      await server.client.postEntry(card.id, {
        by: "1stmate",
        text: "Public follow-up for cleo",
      });

      await waitFor(() =>
        received.some((item) => strField(item, "notice").includes("Public follow-up for cleo")),
      );
      assert.equal(
        received.some((item) => strField(item, "notice").includes("Self note")),
        false,
      );
      assert.equal(
        received.some((item) => strField(item, "notice").includes("Internal note")),
        false,
      );
    } finally {
      rl.close();
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  } finally {
    await server.stop();
  }
});

void test("fleet watch exits cleanly when the NDJSON consumer closes the pipe", async () => {
  const server = await startServerWithStaleCard("Stale pipe seed card");
  try {
    const child = spawn(process.execPath, [BIN_PATH, "watch", "--mate", "cleo"], {
      env: { ...process.env, BOARD_URL: server.url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let sawWake = false;
    child.stdout.once("data", () => {
      sawWake = true;
    });
    try {
      await waitFor(() => sawWake);
      assert.equal(sawWake, true);
      child.stdout.destroy();
      await waitFor(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return true;
        await server.client.createCard({
          mate: "cleo",
          title: "After pipe close",
          actor: "1stmate",
        });
        return false;
      }, 5000);
      assert.equal(await waitForExit(child), 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child);
      }
    }
  } finally {
    await server.stop();
  }
});

void test("fleet watch --webhook POSTs JSON wakes with custom header and survives transient 500s", async () => {
  const server = await startServerWithStaleCard("Stale webhook seed card");

  const hits: {
    readonly method: string | undefined;
    readonly url: string | undefined;
    readonly header: string | undefined;
    readonly body: Record<string, unknown>;
  }[] = [];
  let failNext = true;

  const webhookServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (isRecord(parsed)) {
        hits.push({
          method: req.method,
          url: req.url,
          header:
            typeof req.headers["x-fleet-secret"] === "string"
              ? req.headers["x-fleet-secret"]
              : undefined,
          body: parsed,
        });
      }
      if (failNext) {
        failNext = false;
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("temporary outage");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });

  await new Promise<void>((resolve) => {
    webhookServer.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const addr = webhookServer.address();
  assert.ok(addr !== null && typeof addr === "object");
  const webhookUrl = `http://127.0.0.1:${String(addr.port)}/wake`;

  try {
    const stderrChunks: string[] = [];
    const child = spawn(
      process.execPath,
      [
        BIN_PATH,
        "watch",
        "--mate",
        "cleo",
        "--webhook",
        webhookUrl,
        "--header",
        "X-Fleet-Secret: top-secret",
      ],
      {
        env: { ...process.env, BOARD_URL: server.url },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
    });

    try {
      await waitFor(() => hits.length > 0 && stderrChunks.join("").includes("HTTP 500"));
      assert.match(strField(hits[0]?.body, "notice"), /Stale webhook seed card/u);

      const card = await server.client.createCard({
        mate: "cleo",
        title: "Second webhook card",
        actor: "1stmate",
      });
      await waitFor(() => hits.length >= 2);

      for (const hit of hits) {
        assert.equal(hit.method, "POST");
        assert.equal(hit.url, "/wake");
      }
      assert.equal(hits[1]?.header, "top-secret");
      assert.deepEqual(Object.keys(hits[1]?.body ?? {}).toSorted(), WAKE_ENVELOPE_KEYS);
      assert.equal(strField(hits[1]?.body, "mate"), "cleo");
      assert.equal(strField(hits[1]?.body, "eventType"), "card.created");
      assert.equal(strField(hits[1]?.body, "cardId"), card.id);
      assert.match(strField(hits[1]?.body, "notice"), /Second webhook card/u);

      const stderrText = stderrChunks.join("");
      assert.equal(stderrText.includes("top-secret"), false);
      assert.equal(stderrText.includes(webhookUrl), false);
      assert.equal(stderrText.includes("temporary outage"), false);
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  } finally {
    await new Promise<void>((resolve) => {
      webhookServer.close(() => {
        resolve();
      });
    });
    await server.stop();
  }
});

void test("fleet channel speaks Claude Code MCP Channel protocol over stdio and exits cleanly on EOF", async () => {
  const server = await startServerWithStaleCard("Stale channel seed card");

  try {
    const child = spawn(process.execPath, [BIN_PATH, "channel", "--mate", "cleo"], {
      env: { ...process.env, BOARD_URL: server.url },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages: Record<string, unknown>[] = [];
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) messages.push(parsed);
    });

    try {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {} },
        })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "initialize",
          params: { protocolVersion: "1999-01-01", capabilities: {} },
        })}\n`,
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: "1.0", id: 5, method: "ping" })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 6, method: "notifications/initialized" })}\n`,
      );
      await waitFor(() => [1, 2, 4, 5, 6].every((id) => messages.some((m) => m["id"] === id)));
      const initResp = messages.find((m) => m["id"] === 1);
      assert.ok(initResp !== undefined && isRecord(initResp["result"]));
      assert.equal(initResp["result"]["protocolVersion"], "2025-03-26");
      const repeatInitResp = messages.find((m) => m["id"] === 4);
      assert.ok(repeatInitResp !== undefined);
      assert.ok(isRecord(repeatInitResp["error"]));
      assert.equal(repeatInitResp["error"]["code"], -32_600);
      const invalidResp = messages.find((m) => m["id"] === 5);
      assert.ok(invalidResp !== undefined && isRecord(invalidResp["error"]));
      assert.equal(invalidResp["error"]["code"], -32_600);
      const idBearingResp = messages.find((m) => m["id"] === 6);
      assert.ok(idBearingResp !== undefined && isRecord(idBearingResp["error"]));
      assert.equal(idBearingResp["error"]["code"], -32_601);
      const capabilities = initResp["result"]["capabilities"];
      assert.ok(isRecord(capabilities) && isRecord(capabilities["experimental"]));
      assert.ok(Object.hasOwn(capabilities["experimental"], "claude/channel"));

      await server.client.createCard({
        mate: "cleo",
        title: "Handshake gap card",
        actor: "1stmate",
      });
      assert.equal(await waitFor(() => messages.some((m) => isChannelPush(m)), 400), false);

      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const pushContents = (): string[] =>
        messages
          .filter((m) => isChannelPush(m))
          .map((m) => (isRecord(m["params"]) ? strField(m["params"], "content") : ""));
      await waitFor(
        () =>
          pushContents().some((c) => c.includes("Handshake gap card")) &&
          pushContents().some((c) => c.includes("Stale channel seed card")),
      );
      assert.ok(pushContents().some((c) => c.includes("Handshake gap card")));
      assert.ok(pushContents().some((c) => c.includes("Stale channel seed card")));

      const card = await server.client.createCard({
        mate: "cleo",
        title: "Channel MCP card",
        actor: "1stmate",
      });

      await waitFor(() => pushContents().some((c) => c.includes("Channel MCP card")));
      const notif = messages.find(
        (m) =>
          isChannelPush(m) &&
          isRecord(m["params"]) &&
          strField(m["params"], "content").includes("Channel MCP card"),
      );
      assert.ok(notif !== undefined && isRecord(notif["params"]));
      const meta = notif["params"]["meta"];
      assert.ok(isRecord(meta));
      for (const key of Object.keys(meta)) {
        assert.match(key, /^[A-Za-z0-9_]+$/u);
      }
      assert.equal(meta["mate"], "cleo");
      assert.equal(meta["card_id"], card.id);
      assert.equal(meta["actor"], "1stmate");

      child.stdin.end();
      const exitCode = await waitForExit(child);
      assert.equal(exitCode, 0);
    } finally {
      rl.close();
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await waitForExit(child);
      }
    }
  } finally {
    await server.stop();
  }
});

void test("fleet channel negotiates the highest supported MCP version for unsupported requests", async () => {
  const server = await startTestServer({ parents: FLEET_PARENTS });
  try {
    const child = spawn(process.execPath, [BIN_PATH, "channel", "--mate", "cleo"], {
      env: { ...process.env, BOARD_URL: server.url },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages: Record<string, unknown>[] = [];
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) messages.push(parsed);
    });
    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "1999-01-01", capabilities: {} },
        })}\n`,
      );
      await waitFor(() => messages.some((m) => m["id"] === 1));
      const response = messages.find((m) => m["id"] === 1);
      assert.ok(response !== undefined && isRecord(response["result"]));
      assert.equal(response["result"]["protocolVersion"], "2025-06-18");
    } finally {
      rl.close();
      child.stdin.end();
      await waitForExit(child);
    }
  } finally {
    await server.stop();
  }
});

void test("fleet channel closes promptly on EOF while the Card Server stalls its health reply", async () => {
  let requestSeen = false;
  const stalledBoard = createServer(() => {
    requestSeen = true;
  });
  await new Promise<void>((resolve) => {
    stalledBoard.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const addr = stalledBoard.address();
  assert.ok(addr !== null && typeof addr === "object");
  try {
    const child = spawn(process.execPath, [BIN_PATH, "channel", "--mate", "cleo"], {
      env: { ...process.env, BOARD_URL: `http://127.0.0.1:${String(addr.port)}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {} },
        })}\n`,
      );
      assert.equal(await waitFor(() => requestSeen), true);
      child.stdin.end();
      assert.equal(await waitForExit(child), 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child);
      }
    }
  } finally {
    stalledBoard.closeAllConnections();
    await new Promise<void>((resolve) => {
      stalledBoard.close(() => {
        resolve();
      });
    });
  }
});

void test("fleet channel refuses to acknowledge initialize without a replay cursor and accepts a retry", async () => {
  const probe = await startTestServer({ parents: FLEET_PARENTS });
  const port = Number(new URL(probe.url).port);
  await probe.stop();

  const child = spawn(process.execPath, [BIN_PATH, "channel", "--mate", "cleo"], {
    env: { ...process.env, BOARD_URL: `http://127.0.0.1:${String(port)}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: Record<string, unknown>[] = [];
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const parsed: unknown = JSON.parse(line);
    if (isRecord(parsed)) messages.push(parsed);
  });
  const initialize = (id: number): void => {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      })}\n`,
    );
  };
  let server: TestServer | undefined;
  try {
    initialize(1);
    await waitFor(() => messages.some((m) => m["id"] === 1));
    const failed = messages.find((m) => m["id"] === 1);
    assert.ok(failed !== undefined && isRecord(failed["error"]));
    assert.equal(failed["error"]["code"], -32_603);
    assert.equal(Object.hasOwn(failed, "result"), false);

    server = await startTestServer({ parents: FLEET_PARENTS, port });
    initialize(2);
    await waitFor(() => messages.some((m) => m["id"] === 2));
    const retried = messages.find((m) => m["id"] === 2);
    assert.ok(retried !== undefined && isRecord(retried["result"]));

    child.stdin.end();
    assert.equal(await waitForExit(child), 0);
  } finally {
    rl.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    await server?.stop();
  }
});

void test("Pi adapter attaches idempotently and injects prompts/mate.md when not already present", async () => {
  const server = await startTestServer({
    parents: { "1stmate": "captain", cleo: "1stmate" },
  });

  const mock = createMockPi();
  try {
    attachFleetPiAdapter(mock.api, { boardUrl: server.url, mate: "1stmate" });
    attachFleetPiAdapter(mock.api, { boardUrl: server.url, mate: "1stmate" });

    await mock.emitStart();
    const out = await mock.emitBeforeStart("Base prompt");
    assert.ok(out !== undefined);
    assert.match(out.systemPrompt, /You are a persistent `fleet` mate/u);
    assert.match(out.systemPrompt, /Mate: 1stmate \(parent: captain, subordinates: cleo\)/u);
    const dedup = await mock.emitBeforeStart(out.systemPrompt);
    assert.ok(dedup !== undefined);
    assert.equal(dedup.systemPrompt.split("You are a persistent `fleet` mate").length - 1, 1);

    await server.client.createCard({
      mate: "1stmate",
      title: "Idempotent wake card",
      actor: "captain",
    });
    await waitFor(() => mock.delivered.length > 0);
    await sleep(150);
    assert.equal(mock.delivered.length, 1);
  } finally {
    await mock.emitShutdown();
    await server.stop();
  }
});

void test("Pi adapter stays inert inside crewmates when FLEET_CLAIM_TOKEN is set", async () => {
  const server = await startTestServer({
    parents: { "1stmate": "captain" },
  });
  const prevToken = process.env["FLEET_CLAIM_TOKEN"];
  process.env["FLEET_CLAIM_TOKEN"] = "worker-claim-secret";
  const mock = createMockPi();
  try {
    attachFleetPiAdapter(mock.api, { boardUrl: server.url, mate: "1stmate" });
    await mock.emitStart();
    const out = await mock.emitBeforeStart("Worker prompt");
    assert.equal(out, undefined);

    await server.client.createCard({
      mate: "1stmate",
      title: "Should not wake crewmate",
      actor: "captain",
    });
    await sleep(150);
    assert.equal(mock.delivered.length, 0);
  } finally {
    if (prevToken === undefined) {
      Reflect.deleteProperty(process.env, "FLEET_CLAIM_TOKEN");
    } else {
      process.env["FLEET_CLAIM_TOKEN"] = prevToken;
    }
    await mock.emitShutdown();
    await server.stop();
  }
});

void test("fleet chat launches local mate with cwd, env, auto-generated mcp.json, and -- passthrough", async () => {
  const server = await startTestServer({
    parents: { "1stmate": "captain", cleo: "1stmate" },
  });
  const root = mkdtempSync(join(tmpdir(), "fleet-chat-local-"));
  const harnessPath = join(root, "fake-harness.mjs");
  const cfgPath = join(root, "fleet.yaml");

  writeFileSync(
    harnessPath,
    [
      `#!${process.execPath}`,
      'import { readFileSync } from "node:fs";',
      "const mcpIndex = process.argv.indexOf('--mcp-config');",
      "const mcpPath = mcpIndex >= 0 ? process.argv[mcpIndex + 1] : '';",
      "const mcpContent = mcpPath ? JSON.parse(readFileSync(mcpPath, 'utf8')) : null;",
      "process.stdout.write(JSON.stringify({",
      "  cwd: process.cwd(),",
      "  mate: process.env.FLEET_MATE ?? null,",
      "  boardUrl: process.env.BOARD_URL ?? null,",
      "  claimToken: process.env.FLEET_CLAIM_TOKEN ?? null,",
      "  claimEpoch: process.env.FLEET_CLAIM_EPOCH ?? null,",
      "  args: process.argv.slice(2),",
      "  mcp: mcpContent,",
      String.raw`}) + '\n');`,
      "process.exit(process.argv.includes('--exit-7') ? 7 : 0);",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(harnessPath, 0o755);

  writeFileSync(
    cfgPath,
    [
      `boardUrl: ${server.url}`,
      "mates:",
      "  stateDir: ./mates",
      "  command:",
      `    - ${harnessPath}`,
      "    - --mcp-config",
      '    - "{mcpConfig}"',
      "    - --prompt",
      '    - "{prompt}"',
      "  items:",
      "    - name: 1stmate",
      "      parent: captain",
      "      cwd: ./1stmate",
      "      autoStart: false",
      "",
    ].join("\n"),
    "utf8",
  );

  try {
    await server.client.setCharter("1stmate", "Own top-level delegation.");
    const okRun = await runBinOnce(["chat", "--config", cfgPath, "--", "--help", "--resume"], {
      BOARD_URL: server.url,
      FLEET_CLAIM_TOKEN: "stale-worker-token",
      FLEET_CLAIM_EPOCH: "9",
    });
    assert.equal(okRun.exitCode, 0, okRun.output);
    const payload: unknown = JSON.parse(okRun.stdout.trim());
    assert.ok(isRecord(payload));
    assert.equal(realpathSync(strField(payload, "cwd")), realpathSync(join(root, "1stmate")));
    assert.equal(payload["mate"], "1stmate");
    assert.equal(payload["boardUrl"], server.url);
    assert.equal(payload["claimToken"], null);
    assert.equal(payload["claimEpoch"], null);
    assert.ok(Array.isArray(payload["args"]));
    assert.ok(payload["args"].includes("--help"));
    assert.ok(payload["args"].includes("--resume"));
    const mcp = payload["mcp"];
    assert.ok(isRecord(mcp) && isRecord(mcp["mcpServers"]) && isRecord(mcp["mcpServers"]["fleet"]));
    assert.equal(mcp["mcpServers"]["fleet"]["command"], "fleet");
    assert.deepEqual(mcp["mcpServers"]["fleet"]["args"], ["channel", "--mate", "1stmate"]);

    const exitRun = await runBinOnce(["chat", "1stmate", "--config", cfgPath, "--", "--exit-7"], {
      BOARD_URL: server.url,
    });
    assert.equal(exitRun.exitCode, 7);

    const diskMcp: unknown = JSON.parse(
      readFileSync(join(root, "mates", "1stmate", "mcp.json"), "utf8"),
    );
    assert.ok(isRecord(diskMcp) && isRecord(diskMcp["mcpServers"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
    await server.stop();
  }
});

void test("fleet chat handles external webhook mates cleanly and rejects unreachable board", async () => {
  const server = await startTestServer({
    parents: { "1stmate": "captain", grokbot: "1stmate" },
  });
  const root = mkdtempSync(join(tmpdir(), "fleet-chat-ext-"));
  const cfgPath = join(root, "fleet.yaml");
  const badCfgPath = join(root, "bad-auto.yaml");

  writeFileSync(
    cfgPath,
    [
      `boardUrl: ${server.url}`,
      "mates:",
      "  stateDir: ./mates",
      "  items:",
      "    - name: 1stmate",
      "      parent: captain",
      "      mode: external",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    badCfgPath,
    [
      `boardUrl: ${server.url}`,
      "mates:",
      "  stateDir: ./mates",
      "  items:",
      "    - name: 1stmate",
      "      parent: captain",
      "      mode: external",
      "      autoStart: true",
      "",
    ].join("\n"),
    "utf8",
  );

  try {
    assert.throws(() => loadFleetConfig(badCfgPath), /cannot set autoStart: true/u);

    const loaded = loadFleetConfig(cfgPath);
    assert.equal(loaded.mates?.items[0]?.autoStart, false);
    const statuses = await listMates(loaded);
    assert.equal(statuses[0]?.status, "external");
    assert.equal(statuses[0]?.mode, "external");
    await assert.rejects(() => ensureMatesUp(loaded, { name: "1stmate" }), /mode "external"/u);
    assert.deepEqual(await ensureMatesUp(loaded, { all: true }), []);

    await server.client.setCharter("1stmate", "External Grok Bot 1stmate.");
    await server.client.createCard({
      mate: "1stmate",
      title: "Pending external card",
      actor: "captain",
    });

    const extRun = await runBinOnce(["chat", "--config", cfgPath], { BOARD_URL: server.url });
    assert.equal(extRun.exitCode, 0, extRun.output);
    assert.match(extRun.stdout, /external mate \(mode: external\)/u);
    assert.match(extRun.stdout, /open cards held by 1stmate: 1/u);
    assert.match(extRun.stdout, /fleet watch --mate 1stmate --webhook/u);

    await server.stop();
    const downRun = await runBinOnce(["chat", "--config", cfgPath], { BOARD_URL: server.url });
    assert.notEqual(downRun.exitCode, 0);
    assert.match(downRun.output, /Card Server is unreachable/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await server.stop().catch(() => undefined);
  }
});

void test("fleet doctor validates board, charter, external mode, and Claude channel flags", async () => {
  const server = await startTestServer({
    parents: { "1stmate": "captain", bot: "1stmate" },
  });
  const root = mkdtempSync(join(tmpdir(), "fleet-doctor-"));
  const fakeClaude = join(root, "claude");
  const badClaudeCfg = join(root, "claude-missing-flag.yaml");
  const goodClaudeCfg = join(root, "claude-ok.yaml");
  const externalCfg = join(root, "external.yaml");
  const brokenCfg = join(root, "broken.yaml");

  writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(fakeClaude, 0o755);

  writeFileSync(
    badClaudeCfg,
    [
      `boardUrl: ${server.url}`,
      "mates:",
      "  stateDir: ./mates",
      "  items:",
      "    - name: 1stmate",
      "      parent: captain",
      "      autoStart: false",
      "      command:",
      `        - ${fakeClaude}`,
      "        - --append-system-prompt-file",
      '        - "{prompt}"',
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    goodClaudeCfg,
    [
      `boardUrl: ${server.url}`,
      "mates:",
      "  stateDir: ./mates",
      "  items:",
      "    - name: 1stmate",
      "      parent: captain",
      "      autoStart: false",
      "      command:",
      `        - ${fakeClaude}`,
      "        - --mcp-config",
      '        - "{mcpConfig}"',
      "        - --dangerously-load-development-channels",
      "        - server:fleet",
      "        - --append-system-prompt-file",
      '        - "{prompt}"',
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    externalCfg,
    [
      `boardUrl: ${server.url}`,
      "mates:",
      "  stateDir: ./mates",
      "  items:",
      "    - name: 1stmate",
      "      parent: captain",
      "      mode: external",
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(brokenCfg, "boardUrl: not-a-url\n", "utf8");

  try {
    await server.client.setCharter("1stmate", "Doctor verified charter.");

    const missingChannel = await runBinOnce(["doctor", "--config", badClaudeCfg], {
      BOARD_URL: server.url,
    });
    assert.equal(missingChannel.exitCode, 1);
    assert.match(missingChannel.stdout, /ok: false/u);
    assert.match(missingChannel.stdout, /--dangerously-load-development-channels/u);

    const goodClaude = await runBinOnce(["doctor", "--config", goodClaudeCfg], {
      BOARD_URL: server.url,
    });
    assert.equal(goodClaude.exitCode, 0, goodClaude.output);
    assert.match(goodClaude.stdout, /ok: true/u);

    const extDoc = await runBinOnce(["doctor", "--config", externalCfg], {
      BOARD_URL: server.url,
    });
    assert.equal(extDoc.exitCode, 0, extDoc.output);
    assert.match(extDoc.stdout, /ok: true/u);
    assert.match(extDoc.stdout, /external mate/u);

    const brokenDoc = await runBinOnce(["doctor", "--config", brokenCfg], {
      BOARD_URL: server.url,
    });
    assert.equal(brokenDoc.exitCode, 1);
    assert.match(brokenDoc.stdout, /ok: false/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await server.stop();
  }
});

void test("fleet mcp serves scoped Fleet tools over stdio and exits cleanly on EOF", async () => {
  const server = await startTestServer({
    parents: { "1stmate": "captain", cleo: "1stmate" },
  });
  const child = spawn(process.execPath, [BIN_PATH, "mcp", "--mate", "1stmate"], {
    env: { ...process.env, BOARD_URL: server.url },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: Record<string, unknown>[] = [];
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const parsed: unknown = JSON.parse(line);
    if (isRecord(parsed)) messages.push(parsed);
  });

  const rpc = (payload: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };
  const waitForId = async (id: number): Promise<Record<string, unknown>> => {
    await waitFor(() => messages.some((m) => m["id"] === id));
    const found = messages.find((m) => m["id"] === id);
    assert.ok(found !== undefined);
    return found;
  };

  try {
    rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    const initResp = await waitForId(1);
    assert.ok(isRecord(initResp["result"]) && isRecord(initResp["result"]["capabilities"]));
    assert.ok(Object.hasOwn(initResp["result"]["capabilities"], "tools"));

    rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listResp = await waitForId(2);
    assert.ok(isRecord(listResp["result"]) && Array.isArray(listResp["result"]["tools"]));
    const toolNames = new Set(
      listResp["result"]["tools"]
        .filter((t): t is Record<string, unknown> => isRecord(t))
        .map((t) => strField(t, "name")),
    );
    assert.ok(toolNames.has("fleet_dispatch"));
    assert.ok(toolNames.has("fleet_view"));
    assert.ok(toolNames.has("fleet_snooze"));
    assert.ok(toolNames.has("fleet_close"));

    rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "fleet_dispatch",
        arguments: { title: "MCP stdio self card", body: "Spec details" },
      },
    });
    const dispatchResp = await waitForId(3);
    assert.ok(
      isRecord(dispatchResp["result"]) &&
        isRecord(dispatchResp["result"]["structuredContent"]) &&
        isRecord(dispatchResp["result"]["structuredContent"]["card"]),
    );
    const cardId = strField(dispatchResp["result"]["structuredContent"]["card"], "id");
    assert.ok(cardId.length > 0);

    const snoozeRequestedAt = Date.now();
    rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "fleet_snooze",
        arguments: { id: cardId, duration: "15m", reason: "waiting" },
      },
    });
    const snoozeResp = await waitForId(4);
    const snoozeReturnedAt = Date.now();
    assert.ok(
      isRecord(snoozeResp["result"]) &&
        isRecord(snoozeResp["result"]["structuredContent"]) &&
        isRecord(snoozeResp["result"]["structuredContent"]["card"]),
    );
    const snoozeUntil = snoozeResp["result"]["structuredContent"]["card"]["snoozeUntil"];
    assert.equal(typeof snoozeUntil, "number");
    assert.ok(typeof snoozeUntil === "number");
    assert.ok(snoozeUntil >= snoozeRequestedAt + 15 * 60_000);
    assert.ok(snoozeUntil <= snoozeReturnedAt + 15 * 60_000);

    rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "fleet_snooze", arguments: { id: cardId, duration: "bogus" } },
    });
    const badDurationResp = await waitForId(5);
    assert.ok(isRecord(badDurationResp["result"]));
    assert.equal(badDurationResp["result"]["isError"], true);

    rpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "fleet_close", arguments: { id: cardId, text: "done via mcp" } },
    });
    const closeResp = await waitForId(6);
    assert.ok(
      isRecord(closeResp["result"]) &&
        isRecord(closeResp["result"]["structuredContent"]) &&
        isRecord(closeResp["result"]["structuredContent"]["card"]),
    );
    assert.equal(closeResp["result"]["structuredContent"]["card"]["state"], "done");

    rpc({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "fleet_nonexistent", arguments: {} },
    });
    const unknownResp = await waitForId(7);
    assert.ok(isRecord(unknownResp["error"]));
    assert.equal(unknownResp["error"]["code"], -32_602);

    child.stdin.end();
    assert.equal(await waitForExit(child), 0);
  } finally {
    rl.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    await server.stop();
  }
});

async function postMcp(
  endpoint: string,
  body: Record<string, unknown>,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<{ readonly status: number; readonly json: Record<string, unknown> | null }> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (text.trim().length === 0) return { status: res.status, json: null };
  const parsed: unknown = JSON.parse(text);
  return { status: res.status, json: isRecord(parsed) ? parsed : null };
}

void test("fleet mcp --http serves Streamable HTTP MCP with per-mate scoping and ingress guards", async () => {
  const server = await startTestServer({
    parents: { "1stmate": "captain", cleo: "1stmate", cnp: "1stmate" },
  });
  const portProbe = createServer();
  await new Promise<void>((resolve) => {
    portProbe.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const probeAddr = portProbe.address();
  assert.ok(probeAddr !== null && typeof probeAddr === "object");
  const mcpPort = probeAddr.port;
  await new Promise<void>((resolve) => {
    portProbe.close(() => {
      resolve();
    });
  });
  const child = spawn(
    process.execPath,
    [BIN_PATH, "mcp", "--http", "--host", "127.0.0.1", "--port", String(mcpPort)],
    {
      env: { ...process.env, BOARD_URL: server.url },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderrText = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });

  try {
    await waitFor(() => /fleet mcp listening at http:\/\/127\.0\.0\.1:\d+\/mcp/u.test(stderrText));
    const match = /fleet mcp listening at (http:\/\/127\.0\.0\.1:\d+\/mcp)/u.exec(stderrText);
    assert.ok(match?.[1] !== undefined);
    const mcpUrl = match[1];

    const missingMate = await postMcp(mcpUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    assert.equal(missingMate.status, 400);

    const foreignOrigin = await postMcp(
      `${mcpUrl}?mate=1stmate`,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { origin: "https://evil.example" },
    );
    assert.equal(foreignOrigin.status, 403);

    const badMethod = await fetch(`${mcpUrl}?mate=1stmate`, { method: "GET" });
    assert.equal(badMethod.status, 405);

    const notif = await postMcp(`${mcpUrl}?mate=1stmate`, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(notif.status, 202);

    const createdCleo = await postMcp(`${mcpUrl}?mate=1stmate`, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "fleet_dispatch", arguments: { mate: "cleo", title: "Cleo HTTP MCP card" } },
    });
    assert.equal(createdCleo.status, 200);

    const createdCnp = await postMcp(`${mcpUrl}?mate=1stmate`, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "fleet_dispatch", arguments: { mate: "cnp", title: "CNP private MCP card" } },
    });
    assert.equal(createdCnp.status, 200);
    assert.ok(
      createdCnp.json !== null &&
        isRecord(createdCnp.json["result"]) &&
        isRecord(createdCnp.json["result"]["structuredContent"]) &&
        isRecord(createdCnp.json["result"]["structuredContent"]["card"]) &&
        createdCnp.json["result"]["structuredContent"]["card"]["title"] === "CNP private MCP card",
    );

    const cleoCards = await postMcp(
      mcpUrl,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "fleet_cards", arguments: { state: "open" } },
      },
      { "x-fleet-mate": "cleo" },
    );
    assert.equal(cleoCards.status, 200);
    assert.ok(
      cleoCards.json !== null &&
        isRecord(cleoCards.json["result"]) &&
        isRecord(cleoCards.json["result"]["structuredContent"]) &&
        Array.isArray(cleoCards.json["result"]["structuredContent"]["cards"]),
    );
    const titles = cleoCards.json["result"]["structuredContent"]["cards"]
      .filter((c): c is Record<string, unknown> => isRecord(c))
      .map((c) => strField(c, "title"));
    assert.deepEqual(titles, ["Cleo HTTP MCP card"]);

    const writeCharter = await postMcp(`${mcpUrl}?mate=1stmate`, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "fleet_charter", arguments: { text: "overwrite" } },
    });
    assert.ok(
      writeCharter.json !== null &&
        isRecord(writeCharter.json["result"]) &&
        writeCharter.json["result"]["isError"] === true,
    );

    const oversized = await postMcp(`${mcpUrl}?mate=1stmate`, {
      jsonrpc: "2.0",
      id: 6,
      method: "ping",
      padding: "x".repeat(2_000_000),
    });
    assert.equal(oversized.status, 413);

    const health = await fetch(new URL("/health", mcpUrl));
    assert.equal(health.status, 404);

    const alive = await postMcp(`${mcpUrl}?mate=1stmate`, {
      jsonrpc: "2.0",
      id: 7,
      method: "ping",
    });
    assert.equal(alive.status, 200);

    child.kill("SIGTERM");
    assert.equal(await waitForExit(child), 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    await server.stop();
  }
});
