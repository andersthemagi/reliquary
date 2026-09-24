// Legal and trust pages: terms, privacy, data processing, sub-processors,
// security. Drafts for a small EU-based service run by Red Mage, each marked
// "Draft, pending legal review". Facts come from docs/design.md (privacy,
// compliance, variables) and docs/research/hosting.md (where things run);
// anything not known yet is an OPERATOR field shown as a placeholder.
//
// publicRoute() answers the public URLs that need no session: these pages,
// robots.txt, sitemap.xml and security.txt. The landing page at `/` is not
// here: `/` is Home for a signed-in person, so server.ts decides.

import { html, type Raw, type Theme } from "./html.js";
import { OPERATOR, draftNote, fill, requestAccessHref, robotsTxt, securityTxt, sitePage, sitemapXml } from "./site.js";

const mail = (addr: string) => html`<a href="mailto:${addr}">${addr}</a>`;

function legalPage(theme: Theme, path: string, title: string, description: string, body: Raw): string {
  return sitePage({
    title,
    description,
    path,
    theme,
    body: html`<article class="legal">
  <p class="crumb"><a href="/">Reliquary</a></p>
  <h1>${title}</h1>
  ${draftNote()}
  ${body}
</article>`,
  });
}

const operatorBlock = () => html`<p>Reliquary is run by ${OPERATOR.tradingName} (${OPERATOR.person}): ${fill("legalName", "legal name")}, ${fill("legalForm", "legal form")}, registered in ${fill("country", "country")} under ${fill("registrationNumber", "registration number")}, VAT ${fill("vatId", "VAT ID")}, ${fill("address", "address")}. Contact: ${mail(OPERATOR.contactEmail)}.</p>`;

// Terms ---------------------------------------------------------------------

function terms(theme: Theme): string {
  return legalPage(theme, "/terms", "Terms of service", "The terms for using Reliquary by Red Mage during its beta.", html`
<h2>Who we are</h2>
${operatorBlock()}
<p>"We" means ${OPERATOR.tradingName}. "You" means the person or organisation that uses Reliquary, and "your team" the people you invite. These terms apply to the hosted service at ${OPERATOR.defaultOrigin.replace("https://", "")} and its MCP endpoint.</p>

<h2>The service</h2>
<p>Reliquary holds shared context (files, proposals, comments, an activity log) and environment variables for your team and the AI tools you connect. It runs no AI model: the tools you connect are yours, under your own agreements with their providers.</p>
<p>Reliquary is in beta. Features change, and we may make mistakes. Access is by invitation.</p>

<h2>Your account and your team</h2>
<ul>
  <li>Keep your sign-in email secure. You're responsible for what happens under your account, including what the agents you connect do with your permissions.</li>
  <li>A vault's owners decide who is a member and what each member and their agents may do. Owners are responsible for inviting only people entitled to see the vault's content.</li>
  <li>Revoke tokens and connections you no longer use.</li>
</ul>

<h2>Your content</h2>
<p>What you put in Reliquary stays yours. You give us permission to store, process and display it only to run the service for you. We don't use it to train models, sell it, or read it, unless you ask us to (for support) or the law requires it. The <a href="/dpa">data processing terms</a> apply to personal data in your content.</p>
<p>You're responsible for having the right to put content and credentials in Reliquary, including your clients' credentials.</p>

<h2>Acceptable use</h2>
<p>Don't use Reliquary to break the law, to store content you have no right to, to attack or probe the service or other customers (except under our <a href="/security#disclosure">disclosure policy</a>), or to get around its limits. Don't store health data or payment card data: Reliquary isn't built or certified for them.</p>

<h2>Fees</h2>
<p>Reliquary is free while in beta. Before any fee applies to you, we'll tell you the price and give you ${fill("feeNoticeDays", "notice period")} to decide; you can export and leave at any time.</p>

<h2>Leaving, suspension and deletion</h2>
<ul>
  <li>You can export a vault and delete it whenever you like. Deletion is immediate; backups age out as the <a href="/privacy">privacy policy</a> says.</li>
  <li>We may suspend access that breaks these terms or puts the service or other customers at risk. Where we can, we'll tell you first and give you the chance to export.</li>
  <li>If we ever close Reliquary, we'll give you ${fill("closureNotice", "notice period")} and a way to export first.</li>
</ul>

<h2>No warranty</h2>
<p>During the beta the service is provided as it is, without warranties of availability or fitness for a purpose, to the extent the law allows. Keep your own copy of anything you can't lose; export makes that easy.</p>

<h2>Liability</h2>
<p>Nothing in these terms limits liability that the law doesn't allow to be limited. Otherwise, each side's total liability is limited to ${fill("liabilityCap", "liability cap")}, and neither side is liable for indirect or consequential loss.</p>

<h2>Changes</h2>
<p>We'll post changes to these terms here and tell account holders by email before significant changes take effect.</p>

<h2>Law</h2>
<p>These terms are governed by ${fill("governingLaw", "governing law and courts")}. If you're a consumer, you keep the protection of the mandatory law where you live.</p>

<h2>Contact</h2>
<p>${mail(OPERATOR.contactEmail)}</p>`);
}

