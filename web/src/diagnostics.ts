// Diagnostics: the part of a vault's Settings for working out why something
// happened. Flags and Claims live here, so the vault's own navigation leads
// with what a person reads or acts on (docs/parity.md says an agent's
// capabilities should exist in the web UI too; it doesn't say they belong in
// the first row). Nothing is removed: each page is the one it was, behind
// this frame, at the URL it always had.
//
//   GET /v/:id/diagnostics   what each tab is for; reads nothing that changes
//   GET /v/:id/flags         the Flags tab (flagspage.ts)
//   GET /v/:id/claims        the Claims tab (claimspage.ts)
//   GET /v/:id/activity      the Log tab: the full log (pages.ts, activity.ts)
//
// The landing page is not the Flags tab on purpose: opening Flags marks the
// person's flags shown, and finding Diagnostics in Settings shouldn't.

import { html, tabs, type Raw } from "./html.js";
import { asPerson } from "./db.js";
import { vaultShell } from "./files.js";
import { notFound, render, vault, vaultPath, type Ctx, type Reply, type Vault } from "./pages.js";
import { settingsHeader } from "./vaultadmin.js";

export type DiagTab = "flags" | "claims" | "log";

// The tabs, in order, and one line each for the landing page.
const DIAG_TABS: { tab: DiagTab; label: string; what: string }[] = [
  { tab: "flags", label: "Flags", what: "What changed in this vault since you were last told. Opening it marks what it lists as shown for you, not for your agents." },
  { tab: "claims", label: "Claims", what: "Who is working on which path right now, and for how long. Owners and editors can break a claim." },
  { tab: "log", label: "Log", what: "Every event the vault recorded, including members, rules, variables and claims. It can only be added to." },
];
// The Log keeps the address the vault's Activity page always had.
const tabHref = (id: string, tab: DiagTab) => vaultPath(id, tab === "log" ? "/activity" : `/${tab}`);

export const DIAGNOSTICS_NOTE = "For working out why something happened; most people never need it.";

// A tab's heading and what it shows, under the frame's own heading.
export const diagSection = (title: string, what: Raw | string): Raw => html`<h2>${title}</h2><p class="lede">${what}</p>`;

// The Settings header with Diagnostics current, the tabs, then the tab's body.
export function diagnosticsFrame(id: string, v: Vault, current: DiagTab | undefined, body: Raw): Raw {
  return html`${settingsHeader(id, v, "diagnostics", { description: DIAGNOSTICS_NOTE })}
    <div class="diag-tabs">${tabs(DIAG_TABS.map((t) => ({ href: tabHref(id, t.tab), label: t.label, current: t.tab === current })), "Diagnostics")}</div>
    ${body}`;
}

export async function diagnostics(ctx: Ctx, id: string): Promise<Reply> {
  const out = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const body = html`<dl class="settings-facts">${DIAG_TABS.map(
      (t) => html`<div><dt><a href="${tabHref(id, t.tab)}">${t.label}</a></dt><dd>${t.what}</dd></div>`,
    )}</dl>`;
    return vaultShell(c, ctx, v, { section: "diagnostics" }, diagnosticsFrame(id, v, undefined, body));
  });
  if (!out) return notFound(ctx);
  return render(ctx, "Diagnostics", out, "vaults");
}
