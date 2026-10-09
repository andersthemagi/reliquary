// The claim on a file, shown where a person is looking at the file: a
// banner at the top of the file page and of the editor (files.ts), so
// nobody has to find the Claims page to learn an agent is mid-way through
// rewriting what they are reading (docs/public/concepts/claims.md, "Seeing
// and breaking claims").
//
// A claim covers exactly one path (claimlookup.ts), so a claim on another
// path, a folder or an expired claim shows nothing. The holder is the
// person the claim belongs to; whether an agent took it is read from the
// log's claim.grant event for the path (a claim granted over MCP is always
// by a connection, and the log records which). The label is the opposite
// kind of fact: a note someone typed, shown quoted and escaped, never as
// evidence of who holds the claim. Nothing here reads a secret or a fence:
// the table doesn't let anyone select the secret, and no page needs it.

import type pg from "pg";
import { siteHref } from "./hosts.js";
import { breakHref } from "./claimbreak.js";
import { activeClaim, claimAgents } from "./claimlookup.js";
import { callout, html, time, type Raw } from "./html.js";
import { canWrite, who, type Ctx, type Vault } from "./pages.js";

// What the person is about to do on the page the banner sits on.
export type ClaimMode = "view" | "write" | "propose";

// `back` is the page Break returns to once the claim is broken. Owners and
// editors get Break; the database is what decides who may break a claim
// (public.break_claim is require_human and checks write access), this only
// decides who is offered the button, as the Claims page does.
export async function claimBanner(c: pg.PoolClient, ctx: Ctx, v: Vault, path: string, mode: ClaimMode, back: string): Promise<Raw | ""> {
  const claim = await activeClaim(c, v.id, path);
  if (!claim) return "";
  const agent = (await claimAgents(c, v.id, [path])).has(path);
  const mine = claim.holder === ctx.userId;
  const subject = agent ? (mine ? "Your agent" : `${who(ctx, claim.holder, null)}’s agent`) : mine ? "You" : who(ctx, claim.holder, null);
  const verb = !agent && mine ? "are" : "is";
  const note = claim.holder_label ? html` The note on it, as typed: <q class="claim-note">${claim.holder_label}</q>` : "";
  const editing =
    mode === "write"
      ? html`<p>You can still save: a claim never blocks a write. If the file changes before you save, your save is refused and you see the new version first, so nobody’s work is overwritten by accident.</p>`
      : mode === "propose"
        ? html`<p>You can still propose a change: a claim never blocks one. Your change is a proposal, so the file itself stays as it is until people approve it.</p>`
        : "";
  const breakIt = canWrite(v)
    ? html`<p class="callout-actions"><a class="button" href="${breakHref(v.id, path, back)}" aria-label="Break the claim on ${path}">Break</a></p>${
        mode === "view" ? "" : html`<p class="hint">Breaking leaves this page, so save or copy what you have typed first.</p>`
      }`
    : "";
  return callout(
    mode === "view" ? "info" : "warning",
    html`<p>The claim ends ${time(claim.expires_at)}.${note}</p>${editing}${breakIt}
      <p class="hint"><a href="${siteHref("/docs/concepts/claims")}">About claims</a></p>`,
    { title: `${subject} ${verb} working on this file`, id: "claim-banner" },
  );
}
