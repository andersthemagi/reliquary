// A size-capped JSON request body reader, shared by linkproxy.ts (server-to-
// server; no content-type check, since that caller's shape is fixed by
// server.ts's own routing) and envapi.ts (the env API, which also rejects
// anything not sent as application/json). BadRequest carries a fixed status
// and code -- never an echo of the request -- for each caller's own catch
// block to turn into a response.

import type http from "node:http";

export class BadRequest extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly why?: string, // fixed text, never the request's
  ) {
    super(code);
  }
}

export function readJson(req: http.IncomingMessage, limit: number, opts: { requireJsonContentType?: boolean } = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (opts.requireJsonContentType && !/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
      req.resume();
      reject(new BadRequest(415, "unsupported_media_type"));
      return;
    }
    if (Number(req.headers["content-length"] ?? 0) > limit) {
      req.resume();
      reject(new BadRequest(413, "too_large"));
      return;
    }
    let size = 0;
    let done = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        reject(new BadRequest(413, "too_large"));
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new BadRequest(400, "invalid_request"));
      }
    });
    req.on("error", reject);
  });
}
