// Account settings (/settings): the person's display name, their email,
// the theme, and links to Plan and usage, Connections, and
// Connect. The name is the database's to keep and check
// (public.set_display_name, public.profiles with RLS: your own row, in
// person only; 20260926100000_shell_inbox.sql). An agent can't set it: it's
// profile management, like managing members (docs/parity.md).
//
// What the page shows comes from the top bar's summary (ctx.shell), so the
// page costs no query of its own.

import { asPerson } from "./db.js";
import { refusalText } from "./errorpage.js";
import { csrfField, html, pageHeader, signsOut, themeButtons } from "./html.js";
import { render, type Ctx, type Reply } from "./pages.js";
import { shortId } from "./personref.js";

export const DISPLAY_NAME_MAX = 80;

export function accountSettings(ctx: Ctx): Reply {
  const me = ctx.shell?.me ?? { email: null, name: null };
  const hosted = signsOut();
  return render(
    ctx,
    "Account settings",
    html`${pageHeader({ title: "Account settings", meta: html`<p class="meta">${me.email ?? `Account ${shortId(ctx.userId)}`}</p>` })}
    <section aria-labelledby="profile">
      <h2 id="profile" class="form-title">Profile</h2>
      <form method="post" action="/settings/name" class="panel settings-form">
        ${csrfField(ctx.csrf)}
        <label for="display-name">Display name</label>
        <input id="display-name" type="text" name="display_name" value="${me.name ?? ""}" maxlength="${DISPLAY_NAME_MAX}" autocomplete="name" aria-describedby="display-name-hint">
        <p class="hint" id="display-name-hint">Shown next to your email to people who share a vault with you: in Activity, proposals, threads and members. Up to ${DISPLAY_NAME_MAX} characters, without “@”. Leave it empty to be shown by your email alone.</p>
        <div class="actions"><button class="primary">Save name</button></div>
      </form>
    </section>
    <section aria-labelledby="email">
      <h2 id="email">Email</h2>
      <p>${me.email ? html`<strong>${me.email}</strong>` : html`<span class="muted">No email on this account (local sign-in).</span>`}</p>
      <p class="small muted">You sign in with this address, and invites to vaults are made out to it. It can’t be changed here: to use another address, ask the operator of this Reliquary.</p>
    </section>
    <section aria-labelledby="appearance">
      <h2 id="appearance">Appearance</h2>
      <form method="post" action="/theme" class="theme" aria-label="Theme">
        ${csrfField(ctx.csrf)}<input type="hidden" name="back" value="/settings">
        <span class="menu-label">Theme</span>
        ${themeButtons(ctx.theme)}
      </form>
    </section>
    <section aria-labelledby="more">
      <h2 id="more">Plan and connections</h2>
      <ul class="rows">
        <li><span><a class="name" href="/account">Plan and usage</a><span class="muted small"> · your plan, and the people and storage of the vaults you own</span></span></li>
        <li><span><a class="name" href="/connections">Connections</a><span class="muted small"> · everything that can act as you: tokens, apps and the Reliquary CLI, each with Revoke</span></span></li>
        <li><span><a class="name" href="/connect">Connect an agent</a><span class="muted small"> · set up Claude, ChatGPT, Cursor, VS Code or the CLI</span></span></li>
      </ul>
    </section>
    ${hosted
      ? html`<section aria-labelledby="signout">
      <h2 id="signout">Sign out</h2>
      <p class="small muted">Ends your session in this browser. Your connections stay until you revoke them on Connections.</p>
      <form method="post" action="/signout">${csrfField(ctx.csrf)}<button>Sign out</button></form>
    </section>`
      : ""}`,
    "settings",
  );
}

export async function saveDisplayName(ctx: Ctx): Promise<Reply> {
  const name = ctx.form.get("display_name") ?? "";
  try {
    const kept = await asPerson(ctx.userId, async (c) => (await c.query(`select public.set_display_name($1) as n`, [name])).rows[0].n as string | null);
    ctx.setFlash(kept ? `Saved. People who share a vault with you now see you as ${kept}.` : "Display name cleared. People see your email.", "success");
  } catch (err) {
    ctx.setFlash(refusalText(err));
  }
  return { redirect: "/settings" };
}
