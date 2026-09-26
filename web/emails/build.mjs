// Every email Reliquary's accounts send, from one place.
//
// This file is the source: one layout, and each email's subject and words.
// It writes the files people and servers use:
//
//   web/emails/<id>.html     one template per email, standalone, pasted into
//                            the Supabase dashboard (hosted) or served to
//                            Supabase Auth by the web app (self-hosted,
//                            web/src/selfhost.ts)
//   web/emails/manifest.tsv  id, file, where it goes, subject
//
//   node emails/build.mjs            rewrite them (from web/, in the node image)
//   node emails/build.mjs --check    exit 1 if they're out of date (the tests run this)
//   node emails/build.mjs --preview <file>   one page showing every email with sample values
//
// Supabase Auth's emails use its Go template variables ({{ .Token }},
// {{ .TokenHash }}, {{ .SiteURL }}, {{ .Email }}, ...), exactly as Auth
// passes them. Links go to the app's own /auth/confirm with the token hash,
// never Auth's {{ .ConfirmationURL }} (it returns tokens in a URL fragment,
// which a server can't read). `type=email` verifies sign-in, sign-up,
// invite and recovery tokens alike; a change of address is `email_change`.
//
// The vault invite is Reliquary's own (web/src/emails.ts renders it, with
// every value escaped), and deliverInvite() in web/src/invites.ts sends it
// through Resend when the server has an email sender.
//
// Email-client safe: tables, inline styles, a system font stack, no images,
// fonts, scripts or remote anything; a <style> only for dark mode, which
// clients without it simply skip. Words: sentence case, no em dashes, no
// marketing, and every email says who sent it and what to do if you didn't
// ask.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL(".", import.meta.url));

// Colours: web/public/style.css's light and dark tokens.
const LIGHT = { page: "#f7f6f5", card: "#ffffff", border: "#e2dfdc", fg: "#1c1917", muted: "#5c5652", link: "#0a58ca", btn: "#1c1917", btnFg: "#ffffff", code: "#f7f6f5", brand: "#e8393a" };
const DARK = { page: "#141312", card: "#1c1a19", border: "#34302e", fg: "#edebe9", muted: "#a8a19c", link: "#6cb6ff", btn: "#edebe9", btnFg: "#141312", code: "#262322", brand: "#ff5f57" };
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

// Building blocks --------------------------------------------------------------

const text = (size = 16) => `font-family:${FONT};font-size:${size}px;line-height:${Math.round(size * 1.5)}px;`;

const p = (html) => `<p class="rq-fg" style="margin:0 0 16px 0;${text(16)}color:${LIGHT.fg};">${html}</p>`;
const muted = (html) => `<p class="rq-muted" style="margin:0 0 16px 0;${text(14)}color:${LIGHT.muted};">${html}</p>`;

// The one-time code, big. <strong> stays bare: deploy/test/smoke.mjs finds the code by it.
const code = (expr) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">
<tr><td class="rq-code" style="padding:12px 20px;background-color:${LIGHT.code};border:1px solid ${LIGHT.border};font-family:${MONO};font-size:32px;line-height:40px;letter-spacing:6px;color:${LIGHT.fg};"><strong>${expr}</strong></td></tr>
</table>`;

const button = (href, label) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">
<tr><td class="rq-btn" bgcolor="${LIGHT.btn}" style="background-color:${LIGHT.btn};">${`<a class="rq-btn-a" href="${href}" style="display:inline-block;padding:12px 20px;${text(16)}font-weight:600;color:${LIGHT.btnFg};text-decoration:none;">${label}</a>`}</td></tr>
</table>`;

// The link written out, for clients that drop the button and for copying.
const raw = (href) =>
  muted(`Or copy this link into your browser:<br><a class="rq-link" href="${href}" style="color:${LIGHT.link};text-decoration:underline;word-break:break-all;">${href.replaceAll("&", "&amp;")}</a>`);

