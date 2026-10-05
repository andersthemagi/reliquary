// A vault's Rules page (which paths are canon or open, and how many
// approvals they need) and its search. Owners change rules; the database
// decides (set_policy).

import type pg from "pg";
import { asPerson } from "./db.js";
import { claimRulesSection, loadClaimRules } from "./claimrulespage.js";
import { confirmPage, csrfField, emptyState, html, menu, pageHeader, policyBadge, time, type CrumbPart, type Raw } from "./html.js";
import { Refusal } from "./failure.js";
import { ruleFor, vaultShell } from "./files.js";
import { filePath, message, notFound, q, render, vault, vaultPath, who, type Ctx, type Reply, type Vault } from "./pages.js";

// ---------------------------------------------------------------------------
// Rules

// owners: how many people are named owners of the rule's path (pathowners.ts).
type Rule = { path: string; policy: string; quorum: number; set_by: string | null; set_at: Date | null; owners: number };

// The Add form's values: as sent, when saving was refused (the refusal is
// shown in the form with its reference, the typed values kept and the
// refused field marked), or a rule's own, when "Change" was chosen.
type RuleForm = { path: string; policy: string; quorum: string; error?: string; field?: "path" | "quorum" };

// Rules in tree order: a folder's rule, then the rules inside it, before
// the next folder ("clients/", "clients/acme/", "clients/acme/brief.md",
// "clients-old/"), so the most specific rule sits under the one it
// overrides. Compared a segment at a time, by code point, not by collation.
export function byPath(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

const covers = (folder: string, path: string) => folder.endsWith("/") && folder !== path && path.startsWith(folder);

// The closest other rule on a folder that contains `path`: the one `path`'s
// rule overrides, and the one that applies once it is removed.
const parentRule = (list: Rule[], path: string) =>
  list.filter((r) => covers(r.path, path)).sort((a, b) => b.path.length - a.path.length)[0];

export const approvals = (n: number) => `${n} approval${n === 1 ? "" : "s"}`;
const namedOwners = (n: number) => `${n} named owner${n === 1 ? "" : "s"}`;

// A rule's named owners (pathowners.ts), reached from its row.
export const ownersPath = (id: string, path: string) => vaultPath(id, `/rules/owners?path=${q(path)}`);

export const rulesCrumb = (v: Vault, last?: string): CrumbPart[] => [
  { label: v.name, href: vaultPath(v.id) },
  { label: "Settings", href: vaultPath(v.id, "/config") },
  { label: "Rules", href: vaultPath(v.id, "/rules") },
  ...(last ? [{ label: last }] : []),
];

async function loadRules(c: pg.PoolClient, id: string): Promise<{ list: Rule[]; def: string }> {
  const list: Rule[] = (
    await c.query(
      `select pp.path, pp.policy, pp.quorum,
              (select l.actor from public.log l where l.vault_id = pp.vault_id and l.event = 'policy.set'
                and l.path = pp.path order by l.seq desc limit 1) as set_by,
              (select l.at from public.log l where l.vault_id = pp.vault_id and l.event = 'policy.set'
                and l.path = pp.path order by l.seq desc limit 1) as set_at,
              (select count(*)::int from public.path_owners po where po.vault_id = pp.vault_id and po.path = pp.path) as owners
         from public.path_policies pp where pp.vault_id = $1`,
      [id],
    )
  ).rows;
  list.sort((a, b) => byPath(a.path, b.path));
  const def = (await c.query(`select default_policy from public.vaults where id = $1`, [id])).rows[0].default_policy;
  return { list, def };
}

export async function rules(ctx: Ctx, id: string, form?: RuleForm): Promise<Reply> {
  const remove = ctx.url.searchParams.get("remove");
  if (ctx.method === "GET" && remove !== null) return removePage(ctx, id, remove);
  const check = (ctx.url.searchParams.get("check") ?? "").trim();
  const change = ctx.method === "GET" ? ctx.url.searchParams.get("change") : null;
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const { list, def } = await loadRules(c, id);
    const checked = check ? await ruleFor(c, id, check) : null;
    const claimRules = await loadClaimRules(c, id);
    const owner = v.role === "owner";
    // "Change" fills the form with the rule as it is.
    const changing = change !== null ? list.find((r) => r.path === change) : undefined;
    const values: RuleForm | undefined =
      form ?? (changing ? { path: changing.path, policy: changing.policy, quorum: String(changing.quorum) } : undefined);
    // The refused field is marked invalid and described by the refusal first.
    const described = (f: RuleForm["field"], hint: string) =>
      form?.error && form.field === f ? html` aria-invalid="true" aria-describedby="rule-error ${hint}"` : html` aria-describedby="${hint}"`;

    const addForm = owner
      ? html`<form method="post" action="${vaultPath(id, "/rules")}" class="panel rule-form" id="add-rule" aria-labelledby="add-rule-title">
          <h2 id="add-rule-title" class="form-title">${changing ? html`Change the rule on <code>${changing.path}</code>` : "Add or change a rule"}</h2>
          ${csrfField(ctx.csrf)}
          ${form?.error ? html`<p class="callout danger" role="alert" id="rule-error">${form.error}</p>` : ""}
          <div class="fields">
            <div><label for="pp">Path or folder</label><input id="pp" type="text" name="path" placeholder="clients/" required value="${values?.path ?? ""}"${described("path", "pp-hint")}></div>
            <div><label for="pol">Policy</label><select id="pol" name="policy"><option value="canon">Canon</option><option value="open"${values?.policy === "open" ? " selected" : ""}>Open</option></select></div>
            <div><label for="qq">Approvals needed</label><input id="qq" class="narrow" type="number" name="quorum" min="1" max="20" step="1" required value="${values?.quorum ?? "1"}"${described("quorum", "qq-hint")}></div>
          </div>
          <p class="hint" id="pp-hint">A folder ends in <code>/</code>, like <code>clients/</code>, and covers everything inside it; a file is its full path, like <code>pricing.md</code>. Saving a path that has a rule replaces it.</p>
          <p class="hint" id="qq-hint">For canon: how many different people must approve a change, 1 to 20. Open paths are written directly.</p>
          <div class="actions"><button class="primary">Save rule</button>${changing ? html`<a class="button quiet" href="${vaultPath(id, "/rules")}">Cancel</a>` : ""}</div>
        </form>`
      : "";

    const table = list.length
      ? html`<div class="table-wrap"><table class="table-stack rules-table">
          <thead><tr><th scope="col">Path</th><th scope="col">Policy</th><th scope="col" class="num">Approvals needed</th><th scope="col">Set by</th>${owner ? html`<th scope="col"><span class="sr-only">Actions</span></th>` : ""}</tr></thead>
          <tbody>${list.map((r) => {
            const parent = parentRule(list, r.path);
            return html`<tr>
              <td data-label="Path"><code class="rule-path">${r.path}</code><span class="rule-scope">${r.path.endsWith("/") ? "Folder" : "File"}${
                parent ? html` · overrides <code>${parent.path}</code>` : ""
              }</span>${r.owners ? html`<a class="rule-owners" href="${ownersPath(id, r.path)}">${namedOwners(r.owners)}</a>` : ""}</td>
              <td data-label="Policy">${policyBadge(r.policy)}</td>
              <td data-label="Approvals needed" class="num">${r.policy === "canon" ? r.quorum : html`<span class="muted">Not needed</span>`}</td>
              <td data-label="Set by" class="small muted">${r.set_at ? html`${who(ctx, r.set_by, null)} · ${time(r.set_at)}` : ""}</td>
              ${owner
                ? html`<td class="num rule-actions">${menu({
                    label: `Actions for the rule on ${r.path}`,
                    icon: "more",
                    items: [
                      { href: `${vaultPath(id, "/rules")}?change=${q(r.path)}#add-rule`, label: "Change", description: "Policy or approvals needed" },
                      { href: ownersPath(id, r.path), label: "Named owners", description: r.owners ? namedOwners(r.owners) : "Name people who write it directly" },
                      { href: `${vaultPath(id, "/rules")}?remove=${q(r.path)}`, label: "Remove", description: "Asks you to confirm first", danger: true },
                    ],
                  })}</td>`
                : ""}
            </tr>`;
          })}</tbody></table></div>`
      : emptyState({
          title: "No rules yet",
          body: html`Every path is ${policyBadge(def)}, the vault default.${owner ? " Add a rule to make a folder like clients/ canon." : ""}`,
          ...(owner ? { action: html`<a class="button" href="#add-rule">Add rule</a>` } : {}),
        });

    const checker = html`<form method="get" action="${vaultPath(id, "/rules")}" class="panel rule-check">
        <label for="check">What applies to a path?</label>
        <div class="inline-field"><input id="check" type="text" name="check" value="${check}" placeholder="clients/acme/brief.md">
          <button>Check</button></div>
        ${checked
          ? html`<p class="result"><code>${check}</code> is ${policyBadge(checked.rule?.policy ?? checked.def)} ${
              checked.rule
                ? html`from the rule on <code>${checked.rule.path}</code>${
                    checked.rule.policy === "canon" ? `, and changes need ${approvals(checked.rule.quorum)}` : ""
                  }.`
                : "by the vault default."
            }</p>`
          : ""}
      </form>`;

    // A refused or chosen form goes first, so its message is on the first
    // screen; otherwise the rules, the thing people come to see, lead.
    const formFirst = !!(form?.error || changing);
    const body = html`
      ${pageHeader({
        crumb: rulesCrumb(v),
        title: "Rules",
        description: html`Everything is ${policyBadge(def)} unless a rule says otherwise; the most specific rule wins.${
          owner ? html` <a href="${vaultPath(id, "/config")}">Change the default on General</a>` : ""
        }`,
        primary: owner && !formFirst ? html`<a class="button primary" href="#add-rule">Add rule</a>` : "",
      })}
      ${formFirst ? addForm : ""}
      ${table}
      ${formFirst ? "" : addForm}
      ${checker}
      <p class="hint rules-help">Canon changes need approval from people; agents can only propose them.${owner ? "" : " Only owners change rules."} <a href="/docs/how-to/set-rules">How rules work</a></p>
      ${claimRulesSection(ctx, id, owner, claimRules)}`;
    return { v, shell: await vaultShell(c, ctx, v, { section: "rules" }, body) };
  });
  if (!data) return notFound(ctx);
  return { ...render(ctx, "Rules", data.shell, "vaults"), ...(form?.error ? { status: 400 } : {}) };
}

// The confirm step before a rule is removed: what the path becomes, the
// files that change with it, the rules inside it that stay, and the
// proposals waiting there. Owners only; anyone else, or a path with no
// rule, is sent back to the Rules page with a note.
async function removePage(ctx: Ctx, id: string, path: string): Promise<Reply> {
  const data = await asPerson(ctx.userId, async (c): Promise<{ gone: string } | { shell: Raw } | null> => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    if (v.role !== "owner") return { gone: "Only owners remove rules; ask an owner of this vault." };
    const { list, def } = await loadRules(c, id);
    const rule = list.find((r) => r.path === path);
    if (!rule) return { gone: `There’s no rule on ${/^[^\u0000-\u001f\u007f]{1,200}$/.test(path) ? path : "that path"} to remove; it may have been removed already.` };
    const under = rule.path.endsWith("/") ? `(path = $2 or starts_with(path, $2))` : `path = $2`;
    // Rules inside this one keep deciding their own paths; the files this
    // rule decides today are the rest.
    const inner = list.filter((r) => r !== rule && covers(rule.path, r.path));
    const { decided, waiting } = (
      await c.query(
        `select (select count(*)::int from public.files f
                  where vault_id = $1 and deleted_at is null and ${under}
                    and not exists (select 1 from unnest($3::text[]) r
                                     where f.path = r or (right(r, 1) = '/' and starts_with(f.path, r)))) as decided,
                (select count(*)::int from public.proposals
                  where vault_id = $1 and status = 'open' and ${under}) as waiting`,
        [id, rule.path, inner.map((r) => r.path)],
      )
    ).rows[0] as { decided: number; waiting: number };
    const next = parentRule(list, rule.path);
    const nextPolicy = next?.policy ?? def;
    const nextQuorum = next?.policy === "canon" ? next.quorum : 1;
    const from = next ? html`the rule on <code>${next.path}</code>` : html`the vault default`;
    const was = html`${policyBadge(rule.policy)}${rule.policy === "canon" ? `, with ${approvals(rule.quorum)} needed` : ""}`;
    const becomes = html`${policyBadge(nextPolicy)}${nextPolicy === "canon" ? `, with ${approvals(nextQuorum)} needed` : ""}`;
    const n = decided === 1 ? "1 file" : `${decided} files`;
    const consequences: Raw[] = [
      decided === 0
        ? html`No files are there yet; files added later follow ${from}.`
        : nextPolicy === rule.policy && (nextPolicy !== "canon" || nextQuorum === rule.quorum)
          ? html`${n} there ${decided === 1 ? "stays" : "stay"} ${becomes}, now from ${from}.`
          : html`${n} there ${decided === 1 ? "becomes" : "become"} ${becomes}, from ${from}.`,
      ...(inner.length
        ? [html`${inner.length === 1 ? html`The rule on <code>${inner[0].path}</code>` : `${inner.length} rules`} inside it stay${inner.length === 1 ? "s" : ""} as ${inner.length === 1 ? "it is" : "they are"}.`]
        : []),
      ...(waiting
        ? [html`${waiting === 1 ? "1 proposal" : `${waiting} proposals`} waiting there stay${waiting === 1 ? "s" : ""} open; each approval counts against the rule in force when it is given.`]
        : []),
      // Named owners hang off the rule (path_owners cascades from path_policies).
      ...(rule.owners
        ? [html`Its ${namedOwners(rule.owners)} ${rule.owners === 1 ? "is" : "are"} removed with it. Adding the rule again doesn’t bring them back: name them again from <strong>Named owners</strong>.`]
        : []),
      html`The removal is logged in Activity. You can add the rule again at any time.`,
    ];
    const body = confirmPage({
      crumb: rulesCrumb(v, "Remove rule"),
      title: `Remove the rule on ${rule.path}?`,
      lede: html`<code>${rule.path}</code> is ${was}. Without this rule it follows ${from}.`,
      consequences,
      action: vaultPath(id, "/rules"),
      csrf: ctx.csrf,
      fields: { path: rule.path, policy: "" },
      button: `Remove the rule on ${rule.path}`,
      cancel: vaultPath(id, "/rules"),
    });
    return { shell: await vaultShell(c, ctx, v, { section: "rules" }, body) };
  });
  if (!data) return notFound(ctx);
  if ("gone" in data) {
    ctx.setFlash(data.gone, "warning");
    return { redirect: vaultPath(id, "/rules") };
  }
  return render(ctx, "Remove rule", data.shell, "vaults");
}

// A form value refused before the database sees it: the same shape as the
// database's refusals (a reason written for people, with a reference in the
// server log), shown in the form.
const refuse = (why: string) => message(new Refusal({ status: 400, where: "web app (Rules form)", why }));

export async function setRule(ctx: Ctx, id: string): Promise<Reply> {
  const path = (ctx.form.get("path") ?? "").trim();
  const policy = ctx.form.get("policy") || null;
  const typed = (ctx.form.get("quorum") ?? "1").trim();
  const again = (error: string, field: RuleForm["field"]) =>
    rules(ctx, id, { path, policy: policy ?? "", quorum: typed, error, field });
  if (policy !== null && policy !== "canon" && policy !== "open") {
    return again(refuse("A rule’s policy is Canon or Open; choose one and save again. Nothing was saved"), undefined);
  }
  // Approvals only matter for canon; for open the number is kept as 1.
  let quorum = 1;
  if (policy === "canon") {
    quorum = /^\d{1,3}$/.test(typed) ? Number(typed) : NaN;
    if (!(quorum >= 1 && quorum <= 20)) {
      return again(
        refuse("Approvals needed is a whole number from 1 to 20: how many different people must approve a change. Nothing was saved"),
        "quorum",
      );
    }
  }
  try {
    const after = await asPerson(ctx.userId, async (c) => {
      await c.query(`select public.set_policy($1, $2, $3, $4)`, [id, path, policy, quorum]);
      return policy ? null : await ruleFor(c, id, path);
    });
    if (policy === "canon") ctx.setFlash(`${path} is now canon: changes need ${approvals(quorum)}.`, "success");
    else if (policy === "open") ctx.setFlash(`${path} is now open: members and agents write there directly.`, "success");
    else {
      const now = after?.rule ? `the rule on ${after.rule.path} (${after.rule.policy})` : `the vault default (${after?.def})`;
      ctx.setFlash(`Removed the rule on ${path}. It now follows ${now}.`, "success");
    }
  } catch (err) {
    // A path the database won't take (22023, 20260926120000_rule_paths.sql):
    // the page again, with the reason in the form and what was typed kept.
    // Other refusals (not an owner) come back as a notice, as before.
    if (policy && (err as { code?: string }).code === "22023") return again(message(err), "path");
    ctx.setFlash(message(err));
  }
  return { redirect: vaultPath(id, "/rules") };
}

// ---------------------------------------------------------------------------
// Search in one vault. The top bar searches every vault (search.ts, /search);
// this page says which vault it covers and links there with the same words.

export async function search(ctx: Ctx, id: string): Promise<Reply> {
  const query = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    // Only the start of each text, for its snippet: 30 whole files could be 30 MB.
    const rows = query ? (await c.query(`select path, policy, left(body, 4000) as body from public.search($1, $2, 30)`, [id, query])).rows : [];
    const everywhere = `/search${query ? `?q=${q(query)}` : ""}`;
    const body = html`
      ${pageHeader({
        crumb: [{ label: v.name, href: vaultPath(id) }, { label: "Search" }],
        title: "Search this vault",
        description: html`Only files in ${v.name}. The search at the top of every page looks in all your vaults.`,
        secondary: html`<a class="button" href="${everywhere}">Search all vaults</a>`,
      })}
      <form class="search-page" method="get" action="${vaultPath(id, "/search")}" role="search">
        <label for="vq">Search file names and text in ${v.name}</label>
        <div class="inline-field">
          <input id="vq" type="search" name="q" value="${query}" maxlength="200">
          <button>Search</button>
        </div>
        <p class="hint">Use quotes for a phrase, or <code>or</code> between words.</p>
      </form>
      ${query
        ? rows.length
          ? html`<p class="muted small">${rows.length}${rows.length === 30 ? "+" : ""} result${rows.length > 1 ? "s" : ""} for “${query}” in ${v.name}</p>
            <ul class="rows results">${rows.map(
              (r) => html`<li><span><a class="name" href="${filePath(id, r.path)}">${r.path}</a> ${policyBadge(r.policy)}
                <span class="snippet">${(r.body as string).replace(/\s+/g, " ").slice(0, 200)}</span></span></li>`,
            )}</ul>`
          : emptyState({
              title: `Nothing matches “${query}” in ${v.name}`,
              body: "Try fewer words, or part of a file name, or look in all your vaults.",
              action: html`<a class="button" href="${everywhere}">Search all vaults</a>`,
            })
        : ""}`;
    return { v, shell: await vaultShell(c, ctx, v, { section: "search" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, query ? `Search: ${query}` : "Search", data.shell, "vaults");
}
