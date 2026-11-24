import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { KANBAN_HTML } from "./kanban-html.ts";

export interface KanbanServerOptions {
  readonly boardUrl: string;
  readonly host: string;
  readonly port: number;
}

async function readBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
    else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  const joined = Buffer.concat(chunks);
  const copy = new Uint8Array(new ArrayBuffer(joined.byteLength));
  copy.set(joined);
  return copy;
}

function forwardHeaders(source: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of source.entries()) {
    const lower = key.toLowerCase();
    if (lower !== "transfer-encoding" && lower !== "content-length" && lower !== "connection") {
      out[key] = value;
    }
  }
  return out;
}

async function proxyUpstream(
  baseUrl: string,
  req: IncomingMessage,
  res: ServerResponse,
  rawPath: string,
): Promise<void> {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const body = await readBody(req);
  const headers: Record<string, string> = {};
  const contentType = req.headers["content-type"];
  if (typeof contentType === "string") headers["content-type"] = contentType;
  const accept = req.headers["accept"];
  if (typeof accept === "string") headers["accept"] = accept;
  const lastEventId = req.headers["last-event-id"];
  if (typeof lastEventId === "string") headers["last-event-id"] = lastEventId;

  const cleanBase = baseUrl.replace(/\/+$/u, "");
  const upstream = await fetch(`${cleanBase}${rawPath}`, {
    method: req.method ?? "GET",
    headers,
    ...(body !== undefined ? { body } : {}),
    signal: controller.signal,
  });

  res.writeHead(upstream.status, forwardHeaders(upstream.headers));
  if (upstream.body === null) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    controller.abort();
  } finally {
    reader.releaseLock();
    if (!res.writableEnded) res.end();
  }
}

export async function startKanbanServer(
  options: KanbanServerOptions,
): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const rawUrl = req.url ?? "/";
        if (rawUrl === "/" || rawUrl.startsWith("/?")) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(KANBAN_HTML);
          return;
        }
        if (rawUrl.startsWith("/api/")) {
          await proxyUpstream(options.boardUrl, req, res, rawUrl);
          return;
        }
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
      } catch (error) {
        if (!res.headersSent) {
          const message = error instanceof Error ? error.message : String(error);
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: message }));
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : options.port;
  return { server, url: `http://${options.host}:${String(actualPort)}` };
}
