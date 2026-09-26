// Account settings (/settings): the person's display name, their email,
// the theme, links to Plan and usage, Tokens and connections, and Connect,
// and (hosted) sign out and sign out everywhere. The name is the database's to keep and check
// (public.set_display_name, public.profiles with RLS: your own row, in
// person only; 20260926100000_shell_inbox.sql). An agent can't set it: it's
// profile management, like managing members (docs/parity.md).
//
// What the page shows comes from the top bar's summary (ctx.shell), so the
// page costs no query of its own.
//
// Sign out everywhere (POST /settings/sign-out-everywhere) ends every
// browser session of the account: first at Supabase Auth (a global logout
// revokes every refresh token, so no browser can renew), then in the
// database (public.end_my_sessions sets a cutoff that private.check_session
// holds every session issued before it to, so the access tokens already
// handed out stop working at once instead of within the hour;
// 20260926140000_sign_out_everywhere.sql). Connections (agent tokens,
// connected apps, CLI sign-ins) are not browser sessions and stay, unless
// the person also ticks "Also revoke all my connections".

import { asPerson } from "./db.js";
import { refusalText } from "./errorpage.js";
import { Refusal } from "./failure.js";
import { csrfField, html, notice, pageHeader, signsOut, themeButtons } from "./html.js";
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
      <h2 id="more">Plan, tokens and connections</h2>
      <ul class="rows">
        <li><span><a class="name" href="/account">Plan and usage</a><span class="muted small"> · your plan, and the people and storage of the vaults you own</span></span></li>
        <li><span><a class="name" href="/tokens">Tokens and connections</a><span class="muted small"> · agent tokens, connected apps and CLI sign-ins, with Revoke</span></span></li>
        <li><span><a class="name" href="/connect">Connect an agent</a><span class="muted small"> · set up Claude, ChatGPT, Cursor, VS Code or the CLI</span></span></li>
      </ul>
    </section>
    ${hosted
      ? html`<section aria-labelledby="signout">
      <h2 id="signout">Sign out</h2>
      <p class="small muted">Ends your session in this browser. Your agents’ connections stay until you revoke them on Tokens and connections.</p>
      <form method="post" action="/signout">${csrfField(ctx.csrf)}<button>Sign out</button></form>
    </section>
    <section aria-labelledby="everywhere">
      <h2 id="everywhere">Sign out everywhere</h2>
      <p>Ends every session of your account at once, in every browser and on every device, this one included. Use it if you signed in on a computer you no longer use, or lost a phone.</p>
      <p class="small muted">Connections are separate: agent tokens, connected apps (Claude, ChatGPT, Cursor and others) and Reliquary CLI sign-ins keep working after you sign out everywhere. Revoke them all here, or one at a time on <a href="/tokens">Tokens and connections</a>.</p>
      <form method="post" action="/settings/sign-out-everywhere" class="panel settings-form">
        ${csrfField(ctx.csrf)}
        <label class="choice"><input type="checkbox" name="revoke_connections" value="1"> Also revoke all my connections: agent tokens, connected apps and CLI sign-ins</label>
        <div class="actions"><button class="danger">Sign out everywhere</button></div>
      </form>
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

export async function signOutEverywhere(ctx: Ctx): Promise<Reply> {
  const revoke = ctx.form.get("revoke_connections") === "1";
  if (!signsOut() || !ctx.session) {
    throw new Refusal({ status: 404, where: "web app (Account settings)", why: "Sign out everywhere is for Supabase sign-in; the local stand-in has one session, ended by stopping the server" });
  }
  // Supabase first: once no refresh token of the account works, the
  // database's cutoff can't be outrun by a browser renewing its session.
  const at = await ctx.session.signOutEverywhere();
  if (at === "unavailable") {
    throw new Refusal({ status: 503, where: "sign-out (Supabase Auth)", why: "Reliquary couldn’t reach its sign-in service, so no session was ended and no connection revoked. Try again in a minute" });
  }
  if (at === "refused") {
    throw new Refusal({ status: 502, where: "sign-out (Supabase Auth)", why: "The sign-in service refused to end your account’s sessions, so none was ended and no connection revoked. Sign out, sign in again and retry" });
  }
  const n = await asPerson(ctx.userId, async (c) => (await c.query(`select public.end_my_sessions($1) as n`, [revoke])).rows[0].n as number);
  const connections = revoke
    ? n === 0
      ? html`You had no live connections to revoke.`
      : html`${n === 1 ? "Your one connection was" : `All ${n} of your connections were`} revoked too: agent tokens, connected apps and CLI sign-ins stop working now.`
    : html`Your connections (agent tokens, connected apps and CLI sign-ins) still work. To end them, sign in and revoke them on Tokens and connections.`;
  return {
    html: notice(
      "Signed out everywhere",
      html`Every session of your account has ended, in every browser, this one included. ${connections} <a href="/signin">Sign in</a> again.`,
      ctx.theme,
    ),
  };
}
