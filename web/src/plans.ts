// Plans and limits in the web UI (docs/public/concepts/plans-and-limits.md):
// the account's plan on Home and /account, a vault's tier and usage on its
// Settings' Usage tab. The database decides and counts (20260925230000_plans.sql:
// public.my_plan, public.vault_usage); refusals arrive as SQLSTATE RLP01,
// whose message pages.ts's message() shows where they happen. Admission
// (20260925240000_admission.sql, 20261009200000_open_admission.sql:
// public.my_admission): an account creates vaults once admitted, by invite,
// the operator, or open admission's daily quota; create_vault refuses
// others with SQLSTATE RLP02.

import type pg from "pg";
import { asPerson } from "./db.js";
import { html, pageHeader, plural, type Raw } from "./html.js";
import { render, vaultPath, type Ctx, type Reply } from "./pages.js";
import { selfHosted } from "./selfhost.js";
import { biggerPlanHref } from "./site.js";

export type Plan = { plan: string; planName: string; vaultsOwned: number; maxVaults: number };
export type VaultUsage = {
  tier: string;
  tierName: string;
  plan: string;
  planName: string;
  members: number;
  invites: number | null; // owners only
  maxMembers: number;
  bytes: number;
  maxBytes: number;
};

// Sizes as the database words them (private.size_text): decimal units,
// one decimal place at most.
export function formatBytes(n: number): string {
  const trim = (x: number) => String(Math.round(x * 10) / 10);
  if (Math.abs(n) === 1) return `${n} byte`;
  if (Math.abs(n) < 1000) return `${n} bytes`;
  if (Math.abs(n) < 1e6) return `${trim(n / 1e3)} KB`;
  if (Math.abs(n) < 1e9) return `${trim(n / 1e6)} MB`;
  return `${trim(n / 1e9)} GB`;
}

export async function myPlan(c: pg.PoolClient): Promise<Plan> {
  const r = (await c.query(`select plan, plan_name, vaults_owned, max_vaults from public.my_plan()`)).rows[0];
  return { plan: r.plan, planName: r.plan_name, vaultsOwned: r.vaults_owned, maxVaults: r.max_vaults };
}

export type Admission = { admitted: boolean; inviteOnly: boolean };

export async function myAdmission(c: pg.PoolClient): Promise<Admission> {
  const r = (await c.query(`select admitted, invite_only from public.my_admission()`)).rows[0];
  return { admitted: r.admitted, inviteOnly: r.invite_only };
}

// For an account that can't create vaults yet: why, and the way in. Open
// (invite-only off), the only reason is that today's places are taken.
export const notAdmittedNote = (a: Admission): Raw =>
  a.inviteOnly
    ? html`<p class="callout attention" role="status">Your account can’t create vaults yet: Reliquary is invite-only during the alpha. To get in, open an invite link someone sent you and join their vault, or ask the operator to admit your account. <a href="/docs/concepts/plans-and-limits#who-can-create-vaults">Who can create vaults</a></p>`
    : html`<p class="callout attention" role="status">Your account can’t create vaults yet: during the pre-alpha Reliquary lets in a limited number of new accounts a day, and today’s are taken. Try again after midnight UTC, or open an invite link someone sent you and join their vault. <a href="/docs/concepts/plans-and-limits#who-can-create-vaults">Who can create vaults</a></p>`;

// Usage for the vaults in `ids` the person belongs to, in one query.
export async function vaultUsages(c: pg.PoolClient, ids: string[]): Promise<Map<string, VaultUsage>> {
  if (!ids.length) return new Map();
  const { rows } = await c.query(
    `select v.id, u.* from unnest($1::uuid[]) as v(id) cross join lateral public.vault_usage(v.id) u`,
    [ids],
  );
  return new Map(
    rows.map((r) => [
      r.id as string,
      {
        tier: r.tier,
        tierName: r.tier_name,
        plan: r.plan,
        planName: r.plan_name,
        members: r.members,
        invites: r.invites,
        maxMembers: r.max_members,
        bytes: Number(r.bytes),
        maxBytes: Number(r.max_bytes),
      },
    ]),
  );
}

