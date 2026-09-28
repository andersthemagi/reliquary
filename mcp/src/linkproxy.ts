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
  const strict = env.VERCEL ? "VERCEL" : env.SELF_HOSTED === "1" ? "SELF_HOSTED" : "";
  SECRET = env.LINK_PROXY_SECRET ?? "";
  if (strict && !SECRET) throw new Error(`Refusing to start: ${strict} is set but LINK_PROXY_SECRET is not`);
  BASE = issuer;
}

export class LinkProxyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
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
// caller (tools.ts) relays it to the agent as the tool call's own failure.
export async function callLinkProxy(req: LinkCallRequest): Promise<LinkCallResult> {
  if (!SECRET || !BASE) throw new LinkProxyError("not_configured", "The link proxy isn’t configured on this server.");
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
    throw new LinkProxyError(
      "unreachable",
      err instanceof Error && err.name === "AbortError" ? "The link proxy took too long to respond." : "The link proxy couldn’t be reached.",
    );
  } finally {
    clearTimeout(timer);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new LinkProxyError("bad_response", "The link proxy sent a response that isn’t valid JSON.");
  }
  const b = body as { ok?: unknown; result?: { content?: unknown; isError?: unknown }; error?: unknown; message?: unknown };
  if (b.ok === true) return { content: b.result?.content ?? [], isError: b.result?.isError === true };
  throw new LinkProxyError(typeof b.error === "string" ? b.error : "proxy_failed", typeof b.message === "string" ? b.message : "The link proxy refused the call.");
}
