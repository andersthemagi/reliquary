// Access: Connect (how each MCP client and the CLI connect, one client per
// tab) and Connections (everything that can act as you: tokens, apps you
// signed in to, the Reliquary CLI; create a token, revoke any of them).
// Scope is enforced by the database for every call a connection makes.
//
// Words, the same on these pages and in the docs they cite
// (docs/public/concepts/connections.md): a *connection* is anything that
// acts as you; it is a *token* (made on New token, pasted into a client),
// an *app* (a client you signed in to with OAuth) or the *Reliquary CLI*.
// You *revoke* a connection.

import { asPerson } from "./db.js";
import {
  callout,
  confirmPage,
  csrfField,
  emptyState,
  html,
  pageHeader,
  raw,
  time,
  type Raw,
  type Tab,
} from "./html.js";
import { Refusal } from "./failure.js";
import { message, notFound, q, render, UUID, type Ctx, type Reply } from "./pages.js";

// The routes of these pages; pages.ts sends /connect and /connections/* here.
export function accessRoutes(ctx: Ctx): Promise<Reply> | Reply {
  const p = ctx.url.pathname;
  const get = ctx.method === "GET";
  if (get && p === "/connect") return connect(ctx);
  if (get && p === "/connections") return connections(ctx);
  if (get && p === "/connections/new") return newToken(ctx);
  if (!get && p === "/connections/new") return createToken(ctx);
  const m = /^\/connections\/([^/]+)\/revoke$/.exec(p);
  if (get && m) return revokePage(ctx, m[1]);
  if (!get && m) return revokeToken(ctx, m[1]);
  return notFound(ctx);
}

// The Connections page lived at /tokens until 2026-09-26. Every old URL
// answers with a permanent redirect to its new one, keeping the query, for
// any method: a 308 makes a browser repeat a POST (a form left open in a
// tab) at the new URL, unchanged. server.ts answers these before sign-in,
// so an old link works signed out too. null for any other path.
export function movedConnectionsPath(pathname: string): string | null {
  if (pathname === "/tokens") return "/connections";
  if (pathname.startsWith("/tokens/")) return `/connections${pathname.slice("/tokens".length)}`;
  return null;
}

// ---------------------------------------------------------------------------
// Connect

const CLIENTS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "chat", label: "Claude.ai and ChatGPT" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
  { id: "other", label: "Other clients" },
  { id: "cli", label: "Environment variables" },
] as const;
type Client = (typeof CLIENTS)[number]["id"];

const CEILING = "The agent acts as you, but can’t approve, change rules, manage members or read variable values.";
const TOKEN_SAFETY =
  "Keep the token out of config files and chats: anything an agent can read, it can leak. Read it from an environment variable or a password prompt, as below.";

export function connect(ctx: Ctx): Reply {
  const url = ctx.mcpUrl;
  const asked = ctx.url.searchParams.get("client");
  const client: Client = CLIENTS.find((c) => c.id === asked)?.id ?? "claude-code";
  return render(
    ctx,
    "Connect",
    html`${pageHeader({
      title: "Connect",
      description: "Connect any MCP client to your vaults with this URL.",
      meta: html`<p class="endpoint"><span class="muted small">MCP URL</span><code>${url}</code></p>`,
      secondary: html`<a class="button" href="/connections">Your connections</a>`,
      tabs: CLIENTS.map((c) => ({ href: `/connect?client=${c.id}`, label: c.label, current: c.id === client })) as Tab[],
      tabsLabel: "Clients",
    })}
    <div class="connect-panel">${clientSection(ctx, client)}</div>`,
    "connect",
  );
}

