// Account settings (/settings): Profile (display name, email and, hosted,
// change of email), Appearance (the theme), Sessions (hosted: sign out and
// sign out everywhere) and Danger zone (delete account), with a sub-nav
// that also links to Plan and usage, Connections and Connect. The name
// is the database's to keep and check
// (public.set_display_name, public.profiles with RLS: your own row, in
// person only; 20260926100000_shell_inbox.sql). An agent can't set it: it's
// profile management, like managing members (docs/parity.md). So is "Show
// me to others as" (public.set_email_shown; who sees what is the
// database's rule, 20261014150000_display_preferences.sql).
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
// 20260926140100_sign_out_everywhere.sql). Connections (agent tokens,
// apps, the Reliquary CLI) are not browser sessions and stay, unless
// the person also ticks "Also revoke all my connections".
//
// Change of email (POST /settings/email, hosted) asks Supabase Auth to move
// the account to another address (PUT /user). Auth emails a link to the new
// address and, with its secure email change (on by default), one to the
// current address too; the address changes only once the link is opened
// (/auth/confirm?type=email_change, signin.ts), and until then the page
// shows the change waiting (GET /user). Reliquary keeps no copy of the
// address: memberships, roles, connections, admission and plans hang off
// the account id, so they stay; co-members see the new address; invites are
// matched to the address the account has when one is accepted, so invites
// made out to the old address stop matching and those made out to the new
// one (whose inbox the person has just proved they hold) can be accepted
// with their links (supabase/tests/email_change_test.sql).
//
// Delete account (GET /settings/delete, a confirm page; POST deletes) is
// public.delete_account, in person, with the address typed, which the
// database checks too (20260926140200_delete_account.sql). The page says
// what happens to each vault: left, deleted with the account (nobody else
// in it) or left without an owner (20261014170000_orphaned_vaults.sql).
// Afterwards this browser's session ends here; the database refuses
// any other (private.check_session), and Supabase Auth has no account left
// to renew one for.

import { asPerson } from "./db.js";
import { refusalText } from "./errorpage.js";
import { Refusal } from "./failure.js";
import { callout, confirmPage, csrfField, html, notice, pageHeader, plural, signsOut, themeButtons, time } from "./html.js";
import { loadShell } from "./inbox.js";
import { emailKey } from "./invites.js";
import { EMAIL } from "./signin.js";
import { render, type Ctx, type Reply } from "./pages.js";
import { shortId } from "./personref.js";

const DISPLAY_NAME_MAX = 80;

// A refused save, as posted and with the reason (and its reference), shown
// in the form it came from.
type Draft = { value: string; error: string };