export const tierLabel = (u: VaultUsage) => (u.tier === "standard" ? `Standard (${u.planName})` : u.tierName);
const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
export const peopleOver = (u: VaultUsage) => u.members + (u.invites ?? 0) >= u.maxMembers;
export const storageOver = (u: VaultUsage) => u.bytes >= u.maxBytes;

// Limits this large mean none: a self-hosted instance puts everyone on
// `self_hosted`, whose limits are the largest the columns hold
// (deploy/sql/10_self_hosted.sql). No hosted plan comes near.
export const NO_LIMIT_COUNT = 1_000_000_000;
export const NO_LIMIT_BYTES = 1e18;

// "Free plan · 3 of 5 vaults"; with no limit, "Self-hosted plan · 3 vaults (no limit)"
export const planLine = (p: Plan) =>
  p.maxVaults >= NO_LIMIT_COUNT
    ? `${p.planName} plan · ${p.vaultsOwned} ${p.vaultsOwned === 1 ? "vault" : "vaults"} (no limit)`
    : `${p.planName} plan · ${p.vaultsOwned} of ${p.maxVaults} ${p.maxVaults === 1 ? "vault" : "vaults"}`;
// "Standard (Free) · 4 of 10 people · 12 MB of 100 MB"; with no limits,
// "Standard (Self-hosted) · 4 people · 12 MB"
export const usageLine = (u: VaultUsage) =>
  `${tierLabel(u)} · ${u.maxMembers >= NO_LIMIT_COUNT ? people(u.members) : `${u.members} of ${people(u.maxMembers)}`} · ${
    u.maxBytes >= NO_LIMIT_BYTES ? formatBytes(u.bytes) : `${formatBytes(u.bytes)} of ${formatBytes(u.maxBytes)}`}`;

export const peopleLimited = (u: VaultUsage) => u.maxMembers < NO_LIMIT_COUNT;
export const storageLimited = (u: VaultUsage) => u.maxBytes < NO_LIMIT_BYTES;
// Storage from 80% on is worth a word before anything is refused.
export const storageNear = (u: VaultUsage) => storageLimited(u) && !storageOver(u) && u.bytes >= u.maxBytes * 0.8;
const filled = (u: VaultUsage) => u.members + (u.invites ?? 0);
const PLANS_DOC = html`<a href="/docs/concepts/plans-and-limits">Plans and limits</a>`;
// How a limit is raised: by hand, by the operator (on a self-hosted
// server, with scripts/plan.sh).
const RAISE = "For more, ask the operator for a bigger plan or the Pro tier.";

// How much of a limit is used, as a bar: a <meter> (the CSP allows no
// inline style), amber from 80%, with the numbers as its accessible name.
// Nothing when there's no limit (a count from NO_LIMIT_COUNT; bytes pass
// NO_LIMIT_BYTES).
export function meter(used: number, max: number, label: string, none = NO_LIMIT_COUNT): Raw {
  if (max >= none) return html``;
  return html`<meter class="usage-meter" min="0" max="${max}" low="${Math.floor(max * 0.8)}" high="${max}" optimum="0" value="${Math.min(used, max)}" aria-label="${label}">${label}</meter>`;
}

// "4 of 4 places filled: 3 members and 1 invite waiting" (invites are
// counted for owners, who see them); with no limit, "3 members".
export function placesText(u: VaultUsage): string {
  const who = u.invites ? `${plural(u.members, "member")} and ${plural(u.invites, "invite")} waiting` : plural(u.members, "member");
  if (!peopleLimited(u)) return who;
  return `${filled(u)} of ${plural(u.maxMembers, "place")} filled: ${who}`;
}

// A vault with no place left for another person: what that means and how
// to make room, said before anyone fills in an invite.
export function peopleFullNote(u: VaultUsage, vaultName: string): Raw {
  const body =
    u.members > u.maxMembers
      ? html`<p>${vaultName} has ${plural(u.members, "member")} and room for ${u.maxMembers} on its tier, so nobody new can join until someone leaves or is removed. ${RAISE} ${PLANS_DOC}</p>`
      : html`<p>${vaultName} has ${placesText(u)}. To invite someone, ${u.invites ? "revoke an invite or " : ""}remove a member. ${RAISE} ${PLANS_DOC}</p>`;
  return html`<div class="callout warning" role="status" id="places-full"><p class="callout-title"><strong>No places left</strong></p>${body}</div>`;
}

