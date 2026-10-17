import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Text in, vectors out: gte-small embeddings for search by meaning
// (docs/design.md, "Search"). Stateless on purpose: no database
// credentials, nothing stored, and the model runs inside Supabase, so vault
// text never reaches a third party.
//
// The contract (mcp/src/embeddings.ts calls it; mcp/test/embed-double.mjs
// imitates it in the test suites):
//   POST, Authorization: Bearer <EMBED_SECRET>, {"input": [string, ...]}
//   with 1 to 16 strings of at most 2,000 characters
//   200 {"embeddings": [[384 numbers], ...]}, one per input, in order
//   401 / 400 / 405 / 503 {"error": code, "message": words}
// Nothing here logs an input or the secret.

const MODEL = new Supabase.ai.Session("gte-small");
const MAX_INPUTS = 16;
const MAX_CHARS = 2000;

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, error: string, message: string) => answer(status, { error, message });

// Compares digests, so the time taken says nothing about the secret.
async function sameSecret(given: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, secret].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("EMBED_SECRET") ?? "";
  if (!secret) return refuse(503, "not_configured", "This function has no EMBED_SECRET set, so it answers nobody.");
  if (req.method !== "POST") return refuse(405, "method", "Only POST is answered.");
  const auth = req.headers.get("authorization") ?? "";
  if (!(await sameSecret(auth, `Bearer ${secret}`))) return refuse(401, "unauthorized", "The Authorization header doesn't carry this function's secret.");
  let input: unknown;
  try {
    input = (await req.json())?.input;
  } catch {
    return refuse(400, "bad_body", "The body isn't JSON.");
  }
  if (
    !Array.isArray(input) || input.length < 1 || input.length > MAX_INPUTS ||
    !input.every((t) => typeof t === "string" && t.length <= MAX_CHARS)
  ) {
    return refuse(400, "bad_input", `input must be 1 to ${MAX_INPUTS} strings of at most ${MAX_CHARS} characters.`);
  }
  const embeddings: number[][] = [];
  for (const text of input as string[]) {
    embeddings.push(Array.from((await MODEL.run(text, { mean_pool: true, normalize: true })) as number[]));
  }
  return answer(200, { embeddings });
});
