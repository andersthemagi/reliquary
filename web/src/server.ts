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
// SITE_URL (optional) puts the public site on a host of its own, PUBLIC_URL
// staying the app's: see hosts.ts for which host serves what.
//
// Hosted (docs/research/hosting.md), PUBLIC_URL names the site, e.g.
// https://app.example.com. Then every POST must carry exactly that Origin
// (a missing one is refused too), and with https the cookies are Secure and
// __Host- prefixed. Unset, as under dev.sh and the tests, the Origin is
// compared with http://<Host header>, and absent is allowed.
//
// Routes that must work without a session (chunk C's OAuth metadata and token
// endpoints, the CLI's env API) go before the getSession() call below; pages that need the
// signed-in person use ctx.userId, and a signed-out GET is sent to
// signinUrl(next) and back.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearCookie, configureAuth, cookieName, getSession, localLogin, readCookie, rotateLoginCode, sameSecret, type AuthMode } from "./auth.js";
import { html, notice, setAccountMode, setStyleVersion, type Theme } from "./html.js";
import { describe, errorPage } from "./errorpage.js";
import { doing, fail, failure, withRequest } from "./failure.js";
import { toFlash } from "./flash.js";
import { signinUnavailablePage } from "./signin.js";
import { envApi } from "./envapi.js";
import { crossHost, hostKind, hostsConfigError, isSitePath } from "./hosts.js";
import { landing } from "./landing.js";
import { publicRoute } from "./legal.js";
import { configureOAuth, oauthPublic } from "./oauth.js";
import { routes, type Ctx, type Download, type Reply } from "./pages.js";
import { movedConnectionsPath } from "./access.js";
import { configureDiscovery } from "./discovery.js";
import { configureVariables, missingKeyIds, variablesConfigured } from "./secrets.js";
import { inSession, pool } from "./db.js";
import { clientIp, configureRateLimits, limit, tooManyPage } from "./ratelimit.js";
import { configureMailer } from "./mailer.js";
import { feedbackTick, flushFeedbackNotices, noticeTarget } from "./feedback.js";
import { versionJson } from "./version.js";
import { emailTemplate, selfHosted } from "./selfhost.js";
import { welcomeLanding } from "./welcome.js";
import { FRESH_SIGNIN, safeNext, signinRoutes, signinUrl, SIGNIN_PATHS } from "./signin.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8790);
const MAX_BODY = 2 * 1024 * 1024;
// Forms that carry a file's text (write or propose a file, edit and
// approve, revise a proposal) may be bigger: the database takes 1 MiB of
// text, and a browser percent-encodes each non-ASCII UTF-8 byte as three
// characters, so 1 MiB of non-Latin text is about 3 MiB of form. 3 MiB plus
// 64 KiB for the other fields (a 4000-character reason is at most 48 KB
// encoded). Every other form keeps 2 MB. Vercel's own ceiling for a
// function's request body is 4.5 MB.
const MAX_FILE_FORM = 3 * 1024 * 1024 + 64 * 1024;
const FILE_FORM = /^\/v\/[^/]+\/(file|proposals\/[^/]+\/(edit|revise))$/;
const bodyLimit = (pathname: string): number => (FILE_FORM.test(pathname) ? MAX_FILE_FORM : MAX_BODY);
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
{
  const err = hostsConfigError(process.env);
  if (err) {
    console.error(err);
    process.exit(1);
  }
}
const SECURE = PUBLIC_ORIGIN.startsWith("https://");
// Self-hosted over plain http works (a trial on one machine, or TLS ended by
// a proxy that forwards http), but cookies then can't be Secure: say so.
if (selfHosted() && PUBLIC_ORIGIN && !SECURE) {
  console.warn("PUBLIC_URL is http, so session cookies aren't Secure: use https (deploy/compose's caddy profile) for anything but a trial");
}
// __Host- cookies must be Secure, Path=/ and carry no Domain: bound to this
// exact host, over https only.
const COOKIE_PREFIX = SECURE ? "__Host-" : "";
const THEME_COOKIE = `${COOKIE_PREFIX}rlq_theme`;
const COOKIE_SECURE = SECURE ? "; Secure" : "";

