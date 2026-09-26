// Self-hosting (SELF_HOSTED=1, deploy/compose): what the web app serves only
// there.
//
// Email templates for the self-hosted Supabase Auth server. On Supabase's
// hosted service the owner pastes the same files into the dashboard
// (scripts/email-templates.sh, web/README.md "Supabase dashboard"); the
// standalone Auth server instead fetches each template from a URL
// (GOTRUE_MAILER_TEMPLATES_<type>), and deploy/compose points those at
// /_selfhost/email/<id>.html on this app, over the private network. The
// templates are web/emails/*.html (emails.ts; written by
// web/emails/build.mjs): static text with Auth's placeholders, no secret and
// nothing from the request. Links go to this app's /auth/confirm with the
// token hash, never Auth's own ConfirmationURL (tokens in a URL fragment).
//
// Served on no other deployment, and only Supabase Auth's templates (not the
// app's own vault invite).

import { emailHtml, emailTemplates } from "./emails.js";

export const EMAIL_PATH_PREFIX = "/_selfhost/email/";

export const selfHosted = (env: NodeJS.ProcessEnv = process.env): boolean => env.SELF_HOSTED === "1";

// Every path the self-hosted app serves a template on, with the Auth type it's for.
export function emailTemplatePaths(): { path: string; gotrue: string }[] {
  return emailTemplates()
    .filter((t) => t.gotrue)
    .map((t) => ({ path: `${EMAIL_PATH_PREFIX}${t.id}.html`, gotrue: t.gotrue! }));
}

// The template at `pathname`, when this is a self-hosted instance.
export function emailTemplate(pathname: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!selfHosted(env) || !pathname.startsWith(EMAIL_PATH_PREFIX) || !pathname.endsWith(".html")) return undefined;
  const id = pathname.slice(EMAIL_PATH_PREFIX.length, -".html".length);
  const t = emailTemplates().find((x) => x.id === id);
  return t?.gotrue ? emailHtml(id) : undefined;
}
