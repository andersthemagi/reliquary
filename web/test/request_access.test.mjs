// Request access (src/requestaccess.ts): a signed-out visitor's form that
// emails the operator, with Resend faked by a server in this file
// (RESEND_API_URL). Starts its own web server from dist/ with
// TRUST_PROXY_IP=1, and each test sends from an address of its own
// (x-real-ip), so the per-IP limit counts that test's requests only.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const TO = "ops@access.example.test";

const calls = [];
let answers = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    calls.push(JSON.parse(body));
    const a = answers.shift() ?? { status: 200, json: { id: randomUUID() } };
    res.writeHead(a.status, { "content-type": "application/json" });
    res.end(JSON.stringify(a.json));
  });
});

let child;
let origin = "";
let log = "";

before(async () => {
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const port = await new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
  origin = `http://127.0.0.1:${port}`;
  const base = { ...process.env };
  for (const k of ["RESEND_API_KEY", "EMAIL_FROM", "RESEND_API_URL", "FEEDBACK_EMAIL", "NETLIFY", "SELF_HOSTED", "RATE_LIMIT_SCALE", "RATE_LIMITS"]) delete base[k];
  child = spawn(process.execPath, ["dist/server.js"], {
    env: {
      ...base,
      DATABASE_URL: WEB_DB,
      LOCAL_USER_ID: randomUUID(),
      LOGIN_FILE: `/tmp/access-login-${process.pid}-${port}`,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_URL: "",
      TRUST_PROXY_IP: "1",
      RESEND_API_KEY: `re_test_${randomBytes(16).toString("hex")}`,
      EMAIL_FROM: "Reliquary <no-reply@notify.example.test>",
      RESEND_API_URL: `http://127.0.0.1:${fake.address().port}`,
      FEEDBACK_EMAIL: TO,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(() => {
  child?.kill();
  fake.close();
});

// A visitor: one address, the form's cookie, and its token.
async function visitor() {
  const ip = `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join(".")}`;
  const r = await fetch(`${origin}/request-access`, { headers: { "x-real-ip": ip } });
  assert.equal(r.status, 200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await r.text())[1];
  const send = async (fields, opts = {}) => {
    const res = await fetch(`${origin}/request-access`, {
      method: "POST",
      headers: { "x-real-ip": ip, origin, "content-type": "application/x-www-form-urlencoded", cookie: opts.cookie ?? cookie },
      body: new URLSearchParams({ csrf, ...fields }),
      redirect: "manual",
    });
    return { status: res.status, html: await res.text() };
  };
  return { send };
}

const email = () => `o'neil+${randomBytes(3).toString("hex")}@example.test`;

test("request access: a request emails the operator, escaped, with the visitor as Reply-To, where they are based and how to let them in, and the page says it was sent", async () => {
  calls.length = 0;
  const v = await visitor();
  const from = email();
  const r = await v.send({ email: from, name: "Ana <b>", place: "Canada", note: "Three of us, on Claude and Cursor.\n<script>x</script>" });
  assert.equal(r.status, 200);
  assert.match(r.html, /<h1>Request sent<\/h1>/);
  assert.equal(calls.length, 1);
  const b = calls[0];
  assert.deepEqual(b.to, [TO]);
  assert.equal(b.reply_to, from);
  assert.equal(b.subject, `Reliquary: access request, ${from}`);
  assert.ok(b.html.includes("Ana &lt;b&gt;"));
  assert.ok(b.html.includes("Three of us, on Claude and Cursor.\n&lt;script&gt;x&lt;/script&gt;"));
  assert.ok(b.html.includes("Based in</th><td"), "where they're based");
  assert.ok(b.html.includes(">Canada</td>"));
  assert.ok(b.html.includes(`To let them in, invite ${from.replace("'", "&#39;")} to a vault`));
  assert.ok(!log.includes(from), "the address never reaches the log");
});

test("request access: a filled trap field sends nothing and answers as if it had", async () => {
  calls.length = 0;
  const r = await (await visitor()).send({ email: email(), place: "US", note: "hi", website: "spam.example" });
  assert.equal(r.status, 200);
  assert.match(r.html, /<h1>Request sent<\/h1>/);
  assert.equal(calls.length, 0);
});

test("request access: a post without the form's cookie sends nothing and keeps what was typed", async () => {
  calls.length = 0;
  const r = await (await visitor()).send({ email: email(), place: "US", note: "kept note" }, { cookie: "" });
  assert.equal(r.status, 403);
  assert.match(r.html, /That form expired[^<]*\(ref [\w-]+\)/);
  assert.match(r.html, />kept note<\/textarea>/);
  assert.equal(calls.length, 0);
});

test("request access: when the email can't be sent, the page says why with a ref, keeps what was typed and gives the address to write to", async () => {
  calls.length = 0;
  answers = [{ status: 422, json: { name: "validation_error", message: "Invalid from" } }];
  const r = await (await visitor()).send({ email: email(), place: "US", note: "kept on failure" });
  assert.equal(r.status, 502);
  assert.match(r.html, /Your request wasn’t sent: Resend answered 422 \(validation_error\): Invalid from \(ref [\w-]+\)\. Email ops@access\.example\.test instead, with what you typed below\./);
  assert.match(r.html, />kept on failure<\/textarea>/);
});

test("request access: one network sends at most 5 requests an hour, then gets 429 with when to come back", async () => {
  calls.length = 0;
  const v = await visitor();
  for (let i = 0; i < 5; i++) assert.equal((await v.send({ email: email(), place: "US", note: `n${i}` })).status, 200);
  const r = await v.send({ email: email(), place: "US", note: "sixth" });
  assert.equal(r.status, 429);
  assert.match(r.html, /too many access requests from this network/);
  assert.equal(calls.length, 5);
});

test("request access: a request without a country is refused, sends nothing and keeps what was typed", async () => {
  calls.length = 0;
  const r = await (await visitor()).send({ email: email(), note: "kept without a country" });
  assert.equal(r.status, 400);
  assert.match(r.html, /Say which country you’re based in/);
  assert.match(r.html, /id="place"[^>]*aria-invalid="true"/);
  assert.match(r.html, />kept without a country<\/textarea>/);
  assert.equal(calls.length, 0);
});
