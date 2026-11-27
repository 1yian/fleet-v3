import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startTestServer, waitFor } from "./support.ts";

const BIN_PATH = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const TOKEN = "events-test-token-0123456789abcdef";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(value: unknown, key: string): Record<string, unknown> {
  const field = isRecord(value) ? value[key] : undefined;
  assert.ok(isRecord(field), `expected object at ${key}`);
  return field;
}

function stringField(value: unknown, key: string): string {
  const field = isRecord(value) ? value[key] : undefined;
  assert.equal(typeof field, "string", `expected string at ${key}`);
  return String(field);
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once("exit", (code) => {
      resolve(code);
    });
  });
}

interface RunningBridge {
  readonly url: string;
  readonly stop: () => Promise<number | null>;
}

async function startBridge(
  boardUrl: string,
  statePath: string,
  extraArgs: readonly string[],
): Promise<RunningBridge> {
  const child = spawn(
    process.execPath,
    [BIN_PATH, "events", "--mate", "1stmate", "--port", "0", "--state", statePath, ...extraArgs],
    {
      env: { ...process.env, BOARD_URL: boardUrl, FLEET_EVENTS_TOKEN: TOKEN },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const matcher = /fleet events listening at (http:\/\/127\.0\.0\.1:\d+\/mcp)/u;
  assert.ok(await waitFor(() => matcher.test(stderr), 10_000), `bridge did not start: ${stderr}`);
  const match = matcher.exec(stderr);
  assert.ok(match?.[1] !== undefined);
  return {
    url: match[1],
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      return waitForExit(child);
    },
  };
}

interface Hit {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly raw: string;
  readonly body: Record<string, unknown>;
}

interface Receiver {
  readonly url: string;
  readonly hits: Hit[];
  readonly mode: { failNext: number; wrongChallenge: boolean };
  readonly stop: () => Promise<void>;
}

function signatureOf(secret: string, id: string, timestamp: string, raw: string): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64")}`;
}

function assertSigned(secret: string, hit: Hit): void {
  const id = String(hit.headers["webhook-id"]);
  const timestamp = String(hit.headers["webhook-timestamp"]);
  const signatures = String(hit.headers["webhook-signature"]).split(" ");
  assert.ok(signatures.includes(signatureOf(secret, id, timestamp, hit.raw)));
  assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 30);
}

async function startReceiver(): Promise<Receiver> {
  const hits: Hit[] = [];
  const mode = { failNext: 0, wrongChallenge: false };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const parsed: unknown = JSON.parse(raw);
      const body = isRecord(parsed) ? parsed : {};
      hits.push({ headers: req.headers, raw, body });
      if (body["type"] === "verification") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ challenge: mode.wrongChallenge ? "nope" : body["challenge"] }));
        return;
      }
      if (mode.failNext > 0) {
        mode.failNext -= 1;
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    url: `http://127.0.0.1:${String(address.port)}/hook`,
    hits,
    mode,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

const AUTHORIZED = { authorization: `Bearer ${TOKEN}` };
const MODERN_HEADERS = { "mcp-protocol-version": "2026-07-28" };
const METHOD_NOT_FOUND = -32_601;
const INVALID_PARAMS = -32_602;
const NOT_FOUND = -32_023;
const CALLBACK_ENDPOINT_ERROR = -32_015;
const HOUR_MS = 3_600_000;

interface Reply {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function call(
  endpoint: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<Reply> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? AUTHORIZED) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : {};
  return { status: res.status, json: isRecord(parsed) ? parsed : {} };
}

async function rpcResult(
  endpoint: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reply = await call(endpoint, { jsonrpc: "2.0", id: 1, method, params });
  return recordField(reply.json, "result");
}

async function rpcFailure(
  endpoint: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reply = await call(endpoint, { jsonrpc: "2.0", id: 1, method, params });
  return recordField(reply.json, "error");
}

function newSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

function subscribeParams(
  url: string,
  secret: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "card.wake",
    arguments: {},
    delivery: { mode: "webhook", url, secret },
    cursor: null,
    ...extra,
  };
}

function unsubscribeParams(url: string): Record<string, unknown> {
  return { name: "card.wake", arguments: {}, delivery: { mode: "webhook", url } };
}

