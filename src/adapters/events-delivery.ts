import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { setTimeout as delayFor } from "node:timers/promises";
import { z } from "zod";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_EVENT_BYTES = 262_144;
const SECRET_PREFIX = "whsec_";
const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;
const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

const NON_PUBLIC_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const NON_PUBLIC_V6: readonly (readonly [string, number])[] = [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
];

const nonPublicRanges = new BlockList();
for (const [network, prefix] of NON_PUBLIC_V4) nonPublicRanges.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of NON_PUBLIC_V6) nonPublicRanges.addSubnet(network, prefix, "ipv6");

const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export type CallbackFailureReason =
  | "blocked_destination"
  | "challenge_failed"
  | "connection_refused"
  | "timeout"
  | "tls_error"
  | "http_4xx"
  | "http_5xx"
  | "unreachable";

export class CallbackError extends Error {
  public readonly reason: CallbackFailureReason;
  public readonly status: number | undefined;

  public constructor(reason: CallbackFailureReason, status?: number) {
    super(`Callback failed: ${reason}`);
    this.name = "CallbackError";
    this.reason = reason;
    this.status = status;
  }
}

export function decodeSigningSecret(secret: string): Buffer | undefined {
  if (!secret.startsWith(SECRET_PREFIX)) return undefined;
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return undefined;
  const key = Buffer.from(encoded, "base64");
  return key.length >= MIN_SECRET_BYTES && key.length <= MAX_SECRET_BYTES ? key : undefined;
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !nonPublicRanges.check(address, "ipv4");
  if (family === 6) {
    return globalV6.check(address, "ipv6") && !nonPublicRanges.check(address, "ipv6");
  }
  return false;
}

export interface CallbackPolicy {
  readonly allowLocal: boolean;
}

export function parseCallbackUrl(raw: string, policy: CallbackPolicy): URL | undefined {
  if (!URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  if (url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
  if (url.protocol === "https:") return url;
  return policy.allowLocal && url.protocol === "http:" ? url : undefined;
}

function signatureFor(key: Buffer, id: string, timestamp: string, body: string): string {
  const digest = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${digest}`;
}

export interface SigningSecrets {
  readonly current: string;
  readonly previous?: string | undefined;
}

function signedHeaders(
  secrets: SigningSecrets,
  subscriptionId: string,
  messageId: string,
  body: string,
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const keys = [secrets.current, secrets.previous].flatMap((secret) => {
    const key = secret === undefined ? undefined : decodeSigningSecret(secret);
    return key === undefined ? [] : [key];
  });
  return {
    "content-type": "application/json",
    "webhook-id": messageId,
    "webhook-timestamp": timestamp,
    "webhook-signature": keys.map((key) => signatureFor(key, messageId, timestamp, body)).join(" "),
    "x-mcp-subscription-id": subscriptionId,
  };
}

const validatedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true }, (error, addresses) => {
    if (error !== null) {
      callback(error, []);
      return;
    }
    const first = addresses[0];
    if (first === undefined || !addresses.every((entry) => isPublicAddress(entry.address))) {
      callback(Object.assign(new Error("blocked_destination"), { code: "EBLOCKED" }), []);
      return;
    }
    if (options.all === true) {
      callback(null, addresses);
      return;
    }
    callback(null, first.address, first.family);
  });
};

interface PostResult {
  readonly status: number;
  readonly body: string;
}

function failureFromError(error: unknown): CallbackError {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "EBLOCKED") return new CallbackError("blocked_destination");
  if (code === "ECONNREFUSED") return new CallbackError("connection_refused");
  if (code === "ETIMEDOUT" || code === "ABORT_TIMEOUT") return new CallbackError("timeout");
  if (
    code !== undefined &&
    (code.startsWith("ERR_TLS") ||
      code.startsWith("ERR_SSL") ||
      code.includes("CERT") ||
      code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
      code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE")
  ) {
    return new CallbackError("tls_error");
  }
  return new CallbackError("unreachable");
}

function postJson(
  url: URL,
  headers: Record<string, string>,
  body: string,
  policy: CallbackPolicy,
): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const bareHost = url.hostname.replaceAll(/^\[|\]$/gu, "");
    if (!policy.allowLocal && isIP(bareHost) !== 0 && !isPublicAddress(bareHost)) {
      reject(new CallbackError("blocked_destination"));
      return;
    }
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        agent: false,
        ...(policy.allowLocal ? {} : { lookup: validatedLookup }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        });
        res.once("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.once("error", (error) => {
          reject(failureFromError(error));
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error("timeout"), { code: "ABORT_TIMEOUT" }));
    });
    req.once("error", (error) => {
      reject(failureFromError(error));
    });
    req.end(body);
  });
}

function statusFailure(status: number): CallbackError {
  return new CallbackError(status >= 500 ? "http_5xx" : "http_4xx", status);
}

const ChallengeEchoSchema = z.object({ challenge: z.string() });

export function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function verifyCallback(
  url: URL,
  secret: string,
  subscriptionId: string,
  challenge: string,
  messageId: string,
  policy: CallbackPolicy,
): Promise<void> {
  const body = JSON.stringify({ type: "verification", challenge });
  const result = await postJson(
    url,
    signedHeaders({ current: secret }, subscriptionId, messageId, body),
    body,
    policy,
  );
  if (result.status < 200 || result.status >= 300) throw statusFailure(result.status);
  const echoed = ChallengeEchoSchema.safeParse(parseJson(result.body));
  if (!echoed.success || !safeEqual(echoed.data.challenge, challenge)) {
    throw new CallbackError("challenge_failed");
  }
}

export interface EventEnvelope {
  readonly eventId: string;
  readonly name: string;
  readonly timestamp: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly cursor: null;
}

export type DeliveryOutcome = "delivered" | "gone" | "dropped";

export async function deliverEvent(
  url: URL,
  secrets: SigningSecrets,
  subscriptionId: string,
  event: EventEnvelope,
  policy: CallbackPolicy,
  signal: AbortSignal,
): Promise<DeliveryOutcome> {
  const body = JSON.stringify(event);
  if (Buffer.byteLength(body) > MAX_EVENT_BYTES) return "dropped";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (signal.aborted) return "dropped";
    try {
      const result = await postJson(
        url,
        signedHeaders(secrets, subscriptionId, event.eventId, body),
        body,
        policy,
      );
      if (result.status >= 200 && result.status < 300) return "delivered";
      if (result.status === 410) return "gone";
      if (result.status === 413) return "dropped";
    } catch (error) {
      if (error instanceof CallbackError && error.reason === "blocked_destination") {
        return "dropped";
      }
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) break;
    await delayFor(delay, undefined, { signal }).catch(() => undefined);
  }
  return "dropped";
}