let MODE: AuthMode;
try {
  MODE = configureAuth(process.env, { secure: SECURE, host: HOST, port: PORT });
  configureOAuth();
  configureVariables(process.env);
  configureDiscovery(process.env);
  configureRateLimits(process.env);
  configureMailer(process.env);
  // Names the setting, never the address.
  const notices = noticeTarget(process.env);
  if ("off" in notices && process.env.FEEDBACK_EMAIL) console.warn(`Feedback notices are off: ${notices.off}`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
setAccountMode(MODE);

// Every stored value must name a key this server holds: otherwise a key was
// dropped before its values were re-encrypted (docs/ops/runbook.md), and
// they would fail one by one. Refuse to start instead, naming the ids (never
// a key). If the database can't be asked (down, or the migration not yet
// applied), say so and start: the value routes fail on their own then.
if (variablesConfigured()) {
  let stored: string[] | null = null;
  try {
    stored = (await pool.query("select k from private.stored_key_ids() k")).rows.map((r) => r.k as string);
  } catch (err) {
    console.error("could not check the stored variable key ids", (err as { code?: string }).code ?? (err as Error).name);
  }
  const missing = stored ? missingKeyIds(stored) : [];
  if (missing.length) {
    console.error(
      `Refusing to start: stored values are sealed with key id${missing.length === 1 ? "" : "s"} ${missing.join(", ")}, which VARIABLES_KEYS doesn't hold. Add the old key back, re-encrypt (scripts/rotate-variables-key.sh), then drop it.`,
    );
    process.exit(1);
  }
}

// Static files: a fixed map built at start, so no request path ever touches
// the filesystem. On Vercel, public/ is served by the CDN and may be missing
// from the function bundle: then the map stays empty and the stylesheet
// version comes from the deployed commit.
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};
const STATIC = new Map<string, { type: string; body: Buffer }>();
const fonts = existsSync(join(PUBLIC, "fonts")) ? readdirSync(join(PUBLIC, "fonts")).map((f) => `fonts/${f}`) : [];
for (const rel of ["style.css", "favicon.svg", "og.png", ...fonts]) {
  const type = TYPES[rel.split(".").pop() ?? ""];
  if (type && existsSync(join(PUBLIC, rel))) STATIC.set(`/${rel}`, { type, body: readFileSync(join(PUBLIC, rel)) });
}
const style = STATIC.get("/style.css");
const commit = /^[0-9a-f]{10,}$/.test(process.env.VERCEL_GIT_COMMIT_SHA ?? "") ? process.env.VERCEL_GIT_COMMIT_SHA! : "";
const STYLE_VERSION = style
  ? createHash("sha256").update(style.body).digest("hex").slice(0, 10)
  : commit
    ? commit.slice(0, 10)
    : randomBytes(5).toString("hex");
setStyleVersion(STYLE_VERSION);

// Pages link /style.css?v=<its hash>, and fonts never change under a name, so
// both can be cached for a year: a changed stylesheet is a new URL. Anything
// else (the icon, an unversioned stylesheet request) for five minutes.
const IMMUTABLE = "public, max-age=31536000, immutable";
function staticCache(url: URL): string {
  if (url.pathname.startsWith("/fonts/")) return IMMUTABLE;
  if (url.pathname === "/style.css" && url.searchParams.get("v") === STYLE_VERSION) return IMMUTABLE;
  return "public, max-age=300";
}

const cookie = readCookie;

function readForm(req: http.IncomingMessage, limit = MAX_BODY): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        // Stop reading; the 413 goes out with `connection: close`, which
        // ends the upload.
        req.removeAllListeners("data");
        req.pause();
        chunks.length = 0;
        reject(new Error("too large"));
      } else chunks.push(c);
    });
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

// Ceilings for form fields, checked before any handler runs, so an
// over-long field never costs a database round trip. The database refuses
// the same (20260925110000_hardening.sql, sections 2 and 3), so these only
// answer sooner; they are never looser. Characters, as Postgres's length()
// counts them, except file text, which is bytes. Each answer names the
// ceiling, never the input. Other fields are bounded by the body limit and
// checked by their handlers (a variable's value by sealing, a pasted .env by
// its parser).
const TOO_LONG = "That’s too long (text up to 1 MB, reasons and notes up to 4000 characters, paths up to 1024, names up to 200). Nothing was saved.";
const FIELD_LIMITS: Record<string, { max: number; bytes?: boolean; message?: string }> = {
  content: { max: 1_048_576, bytes: true },
  reason: { max: 4000 },
  note: { max: 4000 },
  body: { max: 4000, message: "Comments are at most 4000 characters." },
  path: { max: 1024 },
  confirm_path: { max: 1024 },
  name: { max: 200 },
  confirm_name: { max: 200 },
  display_name: { max: 80, message: "A display name is at most 80 characters. Nothing was saved." },
  message: { max: 5000, message: "Feedback is at most 5000 characters: shorten it, or summarise a long log. Nothing was sent." },
};
function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
function tooLong(form: URLSearchParams): string | null {
  for (const [field, value] of form) {
    const limit = FIELD_LIMITS[field];
    // Cheap first: a character is at least one UTF-16 unit, and a unit at
    // most three UTF-8 bytes.
    if (!limit || value.length * (limit.bytes ? 3 : 1) <= limit.max) continue;
    const size = limit.bytes ? Buffer.byteLength(value, "utf8") : codePoints(value);
    if (size > limit.max) return limit.message ?? TOO_LONG;
  }
  return null;
}

