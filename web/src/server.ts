// Reliquary web UI. Server-rendered HTML, no client-side script.
//
// Sign-in (src/auth.ts), by AUTH_MODE:
//  - local (default: dev.sh and most tests): the server acts only as
//    LOCAL_USER_ID. At start (and after each use) it writes a one-time login
//    code to LOGIN_FILE (mode 600). `dev.sh ui` opens /login?code=... in the
//    browser without printing it. The session is an HttpOnly,
//    SameSite=Strict cookie. Refuses to start on Vercel.
//  - supabase (hosted): an emailed code or link through Supabase Auth
//    (src/signin.ts). The session is the Supabase JWT and refresh token in
//    HttpOnly, SameSite=Lax cookies, verified on every request; no server
//    state, so any instance serves any session.
//
// Every POST needs the session's CSRF token and, when the browser sends one, a
// same-origin Origin header. Responses carry a CSP that forbids all scripts.
//
// Hosted (docs/research/hosting.md), PUBLIC_URL names the site, e.g.
// https://app.example.com. Then every POST must carry exactly that Origin
// (a missing one is refused too), and with https the cookies are Secure and
// __Host- prefixed. Unset, as under dev.sh and the tests, the Origin is
// compared with http://<Host header>, and absent is allowed.
//
// Routes that must work without a session (chunk C's OAuth metadata and token
// endpoints) go before the getSession() call below; pages that need the
// signed-in person use ctx.userId, and a signed-out GET is sent to
// signinUrl(next) and back.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureAuth, getSession, localLogin, readCookie, rotateLoginCode, sameSecret, type AuthMode } from "./auth.js";
import { html, notice, setAccountMode, setStyleVersion, type Theme } from "./html.js";
import { configureOAuth, oauthPublic } from "./oauth.js";
import { routes, type Ctx, type Reply } from "./pages.js";
import { signinRoutes, signinUrl, SIGNIN_PATHS } from "./signin.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8790);
const MAX_BODY = 2 * 1024 * 1024;
const MCP_URL = process.env.MCP_PUBLIC_URL ?? "http://127.0.0.1:8787/mcp";

let PUBLIC_ORIGIN = "";
if (process.env.PUBLIC_URL) {
  try {
    const u = new URL(process.env.PUBLIC_URL);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    PUBLIC_ORIGIN = u.origin;
  } catch {
    console.error("PUBLIC_URL must be an http(s) URL");
    process.exit(1);
  }
}
const SECURE = PUBLIC_ORIGIN.startsWith("https://");
// __Host- cookies must be Secure, Path=/ and carry no Domain: bound to this
// exact host, over https only.
const COOKIE_PREFIX = SECURE ? "__Host-" : "";
const THEME_COOKIE = `${COOKIE_PREFIX}rlq_theme`;
const COOKIE_SECURE = SECURE ? "; Secure" : "";

let MODE: AuthMode;
try {
  MODE = configureAuth(process.env, { secure: SECURE, host: HOST, port: PORT });
  configureOAuth();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
setAccountMode(MODE);

// Static files: a fixed map built at start, so no request path ever touches
// the filesystem. On Vercel, public/ is served by the CDN and may be missing
// from the function bundle: then the map stays empty and the stylesheet
// version comes from the deployed commit.
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};
const STATIC = new Map<string, { type: string; body: Buffer }>();
const fonts = existsSync(join(PUBLIC, "fonts")) ? readdirSync(join(PUBLIC, "fonts")).map((f) => `fonts/${f}`) : [];
for (const rel of ["style.css", "favicon.svg", ...fonts]) {
  const type = TYPES[rel.split(".").pop() ?? ""];
  if (type && existsSync(join(PUBLIC, rel))) STATIC.set(`/${rel}`, { type, body: readFileSync(join(PUBLIC, rel)) });
}
const style = STATIC.get("/style.css");
const commit = /^[0-9a-f]{10,}$/.test(process.env.VERCEL_GIT_COMMIT_SHA ?? "") ? process.env.VERCEL_GIT_COMMIT_SHA! : "";
setStyleVersion(
  style
    ? createHash("sha256").update(style.body).digest("hex").slice(0, 10)
    : commit
      ? commit.slice(0, 10)
      : randomBytes(5).toString("hex"),
);

