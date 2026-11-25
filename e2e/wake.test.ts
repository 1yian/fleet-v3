import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { attachFleetPiAdapter } from "../src/adapters/pi.ts";
import { createMockPi, startTestServer, waitFor } from "./support.ts";

const BIN_PATH = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
  });
}

function runBinOnce(
  args: readonly string[],
  envOverrides: Readonly<Record<string, string>> = {},
  omitKeys: readonly string[] = [],
): Promise<{ readonly exitCode: number | null; readonly output: string }> {
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
        resolve({ exitCode: typeof code === "number" ? code : null, output: `${stdout}${stderr}` });
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function strField(obj: Readonly<Record<string, unknown>> | undefined, key: string): string {
  const val = obj?.[key];
  return typeof val === "string" ? val : "";
}

void test("fleet watch streams filtered NDJSON wakes and rejects invalid flags", async () => {
  const server = await startTestServer({
    parents: { "1stmate": "captain", cleo: "1stmate" },
  });

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
      await sleep(250);

      const card = await server.client.createCard({
        mate: "cleo",
        title: "Watch NDJSON card",
        actor: "1stmate",
      });
      await waitFor(() => received.length > 0);
      assert.equal(strField(received[0], "mate"), "cleo");
      assert.match(strField(received[0], "notice"), /Watch NDJSON card/u);

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

void test("fleet watch --webhook POSTs JSON wakes with custom header and survives transient 500s", async () => {
  const server = await startTestServer({
    parents: { "1stmate": "captain", cleo: "1stmate" },
  });

  const hits: {
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
      await sleep(250);
      await server.client.createCard({
        mate: "cleo",
        title: "First webhook card",
        actor: "1stmate",
      });
      await waitFor(() => hits.length > 0 && stderrChunks.join("").includes("500"));

      await server.client.createCard({
        mate: "cleo",
        title: "Second webhook card",
        actor: "1stmate",
      });
      await waitFor(() => hits.length >= 2);

      assert.equal(hits[1]?.header, "top-secret");
      assert.equal(strField(hits[1]?.body, "mate"), "cleo");
      assert.match(strField(hits[1]?.body, "notice"), /Second webhook card/u);
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
  const server = await startTestServer({
    parents: { "1stmate": "captain", cleo: "1stmate" },
  });

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
          params: { protocolVersion: "2025-03-26", capabilities: {} },
        })}\n`,
      );
      await waitFor(() => messages.some((m) => m["id"] === 1));
      const initResp = messages.find((m) => m["id"] === 1);
      assert.ok(initResp !== undefined && isRecord(initResp["result"]));
      const capabilities = initResp["result"]["capabilities"];
      assert.ok(isRecord(capabilities) && isRecord(capabilities["experimental"]));
      assert.ok(Object.hasOwn(capabilities["experimental"], "claude/channel"));

      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
      await waitFor(
        () => messages.some((m) => m["id"] === 2) && messages.some((m) => m["id"] === 3),
      );

      await sleep(250);
      const card = await server.client.createCard({
        mate: "cleo",
        title: "Channel MCP card",
        actor: "1stmate",
      });

      await waitFor(() => messages.some((m) => m["method"] === "notifications/claude/channel"));
      const notif = messages.find((m) => m["method"] === "notifications/claude/channel");
      assert.ok(notif !== undefined && isRecord(notif["params"]));
      assert.match(strField(notif["params"], "content"), /Channel MCP card/u);
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

void test("Pi adapter attaches idempotently and injects prompts/mate.md when not already present", async () => {
  const server = await startTestServer({
    parents: { "1stmate": "captain", cleo: "1stmate" },
  });

  try {
    const mock = createMockPi();
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

    await mock.emitShutdown();
  } finally {
    await server.stop();
  }
});
