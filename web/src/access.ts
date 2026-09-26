// Access: the Connect page (how each MCP client and the CLI connect) and
// Tokens (create, list and revoke agent tokens). Token scope is enforced by
// the database for every call a token makes.

import { asPerson } from "./db.js";
import { csrfField, html, pageHeader, raw, when } from "./html.js";
import { ago, message, notFound, q, render, UUID, type Ctx, type Reply } from "./pages.js";

// ---------------------------------------------------------------------------
// Connect

export function connect(ctx: Ctx): Reply {
  const url = ctx.mcpUrl;
  const helper = JSON.stringify({ reliquary: { type: "http", url, headersHelper: "/path/to/reliquary/mcp/headers-helper.sh" } }, null, 2);
  const cursorConfig = { url, headers: { Authorization: "Bearer ${env:RELIQUARY_TOKEN}" } };
  const cursorJson = JSON.stringify({ mcpServers: { reliquary: cursorConfig } }, null, 2);
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=reliquary&config=${q(
    Buffer.from(JSON.stringify(cursorConfig)).toString("base64"),
  )}`;
  const vscodeJson = JSON.stringify(
    {
      inputs: [{ type: "promptString", id: "reliquary-token", description: "Reliquary access token", password: true }],
      servers: { reliquary: { type: "http", url, headers: { Authorization: "Bearer ${input:reliquary-token}" } } },
    },
    null,
    2,
  );
  return render(
    ctx,
    "Connect",
    html`${pageHeader({ title: "Connect an agent", actions: html`<a class="button primary" href="/tokens">Create a token</a>` })}
    <p class="lede">Any MCP client can use your vaults through one URL. Clients that support sign-in (Claude Code, Claude.ai, ChatGPT) connect with your Reliquary account: you choose which vaults they reach and whether they can write. Others use a <a href="/tokens">token</a>. Either way the agent acts as you, but can never approve, change rules or manage members.</p>
    <p class="endpoint"><span class="muted small">MCP URL</span><code>${url}</code></p>
    <nav class="tabs" aria-label="Clients"><a href="#claude-code">Claude Code</a><a href="#chat">Claude.ai and ChatGPT</a><a href="#cursor">Cursor</a><a href="#vscode">VS Code</a><a href="#hermes">Hermes and others</a><a href="#cli">Environment variables</a></nav>

    <section id="claude-code"><h2>Claude Code (app or CLI)</h2>
      <p>On each computer, add Reliquary once for your user:</p>
      <pre class="code">claude mcp add --transport http --scope user reliquary ${url}</pre>
      <p>Then in Claude Code run <code>/mcp</code>, choose <strong>reliquary</strong> and <strong>Authenticate</strong>. Your browser opens Reliquary: sign in, pick the vaults and access, and approve. Claude Code keeps the connection and refreshes it by itself. Revoke it any time on the <a href="/tokens">Tokens</a> page.</p></section>

    <section id="chat"><h2>Claude.ai and ChatGPT</h2>
      <p><strong>Claude.ai:</strong> Settings, Connectors, <strong>Add custom connector</strong>. Name it Reliquary and paste the MCP URL. Claude sends you here to sign in and approve.</p>
      <p><strong>ChatGPT:</strong> Settings, Apps and Connectors, turn on developer mode under Advanced, then create a connector with the MCP URL and OAuth authentication. ChatGPT sends you here to sign in and approve.</p></section>

    <section id="cursor"><h2>Cursor</h2>
      <p class="callout info">Tokens are for clients without sign-in. Keep them out of config files and chats: anything an agent can read, it can leak. The setups below read the token from an environment variable or a password prompt.</p>
      <p>Create a token on the <a href="/tokens">Tokens</a> page, set it as <code>RELIQUARY_TOKEN</code> in the environment Cursor starts from, then <a href="${cursorLink}">add Reliquary to Cursor</a>. If the link doesn’t open, put this in <code>~/.cursor/mcp.json</code>:</p>
      <pre class="code">${cursorJson}</pre></section>

    <section id="vscode"><h2>VS Code</h2>
      <p>Add this to <code>.vscode/mcp.json</code>. VS Code asks for a token from the <a href="/tokens">Tokens</a> page once and stores it securely.</p>
      <pre class="code">${vscodeJson}</pre></section>

    <section id="hermes"><h2>Hermes and other clients</h2>
      <p>Use Streamable HTTP with the MCP URL and this header, reading the token from wherever the client keeps secrets:</p>
      <pre class="code">Authorization: Bearer &lt;your token&gt;</pre>
      <details><summary>Local development (a Reliquary checkout on this machine)</summary>
        <p>With <code>./mcp/dev.sh token "Claude Code on Linux"</code> the token stays in a file, and Claude Code reads it through a helper at connect time. Add this under <code>mcpServers</code> in <code>~/.claude.json</code>:</p>
        <pre class="code">${helper}</pre></details></section>

    <section id="cli"><h2>Environment variables (the Reliquary CLI)</h2>
      <p>Your programs get a vault’s variables through the CLI, never through an agent. Sign this computer in once; your browser opens Reliquary to choose which vaults it reads:</p>
      <pre class="code">npx @reliquary-ai/cli login</pre>
      <p>Then run a command with one environment’s variables, written nowhere on disk:</p>
      <pre class="code">npx @reliquary-ai/cli run --env development -- &lt;command&gt;</pre>
      <p>Or write them to a <code>.env</code> file, which the CLI only does where git ignores it:</p>
      <pre class="code">npx @reliquary-ai/cli env pull --env development</pre>
      <p>To add a project’s <code>.env</code> to the vault, send it; you apply it on the Variables page, where only names are shown. An agent can run this for you without ever seeing a value:</p>
      <pre class="code">npx @reliquary-ai/cli env push --env development --file .env</pre>
      <p class="small muted">Add <code>--vault &lt;name&gt;</code> if you belong to more than one vault. The sign-in is on the <a href="/tokens">Tokens</a> page as Reliquary CLI; revoke it there. Set values on a vault’s Variables page.</p></section>`,
    "connect",
  );
}

// ---------------------------------------------------------------------------
// Tokens

// Scope (which vaults, read or read-write) is enforced by the database for
// every call the token makes, and can't be edited: revoke and recreate. The
// token itself is shown once, in this response only, and never logged.
export async function tokens(ctx: Ctx, fresh?: { name: string; token: string }): Promise<Reply> {
  const { rows, vaults } = await asPerson(ctx.userId, async (c) => ({
    rows: (
      await c.query(
        `select t.id, t.name, t.created_at, t.expires_at, t.last_used_at, t.revoked_at,
                t.all_vaults, t.access, t.kind, t.env_push, t.client_name, t.expires_at <= now() as expired,
                cardinality(t.vault_ids) as n_vaults,
                (select array_agg(v.name order by v.name) from public.vaults v
                  where v.id = any(t.vault_ids)) as vault_names
           from public.access_tokens t
          order by t.revoked_at nulls first, (t.expires_at <= now()), t.created_at desc`,
      )
    ).rows,
    vaults: (
      await c.query(
        `select v.id, v.name from public.vaults v
           join public.vault_members m on m.vault_id = v.id and m.user_id = $1
          order by v.name`,
        [ctx.userId],
      )
    ).rows as { id: string; name: string }[],
  }));

  const scope = (t: { all_vaults: boolean; n_vaults: number; vault_names: string[] | null }) => {
    if (t.all_vaults) return "All your vaults";
    const names = t.vault_names ?? [];
    const gone = t.n_vaults - names.length;
    return names.join(", ") + (gone > 0 ? `${names.length ? ", and " : ""}${gone} you no longer belong to` : "");
  };
  const status = (t: { id: string; revoked_at: Date | null; expired: boolean }) =>
    t.revoked_at
      ? html`<span class="muted small">Revoked</span>`
      : t.expired
        ? html`<span class="muted small">Expired</span>`
        : html`<form method="post" action="/tokens/${t.id}/revoke">${csrfField(ctx.csrf)}<button class="danger">Revoke</button></form>`;

  return render(
    ctx,
    "Tokens",
    html`${pageHeader({ title: "Tokens", actions: html`<button class="primary" form="new-token">Create token</button>` })}
    <p class="lede">A token lets one agent act as you over MCP, in the vaults you choose. A read-only agent can read, search and follow changes. A read-write agent can also write open files and propose changes. No agent can approve, change rules or manage members. <a href="/connect">How to connect an agent</a></p>
    ${fresh
      ? html`<div class="callout attention reveal" role="status"><strong>${fresh.name}</strong>
          <p class="muted small">Copy it now. It won’t be shown again. Put it in your agent’s settings, never in a chat.</p>
          <p class="secret">${fresh.token}</p></div>`
      : ""}
    <form method="post" action="/tokens/new" class="panel token-form" id="new-token">
      ${csrfField(ctx.csrf)}
      <label for="tn">Name it after the agent and machine</label>
      <input id="tn" type="text" name="name" placeholder="Hermes on Linux" required maxlength="100">
      <fieldset>
        <legend>Vaults</legend>
        <label class="choice"><input type="radio" name="scope" value="all" checked> All my vaults, including ones I join later</label>
        <label class="choice"><input type="radio" name="scope" value="some"> Only the vaults I tick</label>
        ${vaults.length
          ? html`<div class="choice-list">${vaults.map(
              (v) => html`<label class="choice"><input type="checkbox" name="vault" value="${v.id}"> ${v.name}</label>`,
            )}</div>`
          : html`<p class="hint">You don’t belong to any vaults yet. <a href="/vaults/new">Create one</a>.</p>`}
        <p class="hint">Ticking a vault limits the token to the ticked vaults.</p>
      </fieldset>
      <fieldset>
        <legend>Access</legend>
        <label class="choice"><input type="radio" name="access" value="read" checked> Read only: read, search and follow changes</label>
        <label class="choice"><input type="radio" name="access" value="write"> Read and write: also write open files and propose changes</label>
      </fieldset>
      <label for="te">Expires after</label>
      <select id="te" name="days" class="token-expiry">
        ${[7, 30, 90, 180, 366].map((d) => html`<option value="${d}"${d === 90 ? raw(" selected") : ""}>${d === 366 ? "1 year" : `${d} days`}</option>`)}
      </select>
      <div class="actions"><button class="primary">Create token</button></div>
      <p class="hint">A token’s vaults and access can’t be changed later. To change them, revoke it and create another.</p>
    </form>
    <h2>Your tokens</h2>
    ${rows.length === 0
      ? html`<div class="empty">No tokens yet. <a href="/connect">Connect an agent</a> to get started.</div>`
      : html`<div class="table-wrap"><table class="token-list"><tr><th>Name</th><th>Vaults</th><th>Access</th><th>Last used</th><th class="hide-sm">Expires</th><th></th></tr>
    ${rows.map(
      (t) => html`<tr${t.revoked_at || t.expired ? raw(' class="inactive"') : ""}><td>${t.name}</td>
        <td class="small">${scope(t)}</td>
        <td class="small">${t.kind === "cli" ? (t.env_push ? "Environment variables (reads; sends for approval)" : "Environment variables") : t.access === "write" ? "Read and write" : "Read only"}</td>
        <td class="small">${t.last_used_at ? ago(t.last_used_at) : "Never"}${t.client_name
          ? html`<span class="muted token-client">from ${t.client_name}</span>`
          : ""}</td>
        <td class="small hide-sm">${when(t.expires_at)}</td>
        <td class="num">${status(t)}</td></tr>`,
    )}</table></div>`}`,
    "tokens",
  );
}

export async function createToken(ctx: Ctx): Promise<Reply> {
  const name = (ctx.form.get("name") ?? "").trim();
  // Ticked vaults always narrow the scope, whatever the radio says: a
  // mismatch between the two must never produce the broader token.
  const ticked = ctx.form.getAll("vault");
  const some = ticked.length > 0 || ctx.form.get("scope") === "some";
  const access = ctx.form.get("access") === "write" ? "write" : "read";
  const days = Number.parseInt(ctx.form.get("days") ?? "90", 10);
  if (some && ticked.length === 0) {
    ctx.setFlash("Tick at least one vault, or choose all your vaults.");
    return { redirect: "/tokens" };
  }
  if (!ticked.every((v) => UUID.test(v))) return notFound(ctx);
  try {
    const token = await asPerson(
      ctx.userId,
      async (c) =>
        (
          await c.query(`select public.create_access_token($1, $2, $3::uuid[], $4) as t`, [
            name,
            Number.isFinite(days) ? days : null,
            some ? ticked : null,
            access,
          ])
        ).rows[0].t as string,
    );
    return tokens(ctx, { name, token });
  } catch (err) {
    ctx.setFlash(message(err));
    return { redirect: "/tokens" };
  }
}

export async function revokeToken(ctx: Ctx, tid: string): Promise<Reply> {
  if (!UUID.test(tid)) return notFound(ctx);
  try {
    await asPerson(ctx.userId, (c) => c.query(`select public.revoke_access_token($1)`, [tid]));
    ctx.setFlash("Token revoked. Any agent using it is cut off on its next request.");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: "/tokens" };
}