const cookie = readCookie;

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

// `cookies`: auth Set-Cookie values (a sign-in, a refreshed or cleared
// session, a flash). A response that carries them is also marked private.
// `reply.formAction`: an extra form-action origin (the OAuth consent page
// posts, then redirects to the client).
function send(res: http.ServerResponse, reply: Reply, extra: Record<string, string> = {}, cookies: string[] = []): void {
  const headers: Record<string, string | string[]> = { ...SECURITY_HEADERS, ...extra };
  if (reply.formAction) {
    headers["content-security-policy"] = SECURITY_HEADERS["content-security-policy"].replace(
      "form-action 'self'", `form-action 'self' ${reply.formAction}`);
  }
  if (cookies.length) {
    headers["set-cookie"] = extra["set-cookie"] ? [...cookies, extra["set-cookie"]] : cookies;
    headers["cache-control"] = "private, no-store";
  }
  if (reply.redirect) {
    res.writeHead(303, { location: reply.redirect, ...headers }).end();
    return;
  }
  res.writeHead(reply.status ?? 200, { "content-type": "text/html; charset=utf-8", ...headers }).end(reply.html ?? "");
}

// The same-origin rule for every POST (see the top of this file).
function originAllowed(req: http.IncomingMessage): { ok: boolean; origin: string | undefined } {
  const origin = req.headers.origin;
  return { ok: PUBLIC_ORIGIN ? origin === PUBLIC_ORIGIN : !origin || origin === `http://${req.headers.host}`, origin };
}
const refused = (theme: Theme): Reply => ({
  status: 403,
  html: notice("Request refused", "This form didn’t come from Reliquary’s own page. If you sent it yourself, reload the page and try again.", theme),
});
const logRefused = (path: string, origin: string | undefined) =>
  console.info(`POST ${path} 403 origin=${origin === undefined ? "none" : origin === "null" ? "null" : "other"}`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    const file = req.method === "GET" ? STATIC.get(url.pathname) : undefined;
    if (file) {
      res.writeHead(200, { "content-type": file.type, "cache-control": "max-age=300", "x-content-type-options": "nosniff" }).end(file.body);
      return;
    }
    const themeCookie = cookie(req, THEME_COOKIE);
    const theme: Theme = themeCookie === "light" || themeCookie === "dark" ? themeCookie : "auto";
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    // OAuth endpoints a client calls without a session (oauth.ts).
    if (await oauthPublic(req, res, url)) return;
    if (MODE === "local" && url.pathname === "/login" && req.method === "GET") {
      const setCookie = localLogin(url.searchParams.get("code") ?? "");
      if (!setCookie) {
        send(res, { status: 401, html: notice("Link expired", html`That sign-in link has already been used or has expired. Run <code>./mcp/dev.sh ui</code> for a fresh one.`, theme) });
        return;
      }
      send(res, { redirect: "/" }, { "set-cookie": setCookie });
      return;
    }

    const auth = await getSession(req);
    if (auth.unavailable) {
      send(res, { status: 503, html: notice("Sign-in is unavailable", "Reliquary can’t reach its sign-in service right now. Try again in a minute.", theme) });
      console.info(`${req.method} ${url.pathname} 503`);
      return;
    }

    // Sign-in pages (AUTH_MODE=supabase): reachable without a session.
    if (MODE === "supabase" && SIGNIN_PATHS.has(url.pathname)) {
      let signinForm = new URLSearchParams();
      if (req.method === "POST") {
        const o = originAllowed(req);
        if (!o.ok) {
          send(res, refused(theme), {}, auth.cookies);
          logRefused(url.pathname, o.origin);
          return;
        }
        signinForm = await readForm(req);
      }
      const out = await signinRoutes({ req, method: req.method ?? "", url, form: signinForm, theme, session: auth.session });
      if (out) {
        send(res, out.reply, {}, [...auth.cookies, ...out.cookies]);
        console.info(`${req.method} ${url.pathname} ${out.reply.redirect ? 303 : out.reply.status ?? 200}`);
        return;
      }
    }

    const session = auth.session;
    if (!session) {
      if (MODE === "supabase") {
        // Signed out: a page sends you to sign in and back; a form post
        // can't be replayed after sign-in, so it just says so.
        if (req.method === "GET") send(res, { redirect: signinUrl(url.pathname + url.search) }, {}, auth.cookies);
        else send(res, { status: 401, html: notice("Signed out", html`Your session ended. <a href="/signin">Sign in</a> and try again.`, theme) }, {}, auth.cookies);
        console.info(`${req.method} ${url.pathname} ${req.method === "GET" ? 303 : 401}`);
      } else {
        send(res, { status: 401, html: notice("Signed out", html`Run <code>./mcp/dev.sh ui</code> to open a sign-in link.`, theme) });
      }
      return;
    }

    let form = new URLSearchParams();
    if (req.method === "POST") {
      const o = originAllowed(req);
      if (!o.ok) {
        send(res, refused(theme), {}, auth.cookies);
        logRefused(url.pathname, o.origin);
        return;
      }
      form = await readForm(req);
      if (!sameSecret(form.get("csrf") ?? "", session.csrf)) {
        send(res, { status: 403, html: notice("Form expired", "Go back, reload the page, and try again.", theme) }, {}, auth.cookies);
        return;
      }
    } else if (req.method !== "GET") {
      send(res, { status: 405, html: "" }, {}, auth.cookies);
      return;
    }

    if (req.method === "POST" && url.pathname === "/theme") {
      const choice = form.get("theme");
      const back = form.get("back") ?? "/";
      const next: Theme = choice === "light" || choice === "dark" ? choice : "auto";
      send(
        res,
        { redirect: back.startsWith("/") && !back.startsWith("//") ? back : "/" },
        { "set-cookie": `${THEME_COOKIE}=${next}; SameSite=Strict; Path=/; Max-Age=31536000${COOKIE_SECURE}` },
        auth.cookies,
      );
      return;
    }

    if (MODE === "supabase" && req.method === "POST" && url.pathname === "/signout") {
      await session.signOut();
      send(res, { redirect: "/signin" }, {}, auth.cookies);
      console.info("POST /signout 303");
      return;
    }

    const ctx: Ctx = {
      userId: session.userId,
      csrf: session.csrf,
      url,
      form,
      method: req.method,
      flash: session.takeFlash(),
      theme,
      mcpUrl: MCP_URL,
      setFlash: (m) => session.setFlash(m),
    };
    const reply = await routes(ctx);
    send(res, reply, {}, auth.cookies);
    console.info(`${req.method} ${url.pathname} ${reply.redirect ? 303 : reply.status ?? 200}`);
  } catch (err) {
    console.error("web error", (err as { code?: string }).code ?? (err as Error).name);
    if (!res.headersSent) send(res, { status: 500, html: notice("Something went wrong", "Reliquary hit an error. Try again; if it keeps happening, check the server log.") });
  }
});

if (MODE === "local") rotateLoginCode();
// On Vercel the app runs as one function (api/index.js) that hands every
// request to this handler; the platform owns the socket. Locally, listen on
// loopback as before.
export const handle: http.RequestListener = (req, res) => {
  server.emit("request", req, res);
};
if (!process.env.VERCEL) {
  server.listen(PORT, HOST, () => console.info(`reliquary web on http://${HOST}:${PORT}`));
}
