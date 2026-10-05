// The web app's side of the error model (failure.ts): what a request is
// doing, in words, and the error page that shows a failure. Every page that
// says something failed uses errorPage(); nothing says "something went
// wrong" (docs/public/reference/errors.md).

import { html, page, type Raw, type Shell, type Theme } from "./html.js";
import { siteHref } from "./hosts.js";
import { fail, ownRaise, plainText, Refusal, type Failure } from "./failure.js";
import type { Flash } from "./flash.js";
import { UUID } from "./personref.js";

// A refusal to show on the page the person was on (a flash, or the form
// again): the reason and the reference. Our own raised exceptions and
// Refusals, and the codes the database answers a refused change with, are
// shown; anything else is thrown on, to the error page.
export function refusalText(err: unknown): string {
  const e = err as { code?: string };
  if (err instanceof Refusal || ownRaise(err as never) || ["42501", "P0002", "22023", "23505", "55000"].includes(e.code ?? "")) {
    const f = fail(err);
    return `${f.why} (ref ${f.ref})`;
  }
  // A size ceiling or a path or name the database won't store
  // (20260925110000_hardening.sql). Never echoes what was sent.
  if (e.code === "23514" || e.code === "22001") {
    const f = fail(err);
    return `That’s too long (text up to 1 MB, reasons and notes up to 4000 characters), or a path or name has control characters in it: ${f.why.replace(/\.$/, "")} (ref ${f.ref})`;
  }
  throw err;
}

const short = (id: string) => (UUID.test(id) ? id.slice(0, 8) : "?");
// Text the person typed (a path, a vault name), shown back to them only and
// never logged, and only when it is plain: at most 200 characters, no
// control characters, no "." or ".." segment. Anything else isn't echoed
// (web/test/hardening.test.mjs), and the description says "a file".
export const typed = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  if (!t || t.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(t) || /(^|\/)\.\.?(\/|$)/.test(t)) return "";
  return t;
};

const DECISIONS: Record<string, string> = { approve: "Approving", reject: "Rejecting", request_changes: "Requesting changes on" };
const FILE_ACTIONS: Record<string, string> = {
  create: "Creating",
  write: "Saving",
  delete: "Deleting",
  propose: "Proposing a change to",
  "propose-delete": "Proposing to delete",
};

