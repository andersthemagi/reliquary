// A vault's Claims page (docs/design.md, "Claims and work plans";
// docs/public/concepts/claims.md): who's working which path, and for how
// much longer. Agents have had this over MCP since CL-2.4 (claim_path,
// renew_claim, release_claim, list_claims); this is the same data for a
// person, plus the one thing MCP never offers -- breaking someone else's
// claim, since break_claim is require_human (design.md "Claims and work
// plans" item 1, the same ceiling as approving or revealing a secret).
//
// A claim is a courtesy signal, not an access gate (compare-and-swap
// already guards the write): breaking one only frees the path for someone
// else to claim next, so it goes through a confirm page like every other
// destructive action (html.ts's menu() guardrail), but needs no typed name.
//
//   GET  /v/:id/claims               active claims, with Break for owners/editors (Settings, Diagnostics, Claims)
//   GET  /v/:id/claims?break=<path>  confirm breaking the claim on path
//   POST /v/:id/claims               action=break, path, confirm=1
//
// Both Break routes take an optional return=<page> (the file page's banner
// sends one): where to go after, or on Cancel, in place of this page. Only
// a page of this same vault is followed (claimbreak.ts returnTarget).

import type pg from "pg";
import { asPerson } from "./db.js";
import { Refusal } from "./failure.js";
import { diagnosticsFrame, diagSection } from "./diagnostics.js";
import { breakHref, returnTarget } from "./claimbreak.js";
import { activeClaim, activeClaims, type Claim } from "./claimlookup.js";
import { claimRulesPath } from "./claimrulespage.js";
import { confirmPage, emptyState, html, time, type Raw } from "./html.js";
import { vaultShell } from "./files.js";
import { settingsCrumb } from "./vaultadmin.js";
import { canWrite, filePath, message, notFound, render, vault, vaultPath, who, type Ctx, type Reply, type Vault } from "./pages.js";

export const claimsPath = (id: string) => vaultPath(id, "/claims");

// A path typed into a URL, said back only when it's plain (as rules.ts and pathowners.ts do).
const shown = (path: string) => (/^[^\u0000-\u001f\u007f]{1,200}$/.test(path) ? path : "that path");

function claimsTable(ctx: Ctx, id: string, v: Vault, rows: Claim[]): Raw {
  const breakable = canWrite(v);
  return html`<div class="table-wrap"><table class="table-stack member-list">
    <thead><tr><th scope="col">Path</th><th scope="col">Held by</th><th scope="col">Time left</th>${
      breakable ? html`<th scope="col"><span class="sr-only">Actions</span></th>` : ""
    }</tr></thead>
    <tbody>${rows.map(
      (r) => html`<tr><td data-label="Path"><a href="${filePath(id, r.path)}">${r.path}</a></td>
        <td class="small" data-label="Held by">${who(ctx, r.holder, null)}${r.holder_label ? html`<span class="token-client">${r.holder_label}</span>` : ""}</td>
        <td class="small" data-label="Time left">${time(r.expires_at)}</td>
        ${breakable
          ? html`<td class="num row-actions"><a class="button quiet" href="${claimsPath(id)}?break=${encodeURIComponent(r.path)}" aria-label="Break the claim on ${r.path}">Break</a></td>`
          : ""}</tr>`,
    )}</tbody></table></div>`;
}

// The page, in the vault shell; or, when it can't be shown, a note for the
// page it sends the person back to (pathowners.ts's build(), same shape).
// The list is a tab of Diagnostics; the confirm page is not, so it has no tabs.
type Built = { shell: Raw; title: string } | { back: string; note: string; tone: "warning" | "info" } | null;

async function build(ctx: Ctx, id: string, fn: (c: pg.PoolClient, v: Vault) => Promise<{ body: Raw; title: string; tab?: true } | { back: string; note: string; tone: "warning" | "info" } | null>): Promise<Reply> {
  const out: Built = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const r = await fn(c, v);
    if (!r || "back" in r) return r;
    return { shell: await vaultShell(c, ctx, v, { section: "diagnostics" }, r.tab ? diagnosticsFrame(id, v, "claims", r.body) : r.body), title: r.title };
  });
  if (!out) return notFound(ctx);
  if ("back" in out) {
    ctx.setFlash(out.note, out.tone);
    return { redirect: out.back };
  }
  return render(ctx, out.title, out.shell, "vaults");
}

