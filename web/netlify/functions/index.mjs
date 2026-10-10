// Netlify entry point: one function for the whole app. The build step (tsc)
// compiles src/ to dist/ first; `config` below routes every path here, after
// static files in public/ have had their turn on the CDN (preferStatic).
//
// Netlify Functions speak web Request and Response; the app is a node:http
// request listener. Rather than imitate IncomingMessage and ServerResponse,
// the function keeps the real server listening on a loopback port of its own
// and relays each request through Node's own http client: the headers, the
// body and the status cross unchanged, in both directions.
//
// NETLIFY is the app's "hosted" marker (TLS to the database or refuse to
// start, https origins only, no loopback allowances; web/README.md). Netlify's
// runtime promises functions only URL, SITE_NAME and SITE_ID, so this file,
// which runs nowhere but on Netlify, sets it itself, before the server module
// loads (a static import would be hoisted above the assignment).
//
// The server is imported by a URL the bundler can't resolve, on purpose:
// Netlify bundles a function with esbuild, and a resolvable import would be
// inlined into this file, so dist/server.js would lose its own location and
// with it version.json, public/ and the CA it reads next to itself. Left
// opaque, the import runs at start against the files netlify.toml ships
// (included_files: dist/**, node_modules/** and the data files).
import http from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";

process.env.NETLIFY ??= "true";
const { handle } = await import(new URL("../../dist/server.js", import.meta.url).href);

const server = http.createServer(handle);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();

const NO_BODY = new Set([204, 205, 304]);

export default (req) =>
  new Promise((resolve, reject) => {
    const url = new URL(req.url);
    // The app routes by the Host header (web/src/hosts.ts): keep the one the
    // client asked for, not the loopback address this hop goes to.
    const headers = { ...Object.fromEntries(req.headers), host: url.host };
    const relay = http.request({ host: "127.0.0.1", port, method: req.method, path: url.pathname + url.search, headers }, (res) => {
      const out = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      const body = req.method === "HEAD" || NO_BODY.has(res.statusCode) ? null : Readable.toWeb(res);
      resolve(new Response(body, { status: res.statusCode, headers: out }));
    });
    relay.on("error", reject);
    if (req.body) Readable.fromWeb(req.body).pipe(relay);
    else relay.end();
  });

export const config = { path: "/*", preferStatic: true, region: "fra" };