// The page a form was posted from, when the browser says (Referer, this
// site only), else home.
function formPage(req: http.IncomingMessage): string {
  try {
    const from = new URL(req.headers.referer ?? "");
    const here = PUBLIC_ORIGIN || `http://${req.headers.host}`;
    if (from.origin === here) return safeNext(from.pathname + from.search);
  } catch {
    // no or unparseable Referer
  }
  return "/";
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
  if (reply.retryAfter) headers["retry-after"] = String(reply.retryAfter);
  if (reply.redirect) {
    res.writeHead(303, { location: reply.redirect, ...headers }).end();
    return;
  }
  res.writeHead(reply.status ?? 200, { "content-type": "text/html; charset=utf-8", ...headers }).end(reply.html ?? "");
}

// A file streamed as the response (a vault export): an attachment, never
// cached, with the page's security headers. The filename is built by us from
// [a-z0-9-] and a date. If writing fails part-way the connection is cut, so
// the browser reports a failed download instead of saving a short file.
async function sendDownload(res: http.ServerResponse, d: Download, cookies: string[]): Promise<void> {
  const headers: Record<string, string | string[]> = {
    ...SECURITY_HEADERS,
    "content-type": d.type,
    "content-disposition": `attachment; filename="${d.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    "cache-control": cookies.length ? "private, no-store" : "no-store",
  };
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(200, headers);
  try {
    await d.write(res);
  } catch (err) {
    // Headers are gone: the browser reports a failed download; the reason
    // and the reference are in the log.
    fail(err, { what: `Downloading ${d.filename.replace(/[^A-Za-z0-9._-]/g, "_")}` });
    res.destroy();
  }
}

// The same-origin rule for every POST (see the top of this file).
function originAllowed(req: http.IncomingMessage): { ok: boolean; origin: string | undefined } {
  const origin = req.headers.origin;
  return { ok: PUBLIC_ORIGIN ? origin === PUBLIC_ORIGIN : !origin || origin === `http://${req.headers.host}`, origin };
}
const refused = (theme: Theme): Reply => ({
  status: 403,
  html: errorPage(
    failure({ status: 403, where: "web app (same-origin check on forms)", why: "This form didn’t come from Reliquary’s own page (its Origin header names another site, or none). If you sent it yourself, reload the page and try again." }),
    { theme, title: "Request refused" },
  ),
});
const logRefused = (path: string, origin: string | undefined) =>
  console.info(`POST ${path} 403 origin=${origin === undefined ? "none" : origin === "null" ? "null" : "other"}`);

// Every request runs with its own reference and a description of what it is
// doing (failure.ts), so any failure in it can say so.
const server = http.createServer((req, res) => {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    url = new URL("http://localhost/");
  }
  const d = describe(req.method ?? "GET", url, new URLSearchParams());
  return withRequest(d.what, d.log, () => serve(req, res, url));
});

