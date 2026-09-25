// Self-hosting (SELF_HOSTED=1, deploy/compose): what the web app serves only
// there.
//
// Email templates for the self-hosted Supabase Auth server. On Supabase's
// hosted service the owner pastes them into the dashboard (web/README.md,
// "Supabase dashboard"); the standalone Auth server instead fetches each
// template from a URL (GOTRUE_MAILER_TEMPLATES_MAGIC_LINK and
// GOTRUE_MAILER_TEMPLATES_CONFIRMATION), and deploy/compose points those at
// this app on the private network. Both carry the 6-digit code and a link to
// /auth/confirm with the token hash (never Auth's own ConfirmationURL, which
// returns tokens in a URL fragment a server can't read). A new invitee's
// first email is the confirmation one; `type=email` verifies both.
//
// They are static text with Auth's template placeholders, no secret and
// nothing from the request, and are served on no other deployment.

const SIGN_IN = `<h2>Sign in to Reliquary</h2>
<p>Your code: <strong>{{ .Token }}</strong></p>
<p>Or <a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">sign in on this device</a>.</p>
<p>If you didn't ask for this, ignore this email.</p>
`;

export const EMAIL_TEMPLATES: ReadonlyMap<string, string> = new Map([
  ["/_selfhost/email/sign-in.html", SIGN_IN],
  ["/_selfhost/email/confirm.html", SIGN_IN],
]);

export const selfHosted = (env: NodeJS.ProcessEnv = process.env): boolean => env.SELF_HOSTED === "1";

// The template at `pathname`, when this is a self-hosted instance.
export function emailTemplate(pathname: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return selfHosted(env) ? EMAIL_TEMPLATES.get(pathname) : undefined;
}
