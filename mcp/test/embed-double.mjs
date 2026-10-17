// A stand-in for the `embed` Edge Function (supabase/functions/embed) in
// the test suites: the same HTTP contract, with deterministic vectors in
// place of gte-small's. Each word counts toward one of 384 dimensions,
// chosen by its "concept": a few words share one (money, below), so texts
// with no words in common can still mean the same thing. Everything else
// is its own concept. The real model is checked by
// supabase/functions/smoke.sh, outside the default run.
//
//   POST /        the function's contract (EMBED_SECRET, {"input": [...]})
//   POST /_status {"status": 503}  answer every call with that status from
//                 now on (200: answer normally again)
//   GET  /_calls  {"calls": n, "inputs": n} answered so far

import http from "node:http";
import { createHash } from "node:crypto";

const SECRET = process.env.EMBED_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 8800);
const CONCEPTS = { money: ["charging", "charge", "price", "priced", "pricing", "seat", "seats", "plan", "plans", "billing", "cost", "costs"] };
const STOP = new Set(["a", "an", "and", "are", "the", "we", "you", "what", "is", "of", "to", "per", "how", "do", "our"]);
const concept = new Map(Object.entries(CONCEPTS).flatMap(([c, words]) => words.map((w) => [w, c])));
const dim = (s) => createHash("sha256").update(s).digest().readUInt32BE(0) % 384;

export function vector(text) {
  const v = new Array(384).fill(0);
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) if (!STOP.has(w)) v[dim(concept.get(w) ?? w)] += 1;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

let status = 200;
let calls = 0;
let inputs = 0;
const send = (res, code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));

http
  .createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/_status") return send(res, 200, { status: (status = JSON.parse(raw).status) });
    if (req.url === "/_calls") return send(res, 200, { calls, inputs });
    if (req.method !== "POST") return send(res, 405, { error: "method" });
    if (req.headers.authorization !== `Bearer ${SECRET}`) return send(res, 401, { error: "unauthorized" });
    const input = JSON.parse(raw).input;
    if (!Array.isArray(input) || input.length < 1 || input.length > 16 || !input.every((t) => typeof t === "string" && t.length <= 2000)) {
      return send(res, 400, { error: "bad_input" });
    }
    if (status !== 200) return send(res, status, { error: "down" });
    calls += 1;
    inputs += input.length;
    send(res, 200, { embeddings: input.map(vector) });
  })
  .listen(PORT, "127.0.0.1");
