// Claim rules (design.md "Claims and work plans" item 3; docs/public/
// concepts/claims.md): how long a claim on a path lasts, and how many a
// connection or person may hold, overriding the fixed defaults (48 hour
// lease, 7 day hold limit, 1 claim per connection, 5 per person) for the
// whole vault or by path prefix. Its own page under Rules, because the
// refusal of a bad save has to land on the form with what was typed kept,
// the way the policy rule form does, and a section at the foot of a long
// page can't do that without the answer being out of sight.
//
//   GET  /v/:id/rules/claims                     the rules; owners also get the form
//   GET  /v/:id/rules/claims?claim=<path>#...    the form filled with that rule (empty: the whole vault)
//   POST /v/:id/rules/claims                     save, or action=remove
//
// Only public.set_claim_rule changes anything, the same ceiling as a
// canon/open rule (owner, in person). The whole vault is the rule with an
// empty path (20261009110000_claim_rule_whole_vault.sql); it is always the
// first row, and with none saved it shows the fixed numbers with Set.
//
// Unlike a canon/open rule, removing one isn't destructive: nothing is
// lost, a path just goes back to the next rule that applies, so Remove here
// is a single-step form, not a confirm page (html.ts's menu() guardrail is
// about actions with real consequences; this has none).
//
// The three presets (design item 3) are submit buttons on the same form as
// the manual fields: picking one sends its own numbers straight through,
// for whatever "Applies to" says, in one step.

import type pg from "pg";
import { asPerson } from "./db.js";
import { Refusal } from "./failure.js";
import { csrfField, html, pageHeader, time, type Raw } from "./html.js";
import { vaultShell } from "./files.js";
import { settingsCrumb } from "./vaultadmin.js";
import { message, notFound, q, render, vault, vaultPath, who, type Ctx, type Reply } from "./pages.js";

export type ClaimRule = {
  path: string; // "" is the whole vault
  lease_minutes: number;
  hold_limit_minutes: number;
  connection_cap: number;
  person_cap: number;
  set_by: string;
  set_at: Date;
};

export const claimRulesPath = (id: string) => vaultPath(id, "/rules/claims");

export async function loadClaimRules(c: pg.PoolClient, id: string): Promise<ClaimRule[]> {
  const { rows } = await c.query(
    `select path, lease_minutes, hold_limit_minutes, connection_cap, person_cap, set_by, set_at
       from public.claim_rules where vault_id = $1 order by path`,
    [id],
  );
  return rows;
}

// What a path gets when no rule covers it: private.claim_rule_for's own fallback.
export const BUILT_IN = { lease: 48 * 60, hold: 7 * 24 * 60, conn: 1, person: 5 };