// Privacy -------------------------------------------------------------------

const COOKIES: Array<[string, string]> = [
  ["rlq_at, rlq_rt", "Your signed-in session (an access token and a refresh token). Up to 30 days."],
  ["rlq_pre", "Protects the sign-in form while you sign in. One hour."],
  ["rlq_flash", "Carries a one-line message to the next page. Five minutes at most."],
  ["rlq_theme", "Your light or dark choice, if you made one. One year."],
];

function privacy(theme: Theme): string {
  return legalPage(theme, "/privacy", "Privacy policy", "What personal data Reliquary by Red Mage holds, why, where, for how long, and your rights.", html`
<h2>Who we are</h2>
${operatorBlock()}
<p>For your account (your email and sign-in), we are the controller. For what you and your team put in a vault, the vault's owner is the controller and we are their processor under the <a href="/dpa">data processing terms</a>.</p>

<h2>What we hold</h2>
<ul>
  <li><strong>Account:</strong> your email address and an account id, and the vaults you belong to with your role.</li>
  <li><strong>Vault content:</strong> files and their versions, proposals, approvals, comments and notes, which can include personal data your team writes.</li>
  <li><strong>Variables:</strong> names and encrypted values, and who may use them.</li>
  <li><strong>Activity:</strong> the vault's activity log and the variables access log: who (and which agent or client) did what, when. These are part of the product and you can see them.</li>
  <li><strong>Connections:</strong> the AI tools and tokens you authorised, when they were last used, and the client's name.</li>
  <li><strong>Technical logs:</strong> our server logs the method, path and response status of each request, never tokens, codes or content. Our hosting provider keeps request logs, including IP addresses, for ${fill("hostingLogRetention", "host log retention")}.</li>
</ul>

<h2>What we don't do</h2>
<ul>
  <li>No analytics, advertising or tracking cookies, and no third-party scripts.</li>
  <li>We don't train models on your data, sell it or share it beyond the <a href="/subprocessors">listed sub-processors</a>.</li>
  <li>Nobody at ${OPERATOR.tradingName} reads your content unless you ask us to (for support) or the law requires it.</li>
</ul>

<h2>Why, and on what basis</h2>
<ul>
  <li>To run the service you signed up for: performance of a contract.</li>
  <li>To keep it secure and fix faults (server logs, access logs, refused attempts): our legitimate interest in a secure service.</li>
  <li>To tell you about changes that affect you: contract and legitimate interest. No marketing email without your consent.</li>
</ul>

<h2>Cookies</h2>
<p>Only cookies the service needs to work, so no consent banner:</p>
<div class="table-wrap"><table>
  <thead><tr><th scope="col">Cookie</th><th scope="col">What it's for, and for how long</th></tr></thead>
  <tbody>${COOKIES.map(([n, d]) => html`<tr><td><code>${n}</code></td><td>${d}</td></tr>`)}</tbody>
</table></div>

<h2>Where it's stored, and who processes it</h2>
<p>The database is in the EU (Frankfurt), and the app runs in Frankfurt. Some providers are US companies whose networks and logs are global; the <a href="/subprocessors">sub-processor list</a> names each one, what it does and where.</p>
<p>AI tools you connect (Claude, ChatGPT, Cursor and others) receive what their agent reads through your account. They are not our sub-processors: you choose them, and they process that data under your agreement with them.</p>

<h2>How long we keep it</h2>
<ul>
  <li>Account data: while you have an account, and deleted when you ask us to close it.</li>
  <li>Vault content: until an owner erases it or deletes the vault. Erasing a file blanks every version at once; deleting a vault removes everything in it at once, keeping only who deleted it, when, and counts.</li>
  <li>The activity log is append-only: it keeps the fact that something happened, but erased content is gone from it.</li>
  <li>Database backups keep deleted data until they age out, after ${fill("backupRetention", "backup retention")}.</li>
</ul>

<h2>Your rights</h2>
<p>You can ask for access to, correction of, or deletion of your personal data, ask us to restrict or stop processing it, and take it with you (vault owners can export a vault themselves). Email ${mail(OPERATOR.contactEmail)}. For data in a vault, we'll pass your request to the vault's owner, who decides as controller. You can also complain to a data protection authority; ours is ${fill("supervisoryAuthority", "supervisory authority")}.</p>

<h2>Security and breaches</h2>
<p>See the <a href="/security">security page</a>. If a breach affects your personal data, we'll tell the vault owners and, where required, the authority within 72 hours of becoming aware of it.</p>

<h2>Children</h2>
<p>Reliquary is a work tool, not meant for anyone under ${fill("minimumAge", "minimum age")}.</p>

<h2>Changes</h2>
<p>We'll post changes here with a new date, and email account holders about significant ones.</p>`);
}