async function serve(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  // "single" unless SITE_URL splits the site from the app (hosts.ts).
  const host = hostKind(req.headers.host);
  // The app host is never indexed, whatever the response.
  if (host === "app") res.setHeader("x-robots-tag", "noindex");
  let theme: Theme = "auto";
  try {
    const file = req.method === "GET" ? STATIC.get(url.pathname) : undefined;
    if (file) {
      res.writeHead(200, { "content-type": file.type, "cache-control": staticCache(url), "x-content-type-options": "nosniff" }).end(file.body);
      return;
    }
    const themeCookie = cookie(req, THEME_COOKIE);
    theme = themeCookie === "light" || themeCookie === "dark" ? themeCookie : "auto";
    const readOnly = req.method === "GET" || req.method === "HEAD";
    if (host === "site") {
      // The public site's host: its pages only, and never a cookie set.
      if (!isSitePath(url.pathname)) {
        res.writeHead(308, { location: crossHost("app", url.pathname, url.search), "cache-control": "no-store" }).end();
        console.info(`${req.method} ${url.pathname} 308 site->app`);
        return;
      }
      if (!readOnly) {
        res.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, HEAD" }).end();
        return;
      }
      const pub = url.pathname === "/"
        ? { status: 200, type: "text/html; charset=utf-8", body: landing(theme) }
        : publicRoute(url.pathname, theme);
      if (pub) res.writeHead(pub.status ?? 200, { ...SECURITY_HEADERS, "content-type": pub.type }).end(pub.body);
      else {
        const f = failure({ status: 404, where: "web app (public site)", why: `There’s no page at ${url.pathname}` });
        res.writeHead(404, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" }).end(`Not found: ${f.why} (ref ${f.ref})\n`);
      }
      return;
    }
    // On the app host, the public site's pages live on the site host.
    // `/` stays: Home, or sign-in.
    if (host === "app" && readOnly && url.pathname !== "/" && isSitePath(url.pathname)) {
      res.writeHead(308, { location: crossHost("site", url.pathname, url.search), "cache-control": "no-store" }).end();
      console.info(`${req.method} ${url.pathname} 308 app->site`);
      return;
    }
    // The Connections page's old URLs (/tokens/*): permanent, any method.
    const moved = movedConnectionsPath(url.pathname);
    if (moved) {
      res.writeHead(308, { location: moved + url.search, "cache-control": "no-store" }).end();
      console.info(`${req.method} ${url.pathname} 308 -> ${moved}`);
      return;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    // Self-hosted only: the email templates Supabase Auth fetches (selfhost.ts).
    const template = req.method === "GET" ? emailTemplate(url.pathname) : undefined;
    if (template) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(template);
      return;
    }
    if (url.pathname === "/version" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(versionJson());
      return;
    }
    // The public site's legal pages, robots.txt, sitemap.xml, docs (legal.ts).
    const pub = req.method === "GET" ? publicRoute(url.pathname, theme) : undefined;
    if (pub) {
      res.writeHead(pub.status ?? 200, { ...SECURITY_HEADERS, "content-type": pub.type }).end(pub.body);
      return;
    }
    // OAuth endpoints a client calls without a session (oauth.ts).
    if (await oauthPublic(req, res, url)) return;
    // The env API, for the Reliquary CLI's bearer tokens (envapi.ts).
    if (await envApi(req, res, url)) return;
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
      send(res, { status: 503, html: signinUnavailablePage(theme) });
      console.info(`${req.method} ${url.pathname} 503`);
      return;
    }
    if (auth.limited) {
      send(res, { status: 429, retryAfter: auth.limited, html: tooManyPage(auth.limited, theme, "Your session was renewed too many times in a short time") });
      console.info(`${req.method} ${url.pathname} 429`);
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
      const out = await signinRoutes({ req, method: req.method ?? "", url, form: signinForm, theme, session: auth.session, ip: clientIp(req) });
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
        // can't be replayed after sign-in, so it just says so. `/` with no
        // session cookies at all is a visitor: the landing page (landing.ts).
        // On the app host of a split site (hosts.ts), `/` is sign-in: the
        // landing page lives on the site host.
        if (req.method === "GET" && url.pathname === "/" && !auth.cookies.length && host !== "app") send(res, { html: landing(theme) });
        else if (req.method === "GET") send(res, { redirect: signinUrl(url.pathname + url.search) }, {}, auth.cookies);
        else send(res, { status: 401, html: notice("Signed out", html`Your session ended. <a href="/signin">Sign in</a> and try again.`, theme) }, {}, auth.cookies);
        console.info(`${req.method} ${url.pathname} ${res.statusCode}`);
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
      try {
        form = await readForm(req, bodyLimit(url.pathname));
      } catch {
        const cap = bodyLimit(url.pathname) === MAX_BODY ? "2 MB" : "3 MB";
        const f = failure({ status: 413, where: "web app (form size limit)", why: `That form is over ${cap}, so nothing was saved. Go back and send less.` });
        send(res, { status: 413, html: errorPage(f, { theme, title: "Too large", back: formPage(req) }) }, { connection: "close" }, auth.cookies);
        console.info(`POST ${url.pathname} 413`);
        return;
      }
      // Now what the form asks for is known ("Saving canon/pricing.md").
      {
        const d = describe(req.method, url, form);
        doing(d.what, d.log);
      }
      if (!sameSecret(form.get("csrf") ?? "", session.csrf)) {
        const f = failure({
          status: 403,
          where: "web app (form check)",
          why: form.get("csrf") ? "The form’s security token isn’t this session’s: the page was opened before you signed in again. Go back, reload the page, and try again." : "The form carried no security token. Go back, reload the page, and try again.",
        });
        send(res, { status: 403, html: errorPage(f, { theme, title: "Form expired", back: formPage(req) }) }, {}, auth.cookies);
        return;
      }
      // An over-long field: back to the form's page with the reason, as a
      // refusal from the database would be shown, without asking it.
      const long = tooLong(form);
      if (long) {
        session.setFlash({ text: long, tone: "danger" });
        send(res, { redirect: formPage(req) }, {}, auth.cookies);
        console.info(`POST ${url.pathname} 303 too long`);
        return;
      }
      // Form posts per session (ratelimit.ts); the session's CSRF token is
      // its key, so the key is per session and never the session itself.
      const wait = await limit([
        { name: "web_write_minute", kind: "session", value: session.csrf },
        { name: "web_write_hour", kind: "session", value: session.csrf },
      ]);
      if (wait) {
        send(res, { status: 429, retryAfter: wait, html: tooManyPage(wait, theme, "That was too many changes in a short time") }, {}, auth.cookies);
        console.info(`POST ${url.pathname} 429`);
        return;
      }
    } else if (req.method !== "GET") {
      const f = failure({ status: 405, where: "web app", why: `${req.method} isn’t accepted here: pages take GET and forms take POST.` });
      send(res, { status: 405, html: errorPage(f, { theme, title: "Method not allowed" }) }, { allow: "GET, POST" }, auth.cookies);
      return;
    }

    if (req.method === "POST" && url.pathname === "/theme") {
      const choice = form.get("theme");
      const next: Theme = choice === "light" || choice === "dark" ? choice : "auto";
      send(
        res,
        // A local path only: never //host or /\host (browsers read that as //host).
        { redirect: safeNext(form.get("back")) },
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
      setFlash: (m, tone) => session.setFlash(toFlash(m, tone)),
      ip: clientIp(req),
      session,
      fresh: readCookie(req, cookieName(FRESH_SIGNIN)) !== undefined,
    };
    let reply: Reply;
    try {
      reply = await inSession({ issuedAt: session.issuedAt }, () => routes(ctx));
    } catch (err) {
      // The database refused the session (SQLSTATE RLA01): its person signed
      // out everywhere after it began, or the account was deleted. End it
      // here too, and send the browser to sign in.
      if ((err as { code?: unknown })?.code !== "RLA01") throw err;
      await session.signOut().catch(() => undefined);
      const cookies = auth.cookies;
      if (MODE === "supabase" && req.method === "GET") send(res, { redirect: signinUrl(url.pathname + url.search) }, {}, cookies);
      else send(res, { status: 401, html: notice("Signed out", MODE === "supabase" ? html`This session was ended: you (or someone signed in as you) chose Sign out everywhere, or the account was deleted. <a href="/signin">Sign in</a> again.` : html`This session was ended. Run <code>./mcp/dev.sh ui</code> to open a sign-in link.`, theme) }, {}, cookies);
      console.info(`${req.method} ${url.pathname} ${res.statusCode} session ended`);
      return;
    }
    if (reply.download) {
      await sendDownload(res, reply.download, auth.cookies);
      console.info(`${req.method} ${url.pathname} ${res.destroyed && !res.writableFinished ? "aborted" : 200}`);
      return;
    }
    // The fresh-sign-in cookie is good for one landing (welcome.ts).
    const landed = ctx.fresh && req.method === "GET" && welcomeLanding(url.pathname);
    send(res, reply, landed ? { "set-cookie": clearCookie(FRESH_SIGNIN) } : {}, auth.cookies);
    console.info(`${req.method} ${url.pathname} ${reply.redirect ? 303 : reply.status ?? 200}`);
    // Feedback notices waiting (an agent's, or one whose email failed):
    // at most once a minute per instance, after the page has gone out.
    if (req.method === "GET") feedbackTick();
  } catch (err) {
    // What was being done, where it broke, why, and the reference, which
    // is also in the log with the detail (failure.ts).
    const f = fail(err);
    if (!res.headersSent) send(res, { status: f.status, html: errorPage(f, { theme, back: req.method === "POST" ? formPage(req) : undefined }) });
    else res.destroy();
    console.info(`${req.method} ${url.pathname} ${f.status} ref=${f.ref}`);
  }
}

if (MODE === "local") rotateLoginCode();
// On Vercel the app runs as one function (api/index.js) that hands every
// request to this handler; the platform owns the socket. Locally, listen on
// loopback as before.
export const handle: http.RequestListener = (req, res) => {
  server.emit("request", req, res);
};
if (!process.env.VERCEL) {
  server.listen(PORT, HOST, () => console.info(`reliquary web on http://${HOST}:${PORT}`));
  // A long-running server also sends feedback notices on a timer, so an
  // agent's feedback is emailed within a minute or two even when nobody
  // opens a page (feedback.ts).
  setInterval(() => void flushFeedbackNotices(), 60_000).unref();
}