function eventHits(receiver: Receiver): Hit[] {
  return receiver.hits.filter((hit) => hit.body["type"] !== "verification");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function statusOf(endpoint: string, headers?: Record<string, string>): Promise<number> {
  const reply = await call(endpoint, { jsonrpc: "2.0", id: 1, method: "ping" }, headers);
  return reply.status;
}

async function assertEndpointGuards(endpoint: string): Promise<void> {
  assert.equal(await statusOf(endpoint, {}), 401);
  assert.equal(await statusOf(endpoint, { authorization: "Bearer wrong" }), 401);
  assert.equal(await statusOf(endpoint, { ...AUTHORIZED, origin: "https://evil.example" }), 403);
  assert.equal(
    await statusOf(endpoint, { ...AUTHORIZED, "mcp-protocol-version": "2024-11-05" }),
    400,
  );
  assert.equal(await statusOf(`${endpoint}/${TOKEN}`, {}), 200);
  const wrongVerb = await fetch(endpoint, { method: "GET" });
  assert.equal(wrongVerb.status, 405);
}

async function assertEventsOnlyCapability(endpoint: string): Promise<void> {
  const init = await rpcResult(endpoint, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1" },
  });
  assert.deepEqual(Object.keys(recordField(init, "capabilities")), ["events"]);
  const noTools = await rpcFailure(endpoint, "tools/list");
  assert.equal(noTools["code"], METHOD_NOT_FOUND);

  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
  const modernHeaders = { ...AUTHORIZED, ...MODERN_HEADERS, "mcp-method": "server/discover" };
  const discover = await call(
    endpoint,
    { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } },
    modernHeaders,
  );
  const discovered = recordField(discover.json, "result");
  assert.equal(discovered["resultType"], "complete");
  assert.deepEqual(discovered["supportedVersions"], ["2026-07-28"]);
  assert.deepEqual(Object.keys(recordField(discovered, "capabilities")), ["events"]);

  const mismatched = await call(
    endpoint,
    { jsonrpc: "2.0", id: 1, method: "events/list", params: { _meta: meta } },
    modernHeaders,
  );
  assert.equal(mismatched.status, 400);
}

async function assertEventCatalog(endpoint: string): Promise<void> {
  const listed = await rpcResult(endpoint, "events/list");
  const events = listed["events"];
  assert.ok(Array.isArray(events) && events.length === 1);
  const definition: unknown = events[0];
  assert.equal(stringField(definition, "name"), "card.wake");
  assert.deepEqual(recordField(definition, "payloadSchema")["required"], [
    "mate",
    "eventType",
    "summary",
  ]);
}

async function assertSubscribeRejections(
  endpoint: string,
  receiver: Receiver,
  secret: string,
): Promise<void> {
  const shortSecret = await rpcFailure(
    endpoint,
    "events/subscribe",
    subscribeParams(receiver.url, "whsec_short"),
  );
  assert.equal(shortSecret["code"], INVALID_PARAMS);
  const unknownEvent = await rpcFailure(
    endpoint,
    "events/subscribe",
    subscribeParams(receiver.url, secret, { name: "other.event" }),
  );
  assert.equal(unknownEvent["code"], NOT_FOUND);

  receiver.mode.wrongChallenge = true;
  const failure = await rpcFailure(
    endpoint,
    "events/subscribe",
    subscribeParams(receiver.url, secret),
  );
  receiver.mode.wrongChallenge = false;
  assert.equal(failure["code"], CALLBACK_ENDPOINT_ERROR);
  assert.equal(recordField(failure, "data")["reason"], "challenge_failed");
  receiver.hits.length = 0;
}

