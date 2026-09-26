// A vault's Rules page (which paths are canon or open, and how many
// approvals they need) and its search. Owners change rules; the database
// decides (set_policy).

import { asPerson } from "./db.js";
import { csrfField, html, pageHeader } from "./html.js";
import { ruleFor, vaultShell } from "./files.js";
import { ago, filePath, message, notFound, render, tag, vault, vaultPath, who, type Ctx, type Reply } from "./pages.js";

// ---------------------------------------------------------------------------
// Rules and search

// `form` is the Add form as it was sent, when saving it was refused: the
// refusal is shown in the form, with its reference, and the typed values kept.
type RuleForm = { path: string; policy: string; quorum: string; error: string };

export async function rules(ctx: Ctx, id: string, form?: RuleForm): Promise<Reply> {
  const check = (ctx.url.searchParams.get("check") ?? "").trim();
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const list = (
      await c.query(
        `select pp.path, pp.policy, pp.quorum,
                (select l.actor from public.log l where l.vault_id = pp.vault_id and l.event = 'policy.set'
                  and l.path = pp.path order by l.seq desc limit 1) as set_by,
                (select l.at from public.log l where l.vault_id = pp.vault_id and l.event = 'policy.set'
                  and l.path = pp.path order by l.seq desc limit 1) as set_at
           from public.path_policies pp where pp.vault_id = $1 order by pp.path`,
        [id],
      )
    ).rows;
    const def = (await c.query(`select default_policy from public.vaults where id = $1`, [id])).rows[0].default_policy;
    const checked = check ? await ruleFor(c, id, check) : null;
    const owner = v.role === "owner";
    const body = html`
      ${pageHeader({ title: "Rules" })}
      <p class="lede">Everything is ${tag(def)} unless a rule says otherwise. A rule on a folder (ending in <code>/</code>) covers everything inside it; the most specific rule wins. Canon changes need approval from people. Agents can only propose them.</p>
      ${owner
        ? html`<form method="post" action="${vaultPath(id, "/rules")}" class="panel" id="add-rule" aria-labelledby="add-rule-title">
            <h2 id="add-rule-title" class="form-title">Add or change a rule</h2>
            ${csrfField(ctx.csrf)}
            ${form ? html`<p class="callout danger" role="alert" id="rule-error">${form.error}</p>` : ""}
            <div class="fields">
              <div><label for="pp">Path or folder</label><input id="pp" type="text" name="path" placeholder="clients/" required value="${form?.path ?? ""}"${form ? html` aria-invalid="true" aria-describedby="rule-error"` : ""}></div>
              <div><label for="pol">Policy</label><select id="pol" name="policy"><option value="canon">Canon</option><option value="open"${form?.policy === "open" ? " selected" : ""}>Open</option></select></div>
              <div><label for="qq">Approvals</label><input id="qq" class="narrow" type="text" name="quorum" value="${form?.quorum ?? "1"}" inputmode="numeric"></div>
            </div>
            <div class="actions"><button class="primary">Save rule</button></div>
          </form>`
        : html`<p class="muted small">Only owners change rules.</p>`}
      <form method="get" action="${vaultPath(id, "/rules")}" class="panel">
        <label for="check">What applies to a path?</label>
        <div class="inline-field"><input id="check" type="text" name="check" value="${check}" placeholder="clients/acme/brief.md">
          <button>Check</button></div>
        ${checked
          ? html`<p class="result"><code>${check}</code> is ${tag(checked.rule?.policy ?? checked.def)} ${
              checked.rule
                ? html`from the rule on <code>${checked.rule.path}</code>${
                    checked.rule.policy === "canon"
                      ? `, and changes need ${checked.rule.quorum} approval${checked.rule.quorum > 1 ? "s" : ""}`
                      : ""
                  }.`
                : "by the vault default."
            }</p>`
          : ""}
      </form>
      ${list.length === 0
        ? html`<div class="empty">No rules yet.${owner ? " Add one above, for example to make a clients/ folder canon." : ""}</div>`
        : html`<div class="table-wrap"><table><tr><th>Path</th><th>Policy</th><th class="num">Approvals</th><th class="hide-sm">Set</th>${owner ? html`<th></th>` : ""}</tr>
          ${list.map(
            (r) => html`<tr><td><code>${r.path}</code></td><td>${tag(r.policy)}</td>
              <td class="num">${r.policy === "canon" ? r.quorum : ""}</td>
              <td class="small muted hide-sm">${r.set_at ? `${who(ctx, r.set_by, null)}, ${ago(r.set_at)}` : ""}</td>
              ${owner
                ? html`<td class="num"><form method="post" action="${vaultPath(id, "/rules")}">${csrfField(ctx.csrf)}
                    <input type="hidden" name="path" value="${r.path}"><input type="hidden" name="policy" value="">
                    <button class="quiet">Remove</button></form></td>`
                : ""}</tr>`,
          )}</table></div>`}`;
    return { v, shell: await vaultShell(c, ctx, v, { section: "rules" }, body) };
  });
  if (!data) return notFound(ctx);
  return { ...render(ctx, "Rules", data.shell, "vaults"), ...(form ? { status: 400 } : {}) };
}

export async function setRule(ctx: Ctx, id: string): Promise<Reply> {
  const path = (ctx.form.get("path") ?? "").trim();
  const policy = ctx.form.get("policy") || null;
  const quorum = Math.max(1, Math.min(20, Number(ctx.form.get("quorum") ?? 1) || 1));
  try {
    await asPerson(ctx.userId, (c) => c.query(`select public.set_policy($1, $2, $3, $4)`, [id, path, policy, quorum]));
    ctx.setFlash(policy ? `${path} is now ${policy}.` : `Rule on ${path} removed.`);
  } catch (err) {
    // A path the database won't take (22023, 20260926120000_rule_paths.sql):
    // the page again, with the reason in the form and what was typed kept.
    // Other refusals (not an owner) come back as a notice, as before.
    if (policy && (err as { code?: string }).code === "22023") {
      return rules(ctx, id, { path, policy, quorum: String(quorum), error: message(err) });
    }
    ctx.setFlash(message(err));
  }
  return { redirect: vaultPath(id, "/rules") };
}

export async function search(ctx: Ctx, id: string): Promise<Reply> {
  const query = (ctx.url.searchParams.get("q") ?? "").trim();
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    // Only the start of each text, for its snippet: 30 whole files could be 30 MB.
    const rows = query ? (await c.query(`select path, policy, left(body, 4000) as body from public.search($1, $2, 30)`, [id, query])).rows : [];
    const body = html`
      ${pageHeader({ title: "Search" })}
      ${query
        ? rows.length
          ? html`<p class="muted small">${rows.length} result${rows.length > 1 ? "s" : ""} for “${query}”</p>
            <ul class="rows results">${rows.map(
              (r) => html`<li><span><a class="name" href="${filePath(id, r.path)}">${r.path}</a> ${tag(r.policy)}
                <span class="snippet">${(r.body as string).replace(/\s+/g, " ").slice(0, 200)}</span></span></li>`,
            )}</ul>`
          : html`<div class="empty">Nothing matches “${query}”. Try fewer words, or part of a file name.</div>`
        : html`<p class="muted">Search file names and text. Use quotes for a phrase, or <code>or</code> between words.</p>`}`;
    return { v, shell: await vaultShell(c, ctx, v, { section: "search" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, query ? `Search: ${query}` : "Search", data.shell, "vaults");
}
