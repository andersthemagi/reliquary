// Email the web app sends itself (today: vault invites), through Resend's
// HTTP API (https://resend.com/docs/api-reference/emails/send-email): one
// POST with a Bearer key, no SDK. Supabase Auth sends sign-in email on its
// own, over Resend's SMTP (docs/ops/runbook.md, "Email sender").
//
//   RESEND_API_KEY  a Resend API key with sending access only
//   EMAIL_FROM      the sender, "Reliquary <no-reply@notify.example.com>",
//                   on a domain verified in Resend
//   RESEND_API_URL  another base URL for the API (a fake in tests); honoured
//                   only when neither NETLIFY nor SELF_HOSTED is set
//
// Both of the first two are optional. Without them nothing is sent, and the
// Members page shows the invite link for the owner to send themself; with
// only one, or a malformed one, the same, and the page and the start-up log
// say which setting is wrong (never its value). A misconfigured sender never
// stops the server: invites work without email.
//
// Never logged, shown or sent anywhere but Resend: the key, the recipient's
// address, the link (a bearer secret) or the message.

import { createHash } from "node:crypto";
import { failure, networkReason, type Failure } from "./failure.js";

const DEFAULT_API = "https://api.resend.com";
// Each attempt's limit, and at most two attempts (the second only after a
// timeout, a network failure, a 429 or a 5xx, with the same idempotency key,
// so Resend sends it once): an owner waits at most about 8 seconds.
const ATTEMPT_MS = 4000;
const RETRY_AFTER_MS = 300;

type Config = { on: true; key: string; from: string; api: string } | { on: false; why: string };

export const ADDRESS = /^[^\s<>@"]+@[^\s<>@"]+\.[^\s<>@"]+$/;
const NAMED = /^([^<>"\r\n]{1,100}) <([^\s<>@"]+@[^\s<>@"]+\.[^\s<>@"]+)>$/;

export function validFrom(from: string): boolean {
  return ADDRESS.test(from) || NAMED.test(from);
}

// Reads the settings. `warnings` are for the start-up log: names only.
export function readMailer(env: NodeJS.ProcessEnv): { config: Config; warnings: string[] } {
  const key = (env.RESEND_API_KEY ?? "").trim();
  const from = (env.EMAIL_FROM ?? "").trim();
  const warnings: string[] = [];
  const strict = env.NETLIFY ? "NETLIFY" : env.SELF_HOSTED === "1" ? "SELF_HOSTED" : "";
  let api = DEFAULT_API;
  if (env.RESEND_API_URL) {
    if (strict) warnings.push(`RESEND_API_URL is ignored with ${strict} set: email goes to ${DEFAULT_API}`);
    else {
      try {
        const u = new URL(env.RESEND_API_URL);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
        api = u.origin + u.pathname.replace(/\/+$/, "");
      } catch {
        warnings.push("RESEND_API_URL isn't an http(s) URL: it is ignored");
      }
    }
  }
  const off = (why: string): { config: Config; warnings: string[] } => {
    if (key || from) warnings.push(`Invite email is off: ${why}`);
    return { config: { on: false, why }, warnings };
  };
  if (!key && !from) return off("no email sender is set up on this server (RESEND_API_KEY and EMAIL_FROM)");
  if (!key) return off("EMAIL_FROM is set but RESEND_API_KEY isn’t");
  if (!from) return off("RESEND_API_KEY is set but EMAIL_FROM isn’t");
  if (/\s/.test(key)) return off("RESEND_API_KEY has a space or line break in it");
  if (!validFrom(from)) return off("EMAIL_FROM isn’t an address or “Name <address>”");
  return { config: { on: true, key, from, api }, warnings };
}

let config: Config | undefined;

// At start (server.ts): reads the settings once and logs what is wrong.
export function configureMailer(env: NodeJS.ProcessEnv): void {
  const r = readMailer(env);
  config = r.config;
  for (const w of r.warnings) console.warn(w);
}

function current(): Config {
  if (!config) config = readMailer(process.env).config;
  return config;
}

export function mailerOn(): boolean {
  return current().on;
}
// Why nothing is sent, for the page that shows the link instead.
export function mailerOffReason(): string | undefined {
  const c = current();
  return c.on ? undefined : c.why;
}

// A key for Resend's Idempotency-Key header (at most 256 characters, kept 24
// hours): derived from something unique to the message, never equal to it.
export function idempotencyKey(kind: string, unique: string): string {
  return `${kind}/${createHash("sha256").update(`reliquary-email:${kind}:`).update(unique).digest("hex").slice(0, 40)}`;
}

// `what` names the operation in a failure ("Emailing the invite"); `tag` is
// the kind, a Resend tag and the log's word for it.
export type Outgoing = { to: string; subject: string; html: string; idempotencyKey: string; tag: string; what: string };
export type SendResult = { sent: true; id: string } | { sent: false; failure?: Failure; off?: string };

const WHERE = "email sender (Resend)";

// Sends one message. Never throws: a failure comes back with its ref,
// already logged (failure.ts), and the caller shows it with the fallback.
export async function sendEmail(m: Outgoing): Promise<SendResult> {
  const c = current();
  if (!c.on) return { sent: false, off: c.why };
  const body = JSON.stringify({ from: c.from, to: [m.to], subject: m.subject, html: m.html, tags: [{ name: "kind", value: m.tag }] });
  const scrub = (s: string) => s.split(c.key).join("<key>");
  let last: { status: number; why: string; code?: string } | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
    let res: Response;
    try {
      res = await fetch(`${c.api}/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${c.key}`,
          "content-type": "application/json",
          "idempotency-key": m.idempotencyKey,
          "user-agent": "reliquary-web",
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(ATTEMPT_MS),
      });
    } catch (err) {
      const net = networkReason(err) ?? "the request to Resend failed before an answer";
      last = { status: /timeout|timed out/i.test(net) ? 504 : 502, why: `Resend didn’t answer: ${net}`, code: "resend_network" };
      continue;
    }
    const text = await res.text().catch(() => "");
    if (res.ok) {
      let id = "";
      try {
        id = String((JSON.parse(text) as { id?: unknown }).id ?? "");
      } catch {
        // an answer we can't read still means Resend took it
      }
      // Resend's id only: never who it went to.
      console.info(`email sent kind=${m.tag} resend_id=${/^[\w-]{1,64}$/.test(id) ? id : "?"}`);
      return { sent: true, id };
    }
    let name = "";
    let said = "";
    try {
      const e = JSON.parse(text) as { name?: unknown; message?: unknown };
      name = typeof e.name === "string" ? e.name.replace(/[^\w.-]/g, "").slice(0, 60) : "";
      said = typeof e.message === "string" ? scrub(e.message).replace(/[\r\n]+/g, " ").slice(0, 300) : "";
    } catch {
      // not JSON: the status says enough
    }
    const why = `Resend answered ${res.status}${name ? ` (${name})` : ""}${said ? `: ${said.replace(/\.$/, "")}` : ""}`;
    last = { status: 502, why, code: name || `http_${res.status}` };
    if (!(res.status === 429 || res.status >= 500)) break;
  }
  const f = failure({ status: last!.status, where: WHERE, why: last!.why, what: m.what, code: last!.code });
  return { sent: false, failure: f };
}