void test("fleet events wakes a subscribed MCP Events client with signed webhooks that survive restart, retry, and refresh", async () => {
  const board = await startTestServer({ parents: { "1stmate": "captain" } });
  const receiver = await startReceiver();
  const stale = await startReceiver();
  const root = mkdtempSync(join(tmpdir(), "fleet-events-"));
  const statePath = join(root, "state", "1stmate.json");
  const secret = newSecret();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge(board.url, statePath, ["--allow-local-callbacks"]);
    let endpoint = bridge.url;
    await assertEndpointGuards(endpoint);
    await assertEventsOnlyCapability(endpoint);
    await assertEventCatalog(endpoint);
    await assertSubscribeRejections(endpoint, receiver, secret);

    const granted = await rpcResult(
      endpoint,
      "events/subscribe",
      subscribeParams(receiver.url, secret, { ttlMs: HOUR_MS }),
    );
    const subscriptionId = stringField(granted, "id");
    const refreshBefore = Date.parse(stringField(granted, "refreshBefore"));
    assert.ok(Math.abs(refreshBefore - (Date.now() + HOUR_MS)) < 10_000);
    assert.equal(granted["cursor"], null);
    const verification = receiver.hits[0];
    assert.ok(verification !== undefined);
    assert.equal(verification.body["type"], "verification");
    assert.equal(verification.headers["x-mcp-subscription-id"], subscriptionId);
    assert.match(String(verification.headers["webhook-id"]), /^msg_verification_/u);
    assertSigned(secret, verification);

    const refreshed = await rpcResult(
      endpoint,
      "events/subscribe",
      subscribeParams(receiver.url, secret, { ttlMs: 2 * HOUR_MS }),
    );
    assert.equal(refreshed["id"], subscriptionId);
    assert.ok(Date.parse(stringField(refreshed, "refreshBefore")) > refreshBefore + HOUR_MS / 2);
    assert.equal(receiver.hits.length, 1);

    const card = await board.client.createCard({
      mate: "1stmate",
      title: "Wake the dot",
      actor: "captain",
    });
    assert.ok(await waitFor(() => eventHits(receiver).length === 1, 5000));
    const delivered = eventHits(receiver)[0];
    assert.ok(delivered !== undefined);
    assertSigned(secret, delivered);
    assert.equal(delivered.headers["x-mcp-subscription-id"], subscriptionId);
    assert.equal(delivered.headers["webhook-id"], delivered.body["eventId"]);
    assert.equal(delivered.body["name"], "card.wake");
    assert.equal(delivered.body["cursor"], null);
    const timestamp = stringField(delivered.body, "timestamp");
    assert.ok(Number.isFinite(Date.parse(timestamp)));
    const data = recordField(delivered.body, "data");
    assert.equal(data["cardId"], card.id);
    assert.equal(data["mate"], "1stmate");
    assert.equal(data["eventType"], "card.created");
    assert.match(stringField(data, "summary"), /Wake the dot/u);

    receiver.mode.failNext = 1;
    await board.client.createCard({ mate: "1stmate", title: "Retry me", actor: "captain" });
    assert.ok(await waitFor(() => eventHits(receiver).length === 3, 8000));
    const [, firstAttempt, secondAttempt] = eventHits(receiver);
    assert.equal(firstAttempt?.body["eventId"], secondAttempt?.body["eventId"]);

    assert.equal(await bridge.stop(), 0);
    const persisted: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    const stored: unknown = isRecord(persisted) ? persisted["subscriptions"] : undefined;
    assert.ok(Array.isArray(stored) && stored.length === 1);
    assert.equal(stringField(stored[0], "id"), subscriptionId);
    const expired = {
      id: "sub_expired",
      url: stale.url,
      secret,
      refreshBefore: Date.now() - 1000,
      verifiedAt: Date.now() - 5000,
    };
    const kept: unknown[] = stored;
    writeFileSync(statePath, JSON.stringify({ subscriptions: [...kept, expired] }));

    bridge = await startBridge(board.url, statePath, ["--allow-local-callbacks"]);
    endpoint = bridge.url;
    await board.client.createCard({ mate: "1stmate", title: "After restart", actor: "captain" });
    assert.ok(await waitFor(() => eventHits(receiver).length === 4, 5000));
    const restartHit = eventHits(receiver)[3];
    const afterRestart = recordField(restartHit?.body, "data");
    assert.match(stringField(afterRestart, "summary"), /After restart/u);
    assert.equal(stale.hits.length, 0);

    const stop = unsubscribeParams(receiver.url);
    assert.deepEqual(await rpcResult(endpoint, "events/unsubscribe", stop), {});
    assert.deepEqual(await rpcResult(endpoint, "events/unsubscribe", stop), {});
    await board.client.createCard({ mate: "1stmate", title: "Nobody listens", actor: "captain" });
    await sleep(600);
    assert.equal(eventHits(receiver).length, 4);
    assert.equal(await bridge.stop(), 0);
    bridge = undefined;
    const emptied: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepEqual(isRecord(emptied) ? emptied["subscriptions"] : undefined, []);
  } finally {
    await bridge?.stop();
    await stale.stop();
    await receiver.stop();
    await board.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

void test("fleet events refuses to start without a token and blocks non-public or non-https callbacks by default", async () => {
  const board = await startTestServer({ parents: { "1stmate": "captain" } });
  const root = mkdtempSync(join(tmpdir(), "fleet-events-"));
  const statePath = join(root, "1stmate.json");
  let bridge: RunningBridge | undefined;
  try {
    const args = [BIN_PATH, "events", "--mate", "1stmate", "--state", statePath];
    const untokened = spawn(process.execPath, args, {
      env: { ...process.env, BOARD_URL: board.url, FLEET_EVENTS_TOKEN: "short" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    untokened.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    assert.notEqual(await waitForExit(untokened), 0);
    assert.match(stderr, /FLEET_EVENTS_TOKEN/u);

    bridge = await startBridge(board.url, statePath, []);
    const secret = newSecret();
    const plain = await rpcFailure(
      bridge.url,
      "events/subscribe",
      subscribeParams("http://example.com/hook", secret),
    );
    assert.equal(plain["code"], INVALID_PARAMS);
    const blockedUrls = [
      "https://127.0.0.1:9/hook",
      "https://[::1]:9/hook",
      "https://10.0.0.5/hook",
      "https://169.254.169.254/hook",
      "https://localhost:9/hook",
    ];
    for (const url of blockedUrls) {
      const error = await rpcFailure(bridge.url, "events/subscribe", subscribeParams(url, secret));
      assert.equal(error["code"], CALLBACK_ENDPOINT_ERROR, url);
      assert.equal(recordField(error, "data")["reason"], "blocked_destination", url);
    }
    assert.equal(await bridge.stop(), 0);
    bridge = undefined;
  } finally {
    await bridge?.stop();
    await board.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