// Minutes as a person reads them, exactly: 150 minutes is "150 min", never
// a rounded "3 h".
export function duration(minutes: number): string {
  if (minutes >= 2880 && minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes >= 120 && minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

export const CLAIM_RULE_PRESETS = [
  { id: "hackathon", name: "Hackathon", lease: 30, hold: 120 },
  { id: "team", name: "Team", lease: 480, hold: 1440 },
  { id: "org", name: "Org", lease: 2880, hold: 10080 },
] as const;
const PRESET_BY_ID = new Map<string, (typeof CLAIM_RULE_PRESETS)[number]>(CLAIM_RULE_PRESETS.map((p) => [p.id, p]));

const UNITS = { minutes: 1, hours: 60, days: 1440 } as const;
type Unit = keyof typeof UNITS;
// A year: far past any lease worth setting, and a bound the typed number times its unit can't overflow.
const MAX_MINUTES = 365 * 1440;

// The largest unit that holds the minutes exactly, so a stored 120 shows as 2 hours.
function inUnits(minutes: number): { n: string; unit: Unit } {
  if (minutes % 1440 === 0) return { n: String(minutes / 1440), unit: "days" };
  if (minutes % 60 === 0) return { n: String(minutes / 60), unit: "hours" };
  return { n: String(minutes), unit: "minutes" };
}

// The form's values: as sent, when saving was refused (shown with the
// refusal and its reference, the refused field marked), or a rule's own,
// when Change was chosen.
type ClaimForm = {
  scope: "vault" | "path";
  path: string;
  lease: string;
  leaseUnit: Unit;
  hold: string;
  holdUnit: Unit;
  conn: string;
  person: string;
  error?: string;
  field?: "path" | "lease" | "hold" | "conn" | "person";
};

const formOf = (r: { path: string; lease: number; hold: number; conn: number; person: number }): ClaimForm => {
  const lease = inUnits(r.lease);
  const hold = inUnits(r.hold);
  return {
    scope: r.path === "" ? "vault" : "path",
    path: r.path,
    lease: lease.n,
    leaseUnit: lease.unit,
    hold: hold.n,
    holdUnit: hold.unit,
    conn: String(r.conn),
    person: String(r.person),
  };
};

const scopeName = (path: string) => (path === "" ? "the whole vault" : path);

// Who it applies to, as a line under the name: what a rule covers.
function appliesTo(ctx: Ctx, r: ClaimRule | null) {
  if (!r) return html`<strong>Whole vault</strong><span class="rule-scope">Every path no rule below covers · fixed default</span>`;
  const set = html`set by ${who(ctx, r.set_by, null)}, ${time(r.set_at)}`;
  if (r.path === "") return html`<strong>Whole vault</strong><span class="rule-scope">Every path no rule below covers · ${set}</span>`;
  return html`<code class="rule-path">${r.path}</code><span class="rule-scope">${r.path.endsWith("/") ? "Folder" : "File"} · ${set}</span>`;
}

export async function claimRules(ctx: Ctx, id: string, form?: ClaimForm): Promise<Reply> {
  const claim = ctx.method === "GET" ? ctx.url.searchParams.get("claim") : null;
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const rules = await loadClaimRules(c, id);
    const owner = v.role === "owner";
    const action = claimRulesPath(id);
    const whole = rules.find((r) => r.path === "") ?? null;
    const paths = rules.filter((r) => r.path !== "");

    // "Change" fills the form with the rule as it is; "Set" on the fixed-default
    // row, with the numbers that apply now.
    const changing = claim !== null ? (rules.find((r) => r.path === claim) ?? null) : null;
    const values: ClaimForm | undefined =
      form ??
      (changing
        ? formOf({ path: changing.path, lease: changing.lease_minutes, hold: changing.hold_limit_minutes, conn: changing.connection_cap, person: changing.person_cap })
        : claim === ""
          ? formOf({ path: "", lease: BUILT_IN.lease, hold: BUILT_IN.hold, conn: BUILT_IN.conn, person: BUILT_IN.person })
          : undefined);
    const described = (f: NonNullable<ClaimForm["field"]>, hint: string) =>
      form?.error && form.field === f ? html` aria-invalid="true" aria-describedby="claim-error ${hint}"` : html` aria-describedby="${hint}"`;
    const unitSelect = (name: string, chosen: Unit) =>
      html`<select name="${name}" aria-label="${name === "lease_unit" ? "Lease" : "Hold limit"} unit">${(Object.keys(UNITS) as Unit[]).map(
        (u) => html`<option value="${u}"${u === chosen ? html` selected` : ""}>${u}</option>`,
      )}</select>`;
    const scope = values?.scope ?? "vault";
    // A rule was chosen from the table: an existing one to change, or the fixed-default whole-vault row to set.
    const picking = changing !== null || claim === "";

    const row = (r: ClaimRule | null) => {
      const lease = r?.lease_minutes ?? BUILT_IN.lease;
      const hold = r?.hold_limit_minutes ?? BUILT_IN.hold;
      const conn = r?.connection_cap ?? BUILT_IN.conn;
      const person = r?.person_cap ?? BUILT_IN.person;
      const path = r?.path ?? "";
      const here = `${action}?claim=${q(path)}#set-claim-rule`;
      return html`<tr>
        <td data-label="Applies to">${appliesTo(ctx, r)}</td>
        <td data-label="Lease">${duration(lease)}</td>
        <td data-label="Hold limit">${duration(hold)}</td>
        <td data-label="Claims at once" class="small">${conn} per connection, ${person} per person</td>
        ${owner
          ? html`<td class="num row-actions">${
              r
                ? html`<a class="button quiet" href="${here}" aria-label="Change the claim rule on ${scopeName(path)}">Change</a>
                    <form method="post" action="${action}">${csrfField(ctx.csrf)}<input type="hidden" name="action" value="remove"><input type="hidden" name="path" value="${path}">
                      <button class="button quiet" aria-label="Remove the claim rule on ${scopeName(path)}">Remove</button></form>`
                : html`<a class="button quiet" href="${here}" aria-label="Set a claim rule for the whole vault">Set</a>`
            }</td>`
          : ""}
      </tr>`;
    };

    const table = html`<div class="table-wrap"><table class="table-stack rules-table claim-rules">
      <thead><tr><th scope="col">Applies to</th><th scope="col">Lease</th><th scope="col">Hold limit</th><th scope="col">Claims at once</th>${
        owner ? html`<th scope="col"><span class="sr-only">Actions</span></th>` : ""
      }</tr></thead>
      <tbody>${row(whole)}${paths.map(row)}</tbody></table></div>`;

    const presetButtons = CLAIM_RULE_PRESETS.map(
      (p) =>
        html`<button class="button" name="preset" value="${p.id}" formnovalidate>${p.name}<span class="token-client">${duration(p.lease)} lease, ${duration(p.hold)} hold limit</span></button>`,
    );

    const addForm = owner
      ? html`<form method="post" action="${action}" class="panel choice-form rule-form" id="set-claim-rule" aria-labelledby="set-claim-rule-title">
          <h2 id="set-claim-rule-title" class="form-title">${changing ? html`Change the claim rule on ${scopeName(changing.path)}` : claim === "" ? "Set a claim rule for the whole vault" : "Set a claim rule"}</h2>
          ${csrfField(ctx.csrf)}
          ${form?.error ? html`<p class="callout danger" role="alert" id="claim-error">${form.error}</p>` : ""}
          <fieldset>
            <legend>Applies to</legend>
            <label class="choice"><input type="radio" name="scope" value="vault"${scope === "vault" ? html` checked` : ""}>
              <span><strong>The whole vault:</strong> every path that no folder or file rule below covers.</span></label>
            <label class="choice"><input type="radio" name="scope" value="path"${scope === "path" ? html` checked` : ""}>
              <span><strong>A folder or file:</strong> it overrides the whole-vault rule.</span></label>
            <div class="choice-list"><label for="crp">Folder or file</label><input id="crp" type="text" name="path" placeholder="clients/" value="${values?.path ?? ""}"${described("path", "crp-hint")}>
              <p class="hint" id="crp-hint">A folder ends in <code>/</code> and covers everything inside it; a file is its full path. Only used when “A folder or file” is chosen.</p></div>
          </fieldset>
          <div class="fields claim-fields">
            <div><label for="crl">Lease</label><div class="duration"><input id="crl" class="narrow" type="number" name="lease" min="1" step="1" inputmode="numeric" required value="${values?.lease ?? ""}"${described("lease", "crl-hint")}>${unitSelect("lease_unit", values?.leaseUnit ?? "hours")}</div></div>
            <div><label for="crh">Hold limit</label><div class="duration"><input id="crh" class="narrow" type="number" name="hold" min="1" step="1" inputmode="numeric" required value="${values?.hold ?? ""}"${described("hold", "crh-hint")}>${unitSelect("hold_unit", values?.holdUnit ?? "hours")}</div></div>
          </div>
          <p class="hint" id="crl-hint"><strong>Lease:</strong> how long a claim lasts if its agent goes quiet. Every check-in starts the lease again.</p>
          <p class="hint" id="crh-hint"><strong>Hold limit:</strong> the longest one claim can be kept, however often it checks in. After that the agent has to release it and claim again. At least the lease, at most 365 days.</p>
          <div class="fields claim-fields">
            <div><label for="crc">Claims per connection</label><input id="crc" class="narrow" type="number" name="conn" min="1" step="1" inputmode="numeric" value="${values?.conn ?? "1"}"${described("conn", "crc-hint")}></div>
            <div><label for="crpn">Claims per person</label><input id="crpn" class="narrow" type="number" name="person" min="1" step="1" inputmode="numeric" value="${values?.person ?? "5"}"${described("person", "crc-hint")}></div>
          </div>
          <p class="hint" id="crc-hint"><strong>Claims at once:</strong> how many claims one connection (one agent) may hold in this vault, and how many all of one person’s agents may hold together.</p>
          <div class="actions"><button class="primary">Save claim rule</button>${picking ? html`<a class="button quiet" href="${action}">Cancel</a>` : ""}</div>
          <p class="hint">Saving a rule that already exists replaces it. Changing a rule never touches a claim already granted, only the next claim or check-in.</p>
          <div class="presets"><p class="hint">Or start from a preset, for the choice above, in one step:</p><div class="actions">${presetButtons}</div></div>
        </form>`
      : html`<p class="hint">Only owners set claim rules.</p>`;

    // A refused or chosen form goes first, so its message is on the first
    // screen; otherwise the rules, the thing people come to see, lead.
    const formFirst = !!form?.error || picking;
    const body = html`
      ${pageHeader({
        crumb: settingsCrumb(id, v, { label: "Rules", href: vaultPath(id, "/rules") }, { label: "Claim rules" }),
        title: "Claim rules",
        description: html`A claim says an agent is working on a path, so others keep clear of it. A rule sets how long that lasts and how many claims one connection or person may hold at once. <a href="/docs/concepts/claims#claim-rules">About claim rules</a>`,
        primary: owner && !formFirst ? html`<a class="button primary" href="#set-claim-rule">Set a rule</a>` : "",
      })}
      ${formFirst ? addForm : ""}
      ${table}
      ${formFirst ? "" : addForm}
      <p class="hint rules-help">The most specific rule wins: a file, then its folder, then the whole vault, then the fixed defaults. See who holds a claim now on <a href="${vaultPath(id, "/claims")}">Claims</a>. Canon and open rules are on <a href="${vaultPath(id, "/rules")}">Rules</a>.</p>`;
    return { shell: await vaultShell(c, ctx, v, { section: "rules" }, body) };
  });
  if (!data) return notFound(ctx);
  return { ...render(ctx, "Claim rules", data.shell, "vaults"), ...(form?.error ? { status: 400 } : {}) };
}