// Data processing -------------------------------------------------------------

function dpa(theme: Theme): string {
  return legalPage(theme, "/dpa", "Data processing", "A summary of how Reliquary by Red Mage processes personal data for its customers, as processor under GDPR Article 28.", html`
<p class="lede">A plain summary of the data processing terms that apply when your vault holds personal data. To sign a data processing agreement, email ${mail(OPERATOR.contactEmail)}.</p>

<h2>Roles</h2>
<p>The vault's owner (you) is the controller. ${OPERATOR.tradingName} is the processor.</p>
${operatorBlock()}

<h2>What we process, and why</h2>
<div class="table-wrap"><table>
  <tbody>
    <tr><th scope="row">Subject matter</th><td>Hosting and serving your vaults: context, proposals, logs and environment variables</td></tr>
    <tr><th scope="row">Duration</th><td>While you use Reliquary, until the data is erased or the vault deleted</td></tr>
    <tr><th scope="row">Purpose</th><td>Only to provide the service to you and your team, on your instructions (what you and your members do in the product is the instruction)</td></tr>
    <tr><th scope="row">Categories of data</th><td>Whatever you put in: typically names, email addresses and work details of your members and of people mentioned in your content; credentials in variables</td></tr>
    <tr><th scope="row">Data subjects</th><td>Your members, and people your content is about (clients, contacts, colleagues)</td></tr>
    <tr><th scope="row">Special categories</th><td>Not allowed: don't store health, biometric or similar data</td></tr>
  </tbody>
</table></div>

<h2>What we commit to</h2>
<ul>
  <li>Process your data only on your documented instructions, and tell you if we believe an instruction breaks the law.</li>
  <li>Keep it confidential: only ${OPERATOR.tradingName} has operator access, and uses it only to run and support the service.</li>
  <li>Keep the security measures on the <a href="/security">security page</a> in place.</li>
  <li>Use only the <a href="/subprocessors">listed sub-processors</a>, with data protection terms at least as protective as these, and tell you ${fill("subprocessorNoticeDays", "notice period")} before adding or replacing one, so you can object.</li>
  <li>Help you answer your data subjects' requests: export, erasure of a file, deletion of a vault.</li>
  <li>Tell you without undue delay, and within 72 hours of becoming aware, of a personal data breach affecting your data, with what we know.</li>
  <li>At the end, let you export, then delete your data; backups age out after ${fill("backupRetention", "backup retention")}.</li>
  <li>Give you the information you need to show compliance, and answer reasonable audit questions in writing.</li>
</ul>

<h2>Transfers outside the EU</h2>
<p>The database and app run in the EU. Where a sub-processor may access data from outside the EU, the transfer relies on ${fill("transferSafeguard", "transfer safeguard, e.g. the provider's Standard Contractual Clauses")}. The <a href="/subprocessors">sub-processor list</a> names each provider and its location.</p>`);
}