function clientSection(ctx: Ctx, client: Client): Raw {
  const url = ctx.mcpUrl;
  switch (client) {
    case "claude-code":
      return html`<section id="claude-code"><h2>Claude Code (app or CLI)</h2>
      <p>Claude Code signs in with your Reliquary account: no token to copy. On each computer, add Reliquary once for your user:</p>
      <pre class="code" tabindex="0">claude mcp add --transport http --scope user reliquary ${url}</pre>
      <p>Then in Claude Code run <code>/mcp</code>, choose <strong>reliquary</strong> and <strong>Authenticate</strong>. Your browser opens Reliquary: sign in, pick the vaults and access, and approve. Claude Code keeps the connection and refreshes it by itself. It shows on <a href="/connections">Connections</a>, where you can revoke it.</p>
      ${callout("info", CEILING)}</section>`;
    case "chat":
      return html`<section id="chat"><h2>Claude.ai and ChatGPT</h2>
      <p>Both sign in with your Reliquary account: no token to copy.</p>
      <p><strong>Claude.ai:</strong> Settings, Connectors, <strong>Add custom connector</strong>. Name it Reliquary and paste the MCP URL. Claude sends you here to sign in and approve.</p>
      <p><strong>ChatGPT:</strong> Settings, Apps and Connectors, turn on developer mode under Advanced, then create a connector with the MCP URL and OAuth authentication. ChatGPT sends you here to sign in and approve.</p>
      <p>Each shows on <a href="/connections">Connections</a> under the app’s name, where you can revoke it.</p>
      ${callout("info", CEILING)}</section>`;
    case "cursor": {
      const cursorConfig = { url, headers: { Authorization: "Bearer ${env:RELIQUARY_TOKEN}" } };
      const cursorJson = JSON.stringify({ mcpServers: { reliquary: cursorConfig } }, null, 2);
      const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=reliquary&config=${q(
        Buffer.from(JSON.stringify(cursorConfig)).toString("base64"),
      )}`;
      return html`<section id="cursor"><h2>Cursor</h2>
      <p>Cursor can’t sign in, so it uses a token. <a href="/connections/new">Create a token</a>, set it as <code>RELIQUARY_TOKEN</code> in the environment Cursor starts from, then <a href="${cursorLink}">add Reliquary to Cursor</a>. If the link doesn’t open, put this in <code>~/.cursor/mcp.json</code>:</p>
      <pre class="code" tabindex="0">${cursorJson}</pre>
      ${callout("warning", TOKEN_SAFETY)}
      ${callout("info", CEILING)}</section>`;
    }
    case "vscode": {
      const vscodeJson = JSON.stringify(
        {
          inputs: [{ type: "promptString", id: "reliquary-token", description: "Reliquary access token", password: true }],
          servers: { reliquary: { type: "http", url, headers: { Authorization: "Bearer ${input:reliquary-token}" } } },
        },
        null,
        2,
      );
      return html`<section id="vscode"><h2>VS Code</h2>
      <p>VS Code uses a token. <a href="/connections/new">Create a token</a>, then add this to <code>.vscode/mcp.json</code>. VS Code asks for the token once and stores it securely.</p>
      <pre class="code" tabindex="0">${vscodeJson}</pre>
      ${callout("warning", TOKEN_SAFETY)}
      ${callout("info", CEILING)}</section>`;
    }
    case "other": {
      const helper = JSON.stringify({ reliquary: { type: "http", url, headersHelper: "/path/to/reliquary/mcp/headers-helper.sh" } }, null, 2);
      return html`<section id="other"><h2>Other clients</h2>
      <p>A client that supports MCP sign-in (OAuth) only needs the MCP URL: it sends you here to sign in and approve. Any other client that speaks Streamable HTTP uses a token: <a href="/connections/new">create one</a> and send it in this header, read from wherever the client keeps secrets:</p>
      <pre class="code" tabindex="0">Authorization: Bearer &lt;your token&gt;</pre>
      ${callout("warning", TOKEN_SAFETY)}
      ${callout("info", CEILING)}
      <details><summary>Local development (a Reliquary checkout on this machine)</summary>
        <p>With <code>./mcp/dev.sh token "Claude Code on Linux"</code> the token stays in a file, and Claude Code reads it through a helper at connect time. Add this under <code>mcpServers</code> in <code>~/.claude.json</code>:</p>
        <pre class="code" tabindex="0">${helper}</pre></details></section>`;
    }
    case "cli":
      return html`<section id="cli"><h2>Environment variables (the Reliquary CLI)</h2>
      <p>Your programs get a vault’s variables through the CLI, never through an agent. Connect the CLI once on each computer; your browser opens Reliquary to choose which vaults it reads:</p>
      <pre class="code" tabindex="0">npx @reliquary-ai/cli login</pre>
      <p>Then run a command with one environment’s variables, written nowhere on disk:</p>
      <pre class="code" tabindex="0">npx @reliquary-ai/cli run --env development -- &lt;command&gt;</pre>
      <p>Or write them to a <code>.env</code> file, which the CLI only does where git ignores it:</p>
      <pre class="code" tabindex="0">npx @reliquary-ai/cli env pull --env development</pre>
      <p>To add a project’s <code>.env</code> to the vault, send it; you apply it on the Variables page, where only names are shown. An agent can run this for you without ever seeing a value:</p>
      <pre class="code" tabindex="0">npx @reliquary-ai/cli env push --env development --file .env</pre>
      <p class="small muted">Add <code>--vault &lt;name&gt;</code> if you belong to more than one vault. The CLI shows on <a href="/connections">Connections</a> as Reliquary CLI; revoke it there. Set values on a vault’s Variables page.</p></section>`;
  }
}

// ---------------------------------------------------------------------------
// Connections

type Row = {
  id: string;
  name: string;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  all_vaults: boolean;
  access: string;
  kind: string;
  env_push: boolean;
  client_name: string | null;
  expired: boolean;
  n_vaults: number;
  vault_names: string[] | null;
};

// Every connection of the person's, with its vaults by name (only the ones
// they can see: RLS on vaults). One id, or all of them.
const SELECT = `select t.id, t.name, t.created_at, t.expires_at, t.last_used_at, t.revoked_at,
        t.all_vaults, t.access, t.kind, t.env_push, t.client_name, t.expires_at <= now() as expired,
        cardinality(t.vault_ids) as n_vaults,
        (select array_agg(v.name order by v.name) from public.vaults v
          where v.id = any(t.vault_ids)) as vault_names
   from public.access_tokens t`;

const TYPE: Record<string, string> = { pat: "Token", oauth: "App", cli: "Reliquary CLI" };
const typeOf = (t: Row) => TYPE[t.kind] ?? t.kind;

const scopeOf = (t: Row) => {
  if (t.all_vaults) return "All your vaults";
  const names = t.vault_names ?? [];
  const gone = t.n_vaults - names.length;
  return names.join(", ") + (gone > 0 ? `${names.length ? ", and " : ""}${gone} you no longer belong to` : "");
};

const accessOf = (t: Row) =>
  t.kind === "cli"
    ? t.env_push
      ? "Environment variables (reads; sends for approval)"
      : "Environment variables"
    : t.access === "write"
      ? "Read and write"
      : "Read only";

// The client's name is kept from its last use, or for an app from sign-in.
const lastUse = (t: Row) =>
  html`${t.last_used_at ? time(t.last_used_at) : "Never"}${
    t.client_name ? html`<span class="token-client"> · from ${t.client_name}</span>` : ""
  }`;

// Revoking is a person's act (the database refuses anything else) and the
// Revoke link leads to a confirm page; scope can't be edited: revoke and
// create another. A token is shown once, in createToken's answer only, and
// never logged.
export async function connections(ctx: Ctx): Promise<Reply> {
  const rows = await asPerson(
    ctx.userId,
    async (c) => (await c.query(`${SELECT} order by t.created_at desc`)).rows as Row[],
  );
  const live = rows.filter((t) => !t.revoked_at && !t.expired);
  const ended = rows
    .filter((t) => t.revoked_at || t.expired)
    .sort((a, b) => +(b.revoked_at ?? b.expires_at) - +(a.revoked_at ?? a.expires_at));

  const head = html`<thead><tr><th>Name</th><th>Type</th><th>Vaults</th><th>Access</th><th>Last used</th>`;
  const cells = (t: Row) => html`<td>${t.name}</td>
        <td data-label="Type" class="small">${typeOf(t)}</td>
        <td data-label="Vaults" class="small">${scopeOf(t)}</td>
        <td data-label="Access" class="small">${accessOf(t)}</td>
        <td data-label="Last used" class="small"><span>${lastUse(t)}</span></td>`;

  return render(
    ctx,
    "Connections",
    html`${pageHeader({
      title: "Connections",
      description: "Everything that can act as you: tokens, apps you signed in to, and the Reliquary CLI.",
      secondary: html`<a class="button" href="/connect">How to connect</a>`,
      primary: html`<a class="button primary" href="/connections/new">New token</a>`,
    })}
    ${live.length
      ? html`<div class="table-wrap"><table class="token-list table-stack">${head}<th>Expires</th><th class="num"><span class="sr-only">Actions</span></th></tr></thead><tbody>
    ${live.map(
      (t) => html`<tr>${cells(t)}
        <td data-label="Expires" class="small">${time(t.expires_at, { absolute: true })}</td>
        <td class="num"><a class="button danger" href="/connections/${t.id}/revoke" aria-label="Revoke ${t.name}">Revoke</a></td></tr>`,
    )}</tbody></table></div>`
      : emptyState({
          title: "Nothing can act as you right now",
          body: "Apps you sign in to from Claude Code, Claude.ai or ChatGPT, tokens you create, and the Reliquary CLI show here once connected.",
          action: html`<a class="button" href="/connect">Connect an agent</a>`,
        })}
    ${ended.length
      ? html`<details class="connections-ended"><summary>Expired and revoked <span class="count">${ended.length}</span></summary>
      <p class="hint">These no longer work. They stay listed so you can see what had access, and when.</p>
      <div class="table-wrap"><table class="token-list table-stack">${head}<th>Ended</th></tr></thead><tbody>
    ${ended.map(
      (t) => html`<tr class="inactive">${cells(t)}
        <td data-label="Ended" class="small">${t.revoked_at ? html`Revoked ${time(t.revoked_at)}` : html`Expired ${time(t.expires_at)}`}</td></tr>`,
    )}</tbody></table></div></details>`
      : ""}`,
    "connections",
  );
}

// ---------------------------------------------------------------------------
// New token

const newCrumb = [{ label: "Connections", href: "/connections" }, { label: "New token" }];

const EXPIRIES = [7, 30, 90, 180, 366];

// The form's values as posted when creating was refused: shown again with
// the reason and its reference, so nothing is chosen twice.
type TokenDraft = { name: string; scope: "all" | "some"; vaults: string[]; access: "read" | "write"; days: string; error: string; field?: "name" | "vaults" };

export async function newToken(ctx: Ctx, d?: TokenDraft): Promise<Reply> {
  const vaults = await asPerson(
    ctx.userId,
    async (c) =>
      (
        await c.query(
          `select v.id, v.name from public.vaults v
             join public.vault_members m on m.vault_id = v.id and m.user_id = $1
            order by v.name`,
          [ctx.userId],
        )
      ).rows as { id: string; name: string }[],
  );
  // An expiry the form doesn't offer (a forged post) shows the default.
  const posted = Number(d?.days);
  const chosenDays = EXPIRIES.includes(posted) ? posted : 90;
  const reply = render(
    ctx,
    "New token",
    html`${pageHeader({
      crumb: newCrumb,
      title: "New token",
      description: "A token lets one MCP client that can’t sign in, like Cursor, VS Code or a script, act as you.",
      secondary: html`<a class="button quiet" href="/connections">Cancel</a>`,
      primary: html`<button class="primary" form="new-token">Create token</button>`,
    })}
    <p class="hint new-token-hint">Claude Code, Claude.ai and ChatGPT don’t need one: they sign in. See <a href="/connect">Connect</a>.</p>
    <form method="post" action="/connections/new" class="panel token-form" id="new-token">
      ${csrfField(ctx.csrf)}
      ${d ? html`<p class="callout danger" role="alert" id="token-error">${d.error}</p>` : ""}
      <label for="tn">Name it after the agent and machine</label>
      <input id="tn" type="text" name="name" placeholder="Hermes on Linux" required maxlength="100" autocomplete="off" value="${d?.name ?? ""}"${
        d?.field === "name" ? raw(' aria-invalid="true" aria-describedby="token-error"') : ""
      }>
      <fieldset${d?.field === "vaults" ? raw(' aria-describedby="token-error"') : ""}>
        <legend>Vaults</legend>
        <label class="choice"><input type="radio" name="scope" value="all"${d?.scope === "some" ? "" : raw(" checked")}> All my vaults, including ones I join later</label>
        <label class="choice"><input type="radio" name="scope" value="some"${d?.scope === "some" ? raw(" checked") : ""}> Only the vaults I tick</label>
        ${vaults.length
          ? html`<div class="choice-list">${vaults.map(
              (v) => html`<label class="choice"><input type="checkbox" name="vault" value="${v.id}"${d?.vaults.includes(v.id) ? raw(" checked") : ""}> ${v.name}</label>`,
            )}</div>`
          : html`<p class="hint">You don’t belong to any vaults yet. <a href="/vaults/new">Create one</a>.</p>`}
        <p class="hint">Ticking a vault limits the token to the ticked vaults.</p>
      </fieldset>
      <fieldset>
        <legend>Access</legend>
        <label class="choice"><input type="radio" name="access" value="read"${d?.access === "write" ? "" : raw(" checked")}> Read only: read, search and follow changes</label>
        <label class="choice"><input type="radio" name="access" value="write"${d?.access === "write" ? raw(" checked") : ""}> Read and write: also write open files and propose changes</label>
      </fieldset>
      <label for="te">Expires after</label>
      <select id="te" name="days" class="token-expiry">
        ${EXPIRIES.map((n) => html`<option value="${n}"${n === chosenDays ? raw(" selected") : ""}>${n === 366 ? "1 year" : `${n} days`}</option>`)}
      </select>
      <p class="hint">A token’s vaults and access can’t be changed later. To change them, revoke it and create another.</p>
      <div class="actions"><button class="primary">Create token</button><a class="button quiet" href="/connections">Cancel</a></div>
    </form>`,
    "connections",
  );
  return d ? { ...reply, status: 400 } : reply;
}

const refuse = (why: string) => message(new Refusal({ status: 400, where: "web app (New token form)", why }));

export async function createToken(ctx: Ctx): Promise<Reply> {
  const name = (ctx.form.get("name") ?? "").trim();
  // Ticked vaults always narrow the scope, whatever the radio says: a
  // mismatch between the two must never produce the broader token.
  const ticked = ctx.form.getAll("vault");
  const some = ticked.length > 0 || ctx.form.get("scope") === "some";
  const access = ctx.form.get("access") === "write" ? "write" : "read";
  const typedDays = ctx.form.get("days") ?? "90";
  const days = Number.parseInt(typedDays, 10);
  const again = (error: string, field?: TokenDraft["field"]) =>
    newToken(ctx, { name, scope: some ? "some" : "all", vaults: ticked, access, days: typedDays, error, field });
  // The database refuses these too (a name's length is a check constraint,
  // whose own words talk about something else); said here, the form can say
  // which field.
  if ([...name].length < 1 || [...name].length > 100) {
    return again(refuse("A token needs a name, up to 100 characters: the agent and machine it is for. Nothing was created"), "name");
  }
  if (some && ticked.length === 0) {
    return again(refuse("Tick at least one vault, or choose all your vaults. Nothing was created"), "vaults");
  }
  if (!ticked.every((v) => UUID.test(v))) return notFound(ctx);
  let token: string;
  try {
    token = await asPerson(
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
  } catch (err) {
    return again(message(err));
  }
  // The one time the token is shown: this answer only, never a redirect
  // (it would have to be stored), and no form here inviting a second one.
  return render(
    ctx,
    "Copy your token",
    html`${pageHeader({
      crumb: newCrumb,
      title: "Copy your token",
      primary: html`<a class="button primary" href="/connections">Done</a>`,
    })}
    <div class="callout warning reveal" role="status"><strong>${name}</strong>
      <p class="muted small">Copy it now. It won’t be shown again. Put it where your client reads secrets (an environment variable or a password prompt), never in a chat or a file an agent can read.</p>
      <p class="secret">${token}</p></div>
    <p>Next, set up the client: <a href="/connect?client=cursor">Cursor</a>, <a href="/connect?client=vscode">VS Code</a> or <a href="/connect?client=other">another client</a>.</p>`,
    "connections",
  );
}

// ---------------------------------------------------------------------------
// Revoke

async function one(ctx: Ctx, tid: string): Promise<Row | undefined> {
  return asPerson(ctx.userId, async (c) => (await c.query(`${SELECT} where t.id = $1`, [tid])).rows[0] as Row | undefined);
}

const again: Record<string, string> = {
  pat: "To connect that client again, create a new token and put it where the client reads it.",
  oauth: "To connect the app again, sign in from it again (in Claude Code: /mcp, then Authenticate).",
  cli: "To use the CLI on that computer again, run reliquary login there.",
};

// What revoking stops, before it does: the connection by name, its type,
// vaults, access and last use, and how to connect again.
export async function revokePage(ctx: Ctx, tid: string): Promise<Reply> {
  if (!UUID.test(tid)) return notFound(ctx);
  const t = await one(ctx, tid);
  if (!t) return notFound(ctx);
  if (t.revoked_at || t.expired) {
    ctx.setFlash(`${t.name} ${t.revoked_at ? "was already revoked" : "has already expired"}: it can’t act as you.`);
    return { redirect: "/connections" };
  }
  const who = t.kind === "pat" ? "Anything using it" : t.kind === "cli" ? "The CLI on that computer" : "The app";
  return render(
    ctx,
    `Revoke ${t.name}`,
    confirmPage({
      crumb: [{ label: "Connections", href: "/connections" }, { label: t.name }],
      title: `Revoke ${t.name}?`,
      lede: `${t.name} stops working on its next request.`,
      consequences: [
        `${typeOf(t)}. ${who} loses access to ${t.all_vaults ? "all your vaults" : scopeOf(t)} (${accessOf(t).toLowerCase()}).`,
        html`Last used: ${lastUse(t)}.`,
        again[t.kind] ?? again.pat,
        "What it already did stays in Activity. This can’t be undone.",
      ],
      action: `/connections/${t.id}/revoke`,
      csrf: ctx.csrf,
      button: `Revoke ${t.name}`,
      cancel: "/connections",
    }),
    "connections",
  );
}

export async function revokeToken(ctx: Ctx, tid: string): Promise<Reply> {
  if (!UUID.test(tid)) return notFound(ctx);
  try {
    const t = await one(ctx, tid);
    await asPerson(ctx.userId, (c) => c.query(`select public.revoke_access_token($1)`, [tid]));
    ctx.setFlash(`Revoked ${t?.name ?? "the connection"}. Anything using it is cut off on its next request.`, "success");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: "/connections" };
}
