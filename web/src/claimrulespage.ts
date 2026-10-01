// Claim rules (design.md "Claims and work plans" item 3; docs/public/
// concepts/claims.md): how long a claim on a path lasts, and how many a
// connection or person may hold, overriding the fixed defaults (48 hour
// lease, 7 day hold limit, 1 claim per connection, 5 per person) by vault
// and path prefix. A section on the vault's Rules page, not its own route
// to GET: only public.set_claim_rule (POST /v/:id/rules/claims) changes
// anything, the same ceiling as a canon/open rule (owner, in person).
//
// Unlike a canon/open rule, removing one isn't destructive: nothing is
// lost, a path just goes back to the fixed defaults, so Remove here is a
// single-step form, not a confirm page (html.ts's menu() guardrail is
// about actions with real consequences; this has none) -- and, unlike
// rules.ts's own policy form, a refused save is a flash, not a sticky
// form with the typed values kept: simpler, and avoids rules.ts and this
// module importing each other just to re-render one another's section.
//
// The three starting presets (design item 3) are submit buttons on the
// same form as the manual fields: picking one sends its own numbers
// straight through, the typed path along with it, in one step.

import type pg from "pg";
import { asPerson } from "./db.js";
import { Refusal } from "./failure.js";
import { csrfField, html, time, type Raw } from "./html.js";
import { message, notFound, vault, vaultPath, type Ctx, type Reply, type Vault, who } from "./pages.js";

export type ClaimRule = {
  path: string;
  lease_minutes: number;
  hold_limit_minutes: number;
  connection_cap: number;
  person_cap: number;
  set_by: string;
  set_at: Date;
};

export async function loadClaimRules(c: pg.PoolClient, id: string): Promise<ClaimRule[]> {
  const { rows } = await c.query(
    `select path, lease_minutes, hold_limit_minutes, connection_cap, person_cap, set_by, set_at
       from public.claim_rules where vault_id = $1 order by path`,
    [id],
  );
  return rows;
}