export async function accountSettings(ctx: Ctx, d: { name?: Draft; email?: Draft } = {}): Promise<Reply> {
  // A POST page isn't given the top bar's summary (pages.ts loads it for
  // GETs), and this page reads the address and name from it.
  if (d.name || d.email) ctx.shell ??= await asPerson(ctx.userId, loadShell);
  const me = ctx.shell?.me ?? { email: null, name: null };
  const hosted = signsOut();
  // A change of address waiting for its link, as Supabase Auth has it.
  const pending = hosted && ctx.session ? await ctx.session.pendingEmail() : null;
  const showEmail = ctx.shell?.show_email !== false;
  const threadEmails = ctx.shell?.thread_emails !== false;
  const notifications = html`<section aria-labelledby="notifications">
      <h2 id="notifications">Emails</h2>
      <form method="post" action="/settings/thread-emails" class="panel settings-form" id="thread-emails">
        ${csrfField(ctx.csrf)}
        <label class="choice"><input type="checkbox" name="thread_emails" value="1"${threadEmails ? html` checked` : ""}>
          <span><strong>Email me about threads</strong>: when a thread is opened for a whole vault you're in, or addressed to you, and when it gets new messages. One email per thread at a time, with its title and who wrote, never the messages themselves.</span></label>
        <div class="actions"><button class="primary">Save</button></div>
      </form>
    </section>`;
  const name = html`<section aria-labelledby="display-name-title">
      <h3 id="display-name-title">Display name</h3>
      <form method="post" action="/settings/name" class="panel settings-form">
        ${csrfField(ctx.csrf)}
        ${d.name ? html`<p class="callout danger" role="alert" id="name-error">${d.name.error}</p>` : ""}
        <label for="display-name">Display name</label>
        <input id="display-name" type="text" name="display_name" value="${d.name?.value ?? me.name ?? ""}" maxlength="${DISPLAY_NAME_MAX}" autocomplete="name"${
          d.name ? html` aria-invalid="true" aria-describedby="name-error display-name-hint"` : html` aria-describedby="display-name-hint"`
        }>
        <p class="hint" id="display-name-hint">Shown to people who share a vault with you, and their agents: in Activity, proposals, threads and members. Up to ${DISPLAY_NAME_MAX} characters, without “@”. Leave it empty to be shown by your email alone.</p>
        <div class="actions"><button class="primary">Save name</button></div>
      </form>
      <form method="post" action="/settings/shown-as" class="panel settings-form choice-form" id="shown-as">
        ${csrfField(ctx.csrf)}
        <fieldset>
          <legend>Show me to others as</legend>
          <label class="choice"><input type="radio" name="show_email" value="1"${showEmail ? html` checked` : ""}>
            <span><strong>Display name and email</strong></span></label>
          <label class="choice"><input type="radio" name="show_email" value="0"${showEmail ? "" : html` checked`}>
            <span><strong>Display name alone:</strong> others see your name and a short tag from your account id, like “Ana · ${shortId(ctx.userId)}”, never your email.</span></label>
        </fieldset>
        <div class="actions"><button class="primary">Save</button></div>
      </form>
    </section>`;
  const email = html`<section aria-labelledby="email">
      <h3 id="email">Email</h3>
      <p>${me.email ? html`<strong>${me.email}</strong>` : html`<span class="muted">No email on this account (local sign-in).</span>`}</p>
      ${hosted
        ? html`${pending === "unavailable"
            ? callout("warning", "Reliquary couldn’t reach its sign-in service to check for a change of address waiting to be confirmed.")
            : pending
              ? callout(
                  "info",
                  html`<p>Waiting for confirmation: <strong>${pending.email}</strong>. We sent a link to that address${pending.sentAt ? html` ${time(pending.sentAt)}` : ""}, and one to your current address too if this site asks both. Open it (or both) to finish the change. Until then you sign in with your current address.</p>`,
                  { title: "Change of email address", id: "email-pending" },
                )
              : ""}
          <form method="post" action="/settings/email" class="panel settings-form">
            ${csrfField(ctx.csrf)}
            ${d.email ? html`<p class="callout danger" role="alert" id="email-error">${d.email.error}</p>` : ""}
            <label for="new-email">New email address</label>
            <input id="new-email" type="text" name="new_email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" required${
              d.email ? html` value="${d.email.value}" aria-invalid="true" aria-describedby="email-error new-email-hint"` : html` aria-describedby="new-email-hint"`
            }>
            <p class="hint" id="new-email-hint">We email a link to the new address to confirm it is yours; nothing changes until you open it. Afterwards you sign in with the new address. Your vaults, roles, connections and plan stay as they are, and people who share a vault with you see the new address. Invites made out to your old address stop working: ask for a new one.</p>
            <div class="actions"><button class="primary">Send confirmation link</button></div>
          </form>`
        : html`<p class="small muted">You sign in with this address, and invites to vaults are made out to it. It can’t be changed here: to use another address, ask the operator of this Reliquary.</p>`}
    </section>`;
  // One page with a sub-nav to its anchored sections, rather than a page per
  // section: a refused form answers the whole page, and every section is a
  // short form. Plan, Connections and Connect are pages of their own, so
  // the sub-nav links to them instead of repeating them here.
  const sections: [string, string][] = [["profile", "Profile"], ["appearance", "Appearance"], ...(hosted ? [["sessions", "Sessions"] as [string, string]] : []), ["danger", "Danger zone"]];
  const nav = html`<nav class="settings-nav" aria-label="Account settings">
      <div class="settings-nav-group"><p class="settings-nav-label">On this page</p><ul>${sections.map(([id, label]) => html`<li><a href="#${id}">${label}</a></li>`)}</ul></div>
      <div class="settings-nav-group"><p class="settings-nav-label">Elsewhere</p><ul>
        <li><a href="/account">Plan and usage</a></li>
        <li><a href="/connections">Connections</a></li>
        <li><a href="/connect">Connect an agent</a></li>
      </ul></div>
    </nav>`;
  const reply = render(
    ctx,
    "Account settings",
    html`${pageHeader({ title: "Account settings", meta: html`<p class="meta">${me.email ?? `Account ${shortId(ctx.userId)}`}</p>` })}
    <div class="settings-layout">${nav}<div class="settings-main">
    <section aria-labelledby="profile">
      <h2 id="profile">Profile</h2>
      ${d.email ? email : name}
      ${d.email ? name : email}
    </section>
    ${notifications}
    <section aria-labelledby="appearance">
      <h2 id="appearance">Appearance</h2>
      <form method="post" action="/theme" class="theme" aria-label="Theme">
        ${csrfField(ctx.csrf)}<input type="hidden" name="back" value="/settings">
        <span class="menu-label">Theme</span>
        ${themeButtons(ctx.theme)}
      </form>
    </section>
    ${hosted
      ? html`<section aria-labelledby="sessions">
      <h2 id="sessions">Sessions</h2>
      <h3 id="signout">Sign out</h3>
      <p class="small muted">Ends your session in this browser. Your connections stay until you revoke them on Connections.</p>
      <form method="post" action="/signout">${csrfField(ctx.csrf)}<button>Sign out</button></form>
      <h3 id="everywhere">Sign out everywhere</h3>
      <p>Ends every session of your account at once, in every browser and on every device, this one included. Use it if you signed in on a computer you no longer use, or lost a phone.</p>
      <p class="small muted">Connections are separate: tokens, apps (Claude, ChatGPT, Cursor and others) and the Reliquary CLI keep working after you sign out everywhere. Revoke them all here, or one at a time on <a href="/connections">Connections</a>.</p>
      <form method="post" action="/settings/sign-out-everywhere" class="panel settings-form">
        ${csrfField(ctx.csrf)}
        <label class="choice"><input type="checkbox" name="revoke_connections" value="1"> Also revoke all my connections: tokens, apps and the Reliquary CLI</label>
        <div class="actions"><button class="danger">Sign out everywhere</button></div>
      </form>
    </section>`
      : ""}
    <section class="settings-danger" id="danger" aria-labelledby="danger-title">
      <h2 id="danger-title">Danger zone</h2>
      <div class="danger-rows">
        <div class="danger-row">
          <div><h3 id="delete-account">Delete account</h3>
            <p>Deletes your account now: you leave every vault, your connections are deleted, and Reliquary forgets your email address and name. What you wrote in vaults stays there, shown as written by a deleted account. This can’t be undone.</p></div>
          <a class="button danger" href="/settings/delete">Delete account</a>
        </div>
      </div>
    </section>
    </div></div>`,
    "settings",
  );
  return d.name || d.email ? { ...reply, status: 400 } : reply;
}