// What a request is doing: `what` for the person (may name a path they
// typed), `log` for the server log (the route's shape and ids only).
export function describe(method: string, url: URL, form: URLSearchParams): { what: string; log: string } {
  const get = method === "GET" || method === "HEAD";
  const p = url.pathname;
  const shape = `${method} ${p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id")}`;
  const ids = [...p.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map((m) => m[0]);
  const log = ids.length ? `${shape} ${ids.join(" ")}` : shape;
  const say = (what: string, extra = "") => ({ what, log: extra ? `${log} ${extra}` : log });
  const pages: Record<string, string> = {
    "/": "Opening Home",
    "/review": "Opening Review",
    "/inbox": "Opening your inbox",
    "/search": "Searching your vaults",
    "/settings": "Opening Account settings",
    "/account": "Opening Plan and usage",
    "/activity": "Opening Activity",
    "/connect": "Opening Connect",
    "/connections": "Opening Connections",
    "/vaults/new": "Opening New vault",
    "/feedback": "Opening Feedback",
    "/signin": "Signing in",
    "/signin/code": "Signing in with a code",
    "/auth/confirm": "Signing in with a link",
  };
  if (get && pages[p]) return say(pages[p]);
  if (p === "/signin" || p === "/signin/code") return say("Signing in");
  if (p === "/auth/confirm") return say("Signing in with a link");
  if (p === "/signout") return say("Signing out");
  if (p === "/theme") return say("Changing the theme");
  if (p === "/settings/name") return say("Saving your display name");
  if (p === "/settings/sign-out-everywhere") return say("Signing out everywhere");
  if (p === "/settings/email") return say("Changing your email address");
  if (p === "/settings/delete") return say(get ? "Opening Delete account" : "Deleting your account");
  if (p === "/feedback") return say("Sending feedback");
  if (p === "/vaults/new") return say(`Creating vault ${typed(form.get("name")) || "(no name)"}`.trim());
  if (p === "/connections/new") return say("Creating a token");
  if (/^\/connections\/[^/]+\/revoke$/.test(p)) return say("Revoking a connection");
  if (p === "/oauth/authorize") return say(get ? "Connecting an app (the consent page)" : "Connecting an app");
  if (p === "/invite") return say(get ? "Opening an invite" : "Accepting an invite");
  const m = /^\/v\/([^/]+)(\/.*)?$/.exec(p);
  if (!m) return say(get ? `Opening ${p}` : `Sending a form to ${p}`);
  const [, id, rest = ""] = m;
  const vault = `vault ${short(id)}`;
  const q = (k: string) => typed(url.searchParams.get(k));
  const path = typed(form.get("path")) || q("path");
  if (rest === "") return say(`Opening ${vault}`);
  if (rest === "/tree") return say(`Opening folder ${q("path") || "/"} in ${vault}`);
  if (rest === "/file" && get) return say(`Opening ${q("path") || "a file"} in ${vault}`);
  if (rest === "/file") {
    const action = form.get("action") ?? "";
    return say(`${FILE_ACTIONS[action] ?? "Changing"} ${path || "a file"} in ${vault}`, `action=${FILE_ACTIONS[action] ? action : "other"}`);
  }
  if (rest === "/edit") return say(`Opening the editor for ${q("path") || "a file"} in ${vault}`);
  if (rest === "/new") return say(`Opening New file in ${vault}`);
  if (rest === "/proposals") return say(`Opening the proposals of ${vault}`);
  if (rest === "/threads") return say(get ? `Opening the threads of ${vault}` : `Opening a thread in ${vault}`);
  if (rest === "/threads/new") return say(`Opening New thread in ${vault}`);
  const tm = /^\/threads\/([^/]+)(?:\/([a-z]+))?$/.exec(rest);
  if (tm) {
    const thread = `thread ${short(tm[1])} in ${vault}`;
    if (get) return say(url.searchParams.has("redact") ? `Opening the redact page of ${thread}` : `Opening ${thread}`);
    const did: Record<string, string> = { post: "Posting in", resolve: "Resolving", reopen: "Reopening", redact: "Redacting a message in" };
    if (tm[2] && did[tm[2]]) return say(`${did[tm[2]]} ${thread}`);
  }
  if (rest === "/activity" || rest === "/log") return say(`Opening the activity of ${vault}`);
  if (rest === "/diagnostics") return say(`Opening the diagnostics of ${vault}`);
  if (rest === "/rules") return say(get ? `Opening the rules of ${vault}` : `Saving a rule for ${path || "a path"} in ${vault}`);
  if (rest === "/rules/owners") {
    if (get) return say(`Opening the named owners of ${path || "a path"} in ${vault}`);
    const naming = form.get("action") === "add";
    return say(`${naming ? "Naming an owner of" : "Removing an owner of"} ${path || "a path"} in ${vault}`, `action=${naming ? "add" : "remove"}`);
  }
  if (rest === "/config/watching") {
    if (get) return say(`Opening what you watch in ${vault}`);
    return form.get("action") === "unwatch" ? say(`Stopping a watch in ${vault}`) : say(`Watching ${path || "a path"} in ${vault}`);
  }
  if (rest === "/search") return say(`Searching ${vault}`);
  if (rest === "/erase") return say(`Erasing ${path || "a file"} in ${vault}`);
  if (rest === "/variables" || rest.startsWith("/variables/")) {
    const sub = rest.split("/").slice(2).filter((s) => !UUID.test(s)).join(" ");
    return say(get ? `Opening the variables of ${vault}` : `Changing variables in ${vault}${sub ? ` (${sub})` : ""}`);
  }
  if (rest === "/config" || rest.startsWith("/config/")) {
    const sub = rest.split("/").slice(2).filter((s) => !UUID.test(s)).join(" ");
    return say(get ? `Opening the settings of ${vault}` : `Changing the settings of ${vault}${sub ? ` (${sub})` : ""}`);
  }
  const pm = /^\/proposals\/([^/]+)(\/[a-z]+)?$/.exec(rest);
  if (pm) {
    const proposal = `proposal ${short(pm[1])} in ${vault}`;
    const action = pm[2] ?? "";
    if (get && action === "") return say(`Opening ${proposal}`);
    if (get) return say(`Opening ${action.slice(1)} for ${proposal}`);
    if (action === "/decide") {
      const d = form.get("decision") ?? "approve";
      return say(`${DECISIONS[d] ?? "Deciding on"} ${proposal}`, `decision=${DECISIONS[d] ? d : "other"}`);
    }
    if (action === "/edit") return say(`Editing and approving ${proposal}`);
    if (action === "/revise") return say(`Revising ${proposal}`);
    if (action === "/repropose") return say(`Proposing ${proposal} again`);
    if (action === "/comment") return say(`Commenting on ${proposal}`);
    if (action === "/snooze") return say(`Snoozing ${proposal}`);
    if (action === "/unsnooze") return say(`Unsnoozing ${proposal}`);
  }
  return say(get ? `Opening ${p}` : `Sending a form to ${p}`);
}

export type ErrorPageOpts = {
  theme?: Theme;
  title?: string; // default: "<what> failed"
  lede?: Raw | string; // default: the reason
  back?: string; // a local path
  backLabel?: string; // what the back button says, "Back" by default
  // The signed-in frame, when there is one.
  user?: string;
  csrf?: string;
  flash?: Flash | string;
  shell?: Shell;
  path?: string;
};

// The error page's body: the reason first, then what, where, why and the
// reference, and, folded away (a <details>, no script needed), the same as
// plain text to copy into a report, then links back. For a page that has
// its own frame (the invite page, members.ts); everything else uses
// errorPage().
export function errorBody(f: Failure, o: Pick<ErrorPageOpts, "title" | "lede" | "back" | "backLabel"> = {}): Raw {
  const title = o.title ?? `${f.what} failed`;
  const back = o.back && o.back.startsWith("/") && !o.back.startsWith("//") ? o.back : "/";
  return html`<h1>${title}</h1>
    <p class="lede">${o.lede ?? f.why}</p>
    <dl class="failure">
      <dt>What</dt><dd>${f.what}</dd>
      <dt>Where</dt><dd>${f.where}</dd>
      <dt>Why</dt><dd>${f.why}</dd>
      <dt>Reference</dt><dd><code>ref ${f.ref}</code></dd>
    </dl>
    <details class="failure-details">
      <summary>Details to send if you report this</summary>
      <p class="small muted">Copy these lines into your report. The reference finds the full record in Reliquary’s server log.</p>
      <pre class="code failure-copy">${plainText(f, { time: new Date().toISOString().slice(0, 19) + "Z" })}</pre>
    </details>
    <p class="actions">${back !== "/" ? html`<a class="button" href="${back}">${o.backLabel ?? "Back"}</a>` : ""}<a class="button" href="/">Home</a><a href="${siteHref("/docs/reference/errors")}">What these fields mean</a></p>`;
}

// The error page: errorBody() in the site's frame, signed in or not.
export function errorPage(f: Failure, o: ErrorPageOpts = {}): string {
  return page(o.title ?? `${f.what} failed`, errorBody(f, o), {
    theme: o.theme,
    user: o.user,
    csrf: o.csrf,
    flash: o.flash,
    shell: o.shell,
    path: o.path,
  });
}