// A small two-column list of facts (for the vault invite).
const facts = (rows) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">
${rows.map(([k, v]) => `<tr><td class="rq-muted" style="padding:2px 16px 2px 0;${text(14)}color:${LIGHT.muted};vertical-align:top;">${k}</td><td class="rq-fg" style="padding:2px 0;${text(14)}color:${LIGHT.fg};">${v}</td></tr>`).join("\n")}
</table>`;

const rule = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px 0;"><tr><td class="rq-rule" style="border-top:1px solid ${LIGHT.border};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;

function layout({ subject, preheader, title, body, didntAsk, sentBy }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${subject}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .rq-page { background-color: ${DARK.page} !important; }
    .rq-card { background-color: ${DARK.card} !important; border-color: ${DARK.border} !important; }
    .rq-fg { color: ${DARK.fg} !important; }
    .rq-muted { color: ${DARK.muted} !important; }
    .rq-link { color: ${DARK.link} !important; }
    .rq-brand { color: ${DARK.brand} !important; }
    .rq-code { background-color: ${DARK.code} !important; border-color: ${DARK.border} !important; color: ${DARK.fg} !important; }
    .rq-btn { background-color: ${DARK.btn} !important; }
    .rq-btn-a { color: ${DARK.btnFg} !important; }
    .rq-rule { border-color: ${DARK.border} !important; }
  }
</style>
</head>
<body class="rq-page" style="margin:0;padding:0;background-color:${LIGHT.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${preheader}</div>
<table role="presentation" class="rq-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${LIGHT.page};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td style="padding:0 0 16px 0;${text(16)}font-weight:600;color:${LIGHT.fg};" class="rq-fg"><span class="rq-brand" style="color:${LIGHT.brand};">&#9670;</span>&nbsp;Reliquary</td></tr>
<tr><td class="rq-card" style="padding:32px;background-color:${LIGHT.card};border:1px solid ${LIGHT.border};">
<h1 class="rq-fg" style="margin:0 0 16px 0;${text(22)}font-weight:600;color:${LIGHT.fg};">${title}</h1>
${body.join("\n")}
${rule}
${muted(didntAsk)}
</td></tr>
<tr><td class="rq-muted" style="padding:16px 0 0 0;${text(12)}color:${LIGHT.muted};">${sentBy}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

// Auth's link to the app's /auth/confirm. `&type=` stays a bare `&` in the
// href, as Auth's own examples write it; the written-out copy escapes it.
const confirm = (type) => `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=${type}`;
const SENT_BY = "Sent by Reliquary at {{ .SiteURL }} about the account {{ .Email }}.";
const NOT_YOU = "If you didn't make this change, tell the person who runs Reliquary at {{ .SiteURL }} right away. If it was you, there's nothing to do.";

// The emails -------------------------------------------------------------------
//
// section: where the template goes in the Supabase dashboard
//   ("Authentication, Emails, Templates" or its "Security notifications"),
//   or "Reliquary" for the app's own.
// gotrue: the key in GOTRUE_MAILER_TEMPLATES_<key> / GOTRUE_MAILER_SUBJECTS_<key>.
// notify: a security notification, which Auth sends only when turned on
//   (GOTRUE_MAILER_NOTIFICATIONS_<notify>_ENABLED).

export const TEMPLATES = [
  {
    id: "sign-in",
    name: "Magic link or OTP",
    section: "Templates",
    gotrue: "MAGIC_LINK",
    subject: "Your Reliquary sign-in code",
    when: "You ask to sign in with an address that has an account.",
    vars: ["Token", "TokenHash", "SiteURL", "Email"],
    link: confirm("email"),
    html: () =>
      layout({
        subject: "Your Reliquary sign-in code",
        preheader: "Your code to sign in to Reliquary. It works once, within 10 minutes.",
        title: "Sign in to Reliquary",
        body: [
          p("Enter this code on the sign-in page to finish signing in. It works once, within 10 minutes."),
          code("{{ .Token }}"),
          p("Or sign in on the device you're reading this on:"),
          button(confirm("email"), "Sign in"),
          raw(confirm("email")),
        ],
        didntAsk: "If you didn't ask to sign in, ignore this email. Nothing changes, and no one can sign in without this code or link.",
        sentBy: SENT_BY,
      }),
  },
  {
    id: "confirm-signup",
    name: "Confirm sign up",
    section: "Templates",
    gotrue: "CONFIRMATION",
    subject: "Confirm your email for Reliquary",
    when: "You sign in for the first time, from an invite, and the account is new.",
    vars: ["Token", "TokenHash", "SiteURL", "Email"],
    link: confirm("email"),
    html: () =>
      layout({
        subject: "Confirm your email for Reliquary",
        preheader: "Your code to confirm this address and finish making your Reliquary account.",
        title: "Confirm your email",
        body: [
          p("Enter this code on the sign-in page to confirm this address and finish making your Reliquary account. It works once, within 10 minutes."),
          code("{{ .Token }}"),
          p("Or confirm and sign in on the device you're reading this on:"),
          button(confirm("email"), "Confirm and sign in"),
          raw(confirm("email")),
        ],
        didntAsk: "If you didn't ask for a Reliquary account, ignore this email. Nothing changes: the account stays unconfirmed and can't be used without this code or link.",
        sentBy: SENT_BY,
      }),
  },
  {
    id: "invite-user",
    name: "Invite user",
    section: "Templates",
    gotrue: "INVITE",
    subject: "You have a Reliquary account",
    when: "The person who runs the site makes an account for you with Supabase's Invite user.",
    vars: ["TokenHash", "SiteURL", "Email"],
    link: confirm("email"),
    html: () =>
      layout({
        subject: "You have a Reliquary account",
        preheader: "An account was made for you on Reliquary. Sign in to start.",
        title: "You have a Reliquary account",
        body: [
          p("The person who runs Reliquary at {{ .SiteURL }} made an account for {{ .Email }}. Sign in to start: vaults you're invited to show up on your Home page."),
          button(confirm("email"), "Sign in"),
          raw(confirm("email")),
          p("The link works once. After that, sign in at {{ .SiteURL }}/signin with this address: Reliquary emails you a code each time. There's no password."),
        ],
        didntAsk: "If you weren't expecting this, ignore this email. Nothing happens unless you sign in.",
        sentBy: SENT_BY,
      }),
  },
  {
    id: "change-email",
    name: "Change email address",
    section: "Templates",
    gotrue: "EMAIL_CHANGE",
    subject: "Confirm the new email address for your Reliquary account",
    when: "Someone asks to change an account's email address.",
    vars: ["TokenHash", "SiteURL", "Email", "NewEmail"],
    link: confirm("email_change"),
    html: () =>
      layout({
        subject: "Confirm the new email address for your Reliquary account",
        preheader: "Confirm the change of your Reliquary account's email address.",
        title: "Confirm the change of email address",
        body: [
          p("Someone asked to change the email address of a Reliquary account from <strong>{{ .Email }}</strong> to <strong>{{ .NewEmail }}</strong>."),
          p("To confirm, open the link below. If an email like this one also went to the other address, confirm that one too: the change happens once both are confirmed."),
          button(confirm("email_change"), "Confirm the change"),
          raw(confirm("email_change")),
        ],
        didntAsk: "If you didn't ask for this, ignore this email. Nothing changes: the account keeps {{ .Email }}.",
        sentBy: SENT_BY,
      }),
  },
  {
    id: "reset-password",
    name: "Reset password",
    section: "Templates",
    gotrue: "RECOVERY",
    subject: "Reliquary has no password to reset",
    when: "Someone asks Supabase Auth to reset a password. Reliquary has none, so the email explains that and signs you in instead.",
    vars: ["TokenHash", "SiteURL", "Email"],
    link: confirm("email"),
    html: () =>
      layout({
        subject: "Reliquary has no password to reset",
        preheader: "Reliquary signs you in with a code by email. There's no password.",
        title: "There's no password to reset",
        body: [
          p("Someone asked to reset the password of the Reliquary account for {{ .Email }}. Reliquary doesn't use passwords: each time you sign in, it emails a code to this address."),
          p("To sign in now, on the device you're reading this on:"),
          button(confirm("email"), "Sign in"),
          raw(confirm("email")),
          p("The link works once. Later, sign in at {{ .SiteURL }}/signin with this address."),
        ],
        didntAsk: "If you didn't ask for this, ignore this email. Nothing changes, and no one can sign in without this link.",
        sentBy: SENT_BY,
      }),
  },
  {
    id: "reauthentication",
    name: "Reauthentication",
    section: "Templates",
    gotrue: "REAUTHENTICATION",
    subject: "Your Reliquary confirmation code",
    when: "Someone signed in to the account asks to change how it signs in, which needs a fresh code.",
    vars: ["Token", "SiteURL", "Email"],
    html: () =>
      layout({
        subject: "Your Reliquary confirmation code",
        preheader: "Your code to confirm a change to how you sign in to Reliquary.",
        title: "Confirm it's you",
        body: [
          p("Enter this code to confirm a change to how you sign in to Reliquary. Use it only where you just asked for that change."),
          code("{{ .Token }}"),
          p("No one from Reliquary will ever ask you for this code by email, chat or phone."),
        ],
        didntAsk: "If you didn't ask for this, ignore this email. Nothing changes without the code.",
        sentBy: SENT_BY,
      }),
  },
  notification({
    id: "password-changed",
    name: "Password changed",
    gotrue: "PASSWORD_CHANGED_NOTIFICATION",
    notify: "PASSWORD_CHANGED",
    subject: "The password of your Reliquary account was changed",
    title: "Your password was changed",
    what: "The password of the Reliquary account {{ .Email }} was changed. Reliquary signs you in by email code, so this password is only used by tools that talk to its sign-in service directly.",
    vars: ["SiteURL", "Email"],
  }),
  notification({
    id: "email-changed",
    name: "Email address changed",
    gotrue: "EMAIL_CHANGED_NOTIFICATION",
    notify: "EMAIL_CHANGED",
    subject: "The email address of your Reliquary account was changed",
    title: "Your email address was changed",
    what: "The email address of your Reliquary account changed from <strong>{{ .OldEmail }}</strong> to <strong>{{ .Email }}</strong>. From now on, sign-in codes go to {{ .Email }}.",
    vars: ["SiteURL", "Email", "OldEmail"],
  }),
  notification({
    id: "phone-changed",
    name: "Phone number changed",
    gotrue: "PHONE_CHANGED_NOTIFICATION",
    notify: "PHONE_CHANGED",
    subject: "The phone number of your Reliquary account was changed",
    title: "Your phone number was changed",
    what: "The phone number of the Reliquary account {{ .Email }} was changed to {{ .Phone }}.",
    vars: ["SiteURL", "Email", "Phone"],
  }),
  notification({
    id: "identity-linked",
    name: "Sign-in method linked",
    gotrue: "IDENTITY_LINKED_NOTIFICATION",
    notify: "IDENTITY_LINKED",
    subject: "A sign-in method was added to your Reliquary account",
    title: "A sign-in method was added",
    what: "A new way to sign in ({{ .Provider }}) was added to the Reliquary account {{ .Email }}.",
    vars: ["SiteURL", "Email", "Provider"],
  }),
  notification({
    id: "identity-unlinked",
    name: "Sign-in method removed",
    gotrue: "IDENTITY_UNLINKED_NOTIFICATION",
    notify: "IDENTITY_UNLINKED",
    subject: "A sign-in method was removed from your Reliquary account",
    title: "A sign-in method was removed",
    what: "A way to sign in ({{ .Provider }}) was removed from the Reliquary account {{ .Email }}.",
    vars: ["SiteURL", "Email", "Provider"],
  }),
  notification({
    id: "mfa-added",
    name: "Verification method added",
    gotrue: "MFA_FACTOR_ENROLLED_NOTIFICATION",
    notify: "MFA_FACTOR_ENROLLED",
    subject: "A second sign-in step was added to your Reliquary account",
    title: "A second sign-in step was added",
    what: "A second sign-in step ({{ .FactorType }}) was added to the Reliquary account {{ .Email }}.",
    vars: ["SiteURL", "Email", "FactorType"],
  }),
  notification({
    id: "mfa-removed",
    name: "Verification method removed",
    gotrue: "MFA_FACTOR_UNENROLLED_NOTIFICATION",
    notify: "MFA_FACTOR_UNENROLLED",
    subject: "A second sign-in step was removed from your Reliquary account",
    title: "A second sign-in step was removed",
    what: "A second sign-in step ({{ .FactorType }}) was removed from the Reliquary account {{ .Email }}.",
    vars: ["SiteURL", "Email", "FactorType"],
  }),
  {
    id: "vault-invite",
    name: "Vault invite",
    section: "Reliquary",
    subject: "You're invited to {{ .VaultName }} on Reliquary",
    when: "A vault owner invites you (not sent yet: the owner copies the link from the Members page).",
    vars: ["VaultName", "Role", "InviteURL", "ExpiresAt", "SiteURL", "Email"],
    link: "{{ .InviteURL }}",
    html: () =>
      layout({
        subject: "You're invited to {{ .VaultName }} on Reliquary",
        preheader: "You're invited to join the vault {{ .VaultName }} on Reliquary.",
        title: "You're invited to a vault",
        body: [
          p("You're invited to join the vault <strong>{{ .VaultName }}</strong> on Reliquary."),
          facts([
            ["Vault", "{{ .VaultName }}"],
            ["Role", "{{ .Role }}"],
            ["For", "{{ .Email }}"],
            ["Until", "{{ .ExpiresAt }}"],
          ]),
          p("Open the invite and sign in with {{ .Email }}. It works once, only for that address."),
          button("{{ .InviteURL }}", "Open the invite"),
          raw("{{ .InviteURL }}"),
        ],
        didntAsk: "If you weren't expecting this, ignore this email. Nothing changes unless you open the invite and sign in.",
        sentBy: "Sent by Reliquary at {{ .SiteURL }} on behalf of a vault owner, to {{ .Email }}.",
      }),
  },
];

function notification(n) {
  return {
    id: n.id,
    name: n.name,
    section: "Security notifications",
    gotrue: n.gotrue,
    notify: n.notify,
    subject: n.subject,
    when: "Only when turned on, after that change to an account.",
    vars: n.vars,
    html: () =>
      layout({
        subject: n.subject,
        preheader: n.title + ".",
        title: n.title,
        body: [p(n.what)],
        didntAsk: NOT_YOU,
        sentBy: SENT_BY,
      }),
  };
}

// Rendering with values (tests, the preview, and the app's vault invite) ------

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

// Replaces each {{ .Name }} with its value, escaped. An unknown name throws,
// so a typo never ships as a literal "{{ .Nmae }}".
export function render(template, values) {
  return template.replace(/\{\{ \.([A-Za-z]+) \}\}/g, (_, k) => {
    if (!(k in values)) throw new Error(`no value for {{ .${k} }}`);
    return escapeHtml(values[k]);
  });
}

export const SAMPLE = {
  SiteURL: "https://app.reliquary.example",
  Email: "sam@example.com",
  NewEmail: "sam.new@example.com",
  OldEmail: "sam.old@example.com",
  Token: "402918",
  TokenHash: "pkce_3f1a9c0d2b7e4f6a8c1d3e5f7a9b0c2d4e6f8a1b3c5d7e9f0a2b4c6d",
  Phone: "+1 555 0100",
  Provider: "github",
  FactorType: "totp",
  VaultName: "Acme handbook",
  Role: "editor",
  InviteURL: "https://app.reliquary.example/invite?token=rli_0000000000000000000000000000000000000000000000000000000000000000",
  ExpiresAt: "3 October 2026, 14:00 UTC",
};

// Files --------------------------------------------------------------------------

const HEADER = (t) => `<!-- Reliquary email: ${t.id} (${t.section === "Reliquary" ? "sent by the web app" : `Supabase Auth, ${t.section}, ${t.name}`}). Generated by web/emails/build.mjs; edit that, then run it. -->\n`;

export function outputs() {
  const files = new Map();
  for (const t of TEMPLATES) files.set(`${t.id}.html`, t.html().replace("<head>\n", `<head>\n${HEADER(t)}`));
  const rows = TEMPLATES.map((t) => [t.id, `${t.id}.html`, t.section, t.name, t.gotrue ?? "-", t.notify ?? "-", t.subject].join("\t"));
  files.set("manifest.tsv", ["# id\tfile\tdashboard section\tdashboard name\tgotrue key\tnotification\tsubject", ...rows].join("\n") + "\n");
  return files;
}

function preview(out) {
  const cards = TEMPLATES.map((t) => {
    const values = { ...SAMPLE };
    const html = render(t.html(), values);
    return `<section>