export async function saveDisplayName(ctx: Ctx): Promise<Reply> {
  const name = ctx.form.get("display_name") ?? "";
  try {
    const kept = await asPerson(ctx.userId, async (c) => (await c.query(`select public.set_display_name($1) as n`, [name])).rows[0].n as string | null);
    ctx.setFlash(kept ? `Saved. People who share a vault with you now see you as ${kept}.` : "Display name cleared. People see your email.", "success");
  } catch (err) {
    return accountSettings(ctx, { name: { value: name, error: refusalText(err) } });
  }
  return { redirect: "/settings" };
}

// POST /settings/shown-as: public.set_email_shown, the person in person.
export async function saveShownAs(ctx: Ctx): Promise<Reply> {
  const show = ctx.form.get("show_email") !== "0";
  await asPerson(ctx.userId, (c) => c.query(`select public.set_email_shown($1)`, [show]));
  ctx.setFlash(show ? "Saved. People who share a vault with you see your name and email." : "Saved. People see your name and a short tag, not your email.", "success");
  return { redirect: "/settings" };
}

// POST /settings/thread-emails: public.set_thread_emails, the person in person.
export async function saveThreadEmails(ctx: Ctx): Promise<Reply> {
  const on = ctx.form.get("thread_emails") === "1";
  await asPerson(ctx.userId, (c) => c.query(`select public.set_thread_emails($1)`, [on]));
  ctx.setFlash(on ? "Saved. You'll be emailed about threads for you or your whole vault." : "Saved. No more emails about threads; your flags and the Threads page still show them.", "success");
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
      : html`${n === 1 ? "Your one connection was" : `All ${n} of your connections were`} revoked too: tokens, apps and the Reliquary CLI stop working now.`
    : html`Your connections (tokens, apps and the Reliquary CLI) still work. To end them, sign in and revoke them on Connections.`;
  return {
    html: notice(
      "Signed out everywhere",
      html`Every session of your account has ended, in every browser, this one included. ${connections} <a href="/signin">Sign in</a> again.`,
      ctx.theme,
    ),
  };
}

