// Calling the web app's internal endpoint to make one already-authorized
// <link>.<tool> call (web/src/linkproxy.ts). This server only ever holds
// the sealed credential begin_link_call hands back -- never key material:
// VARIABLES_KEYS stays web-app-only (server.ts refuses to start with one
// set), the same reason environment variable values never reach here
// either. Authenticated by a shared secret (LINK_PROXY_SECRET), the same
// two-servers-talking shape as /healthz?db=1's KEEPALIVE_TOKEN, not a
// person's session or any kind of access token.

let BASE = "";
let SECRET = "";

// Called once at startup (server.ts), alongside the rest of oauthConfig:
// issuer is the web app's own URL, already resolved there (AUTH_ISSUER).
export function configureLinkProxy(env: NodeJS.ProcessEnv, issuer: string): void {
  const strict = env.NETLIFY ? "NETLIFY" : env.SELF_HOSTED === "1" ? "SELF_HOSTED" : "";
  SECRET = env.LINK_PROXY_SECRET ?? "";
  if (strict && !SECRET) throw new Error(`Refusing to start: ${strict} is set but LINK_PROXY_SECRET is not`);
  BASE = issuer;
}

// `message` is the reason, written for people. `where` and `ref` are the web
// app's own when it answered (its reference finds the detail in its log);
// otherwise `where` says which step of reaching it broke and there is none.
export class LinkProxyError extends Error {
  readonly where: string;
  readonly ref?: string;
  readonly status: number;
  constructor(
    readonly code: string,
    message: string,
    o: { where?: string; ref?: string; status?: number } = {},
  ) {
    super(message);
    this.where = o.where ?? "link proxy";
    this.ref = o.ref;
    this.status = o.status ?? 502;
  }
}

// A little under the web app's own worst case (three 8 s round trips to
// the upstream server, linkcall.ts) plus room for this hop and its
// response, all inside mcp/'s own 30 s request timeout (server.ts).
const TIMEOUT_MS = 28_000;

export type LinkCallRequest = {
  vaultId: string;
  url: string;
  keyId: string;
  nonce: string;
  ciphertext: string;
  toolName: string;
  args: unknown;
};
export type LinkCallResult = { content: unknown; isError: boolean };

// Throws LinkProxyError, never the credential (this call never holds a
// plaintext one to begin with), with a reason written for people; the
// caller (links-tools.ts) relays it to the agent as the tool call's own
// failure. The response is the contract documented in web/src/linkproxy.ts;
// mcp/test/link_proxy.test.mjs fails if the two stop agreeing.
export async function callLinkProxy(req: LinkCallRequest): Promise<LinkCallResult> {
  if (!SECRET || !BASE) throw new LinkProxyError("not_configured", "The link proxy isn’t configured on this server (LINK_PROXY_SECRET is not set).", { where: "link proxy (settings)", status: 503 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(new URL("/internal/link-call", BASE), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        vault_id: req.vaultId,
        url: req.url,
        key_id: req.keyId,
        nonce: req.nonce,
        ciphertext: req.ciphertext,
        tool_name: req.toolName,
        args: req.args,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const slow = err instanceof Error && err.name === "AbortError";
    throw new LinkProxyError("unreachable", slow ? "The link proxy took too long to respond." : "The link proxy couldn’t be reached.", {
      where: "link proxy (network)",
      status: slow ? 504 : 503,
    });
  } finally {
    clearTimeout(timer);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new LinkProxyError("bad_response", `The link proxy sent a response that isn’t valid JSON (status ${res.status}).`, { where: "link proxy (response)" });
  }
  const b = body as { ok?: unknown; result?: { content?: unknown; isError?: unknown }; error?: unknown; why?: unknown; message?: unknown; where?: unknown; ref?: unknown };
  if (b.ok === true) return { content: b.result?.content ?? [], isError: b.result?.isError === true };
  // The web app's refusal (web/src/linkproxy.ts): its code, reason, place
  // and reference. Shown to an agent, so each is checked, not trusted.
  const text = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined);
  const code = text(b.error, 64) ?? "proxy_failed";
  const why =
    text(b.why, 500) ??
    text(b.message, 500) ??
    (code === "unauthorized"
      ? "The web app didn’t accept this server’s link proxy secret, so no link call works until LINK_PROXY_SECRET is the same on both"
      : `The link proxy answered ${res.status} (${code}) without saying why`);
  const ref = typeof b.ref === "string" && /^[0-9a-f]{8}$/.test(b.ref) ? b.ref : undefined;
  // A refusal with a reference is the web app's own failure and keeps its
  // status; one without (401, 405) is a setup problem between the two.
  throw new LinkProxyError(code, why, { where: text(b.where, 200), ref, status: ref && res.status >= 400 ? res.status : 502 });
}
