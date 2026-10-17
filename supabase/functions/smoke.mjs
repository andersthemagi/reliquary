// The real `embed` function, in the real edge runtime (smoke.sh starts it):
// its contract, and gte-small's sense of meaning. Not in ./test.sh: the
// runtime downloads the model on first use, which needs the network.

import assert from "node:assert/strict";

const { EMBED_URL, EMBED_SECRET } = process.env;
const post = (body, secret = EMBED_SECRET) =>
  fetch(EMBED_URL, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) });

assert.equal((await post({ input: ["x"] }, "wrong")).status, 401, "a wrong secret is refused");
assert.equal((await post({ input: [] })).status, 400, "no input is refused");
assert.equal((await post({ input: ["x".repeat(2001)] })).status, 400, "a text over 2,000 characters is refused");

const res = await post({ input: ["what are we charging teams", "Seats and plans: priced per seat.", "Tomatoes need sun in the garden."] });
assert.equal(res.status, 200);
const { embeddings: [q, pricing, garden] } = await res.json();
assert.equal(q.length, 384, "384 dimensions");
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
console.log(`similarity: question to pricing ${cos(q, pricing).toFixed(3)}, question to garden ${cos(q, garden).toFixed(3)} (EMBED_MIN_SIMILARITY defaults to 0.78)`);
assert.ok(Math.abs(cos(q, q) - 1) < 1e-3, "normalised");
assert.ok(cos(q, pricing) > cos(q, garden), "the question is nearer the pricing note than the garden");
console.log("smoke: ok");