export async function changeEmail(ctx: Ctx): Promise<Reply> {
  const where = "web app (Account settings)";
  if (!signsOut() || !ctx.session) {
    throw new Refusal({ status: 404, where, why: "Changing your email is for Supabase sign-in; the local stand-in has no email to change" });
  }
  const email = (ctx.form.get("new_email") ?? "").trim();
  const refuse = (why: string, at = where) =>
    accountSettings(ctx, { email: { value: email, error: refusalText(new Refusal({ status: 400, where: at, why })) } });
  if (!EMAIL.test(email) || email.length > 254) return refuse("Enter the new address like name@example.com. Nothing was changed");
  const current = (await asPerson(ctx.userId, async (c) => (await c.query(`select public.my_email() as e`)).rows[0].e as string | null)) ?? "";
  if (emailKey(email) === emailKey(current)) {
    return refuse("That is already your address. Nothing was changed");
  }
  const r = await ctx.session.changeEmail(email);
  const auth = "change of email (Supabase Auth)";
  if (r === "unavailable") {
    throw new Refusal({ status: 503, where: auth, why: "Reliquary couldn’t reach its sign-in service, so no confirmation link was sent and your address is unchanged. Try again in a minute" });
  }
  if (r === "taken") return refuse("That address already belongs to another Reliquary account, so it can’t be yours too. Nothing was changed", auth);
  if (r === "invalid") return refuse("The sign-in service doesn’t accept that as an email address. Nothing was changed", auth);
  if (r === "limited") return refuse("The sign-in service has sent as many emails as it allows for now, so no link was sent. Wait an hour, then ask again. Nothing was changed", auth);
  if (r === "refused") return refuse("The sign-in service refused the change, so no link was sent. Sign out, sign in again and retry. Nothing was changed", auth);
  ctx.setFlash("We sent a confirmation link to the new address. Open it to finish the change; until then you sign in with your current address.", "success");
  return { redirect: "/settings" };
}

// ---------------------------------------------------------------------------
// Delete account

type DeletionSummary = {
  email: string | null;
  // What deleting the account does to each vault (private.account_vault_fates).
  vaults: { id: string; name: string; role: string; fate: "leave" | "orphan" | "delete" }[];
  connections: number;
  invites: number;
};
const NO_EMAIL_PHRASE = "delete my account";
const crumb = [{ label: "Account settings", href: "/settings" }, { label: "Delete account" }];

