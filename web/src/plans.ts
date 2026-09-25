// Plans and limits in the web UI (docs/public/concepts/plans-and-limits.md):
// the account's plan on Home and /account, a vault's tier and usage in its
// Settings. The database decides and counts (20260925230000_plans.sql:
// public.my_plan, public.vault_usage); refusals arrive as SQLSTATE RLP01,
// whose message pages.ts's message() shows where they happen. Admission
// (20260925240000_admission.sql: public.my_admission): while
// Reliquary is invite-only, an account creates vaults only once admitted;
// create_vault refuses others with SQLSTATE RLP02.

import type pg from "pg";
import { asPerson } from "./db.js";
import { html, pageHeader, type Raw } from "./html.js";
import { render, vaultPath, type Ctx, type Reply } from "./pages.js";

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

// For an account that can't create vaults yet: why, and the way in.
export const notAdmittedNote = (): Raw =>
  html`<p class="callout attention" role="status">Your account can’t create vaults yet: Reliquary is invite-only during the alpha. To get in, open an invite link someone sent you and join their vault, or ask the operator to admit your account. <a href="/docs/concepts/plans-and-limits#invite-only">Invite-only</a></p>`;

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

// What a vault at or over a limit can't do, and how to make room.
function limitNotes(u: VaultUsage): Raw {
  const notes: Raw[] = [];
  if (u.members > u.maxMembers) {
    notes.push(html`<li>It has more people than its tier allows, so nobody new can join until some leave or are removed.</li>`);
  } else if (peopleOver(u)) {
    notes.push(html`<li>Its places are full${u.invites ? " (counting invites waiting)" : ""}: to invite someone, revoke an invite or remove a member first.</li>`);
  }
  if (u.bytes > u.maxBytes) {
    notes.push(html`<li>It stores more than its tier allows, so nothing that adds to it is saved until it is under: erase files you no longer need (deleting keeps their history) or delete variables.</li>`);
  } else if (storageOver(u)) {
    notes.push(html`<li>Its storage is full: erase files you no longer need (deleting keeps their history) or delete variables to make room.</li>`);
  }
  return notes.length ? html`<div class="callout attention" role="status"><p><strong>This vault is at a limit.</strong></p><ul>${notes}</ul></div>` : html``;
}

// The Settings section. Every member sees it; owners also see invites waiting.
export function usageSection(u: VaultUsage): Raw {
  return html`<h2>Plan and usage</h2>
    <p class="usage-line">${usageLine(u)}${u.invites ? html` <span class="muted">(${u.invites} ${u.invites === 1 ? "invite" : "invites"} waiting, counted as people)</span>` : ""}</p>
    ${limitNotes(u)}
    <p class="small muted">${u.tier === "standard"
      ? `Standard vaults take their limits from the ${u.planName} plan of the account that created them.`
      : `The ${u.tierName} tier sets this vault’s limits, whatever its account’s plan.`} Storage counts every version of every file, variable values and imports waiting. <a href="/docs/concepts/plans-and-limits">Plans and limits</a></p>`;
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
  const full = plan.vaultsOwned >= plan.maxVaults;
  return render(
    ctx,
    "Plan and usage",
    html`${pageHeader({ title: "Plan and usage" })}
    <p class="lede usage-line">${planLine(plan)}</p>
    ${admission.admitted ? "" : notAdmittedNote()}
    ${full
      ? html`<p class="callout attention" role="status">You own ${plan.vaultsOwned} ${plan.vaultsOwned === 1 ? "vault" : "vaults"}, and the ${plan.planName} plan allows ${plan.maxVaults}: delete one you no longer need before creating another. Nothing is deleted for you.</p>`
      : ""}
    <p>Your plan limits how many vaults you own: the ones you created. Each vault’s tier limits its people and storage. Nothing is billed during the beta; the operator gives bigger plans and upgrades by hand. <a href="/docs/concepts/plans-and-limits">Plans and limits</a></p>
    <h2>Vaults you own</h2>
    ${vaults.length
      ? html`<ul class="rows">${vaults.map(
          (v) => html`<li><span><a class="name" href="${vaultPath(v.id)}">${v.name}</a>
            <span class="muted small"> · ${usageLine(v.usage)}</span>${
              peopleOver(v.usage) || storageOver(v.usage) ? html` <span class="badge attention">At a limit</span>` : ""}</span></li>`,
        )}</ul>`
      : html`<div class="empty">You haven’t created a vault yet. <a href="/vaults/new">New vault</a></div>`}`,
    "home",
  );
}
