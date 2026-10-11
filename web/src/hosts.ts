// Which host a request came to, when the public site and the app live on
// two hostnames (docs/ops/runbook.md, "Hosts").
//
//   PUBLIC_URL  the app's origin: sign-in, Home and every signed-in page, the
//               OAuth issuer, the env API. Cookies, the POST Origin rule and
//               the issuer all use it.
//   SITE_URL    optional: the public site's origin (landing, docs, roadmap redirect,
//               legal pages, robots.txt, sitemap.xml, security.txt).
//
// Split (SITE_URL set and a different origin from PUBLIC_URL):
//  - on the site host only public paths are served; any other path is a 308
//    to the same path and query on the app host. `/` is the landing page.
//    Nothing there reads or sets a cookie.
//  - on the app host (and any other host name, e.g. a deployment's own
//    *.netlify.app address) the app is served, and public-only paths are a
//    308 to the site host; `/` stays: Home, or sign-in.
//  - static files (style, icon, og.png, fonts) are served on both.
// Not split (SITE_URL unset, or the same origin): one host, as before.
//
// The host is the Host header: on Netlify that is the domain the client
// asked for (x-forwarded-host carries the same). Redirects only ever go to
// one of the two configured origins, with a path that starts with exactly
// one "/", so no request can make this an open redirect.

const originOf = (v: string | undefined): string => {
  if (!v) return "";
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : "";
  } catch {
    return "";
  }
};

const APP = originOf(process.env.PUBLIC_URL);
const SITE = originOf(process.env.SITE_URL);
export const split = !!SITE && !!APP && SITE !== APP;
const APP_HOST = split ? new URL(APP).host : "";
const SITE_HOST = split ? new URL(SITE).host : "";

// Checked once at start (server.ts): a message naming the variable, never
// its value, or null.
export function hostsConfigError(env: NodeJS.ProcessEnv): string | null {
  if (!env.SITE_URL) return null;
  let u: URL;
  try {
    u = new URL(env.SITE_URL);
  } catch {
    return "SITE_URL must be an http(s) origin, like https://example.com";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "SITE_URL must be an http(s) origin, like https://example.com";
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password) {
    return "SITE_URL must be a bare origin, with no path, query or fragment";
  }
  if (!env.PUBLIC_URL) return "SITE_URL is set but PUBLIC_URL (the app's origin) is not";
  if (env.NETLIFY && u.protocol !== "https:") return "Refusing to start: on Netlify, SITE_URL must be https";
  return null;
}

// The public site's origin, for canonical and Open Graph URLs, the
// sitemap, robots.txt, security.txt and llms.txt: SITE_URL, else PUBLIC_URL,
// else the default.
export function publicSiteOrigin(fallback: string): string {
  return SITE || APP || fallback;
}

// Links across the two hosts. Relative when not split.
export const siteHref = (path: string) => (split ? SITE + path : path);
export const appHref = (path: string) => (split ? APP + path : path);

export type HostKind = "site" | "app" | "single";

export function hostKind(hostHeader: string | undefined): HostKind {
  if (!split) return "single";
  return (hostHeader ?? "").toLowerCase() === SITE_HOST ? "site" : "app";
}
export const appHostName = () => APP_HOST;

// Paths only the public site serves (GET). Static files are not here: both
// hosts serve them.
const SITE_EXACT = new Set([
  "/",
  "/terms",
  "/privacy",
  "/dpa",
  "/subprocessors",
  "/security",
  "/robots.txt",
  "/sitemap.xml",
  "/.well-known/security.txt",
  "/roadmap",
  "/llms.txt",
  "/llms-full.txt",
  "/docs",
]);
export const isSitePath = (path: string) => SITE_EXACT.has(path) || path.startsWith("/docs/");

// The same path and query on the other host. `path` is a URL's pathname
// (always starting with "/"); leading slashes collapse to one so the result
// can never read as another host.
export function crossHost(to: "site" | "app", pathname: string, search: string): string {
  const origin = to === "site" ? SITE : APP;
  const path = "/" + pathname.replace(/^[/\\]+/, "");
  const target = new URL(path + search, origin);
  if (target.origin !== origin) return origin + "/";
  return target.href;
}