// A line for the Rules page: what the whole vault gets, and how many paths
// have a rule of their own, with the way in.
export function claimRulesSummary(id: string, rules: ClaimRule[]): Raw {
  const whole = rules.find((r) => r.path === "");
  const own = rules.length - (whole ? 1 : 0);
  const lease = duration(whole?.lease_minutes ?? BUILT_IN.lease);
  const hold = duration(whole?.hold_limit_minutes ?? BUILT_IN.hold);
  return html`<h2 id="claim-rules">Claim rules</h2>
    <p class="hint">How long an agent’s claim on a path lasts, and how many one connection or person may hold at once.</p>
    <p>Every path leases for ${lease}, with a ${hold} hold limit${whole ? "" : " (the fixed default)"}${
      own ? html`; ${own === 1 ? "1 folder or file has a rule of its own" : `${own} folders and files have rules of their own`}` : ""
    }. <a class="button" href="${claimRulesPath(id)}">Claim rules</a></p>`;
}

// ---------------------------------------------------------------------------
// POST: remove, or add/change (manual fields, or a preset's own numbers).
// The database refuses anyone but an owner, and a bad path; a bad path or
// number is shown in the form, anything else (not an owner) as a notice,
// each with its reference.

const refuse = (why: string) => message(new Refusal({ status: 400, where: "web app (claim rules)", why }));