<h2>${escapeHtml(t.name)} <small>${escapeHtml(t.section === "Reliquary" ? "Reliquary (not sent yet)" : `Supabase: ${t.section}`)} &middot; web/emails/${t.id}.html</small></h2>
<p class="subject">Subject: <strong>${escapeHtml(render(t.subject, values))}</strong></p>
<p class="when">${escapeHtml(t.when)}</p>
<div class="pair">
<iframe title="${escapeHtml(t.name)}, light" srcdoc="${escapeHtml(html.replace("@media (prefers-color-scheme: dark) {", "@media not all {"))}"></iframe>
<iframe title="${escapeHtml(t.name)}, dark" class="dark" srcdoc="${escapeHtml(html.replace("<head>", '<head><style>:root{color-scheme:dark}</style>').replace(/@media \(prefers-color-scheme: dark\) \{/, "@media all {"))}"></iframe>
</div>
</section>`;
  }).join("\n");
  writeFileSync(
    out,
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reliquary emails</title>
<style>
:root{--bg:#f7f6f5;--fg:#1c1917;--muted:#5c5652;--border:#e2dfdc}
@media (prefers-color-scheme: dark){:root{--bg:#141312;--fg:#edebe9;--muted:#a8a19c;--border:#34302e}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 ${FONT}}
main{max-width:1240px;margin:0 auto}
h1{font-size:24px;margin:0 0 4px}
h2{font-size:18px;margin:32px 0 4px}
small{font-weight:400;color:var(--muted);font-size:13px}
.subject,.when{margin:0 0 4px}.when{color:var(--muted)}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:8px}
iframe{width:100%;height:640px;border:1px solid var(--border);background:#fff}
iframe.dark{background:#141312}
@media (max-width:800px){.pair{grid-template-columns:1fr}}
</style></head>
<body><main>
<h1>Reliquary emails</h1>
<p class="when">Every email, with sample values: light on the left, dark on the right (as mail apps that follow the system's dark mode show it). Source: web/emails/build.mjs.</p>
${cards}
</main></body></html>
`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === "--preview") {
    preview(process.argv[3] ?? "email-preview.html");
  } else {
    let stale = [];
    for (const [name, content] of outputs()) {
      const path = DIR + name;
      let now = "";
      try {
        now = readFileSync(path, "utf8");
      } catch {
        now = "";
      }
      if (now === content) continue;
      if (arg === "--check") stale.push(name);
      else writeFileSync(path, content);
    }
    if (stale.length) {
      console.error(`web/emails is out of date (${stale.join(", ")}): run node emails/build.mjs in web/`);
      process.exit(1);
    }
  }
}
