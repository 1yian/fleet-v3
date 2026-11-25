import type { IncomingMessage } from "node:http";
import { BoardError } from "./types.ts";

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

export function checkWriteIngress(req: IncomingMessage): BoardError | undefined {
  if (SAFE_METHODS.has(req.method ?? "GET")) return undefined;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const sameHost = URL.canParse(origin) && new URL(origin).host === req.headers.host;
    if (!sameHost) {
      return new BoardError(403, "foreign_origin", "Cross-origin writes are not accepted");
    }
  }
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return new BoardError(415, "unsupported_media_type", "Writes must be application/json");
  }
  return undefined;
}
