// Search by meaning (docs/design.md, "Search"): calling the `embed` Edge
// Function (supabase/functions/embed), which turns text into gte-small
// vectors, and keeping a vault's vectors current from inside its searches.
//
// The function is a model call and nothing else; the queue, the gate and
// the lifecycle are in the database (20261017110000_semantic_search.sql).
// EMBED_SECRET authenticates this server to it and is never logged or
// shown; no error below carries it, or any text sent.

import type pg from "pg";
import { fail, Refusal } from "./failure.js";
import { openBody, storeBytes } from "./content.js";
import { vectorBytes } from "./search.js";
import { VAULT_REF } from "./tools-shared.js";

const DIMENSIONS = 384;
// The function's limits (supabase/functions/embed): 16 inputs a call, 2,000
// characters each. One call per search carries the query and up to 15
// chunks of queued files, which keeps a call well inside the edge
// runtime's CPU time.
const MAX_INPUTS = 16;
const CHUNK_CHARS = 1200;
// ponytail: a file's first 8 chunks (about 10 KB) are embedded; the rest of
// a long file is found by its words. More chunks (and the table's check)
// when long files need it.
const MAX_CHUNKS = 8;
const MAX_FILES = 8;
const TIMEOUT_MS = 8000;

let URL_ = "";
let SECRET = "";
let REGION = "";
let MIN_SIMILARITY = 0.78;

// Called once at startup (server.ts). No EMBED_URL: search by words alone.
export function configureEmbeddings(env: NodeJS.ProcessEnv): void {
  URL_ = env.EMBED_URL ?? "";
  SECRET = env.EMBED_SECRET ?? "";
  // Hosted, Supabase runs the function in the region nearest the caller
  // unless pinned: eu-central-1 keeps the text in the database's region.
  REGION = env.EMBED_REGION ?? "";
  if (URL_ && !/^https?:\/\/[^#]+$/.test(URL_)) throw new Error("Refusing to start: EMBED_URL must be an http(s) URL");
  if (URL_ && !SECRET) throw new Error("Refusing to start: EMBED_URL is set but EMBED_SECRET is not");
  // The calibration knob: gte-small rates unrelated texts around 0.7.
  const min = Number(env.EMBED_MIN_SIMILARITY || 0.78);
  if (!(min >= 0 && min <= 1)) throw new Error("Refusing to start: EMBED_MIN_SIMILARITY must be a number from 0 to 1");
  MIN_SIMILARITY = min;
}

export const minSimilarity = (): number => MIN_SIMILARITY;

// A file's text in chunks of whole lines, up to CHUNK_CHARS each (a longer
// line is cut), with each chunk's first line; blank chunks are skipped.
export function chunks(body: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let text = "";
  let line = 1;
  const flush = () => {
    if (text.trim() !== "") out.push({ line, text });
    text = "";
  };
  const lines = body.split("\n");
  for (let i = 0; i < lines.length && out.length < MAX_CHUNKS; i++) {
    let l = lines[i];
    if (text && text.length + 1 + l.length > CHUNK_CHARS) flush();
    if (!text) line = i + 1;
    while (l.length > CHUNK_CHARS && out.length < MAX_CHUNKS) {
      text = l.slice(0, CHUNK_CHARS);
      flush();
      line = i + 1;
      l = l.slice(CHUNK_CHARS);
    }
    text = text ? `${text}\n${l}` : l;
  }
  if (out.length < MAX_CHUNKS) flush();
  return out;
}

const WHERE = "embedding function";

async function embed(input: string[]): Promise<number[][]> {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}`, ...(REGION ? { "x-region": REGION } : {}) },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 401 is the one an operator causes: the secret was set in one place only.
  if (res.status === 401) {
    throw new Refusal({ status: 503, where: WHERE, why: "The embedding function answered 401: its EMBED_SECRET and this server's differ", code: "embed_secret" });
  }
  if (!res.ok) throw new Refusal({ status: 503, where: WHERE, why: `The embedding function answered ${res.status}`, code: "embed_status" });
  const body = (await res.json().catch(() => null)) as { embeddings?: unknown } | null;
  const e = body?.embeddings;
  if (!Array.isArray(e) || e.length !== input.length || !e.every((v) => Array.isArray(v) && v.length === DIMENSIONS && v.every(Number.isFinite))) {
    throw new Refusal({ status: 502, where: WHERE, why: `The embedding function's answer wasn't ${DIMENSIONS} numbers for each text`, code: "embed_shape" });
  }
  return e as number[][];
}

// The query's vector for public.search, after embedding up to 15 chunks of
// the vault's queued files in the same call and storing them. Null with a
// note for the response when the function can't answer: the failure is
// logged with its ref, and the search goes on by words. Null and no note
// when search by meaning isn't set up here. The database work runs under a
// savepoint, so a failure in it leaves the search's transaction usable.
export async function queryVector(c: pg.PoolClient, vault: string, query: string): Promise<{ vector: number[] | null; note: string }> {
  if (!URL_) return { vector: null, note: "" };
  await c.query("savepoint embed");
  try {
    const { rows } = await c.query(
      `select p.file_id, p.version_id, p.vault_id, p.body from ${VAULT_REF} cross join lateral private.embedding_pending(v.id, $2) p`,
      [vault, MAX_FILES],
    );
    const batch: { file: string; version: string; vault: string; parts: { line: number; text: string }[] }[] = [];
    let n = 1;
    for (const r of rows) {
      const parts = chunks(openBody(r.body, r.vault_id));
      if (n + parts.length > MAX_INPUTS) break;
      batch.push({ file: r.file_id, version: r.version_id, vault: r.vault_id, parts });
      n += parts.length;
    }
    const vectors = await embed([query, ...batch.flatMap((b) => b.parts.map((p) => p.text))]);
    let i = 1;
    for (const b of batch) {
      const stored = b.parts.map((p, chunk) => ({ chunk, line: p.line, embedding: storeBytes(vectorBytes(vectors[i++]), b.vault).toString("base64") }));
      await c.query("select private.store_embeddings($1, $2, $3::jsonb)", [b.file, b.version, JSON.stringify(stored)]);
    }
    await c.query("release savepoint embed");
    return { vector: vectors[0], note: "" };
  } catch (err) {
    await c.query("rollback to savepoint embed");
    // No such vault: the search says so itself, as for any tool.
    if ((err as { code?: string }).code === "RLV01") throw err;
    const f = fail(err, { where: WHERE });
    return {
      vector: null,
      note: `Search by meaning is unavailable right now (${f.why.replace(/\.$/, "")}; ref ${f.ref}). These results match words only.`,
    };
  }
}

// GET /healthz?embed=1 (server.ts, scripts/deploy-check.sh): whether search
// by meaning works here, without a vault. "off" when it isn't set up, "ok"
// when the function embedded a fixed text, otherwise why not, in words this
// file wrote (never the secret or a response body). An "ok" is kept a
// minute, so the probe can't be used to keep the function busy; a failure
// isn't, so a fixed secret shows at once.
let probedOk = 0;
export async function probe(): Promise<string> {
  if (!URL_) return "off";
  if (Date.now() - probedOk < 60_000) return "ok";
  try {
    await embed(["Reliquary health check"]);
    probedOk = Date.now();
    return "ok";
  } catch (err) {
    return err instanceof Refusal ? err.message : "The embedding function couldn't be reached";
  }
}
