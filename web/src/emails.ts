// The email templates in web/emails/ (written by web/emails/build.mjs, the
// one source): Supabase Auth's, which the self-hosted instance serves to its
// Auth server (selfhost.ts) and the hosted owner pastes into the Supabase
// dashboard (scripts/email-templates.sh), and Reliquary's own vault invite,
// rendered here for deliverInvite() (invites.ts), which sends it through
// Resend (mailer.ts).
//
// Files are read on first use, never at import. The hosted app on Vercel
// reads only vault-invite.html and manifest.tsv (vercel.json's includeFiles).

import { readFileSync } from "node:fs";

const DIR = new URL("../emails/", import.meta.url);

export type EmailTemplate = {
  id: string; // file name without .html
  section: string; // "Templates" or "Security notifications" (Supabase), or "Reliquary"
  name: string; // the template's name in the Supabase dashboard
  gotrue: string | undefined; // GOTRUE_MAILER_TEMPLATES_<gotrue>
  notification: string | undefined; // GOTRUE_MAILER_NOTIFICATIONS_<notification>_ENABLED
  subject: string;
};

let manifest: EmailTemplate[] | undefined;
const bodies = new Map<string, string>();

export function emailTemplates(): EmailTemplate[] {
  if (!manifest) {
    manifest = readFileSync(new URL("manifest.tsv", DIR), "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const [id, , section, name, gotrue, notification, subject] = l.split("\t");
        return { id, section, name, gotrue: gotrue === "-" ? undefined : gotrue, notification: notification === "-" ? undefined : notification, subject };
      });
  }
  return manifest;
}

// A template's HTML, as written: Go template placeholders and all.
export function emailHtml(id: string): string | undefined {
  if (!/^[a-z-]+$/.test(id) || !emailTemplates().some((t) => t.id === id)) return undefined;
  let b = bodies.get(id);
  if (b === undefined) {
    b = readFileSync(new URL(`${id}.html`, DIR), "utf8");
    bodies.set(id, b);
  }
  return b;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

// {{ .Name }} -> its value, escaped. A placeholder without a value throws, so
// nothing is sent with a literal "{{ .Name }}" in it.
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{ \.([A-Za-z]+) \}\}/g, (_, k: string) => {
    if (!Object.hasOwn(values, k)) throw new Error(`email template: no value for {{ .${k} }}`);
    return escape(values[k]);
  });
}

// The vault invite email, for deliverInvite() (invites.ts). The link is a
// bearer secret: whatever sends this must never log it.
export function vaultInviteEmail(
  mail: { to: string; link: string; vaultName: string; role: string; expiresAt: Date },
  siteUrl: string,
): { subject: string; html: string } {
  const t = emailTemplates().find((x) => x.id === "vault-invite");
  const html = emailHtml("vault-invite");
  if (!t || !html) throw new Error("email template: web/emails/vault-invite.html is missing");
  const values = {
    VaultName: mail.vaultName,
    Role: mail.role,
    InviteURL: mail.link,
    ExpiresAt: mail.expiresAt.toUTCString().replace(/:\d\d GMT$/, " UTC"),
    Email: mail.to,
    SiteURL: siteUrl,
  };
  // The subject is plain text: fill it, then undo the HTML escaping.
  const subject = fill(t.subject, values).replace(/&(amp|lt|gt|quot|#39);/g, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[m]!);
  return { subject, html: fill(html.replace(/<!-- Reliquary email:[^\n]*-->\n/, ""), values) };
}
