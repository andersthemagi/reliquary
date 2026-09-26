// The self-hosted stack, end to end, as its first owner would use it
// (deploy/test.sh runs this in a node container on the host's network,
// against the published ports). Needs node 22 and nothing else.
//
// Environment:
//   WEB_URL    the web app (PUBLIC_URL), e.g. http://127.0.0.1:30502
//   MCP_URL    the MCP endpoint (MCP_RESOURCE)
//   MAIL_API   the mail catcher's API (Mailpit), where sign-in emails land
//   EMAIL      the owner's address (deploy/test.sh made the account with
//              deploy/bin/owner.mjs)
//
// Prints one line per step: `ok <step>` or `FAIL <step>: <why>`. Never
// prints a code, a token or a cookie.

const { WEB_URL, MCP_URL, MAIL_API, EMAIL } = process.env;
for (const [k, v] of Object.entries({ WEB_URL, MCP_URL, MAIL_API, EMAIL })) {
  if (!v) {
    console.error(`FAIL setup: ${k} is not set`);
    process.exit(2);
  }
}
const ORIGIN = new URL(WEB_URL).origin;

let failed = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err.message}`);
    throw err;
  }
}
const check = (cond, why) => {
  if (!cond) throw new Error(why);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A cookie jar for the web app: name -> value.
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function keep(res) {
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const gone = value === "" || attrs.some((a) => /max-age=0\b/i.test(a.trim()));
    if (gone) jar.delete(name);
    else jar.set(name, value);
  }
  return res;
}
const get = async (path) => keep(await fetch(WEB_URL + path, { headers: { cookie: cookieHeader() }, redirect: "manual" }));
const post = async (path, fields) =>
  keep(
    await fetch(WEB_URL + path, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: cookieHeader(), origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }),
  );
const field = (html, name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];

async function mcp(token, method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  check(res.ok, `MCP ${method} answered HTTP ${res.status}`);
  const json = JSON.parse(text);
  check(!json.error, `MCP ${method} returned a JSON-RPC error: ${json.error?.message}`);
  return json.result;
}
const toolText = (r) => (r.content ?? []).map((c) => c.text).join("\n");

let vaultId = "";
let codeFormCsrf = "";
let token = "";

try {
  await step("both apps answer /healthz", async () => {
    check((await fetch(`${WEB_URL}/healthz`)).ok, "the web app's /healthz isn't ok");
    check((await fetch(`${new URL(MCP_URL).origin}/healthz`)).ok, "the MCP server's /healthz isn't ok");
  });

  await step("the web app serves the sign-in email template", async () => {
    const r = await fetch(`${WEB_URL}/_selfhost/email/sign-in.html`);
    check(r.status === 200, `HTTP ${r.status}`);
    const t = await r.text();
    check(t.includes("{{ .Token }}") && t.includes("/auth/confirm?token_hash={{ .TokenHash }}&type=email"), "the template lacks the code or the link");
  });

  await step("sign in: the owner asks for a code", async () => {
    const form = await (await get("/signin")).text();
    const csrf = field(form, "csrf");
    check(csrf, "the sign-in form has no csrf field");
    const r = await post("/signin", { csrf, next: "/", email: EMAIL });
    const h = await r.text();
    check(r.status === 200, `POST /signin answered HTTP ${r.status}`);
    check(/Check your email/.test(h), "no 'Check your email' page");
    codeFormCsrf = field(h, "csrf") ?? "";
  });

  let code = "";
  let link = "";
  await step("sign in: Supabase Auth emails a code and a link to this site", async () => {
    let msg;
    for (let i = 0; i < 60 && !msg; i++) {
      const list = await (await fetch(`${MAIL_API}/api/v1/messages`)).json();
      const m = (list.messages ?? []).find((x) => (x.To ?? []).some((t) => t.Address.toLowerCase() === EMAIL.toLowerCase()));
      if (m) msg = await (await fetch(`${MAIL_API}/api/v1/message/${m.ID}`)).json();
      else await sleep(1000);
    }
    check(msg, "no email arrived in 60 seconds");
    check(msg.Subject === "Your Reliquary sign-in code", `subject is "${msg.Subject}"`);
    code = /<strong>(\d{6})<\/strong>/.exec(msg.HTML ?? "")?.[1] ?? "";
    check(code, "the email has no 6-digit code");
    link = /href="([^"]+\/auth\/confirm\?[^"]+)"/.exec(msg.HTML ?? "")?.[1]?.replaceAll("&amp;", "&") ?? "";
    check(link.startsWith(`${ORIGIN}/auth/confirm?token_hash=`), "the email's link doesn't lead to this site's /auth/confirm");
  });

  await step("sign in: the code opens a session", async () => {
    const r = await post("/signin/code", { csrf: codeFormCsrf, next: "/", email: EMAIL, code });
    check(r.status === 303 || r.status === 302, `POST /signin/code answered HTTP ${r.status}`);
    // A brand-new account's first landing on Home is the welcome tour, once.
    const first = await get("/");
    check(first.status === 303 && (first.headers.get("location") ?? "").endsWith("/welcome"),
      `a new account's first landing on Home answered HTTP ${first.status} to ${first.headers.get("location")}, not the welcome tour`);
    const slide = await (await get("/welcome")).text();
    check(/Welcome to Reliquary/i.test(slide), "the welcome tour's first slide doesn't say Welcome to Reliquary");
    const skipped = await post("/welcome/done", { csrf: field(slide, "csrf") });
    check(skipped.status === 303 || skipped.status === 302, `Skip answered HTTP ${skipped.status}`);
    const home = await (await get("/")).text();
    check(/New vault/.test(home), "Home doesn't show New vault: not signed in");
  });

  await step("the owner is on the self-hosted plan, with no limits", async () => {
    const home = await (await get("/")).text();
    check(/You own 0 vaults on the Self-hosted plan, which has no limit/.test(home), "Home doesn't say 'You own 0 vaults on the Self-hosted plan, which has no limit'");
  });

  await step("the owner creates a vault", async () => {
    const csrf = field(await (await get("/vaults/new")).text(), "csrf");
    const r = await post("/vaults/new", { csrf, name: "Smoke vault", default_policy: "open" });
    check(r.status === 303, `POST /vaults/new answered HTTP ${r.status}`);
    vaultId = /^\/v\/([0-9a-f-]{36})/.exec(r.headers.get("location") ?? "")?.[1] ?? "";
    check(vaultId, "no vault in the redirect");
  });

  await step("the owner makes a read-write token for that vault", async () => {
    const csrf = field(await (await get("/connections")).text(), "csrf");
    const r = await post("/connections/new", { csrf, name: "Smoke agent", scope: "some", vault: vaultId, access: "write", days: "1" });
    const h = await r.text();
    token = /<p class="secret">(rlq_[0-9a-f]{64})<\/p>/.exec(h)?.[1] ?? "";
    check(token, `no token on the page (HTTP ${r.status})`);
  });

  const content = `# Hello from the smoke test\n\nWritten over MCP at ${new Date().toISOString()}.\n`;
  await step("an agent writes a file over MCP with the token", async () => {
    await mcp(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "deploy-smoke", version: "0" } });
    const r = await mcp(token, "tools/call", { name: "write_file", arguments: { vault: "Smoke vault", path: "notes/hello.md", content } });
    check(!r.isError, `write_file refused: ${toolText(r).slice(0, 300)}`);
  });

  await step("the agent reads it back over MCP", async () => {
    const r = await mcp(token, "tools/call", { name: "read_file", arguments: { vault: vaultId, path: "notes/hello.md" } });
    check(!r.isError, `read_file refused: ${toolText(r).slice(0, 300)}`);
    check(toolText(r).includes("Hello from the smoke test"), "read_file doesn't return what was written");
  });

  await step("the owner sees the file in the web UI", async () => {
    const r = await get(`/v/${vaultId}/file?path=notes/hello.md`);
    const h = await r.text();
    check(r.status === 200, `the file page answered HTTP ${r.status}`);
    check(h.includes("Hello from the smoke test"), "the file page doesn't show the text");
  });

  await step("a request without the token is refused", async () => {
    const r = await fetch(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    check(r.status === 401, `HTTP ${r.status}`);
  });
} catch {
  // step() printed it
}
console.log(failed ? `smoke: ${failed} step(s) failed` : "smoke: every step passed");
process.exit(failed ? 1 : 0);
