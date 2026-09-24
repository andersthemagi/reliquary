// Reliquary web UI (local). Server-rendered HTML, no client-side script.
//
// Sign-in stand-in until Supabase Auth: the server acts only as LOCAL_USER_ID.
// At start (and after each use) it writes a one-time login code to LOGIN_FILE
// (mode 600). `dev.sh ui` opens /login?code=... in the browser without
// printing it. The session is an HttpOnly, SameSite=Strict cookie.
//
// Every POST needs the session's CSRF token and, when the browser sends one, a
// same-origin Origin header. Responses carry a CSP that forbids all scripts.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { html, notice, setStyleVersion, type Theme } from "./html.js";
import { routes, type Ctx, type Reply } from "./pages.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8790);
const USER = process.env.LOCAL_USER_ID ?? "";
const LOGIN_FILE = process.env.LOGIN_FILE ?? ".login";
const MAX_BODY = 2 * 1024 * 1024;
const SESSION_HOURS = 12;
const MCP_URL = process.env.MCP_PUBLIC_URL ?? "http://127.0.0.1:8787/mcp";

if (!/^[0-9a-f-]{36}$/.test(USER)) {
  console.error("LOCAL_USER_ID must be a UUID");
  process.exit(1);
}

// Static files: a fixed map built at start, so no request path ever touches
// the filesystem.
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};
const STATIC = new Map<string, { type: string; body: Buffer }>();
for (const rel of ["style.css", "favicon.svg", ...readdirSync(join(PUBLIC, "fonts")).map((f) => `fonts/${f}`)]) {
  const type = TYPES[rel.split(".").pop() ?? ""];
  if (type) STATIC.set(`/${rel}`, { type, body: readFileSync(join(PUBLIC, rel)) });
}
setStyleVersion(createHash("sha256").update(STATIC.get("/style.css")!.body).digest("hex").slice(0, 10));

type Session = { userId: string; csrf: string; expires: number; flash?: string };
const sessions = new Map<string, Session>();
let loginCode = "";

function rotateLoginCode(): void {
  loginCode = randomBytes(24).toString("hex");
  writeFileSync(LOGIN_FILE, `http://${HOST}:${PORT}/login?code=${loginCode}\n`, { mode: 0o600 });
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  // Not "no-referrer": under that policy browsers send `Origin: null` on
  // form posts, which the same-origin check below (rightly) refuses.
  // "same-origin" keeps the real Origin for this site and sends nothing to
  // any other.
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};

function send(res: http.ServerResponse, reply: Reply, extra: Record<string, string> = {}): void {
  if (reply.redirect) {
    res.writeHead(303, { location: reply.redirect, ...SECURITY_HEADERS, ...extra }).end();
    return;
  }
  res
    .writeHead(reply.status ?? 200, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra })
    .end(reply.html ?? "");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    const file = req.method === "GET" ? STATIC.get(url.pathname) : undefined;
    if (file) {
      res.writeHead(200, { "content-type": file.type, "cache-control": "max-age=300", "x-content-type-options": "nosniff" }).end(file.body);
      return;
    }
    const themeCookie = cookie(req, "rlq_theme");
    const theme: Theme = themeCookie === "light" || themeCookie === "dark" ? themeCookie : "auto";
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (url.pathname === "/login" && req.method === "GET") {
      const code = url.searchParams.get("code") ?? "";
      if (!loginCode || !sameSecret(code, loginCode)) {
        send(res, { status: 401, html: notice("Link expired", html`That sign-in link has already been used or has expired. Run <code>./mcp/dev.sh ui</code> for a fresh one.`, theme) });
        return;
      }
      rotateLoginCode();
      const sid = randomBytes(32).toString("hex");
      sessions.set(sid, {
        userId: USER,
        csrf: randomBytes(24).toString("hex"),
        expires: Date.now() + SESSION_HOURS * 3600_000,
      });
      send(res, { redirect: "/" }, {
        "set-cookie": `rlq_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
      });
      return;
    }

    const sid = cookie(req, "rlq_session");
    const session = sid ? sessions.get(sid) : undefined;
    if (!session || session.expires < Date.now()) {
      if (sid) sessions.delete(sid);
      send(res, { status: 401, html: notice("Signed out", html`Run <code>./mcp/dev.sh ui</code> to open a sign-in link.`, theme) });
      return;
    }

    let form = new URLSearchParams();
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) {
        send(res, { status: 403, html: notice("Request refused", "This form didn’t come from Reliquary’s own page. If you sent it yourself, reload the page and try again.", theme) });
        console.info(`POST ${url.pathname} 403 origin=${origin === "null" ? "null" : "other"}`);
        return;
      }
      form = await readForm(req);
      if (!sameSecret(form.get("csrf") ?? "", session.csrf)) {
        send(res, { status: 403, html: notice("Form expired", "Go back, reload the page, and try again.", theme) });
        return;
      }
    } else if (req.method !== "GET") {
      send(res, { status: 405, html: "" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/theme") {
      const choice = form.get("theme");
      const back = form.get("back") ?? "/";
      const next: Theme = choice === "light" || choice === "dark" ? choice : "auto";
      send(res, { redirect: back.startsWith("/") && !back.startsWith("//") ? back : "/" }, {
        "set-cookie": `rlq_theme=${next}; SameSite=Strict; Path=/; Max-Age=31536000`,
      });
      return;
    }

    const flash = session.flash;
    session.flash = undefined;
    const ctx: Ctx = {
      userId: session.userId,
      csrf: session.csrf,
      url,
      form,
      method: req.method,
      flash,
      theme,
      mcpUrl: MCP_URL,
      setFlash: (m) => {
        session.flash = m;
      },
    };
    const reply = await routes(ctx);
    send(res, reply);
    console.info(`${req.method} ${url.pathname} ${reply.redirect ? 303 : reply.status ?? 200}`);
  } catch (err) {
    console.error("web error", (err as { code?: string }).code ?? (err as Error).name);
    if (!res.headersSent) send(res, { status: 500, html: notice("Something went wrong", "Reliquary hit an error. Try again; if it keeps happening, check the server log.") });
  }
});

rotateLoginCode();
server.listen(PORT, HOST, () => console.info(`reliquary web on http://${HOST}:${PORT}`));