// Sub-processors ----------------------------------------------------------------

type Sub = { name: string; what: string; where: string; data: string; link?: [string, string] };
const SUBPROCESSORS: Sub[] = [
  {
    name: "Supabase",
    what: "Database and sign-in (authentication)",
    where: "EU: AWS Frankfurt (eu-central-1)",
    data: "All vault content, encrypted variable values, account emails",
    link: ["https://supabase.com/privacy", "Supabase privacy policy"],
  },
  {
    name: "Vercel",
    what: "Hosting and CDN for the web app and MCP endpoint",
    where: "Functions in Frankfurt (fra1); CDN and request logs global (US company)",
    data: "Requests in transit, request logs with IP addresses",
    link: ["https://vercel.com/legal/privacy-policy", "Vercel privacy policy"],
  },
];

function subprocessors(theme: Theme): string {
  return legalPage(theme, "/subprocessors", "Sub-processors", "The companies that process data for Reliquary by Red Mage, what each does and where.", html`
<p class="lede">The companies that process your data so Reliquary can run.</p>
<div class="table-wrap"><table class="subprocessors">
  <thead><tr><th scope="col">Provider</th><th scope="col">What it does</th><th scope="col">Where</th><th scope="col">Data</th></tr></thead>
  <tbody>
    ${SUBPROCESSORS.map(
      (s) => html`<tr><td><strong>${s.name}</strong>${s.link ? html`<br><a href="${s.link[0]}">${s.link[1]}</a>` : ""}</td><td data-label="What it does">${s.what}</td><td data-label="Where">${s.where}</td><td data-label="Data">${s.data}</td></tr>`,
    )}
    <tr><td><strong>Email provider</strong></td><td data-label="What it does">Sending sign-in codes and invitations</td><td colspan="2" data-label="Where and data"><mark class="placeholder">[to be added: provider, location and data (email addresses, message content)]</mark></td></tr>
    <tr><td><strong>Payment provider</strong></td><td data-label="What it does">Billing, once plans are paid</td><td colspan="2" data-label="Where and data">None yet: nothing is billed during the beta. Added here before billing starts.</td></tr>
  </tbody>
</table></div>

<h2>Model providers: none</h2>
<p>Reliquary runs no AI model and sends your content to no model provider. The AI tools you connect (Claude, ChatGPT, Cursor and others) receive what their agent reads through your account, under your own agreement with their provider. They are your choice, not our sub-processors.</p>

<h2>Changes</h2>
<p>We update this page and tell vault owners ${fill("subprocessorNoticeDays", "notice period")} before adding or replacing a sub-processor. To object, email ${mail(OPERATOR.contactEmail)}.</p>`);
}

// Security ------------------------------------------------------------------------