function storageNote(u: VaultUsage, vaultName: string): Raw {
  const room = "erase files you no longer need (deleting a file keeps its history) or delete variables";
  const box = (title: string, body: Raw) =>
    html`<div class="callout warning" role="status"><p class="callout-title"><strong>${title}</strong></p><p>${body}</p></div>`;
  if (u.bytes > u.maxBytes) {
    return box("Storage over its limit", html`${vaultName} stores ${formatBytes(u.bytes)} and its tier allows ${formatBytes(u.maxBytes)}, so nothing that adds to it is saved until it is under: ${room}. ${RAISE} ${PLANS_DOC}`);
  }
  if (storageOver(u)) {
    return box("Storage full", html`${vaultName} uses all ${formatBytes(u.maxBytes)} of its storage, so the next save is refused. To make room, ${room}. ${RAISE} ${PLANS_DOC}`);
  }
  if (storageNear(u)) {
    return box("Storage nearly full", html`${vaultName} uses ${formatBytes(u.bytes)} of its ${formatBytes(u.maxBytes)}. A save that doesn’t fit is refused and nothing is saved. To make room, ${room}.`);
  }
  return html``;
}

const percent = (used: number, max: number) => Math.floor((used / max) * 100);

// The Usage tab of a vault's Settings. Every member sees it; owners also
// see invites waiting, which count as people.
export function usagePanel(u: VaultUsage, vaultName: string): Raw {
  return html`
    ${peopleLimited(u) && peopleOver(u) ? peopleFullNote(u, vaultName) : ""}
    ${storageLimited(u) ? storageNote(u, vaultName) : ""}
    <div class="table-wrap"><table class="usage-table">
      <tr><th scope="row">Tier</th><td>${tierLabel(u)}<span class="muted token-client">${
        u.tier === "standard"
          ? `Limits from the ${u.planName} plan of the account that created the vault.`
          : `The ${u.tierName} tier sets the limits, whatever the account’s plan.`
      }</span></td></tr>
      <tr><th scope="row">People</th><td>${peopleLimited(u) ? `${filled(u)} of ${u.maxMembers}` : `${u.members} (no limit)`}${meter(
        filled(u), u.maxMembers, `${filled(u)} of ${u.maxMembers} places filled`)}<span class="muted token-client">${
        u.invites ? `${plural(u.members, "member")} and ${plural(u.invites, "invite")} waiting, which count as people.` : plural(u.members, "member")
      }</span></td></tr>
      <tr><th scope="row">Storage</th><td>${
        storageLimited(u)
          ? html`${formatBytes(u.bytes)} of ${formatBytes(u.maxBytes)} (${percent(u.bytes, u.maxBytes)}%)${meter(
              u.bytes, u.maxBytes, `${formatBytes(u.bytes)} of ${formatBytes(u.maxBytes)} used`, NO_LIMIT_BYTES)}`
          : `${formatBytes(u.bytes)} (no limit)`
      }<span class="muted token-client">Every version of every file, variable values and imports waiting.</span></td></tr>
    </table></div>
    <p class="hint">Removing always works at a limit: deleting and erasing files, deleting variables, removing members and leaving. ${PLANS_DOC}</p>`;
}

// What Plan and usage says about billing: hosted, nothing is billed yet and
// the operator raises limits by hand; a self-hosted server (SELF_HOSTED=1,
// or a plan with no limits) has no billing to mention.
export function planNote(p: Plan, selfHostedServer: boolean): Raw {
  if (selfHostedServer || p.maxVaults >= NO_LIMIT_COUNT) {
    return html`<p class="hint plan-note">This Reliquary is self-hosted: its operator sets plans and tiers. ${PLANS_DOC}</p>`;
  }
  return html`<p class="hint plan-note">Nothing is billed during the beta. For a bigger plan, or the Pro tier for one vault, ask the operator: upgrades are given by hand. <a href="${biggerPlanHref()}">Ask for a bigger plan</a> ${PLANS_DOC}</p>`;
}