export async function setClaimRuleAction(ctx: Ctx, id: string): Promise<Reply> {
  const back = claimRulesPath(id);
  const typedPath = (ctx.form.get("path") ?? "").trim();
  if (ctx.form.get("action") === "remove") {
    try {
      const done = await asPerson(ctx.userId, async (c) => {
        if (!(await vault(c, ctx, id))) return null;
        await c.query(`select public.set_claim_rule($1, $2, null, null)`, [id, typedPath]);
        return true;
      });
      if (done === null) return notFound(ctx);
      ctx.setFlash(
        typedPath === ""
          ? `Removed the whole-vault claim rule. Paths with no rule of their own go back to the fixed defaults.`
          : `Removed the claim rule on ${typedPath}. It now follows the next rule that applies, or the fixed defaults.`,
        "success",
      );
    } catch (err) {
      ctx.setFlash(message(err));
    }
    return { redirect: back };
  }

  const preset = PRESET_BY_ID.get(ctx.form.get("preset") ?? "");
  const unit = (field: string): Unit => {
    const u = ctx.form.get(field) ?? "minutes";
    return u in UNITS ? (u as Unit) : "minutes";
  };
  const typed = {
    scope: (ctx.form.get("scope") === "vault" ? "vault" : "path") as ClaimForm["scope"],
    path: typedPath,
    lease: (ctx.form.get("lease") ?? "").trim(),
    leaseUnit: unit("lease_unit"),
    hold: (ctx.form.get("hold") ?? "").trim(),
    holdUnit: unit("hold_unit"),
    conn: (ctx.form.get("conn") ?? "1").trim(),
    person: (ctx.form.get("person") ?? "5").trim(),
  };
  const path = typed.scope === "vault" ? "" : typedPath;
  const again = (error: string, field: ClaimForm["field"]) => claimRules(ctx, id, { ...typed, error, field });
  const whole = (n: string, mult: number) => (/^\d{1,9}$/.test(n) ? Number(n) * mult : NaN);
  const lease = preset ? preset.lease : whole(typed.lease, UNITS[typed.leaseUnit]);
  const hold = preset ? preset.hold : whole(typed.hold, UNITS[typed.holdUnit]);
  const conn = whole(typed.conn, 1);
  const person = whole(typed.person, 1);

  if (typed.scope === "vault" && typedPath !== "") {
    return again(
      refuse(`You chose The whole vault but also typed ${typedPath}. Choose A folder or file to apply the rule to ${typedPath}, or clear the path to apply it to the whole vault. Nothing was saved`),
      "path",
    );
  }
  if (typed.scope === "path" && path === "") {
    return again(refuse("A rule for a folder or file needs its path: a folder ending in / or a file. To cover every path, choose The whole vault. Nothing was saved"), "path");
  }
  if (!(lease >= 1 && lease <= MAX_MINUTES)) {
    return again(refuse("The lease is a whole number of minutes, hours or days: at least 1 minute and at most 365 days. Nothing was saved"), "lease");
  }
  if (!(hold >= lease && hold <= MAX_MINUTES)) {
    return again(
      refuse(`The hold limit has to be at least as long as the lease (${duration(lease)}) and at most 365 days. Nothing was saved`),
      "hold",
    );
  }
  if (!(conn >= 1) || !(person >= conn)) {
    return again(
      refuse("Claims per connection and per person are whole numbers: connection at least 1, and person at least the connection’s. Nothing was saved"),
      "conn",
    );
  }
  try {
    const done = await asPerson(ctx.userId, async (c) => {
      if (!(await vault(c, ctx, id))) return null;
      await c.query(`select public.set_claim_rule($1, $2, $3, $4, null, $5, $6)`, [id, path, lease, hold, conn, person]);
      return true;
    });
    if (done === null) return notFound(ctx);
    ctx.setFlash(`Saved the claim rule on ${scopeName(path)}: ${duration(lease)} lease, ${duration(hold)} hold limit.`, "success");
  } catch (err) {
    // A path the database won't take (22023): the form again, the reason
    // in it and what was typed kept. Other refusals (not an owner) are a notice.
    if ((err as { code?: string }).code === "22023") return again(message(err), "path");
    ctx.setFlash(message(err));
  }
  return { redirect: back };
}