function security(theme: Theme): string {
  return legalPage(theme, "/security", "Security", "How Reliquary by Red Mage protects vaults: access enforced in the database, hostile tests on every push, encrypted variables, EU hosting, and what we can't promise.", html`
<p class="lede">What protects your vaults, what doesn't, and how to report a problem.</p>

<h2>The database enforces access</h2>
<p>Every permission is a Postgres row-level security policy or trigger, not a check in the app that a bug could skip. Among them:</p>
<ul>
  <li>A member of one vault sees no trace of another.</li>
  <li>Canon files change only through a proposal that a quorum of people approves.</li>
  <li>An agent acts as its person, minus a ceiling: it can't approve, set rules, manage members, reveal a variable's value, erase a file, or export or delete a vault. Those need the person, signed in.</li>
  <li>The activity log and the variables access log are append-only: nobody, us included, edits or deletes a row, except by deleting a whole vault.</li>
</ul>

<h2>Tested on every push</h2>
<p>Each of those rules has a hostile test that tries to break it, for example a session for one vault reading another, an agent approving a proposal, anyone editing a log row, an agent revealing a variable. The whole suite runs on every push and pull request.</p>

<h2>Variables</h2>
<ul>
  <li>Values are encrypted by the web app with AES-256-GCM, under a key kept outside the database. The database only ever holds ciphertext.</li>
  <li>Ciphertext leaves the database only through one function that checks the person's grant and writes the access log in the same transaction.</li>
  <li>No MCP tool returns a value. Values reach a machine only through <code>reliquary run</code> (into one process) or <code>reliquary env pull</code> (into a gitignored <code>.env</code>).</li>
  <li>Every read, reveal, change and refused attempt is in the access log.</li>
</ul>

<h2>Sign-in and the web app</h2>
<ul>
  <li>Sign-in by emailed code or link; sessions in HttpOnly, Secure cookies.</li>
  <li>No client-side script at all: the content security policy forbids scripts, and every form carries a token and must come from Reliquary's own pages.</li>
  <li>AI tools connect with OAuth or with scoped, expiring tokens you can revoke.</li>
  <li>Content written by agents is shown and served as quoted data, never as instructions.</li>
</ul>

<h2>Hosting</h2>
<p>The database is in the EU (Frankfurt), and the app runs in Frankfurt. See the <a href="/subprocessors">sub-processors</a>. Backups: ${fill("backupRetention", "backup schedule and retention")}.</p>

<h2>What we can't promise</h2>
<ul class="caveats">
  <li><strong>Agents can read what reaches them.</strong> An agent that can run commands in a process holding a variable can read that variable. <code>reliquary run</code> limits exposure to one process; it doesn't stop that process. Prefer scoped, short-lived credentials where your provider offers them.</li>
  <li><strong>The operator can decrypt.</strong> Someone with both the database and the web app's key, which means us as the operator, could technically decrypt variable values. We don't, and our access is limited to running the service. Client-side encryption, where only your members hold keys, is a later feature.</li>
  <li><strong>No certification yet.</strong> Reliquary has no SOC 2 report or ISO certificate, and no SSO. It is built and run by one person. We list the controls we have rather than claim a standard.</li>
</ul>

<h2 id="disclosure">Reporting a vulnerability</h2>
<p>Email ${mail(OPERATOR.securityEmail)} with what you found and how to reproduce it. We'll acknowledge it within ${fill("disclosureResponse", "response time")}, keep you updated, and credit you if you'd like. Please test only against your own account and vaults, don't access other people's data, and give us reasonable time to fix before you publish. We won't take action against good-faith research that follows these rules.</p>
<p class="muted small">Also at <a href="/.well-known/security.txt">/.well-known/security.txt</a>. Questions about security for your team: <a href="${requestAccessHref()}">get in touch</a>.</p>`);
}

// Dispatch ---------------------------------------------------------------------

export type PublicReply = { type: string; body: string };

const PAGES: Record<string, (t: Theme) => string> = {
  "/terms": terms,
  "/privacy": privacy,
  "/dpa": dpa,
  "/subprocessors": subprocessors,
  "/security": security,
};

export function publicRoute(path: string, theme: Theme): PublicReply | undefined {
  const pageFor = PAGES[path];
  if (pageFor) return { type: "text/html; charset=utf-8", body: pageFor(theme) };
  if (path === "/robots.txt") return { type: "text/plain; charset=utf-8", body: robotsTxt() };
  if (path === "/sitemap.xml") return { type: "application/xml; charset=utf-8", body: sitemapXml() };
  if (path === "/.well-known/security.txt") return { type: "text/plain; charset=utf-8", body: securityTxt() };
  return undefined;
}