export async function claims(ctx: Ctx, id: string): Promise<Reply> {
  const breakPath = ctx.url.searchParams.get("break");
  if (breakPath !== null) return confirmBreak(ctx, id, breakPath);
  return build(ctx, id, async (c, v) => {
    const rows = await activeClaims(c, id);
    const body = html`
      ${diagSection("Claims", "Who’s working which path, and for how much longer. A claim is a courtesy signal, not an access gate: it never blocks a write.")}
      ${rows.length ? claimsTable(ctx, id, v, rows) : emptyState({ title: "No active claims", body: "Nobody is claiming a path right now." })}
      <p class="hint">Your agents see and take the same claims over MCP (<code>list_claims</code>, <code>claim_path</code>). How long a claim lasts is set in <a href="${claimRulesPath(id)}">Claim rules</a>. <a href="/docs/concepts/claims">About claims</a></p>`;
    return { body, title: "Claims", tab: true };
  });
}

// ---------------------------------------------------------------------------
// Confirm breaking someone's claim. A GET: nothing changes until its form is sent.

async function confirmBreak(ctx: Ctx, id: string, path: string): Promise<Reply> {
  return build(ctx, id, async (c, v) => {
    const back = claimsPath(id);
    const ret = returnTarget(id, ctx.url.searchParams.get("return"));
    const to = ret ?? back;
    if (!canWrite(v)) return { back: to, note: "Only an owner or editor breaks a claim.", tone: "warning" };
    const claim = await activeClaim(c, id, path);
    if (!claim) return { back: to, note: `There’s no active claim on ${shown(path)} to break; it may have been released or expired already.`, tone: "warning" };
    const holder = who(ctx, claim.holder, null);
    const body = confirmPage({
      title: `Break the claim on ${path}?`,
      crumb: settingsCrumb(id, v, { label: "Diagnostics", href: vaultPath(id, "/diagnostics") }, { label: "Claims", href: back }, { label: "Break" }),
      lede: html`${holder}${claim.holder_label ? html` (${claim.holder_label})` : ""} loses this claim; they, and their agent, can claim <code>${path}</code> again once they’re ready.`,
      consequences: ["Nothing about the file itself changes: a claim is a courtesy signal, not an access gate.", "It’s logged in Activity."],
      action: claimsPath(id),
      csrf: ctx.csrf,
      fields: { path, action: "break", confirm: "1", ...(ret ? { return: ret } : {}) },
      button: `Break the claim on ${path}`,
      cancel: to,
    });
    return { body, title: "Break a claim" };
  });
}

// ---------------------------------------------------------------------------
// POST: break, once confirmed. The database refuses anyone but an owner or
// editor, and a path with no active claim; its refusal comes back as a
// flash with its reference.

const refuse = (why: string) => message(new Refusal({ status: 400, where: "web app (a vault's claims)", why }));

export async function claimAction(ctx: Ctx, id: string): Promise<Reply> {
  const path = ctx.form.get("path") ?? "";
  const action = ctx.form.get("action") ?? "";
  const back = claimsPath(id);
  const ret = returnTarget(id, ctx.form.get("return"));
  const to = ret ?? back;
  if (action !== "break") {
    ctx.setFlash(refuse("The form didn’t say what to do, so nothing changed"));
    return { redirect: to };
  }
  // Only the confirm page's form carries this: anything else is sent there.
  if (ctx.form.get("confirm") !== "1") return { redirect: breakHref(id, path, ret ?? undefined) };
  try {
    const done = await asPerson(ctx.userId, async (c) => {
      if (!(await vault(c, ctx, id))) return null;
      await c.query(`select public.break_claim($1, $2)`, [id, path]);
      return true;
    });
    if (done === null) return notFound(ctx);
    ctx.setFlash(`The claim on ${path} is broken; it’s free to claim again.`, "success");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: to };
}