// Minutes as a person reads them: under 2 hours in minutes, under 2 days
// in hours, otherwise days. Never a stray ".5": the numbers this page
// stores are always whole minutes a person typed or a preset gave.
function duration(minutes: number): string {
  if (minutes < 120) return `${minutes} min`;
  if (minutes < 2880) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} days`;
}

export const CLAIM_RULE_PRESETS = [
  { id: "hackathon", name: "Hackathon", lease: 30, hold: 120 },
  { id: "team", name: "Team", lease: 480, hold: 1440 },
  { id: "org", name: "Org", lease: 2880, hold: 10080 },
] as const;

export function claimRulesSection(ctx: Ctx, id: string, owner: boolean, rules: ClaimRule[]): Raw {
  const action = `/v/${id}/rules/claims`;

  const table = rules.length
    ? html`<div class="table-wrap"><table class="table-stack rules-table">
        <thead><tr><th scope="col">Path</th><th scope="col">Lease</th><th scope="col">Hold limit</th><th scope="col">Caps</th><th scope="col">Set by</th>${
          owner ? html`<th scope="col"><span class="sr-only">Actions</span></th>` : ""
        }</tr></thead>
        <tbody>${rules.map(
          (r) => html`<tr>
            <td data-label="Path"><code class="rule-path">${r.path}</code><span class="rule-scope">${r.path.endsWith("/") ? "Folder" : "File"}</span></td>
            <td data-label="Lease">${duration(r.lease_minutes)}</td>
            <td data-label="Hold limit">${duration(r.hold_limit_minutes)}</td>
            <td data-label="Caps" class="small">${r.connection_cap}/connection, ${r.person_cap}/person</td>
            <td data-label="Set by" class="small muted">${who(ctx, r.set_by, null)} · ${time(r.set_at)}</td>
            ${owner
              ? html`<td class="num row-actions"><form method="post" action="${action}">
                  ${csrfField(ctx.csrf)}<input type="hidden" name="action" value="remove">
                  <input type="hidden" name="path" value="${r.path}">
                  <button class="button quiet" aria-label="Remove the claim rule on ${r.path}">Remove</button></form></td>`
              : ""}
          </tr>`,
        )}</tbody></table></div>`
    : html`<p class="hint">No claim rule yet: every path leases for 48 hours, with a 7 day hold limit, 1 claim per connection and 5 per person.</p>`;

  const presetButtons = CLAIM_RULE_PRESETS.map(
    (p) =>
      html`<button class="button quiet" name="preset" value="${p.id}" formnovalidate>${p.name}<span class="token-client">${duration(p.lease)} lease, ${duration(p.hold)} hold</span></button>`,
  );

  const addForm = owner
    ? html`<form method="post" action="${action}" class="panel rule-form" id="add-claim-rule" aria-labelledby="add-claim-rule-title">
        <h2 id="add-claim-rule-title" class="form-title">Add or change a claim rule</h2>
        ${csrfField(ctx.csrf)}
        <div class="fields">
          <div><label for="crp">Path or folder</label><input id="crp" type="text" name="path" placeholder="clients/" required></div>
          <div><label for="crl">Lease (minutes)</label><input id="crl" class="narrow" type="number" name="lease" min="1" step="1"></div>
          <div><label for="crh">Hold limit (minutes)</label><input id="crh" class="narrow" type="number" name="hold" min="1" step="1"></div>
          <div><label for="crc">Claims per connection</label><input id="crc" class="narrow" type="number" name="conn" min="1" step="1" value="1"></div>
          <div><label for="crpn">Claims per person</label><input id="crpn" class="narrow" type="number" name="person" min="1" step="1" value="5"></div>
        </div>
        <p class="hint">A folder ends in <code>/</code> and covers everything inside it; a file is its full path. Saving a path that has a rule replaces it. Hold limit is at least the lease.</p>
        <div class="actions"><button class="primary">Save claim rule</button></div>
        <p class="hint">Or start from a preset, with the path above filled in: ${presetButtons}</p>
      </form>`
    : "";

  return html`<h2>Claim rules</h2>
    <p class="hint">How long a claim on a path lasts, and how many a connection or person may hold at once. <a href="/docs/concepts/claims#claim-rules">About claim rules</a></p>
    ${table}
    ${addForm}`;
}

// ---------------------------------------------------------------------------
// POST: remove, or add/change (manual fields, or a preset's own numbers).
// The database refuses anyone but an owner, and a bad path; both come back
// as a flash with its reference, same as every other refusal on this page.

const refuse = (why: string) => message(new Refusal({ status: 400, where: "web app (claim rules)", why }));
const PRESET_BY_ID = new Map<string, (typeof CLAIM_RULE_PRESETS)[number]>(CLAIM_RULE_PRESETS.map((p) => [p.id, p]));

export async function setClaimRuleAction(ctx: Ctx, id: string): Promise<Reply> {
  const back = vaultPath(id, "/rules");
  const path = (ctx.form.get("path") ?? "").trim();
  if (ctx.form.get("action") === "remove") {
    try {
      const done = await asPerson(ctx.userId, async (c) => {
        if (!(await vault(c, ctx, id))) return null;
        await c.query(`select public.set_claim_rule($1, $2, null, null)`, [id, path]);
        return true;
      });
      if (done === null) return notFound(ctx);
      ctx.setFlash(`Removed the claim rule on ${path}. It now follows the next rule that applies, or the fixed defaults.`, "success");
    } catch (err) {
      ctx.setFlash(message(err));
    }
    return { redirect: back };
  }

  const preset = PRESET_BY_ID.get(ctx.form.get("preset") ?? "");
  const num = (field: string, fallback?: number) => {
    const typed = (ctx.form.get(field) ?? "").trim();
    if (typed === "" && fallback !== undefined) return fallback;
    return /^\d{1,9}$/.test(typed) ? Number(typed) : NaN;
  };
  const lease = preset ? preset.lease : num("lease");
  const hold = preset ? preset.hold : num("hold");
  const conn = num("conn", 1);
  const person = num("person", 5);
  if (path === "") {
    ctx.setFlash(refuse("A claim rule needs a path: a folder ending in / or a file. Nothing was saved"));
    return { redirect: back };
  }
  if (!(lease >= 1)) {
    ctx.setFlash(refuse("The lease is a whole number of minutes, at least 1. Nothing was saved"));
    return { redirect: back };
  }
  if (!(hold >= lease)) {
    ctx.setFlash(refuse("The hold limit is a whole number of minutes, at least the lease. Nothing was saved"));
    return { redirect: back };
  }
  if (!(conn >= 1) || !(person >= conn)) {
    ctx.setFlash(refuse("Claims per connection and per person are whole numbers, connection at least 1 and person at least the connection cap. Nothing was saved"));
    return { redirect: back };
  }
  try {
    const done = await asPerson(ctx.userId, async (c) => {
      if (!(await vault(c, ctx, id))) return null;
      await c.query(`select public.set_claim_rule($1, $2, $3, $4, null, $5, $6)`, [id, path, lease, hold, conn, person]);
      return true;
    });
    if (done === null) return notFound(ctx);
    ctx.setFlash(`Saved the claim rule on ${path}: ${duration(lease)} lease, ${duration(hold)} hold limit.`, "success");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: back };
}