export async function deleteAccountPage(ctx: Ctx, error?: string): Promise<Reply> {
  const s = await asPerson(ctx.userId, async (c) => (await c.query(`select public.account_deletion_summary() as s`)).rows[0].s as DeletionSummary);
  const leaving = s.vaults.filter((v) => v.fate !== "delete");
  const fates = s.vaults.flatMap((v) =>
    v.fate === "delete"
      ? [html`Nobody else is in <strong>${v.name}</strong>, so it is deleted with your account, with everything in it. <a href="/v/${v.id}/config/export">Export it</a> first to keep a copy.`]
      : v.fate === "orphan"
        ? [html`<strong>${v.name}</strong> has no other owner, so it is left without one. Its members keep working in it, and any of them can choose to become its owner.`]
        : [],
  );
  const typed = s.email ?? NO_EMAIL_PHRASE;
  const left = leaving.length
    ? html`You leave ${leaving.length === 1 ? "one vault" : `${leaving.length} vaults`}: ${leaving.map((v, i) => html`${i ? ", " : ""}<strong>${v.name}</strong> (${v.role})`)}.`
    : s.vaults.length ? "" : html`You’re in no vault.`;
  return render(
    ctx,
    "Delete account",
    confirmPage({
      title: "Delete your account",
      crumb,
      lede: html`This deletes your account now. ${left} ${s.connections ? `${plural(s.connections, "connection")} (tokens, apps and the Reliquary CLI) ${s.connections === 1 ? "is" : "are"} deleted and stop${s.connections === 1 ? "s" : ""} working.` : "You have no connections to delete."} This can’t be undone.`,
      consequences: [
        ...fates,
        "Reliquary forgets your email address, your display name and your plan, and signs you out everywhere.",
        ...(s.invites ? [`${plural(s.invites, "invite")} you made that ${s.invites === 1 ? "is" : "are"} still waiting ${s.invites === 1 ? "is" : "are"} withdrawn.`] : []),
        "What you wrote in vaults stays there: files, proposals, comments and the activity log belong to each vault and its owners. It shows as written by a deleted account. To remove something you wrote, erase it or ask an owner to, before you delete your account.",
        "Backups keep your data until they age out, then it is gone everywhere.",
        "You can sign up again later with the same address. That is a new account: it has none of your vaults.",
      ],
      action: "/settings/delete",
      csrf: ctx.csrf,
      typed: {
        value: typed,
        name: "confirm_email",
        label: s.email ? html`Type your email address, <strong>${s.email}</strong>, to confirm` : html`Type <strong>${NO_EMAIL_PHRASE}</strong> to confirm`,
      },
      button: "Delete my account",
      cancel: "/settings",
      error,
    }),
    "settings",
  );
}

export async function deleteAccount(ctx: Ctx): Promise<Reply> {
  const typed = ctx.form.get("confirm_email") ?? "";
  let n: { vaults: number; orphaned: number; deleted: number; connections: number; invites: number };
  try {
    n = await asPerson(ctx.userId, async (c) => (await c.query(`select public.delete_account($1) as n`, [typed])).rows[0].n);
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "22023") {
      const r = await deleteAccountPage(ctx, "That isn’t your email address as it is on this account. Nothing was deleted.");
      return { ...r, status: 400 };
    }
    throw err;
  }
  // The account is gone: end this browser's session too. Supabase Auth has
  // no account left to refresh it for, and the database refuses its access
  // token from now on.
  await ctx.session?.signOut().catch(() => undefined);
  return {
    html: notice(
      "Account deleted",
      html`Your account is deleted. You left ${plural(n.vaults, "vault")}, ${plural(n.connections, "connection")} ${n.connections === 1 ? "was" : "were"} deleted${n.invites ? `, and ${plural(n.invites, "waiting invite")} ${n.invites === 1 ? "was" : "were"} withdrawn` : ""}.${
        n.orphaned ? ` ${n.orphaned === 1 ? "One of them has" : `${n.orphaned} of them have`} no owner now, until a member chooses to become one.` : ""}${
        n.deleted ? ` ${plural(n.deleted, "vault")} nobody else was in ${n.deleted === 1 ? "was" : "were"} deleted with your account.` : ""} What you wrote in vaults stays there, shown as written by a deleted account.`,
      ctx.theme,
    ),
  };
}