// One vault against its limits, named: "People full", "Storage full",
// "Storage 85%", or within limits.
function status(u: VaultUsage): Raw {
  const out: Raw[] = [];
  if (peopleLimited(u) && peopleOver(u)) out.push(html`<span class="badge attention" title="No place left to invite someone">People full</span>`);
  if (storageLimited(u) && storageOver(u)) out.push(html`<span class="badge attention" title="The next save is refused">Storage full</span>`);
  else if (storageNear(u)) out.push(html`<span class="badge warning" title="A save that doesn’t fit is refused">Storage ${percent(u.bytes, u.maxBytes)}%</span>`);
  return out.length ? html`<span class="usage-status">${out}</span>` : html`<span class="muted">Within limits</span>`;
}

// /account: the plan, and the vaults this person created.
export async function accountPage(ctx: Ctx): Promise<Reply> {
  const { plan, admission, vaults } = await asPerson(ctx.userId, async (c) => {
    const plan = await myPlan(c);
    const admission = await myAdmission(c);
    const owned = (
      await c.query(`select id, name from public.vaults where created_by = $1 order by name, id`, [ctx.userId])
    ).rows as { id: string; name: string }[];
    const usage = await vaultUsages(c, owned.map((v) => v.id));
    return { plan, admission, vaults: owned.map((v) => ({ ...v, usage: usage.get(v.id)! })).filter((v) => v.usage) };
  });
  const limited = plan.maxVaults < NO_LIMIT_COUNT;
  const full = limited && plan.vaultsOwned >= plan.maxVaults;
  return render(
    ctx,
    "Plan and usage",
    html`${pageHeader({
      title: "Plan and usage",
      description: limited
        ? `The ${plan.planName} plan: up to ${plural(plan.maxVaults, "vault")} you own, each with its tier’s limits on people and storage.`
        : `The ${plan.planName} plan: no limit on the vaults you own, their people or their storage.`,
    })}
    ${admission.admitted ? "" : notAdmittedNote(admission)}
    ${full
      ? html`<p class="callout attention" role="status">You own ${plan.vaultsOwned} ${plan.vaultsOwned === 1 ? "vault" : "vaults"}, and the ${plan.planName} plan allows ${plan.maxVaults}: delete one you no longer need before creating another. Nothing is deleted for you.</p>`
      : ""}
    <div class="plan-summary">
      <p class="usage-line"><strong>${planLine(plan)}</strong></p>
      ${meter(plan.vaultsOwned, plan.maxVaults, `${plan.vaultsOwned} of ${plan.maxVaults} vaults owned`)}
      <p class="hint">The vaults you own are the ones you created. Being a member of someone else’s, even an owner, doesn’t count.</p>
    </div>
    <h2>Vaults you own</h2>
    ${vaults.length
      ? html`<div class="table-wrap"><table class="table-stack plan-vaults">
          <thead><tr><th>Vault</th><th>People</th><th>Storage</th><th>Status</th></tr></thead>
          <tbody>${vaults.map(({ id, name, usage: u }) => html`<tr>
            <td><a class="name" href="${vaultPath(id)}">${name}</a><span class="muted token-client">${tierLabel(u)}</span></td>
            <td data-label="People">${peopleLimited(u) ? `${filled(u)} of ${u.maxMembers}` : `${u.members}`}${meter(
              filled(u), u.maxMembers, `${filled(u)} of ${u.maxMembers} places filled`)}</td>
            <td data-label="Storage">${storageLimited(u)
              ? html`${formatBytes(u.bytes)} of ${formatBytes(u.maxBytes)}${meter(u.bytes, u.maxBytes, `${formatBytes(u.bytes)} of ${formatBytes(u.maxBytes)} used`, NO_LIMIT_BYTES)}`
              : formatBytes(u.bytes)}</td>
            <td data-label="Status">${status(u)}</td></tr>`)}</tbody></table></div>`
      : html`<div class="empty">You haven’t created a vault yet. <a href="/vaults/new">New vault</a></div>`}
    ${planNote(plan, selfHosted())}`,
    "account",
  );
}
