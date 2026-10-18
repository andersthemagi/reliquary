// Legal and trust pages: terms, privacy, data processing, sub-processors,
// security, for a service run by a Colorado LLC (Red Mage), offered in the
// US and outside the EU first; a lawyer reviews them before paid plans or an
// open launch (#8). What only applies once it is offered in the EU sits in
// one marked section of the privacy policy (#315, #212), saying what is
// still to be appointed rather than showing placeholders. Facts come from
// docs/design.md (privacy, compliance, variables) and docs/research/hosting.md
// (where things run); anything not known yet is a null OPERATOR field.
//
// publicRoute() answers the public URLs that need no session: these pages,
// robots.txt, sitemap.xml and security.txt. The landing page at `/` is not
// here: `/` is Home for a signed-in person, so server.ts decides.

import { docsPaths, docsRoute } from "./docs.js";
import { appHref } from "./hosts.js";
import { ALPHA, html, type Raw, type Theme } from "./html.js";
import { BUILD } from "./version.js";
import { OPERATOR, fill, updatedNote, requestAccessHref, robotsTxt, securityTxt, sitePage, sitemapXml } from "./site.js";

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
  ${updatedNote()}
  ${body}
</article>`,
  });
}

const operatorBlock = () => html`<p>Reliquary is run by ${OPERATOR.tradingName} (${OPERATOR.person}): ${fill("legalName", "legal name")}, ${fill("legalForm", "legal form")} registered in ${fill("country", "country")} under ID ${fill("registrationNumber", "Colorado Secretary of State ID")}, ${fill("address", "address")}. Contact: ${mail(OPERATOR.contactEmail)}.</p>`;

// Terms ---------------------------------------------------------------------

function terms(theme: Theme): string {
  return legalPage(theme, "/terms", "Terms of service", "The terms for using Reliquary by Red Mage during its alpha.", html`
<h2>Who we are</h2>
${operatorBlock()}
<p>"We" means ${OPERATOR.tradingName}. "You" means the person or organisation that uses Reliquary, and "your team" the people you invite. These terms apply to the hosted service at ${OPERATOR.defaultOrigin.replace("https://", "")} and its MCP endpoint.</p>
<p>You accept these terms, and the <a href="/privacy">privacy policy</a>, by ticking the box on the sign-in page; each sign-in confirms them again.</p>

<h2>The service</h2>
<p>Reliquary holds shared context (files, proposals, comments, an activity log) and environment variables for your team and the AI tools you connect. It runs no AI model: the tools you connect are yours, under your own agreements with their providers.</p>
<p>Reliquary is an alpha. It may have bugs, be unavailable, or change or remove features without notice, and we don't promise it will become generally available. Don't rely on it as the only copy of anything, or as the only place a credential lives. If a change removes something you rely on, we'll try to tell you first, and you can always export.</p>
<p>The MCP endpoint and the CLI are covered by these terms. Each token belongs to one person's account: don't share tokens, or use several accounts to get around limits. If use through them harms the service, we may slow it or suspend it, warning you first where we can.</p>
<p>The AI tools and other services you connect aren't ours. We don't control what they do with what they read, and we're not responsible for them.</p>
<p>These terms cover only the service we host. Running Reliquary yourself is governed by its licence (the Functional Source License for the server, MIT for the CLI), and we don't operate, support or answer for a self-hosted instance.</p>

<h2>Your account and your team</h2>
<ul>
  <li>You must be at least ${fill("minimumAge", "minimum age")} and able to enter a binding contract. If you use Reliquary for an organisation, you confirm you may accept these terms for it.</li>
  <li>Reliquary is offered outside the EU, EEA, UK and Switzerland for now, and you confirm you're not there each time you sign in. You also confirm you're not in a country or region under comprehensive United States sanctions, and not on a US list of restricted parties, such as the Treasury's Specially Designated Nationals list.</li>
  <li>Keep your sign-in email secure. You're responsible for what happens under your account, including what the agents you connect do with your permissions.</li>
  <li>A vault's owners decide who is a member and what each member and their agents may do. Owners are responsible for inviting only people entitled to see the vault's content.</li>
  <li>Revoke tokens and connections you no longer use. Tell us at ${mail(OPERATOR.contactEmail)} as soon as you think someone else has used your account or one of its tokens; we may suspend an account or revoke a token we believe is compromised.</li>
</ul>

<h2>Your content</h2>
<p>What you put in Reliquary stays yours. You give us permission to store, process and display it only to run the service for you: that covers copying it to backups, indexing it for search (including the numbers search by meaning uses), and letting our <a href="/subprocessors">listed sub-processors</a> handle it for these purposes. The permission ends when the content is deleted, except in backups until they age out. We don't use your content to train models or sell it. The <a href="/dpa">data processing terms</a> apply to personal data in it.</p>
<p id="access">Nobody at ${OPERATOR.tradingName} looks at your content except to help you when you ask, to investigate a security problem, abuse or a legal notice, to fix a fault that needs it, or when the law requires it. We look at as little as we can, and tell the vault's owners unless the law or a security risk stops us.</p>
<p>You're responsible for having the right to put content and credentials in Reliquary, including your clients' credentials.</p>
<p>If you send us ideas or feedback, including through the feedback tool, we may use them freely, without paying you or owing you anything.</p>

<h2>Acceptable use</h2>
<p>Don't use Reliquary to break the law, to store content you have no right to, to attack or probe the service or other customers (except under our <a href="/security#disclosure">disclosure policy</a>), or to get around its limits. Don't store health data or payment card data: Reliquary isn't built or certified for them. Don't use Reliquary where United States sanctions or export controls forbid it.</p>
<p>We don't review content in advance. We may remove or disable content that breaks the law or these terms, and we'll tell the vault's owners when we do, unless the law stops us.</p>

<h2 id="copyright">Copyright complaints</h2>
<p>If you believe content in Reliquary infringes your copyright, send a notice to our designated agent: ${OPERATOR.person}, ${fill("legalName", "legal name")}, ${fill("address", "address")}; ${OPERATOR.copyrightAgentPhone ? html`phone ${OPERATOR.copyrightAgentPhone}; ` : ""}${mail(OPERATOR.contactEmail)}. The notice must include:</p>
<ul>
  <li>your physical or electronic signature, as the owner or someone authorised to act for them;</li>
  <li>the work you say is infringed;</li>
  <li>the content you say infringes it, and enough to find it (the vault and the file path, or a link);</li>
  <li>your name, address, phone and email;</li>
  <li>a statement that you believe in good faith the use isn't authorised by the owner, its agent or the law;</li>
  <li>a statement, under penalty of perjury, that the notice is accurate and that you're the owner or authorised to act for them.</li>
</ul>
<p>We remove or disable the content and tell the vault's owners. If you think we removed your content by mistake, send the agent a counter-notice: your signature, the content and where it was, a statement under penalty of perjury that it was removed by mistake or misidentification, and your name, address and phone, with your consent to the jurisdiction of the federal court for your address (or, outside the United States, any court where we may be found) and to accept service from the person who sent the notice. We pass it to them, and restore the content in 10 to 14 business days unless they tell us they've gone to court.</p>
<p>We close the accounts of people who infringe repeatedly. Notices are for copyright only; anything else goes to ${mail(OPERATOR.contactEmail)}.</p>

<h2>Fees</h2>
<p>Reliquary is free while in alpha. Before any fee applies to you, we'll tell you the price and give you ${fill("feeNoticeDays", "notice period")} to decide; you can export and leave at any time.</p>
<p>Your plan sets how many vaults you own, and each vault's tier how many people and how much storage it holds (<a href="/docs/concepts/plans-and-limits">Plans and limits</a>). If a plan gets smaller, nothing is deleted: a vault over a limit keeps everything and takes nothing new until it is under.</p>

<h2>Leaving, suspension and deletion</h2>
<ul>
  <li>You can export a vault and delete it whenever you like. Deletion is immediate; backups age out as the <a href="/privacy">privacy policy</a> says.</li>
  <li>You can delete your account whenever you like, on Account settings, once no vault has you as its only owner. It is immediate: you leave every vault, and what you wrote in a vault stays with that vault (<a href="/docs/how-to/delete-your-account">Delete your account</a>).</li>
  <li>We may suspend or close access that breaks these terms or puts the service or other customers at risk. Where we can, we'll tell you first and give you the chance to export, unless the breach is serious or the law stops us.</li>
  <li>If we ever close Reliquary, we'll give you ${fill("closureNotice", "notice period")} and a way to export first.</li>
  <li>The sections on your content, feedback, no warranty, liability, indemnity and law still apply after an account closes.</li>
</ul>

<h2>No warranty</h2>
<p><strong>Reliquary is provided as it is and as available, without warranties of any kind, including merchantability, fitness for a purpose and non-infringement, to the extent the law allows.</strong> Keep your own copy of anything you can't lose; export makes that easy.</p>

<h2>Liability</h2>
<p>Nothing in these terms limits liability that the law doesn't allow to be limited. Otherwise, each side's total liability is limited to ${fill("liabilityCap", "liability cap")}, and neither side is liable for indirect, incidental, special or consequential loss, or for lost profits or data.</p>

<h2>Indemnity</h2>
<p>If someone else brings a claim against us because of content you put in Reliquary or because you broke these terms, you'll cover our reasonable costs of that claim.</p>

<h2>Changes</h2>
<p>We'll post changes to these terms here and tell account holders by email at least 30 days before significant changes take effect.</p>

<h2>Law</h2>
<p>These terms are governed by ${fill("governingLaw", "governing law and courts")}. If you're a consumer, you keep the protection of the mandatory law where you live. If a court finds part of these terms unenforceable, the rest still applies.</p>
<p>Before going to court, email ${mail(OPERATOR.contactEmail)} and give us 30 days to try to settle it. Either side can still use small claims court.</p>

<h2>General</h2>
<ul>
  <li>We send notices by email to your account's address, and you agree they count as written. Legal notices to us go by email to ${mail(OPERATOR.contactEmail)} and by post to the address above.</li>
  <li>These terms, the <a href="/privacy">privacy policy</a> and the <a href="/dpa">data processing terms</a> are the whole agreement between us about Reliquary.</li>
  <li>If we don't enforce a term, we haven't given it up.</li>
  <li>We may transfer these terms to a company that takes over Reliquary; you may transfer them only with our written agreement.</li>
  <li>Neither side is responsible for delays or failures caused by things outside its reasonable control.</li>
</ul>

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
  <li><strong>Access requests:</strong> the email address, name, country and note you send with Request access. The service emails them to us and doesn't store them; we keep the email while we arrange your access.</li>
  <li><strong>Vault content:</strong> files and their versions, proposals, approvals, comments and notes, which can include personal data your team writes.</li>
  <li><strong>Variables:</strong> names and encrypted values, and who may use them.</li>
  <li><strong>Activity:</strong> the vault's activity log and the variables access log: who (and which agent or client) did what, when. These are part of the product and you can see them.</li>
  <li><strong>Connections:</strong> the AI tools and tokens you authorised, when they were last used, and the client's name.</li>
  <li><strong>Technical logs:</strong> our server logs the method, path and response status of each request, never tokens, codes or content. Our hosting provider keeps request logs, including IP addresses, for ${fill("hostingLogRetention", "host log retention")}.</li>
</ul>

<h2>What we don't do</h2>
<ul>
  <li>No analytics, advertising or tracking cookies, and no third-party scripts.</li>
  <li>We don't train models on your data, sell it or share it beyond the <a href="/subprocessors">listed sub-processors</a>, except as <a href="#authorities">Requests from authorities</a> says. We don't share personal information with anyone for their direct marketing.</li>
  <li>Nobody at ${OPERATOR.tradingName} looks at your content except in the cases the <a href="/terms#access">terms</a> list: to help you when you ask, to investigate a security problem, abuse or a legal notice, to fix a fault, or when the law requires it.</li>
  <li>We don't track you across sites, so a Do Not Track or Global Privacy Control signal changes nothing here. If your browser sends one, we treat it as a request not to sell or share your data, which we never do anyway.</li>
</ul>

<h2 id="authorities">Requests from authorities</h2>
<p>We give data to the authorities only when a valid US legal order compels us, or in an emergency involving a risk to someone's life, and we tell the vault's owners first unless the law forbids it. If Reliquary is ever transferred to another company, this policy keeps applying to your data.</p>

<h2>Why we use it</h2>
<ul>
  <li>To run the service you signed up for.</li>
  <li>To answer an access request.</li>
  <li>To keep it secure and fix faults (server logs, access logs, refused attempts).</li>
  <li>To tell you about changes that affect you. No marketing email without your consent.</li>
</ul>

<h2>Cookies</h2>
<p>Only cookies the service needs to work, so no consent banner:</p>
<div class="table-wrap"><table>
  <thead><tr><th scope="col">Cookie</th><th scope="col">What it's for, and for how long</th></tr></thead>
  <tbody>${COOKIES.map(([n, d]) => html`<tr><td><code>${n}</code></td><td>${d}</td></tr>`)}</tbody>
</table></div>

<h2>Where it's stored, and who processes it</h2>
<p>The database is in the EU (Frankfurt). The app itself runs in the United States (Netlify), so your requests and what they carry are processed there. Some providers are US companies whose networks and logs are global; the <a href="/subprocessors">sub-processor list</a> names each one, what it does and where.</p>
<p>Email (sign-in codes and links, account notices, vault invitations and access requests) is sent through Resend, a US company: it receives the recipient's address and the message, sends it from the EU, and keeps delivery records in the US for 30 days.</p>
<p>AI tools you connect (Claude, ChatGPT, Cursor and others) receive what their agent reads through your account. They are not our sub-processors: you choose them, and they process that data under your agreement with them.</p>

<h2>How long we keep it</h2>
<ul>
  <li>Account data: while you have an account. Deleting your account (on Account settings, or by asking us) deletes your email address, display name, plan and sign-in at once. The logs of vaults you were in keep a random account id, shown as "a deleted account", never your address.</li>
  <li>Vault content: until an owner erases it or deletes the vault. Erasing a file blanks every version at once; deleting a vault removes everything in it at once, keeping only who deleted it, when, and counts.</li>
  <li>The activity log is append-only: it keeps the fact that something happened, but erased content is gone from it.</li>
  <li>Sent email: our email provider keeps each message's record (address, subject, delivery status) for 30 days.</li>
  <li>Access requests: we delete the email within 90 days of arranging or turning down your access.</li>
  <li>Our own server logs: our hosting provider deletes them within 7 days.</li>
  <li>Database backups keep deleted data until they age out, after ${fill("backupRetention", "backup retention")}.</li>
</ul>

<h2>Your rights</h2>
<p>You can change your email address and delete your account yourself, on Account settings. You can also ask for access to, correction of, or deletion of your personal data, ask us to restrict or stop processing it, and take it with you (vault owners can export a vault themselves). Email ${mail(OPERATOR.contactEmail)}. For data in a vault, we'll pass your request to the vault's owner, who decides as controller.</p>

<h2 id="us-states">US state privacy rights</h2>
<p>Residents of California, Colorado, Virginia, Connecticut and other states with privacy laws have these rights, and we give them to everyone:</p>
<ul>
  <li>We don't sell your personal information, share it for cross-context behavioral advertising, or use it for profiling that has legal or similar effects.</li>
  <li>What we collect, by category: identifiers (email address, account id, IP address in host logs), internet activity (the request and access logs above), and what you write in vaults. Sources: you, your team, and the AI tools you connect. Who receives it: the <a href="/subprocessors">sub-processors</a>, for the purposes above.</li>
  <li>You can ask to know, access, correct or delete your personal information, and get a copy you can take with you. Email ${mail(OPERATOR.contactEmail)}; we answer within 45 days (or tell you within that time if we need 45 more) and confirm who you are by your account's email address. Someone you authorise can ask for you.</li>
  <li>We won't treat you differently for using these rights. If we turn a request down, reply to say so and we'll review it again; if that doesn't settle it, you can contact your state's attorney general.</li>
</ul>

<h2>Security and breaches</h2>
<p>See the <a href="/security">security page</a>. If a breach affects your personal data, we'll tell the vault owners without undue delay, and tell you and the authorities as the law where you live requires, within 30 days at most.</p>

<h2>Children</h2>
<p>Reliquary is a work tool for people ${fill("minimumAge", "minimum age")} and over. If we learn an account belongs to someone younger, we close it and delete its personal data. We don't knowingly collect personal information from children under 13; if you believe we have, email ${mail(OPERATOR.contactEmail)} and we'll delete it.</p>

<h2 id="eu">If you're in the EU, EEA, UK or Switzerland</h2>
<p class="callout attention" role="note">The alpha is offered in the United States and outside Europe first. We're not yet set up for people in the EU, EEA, UK or Switzerland, so please <a href="${appHref("/request-access")}">request access</a> rather than signing up, and we'll tell you when we are. What follows is what will apply then.</p>
<ul>
  <li><strong>Controller:</strong> ${OPERATOR.tradingName}, as above. For vault content, the vault's owner is the controller and we are their processor (<a href="/dpa">data processing terms</a>).</li>
  <li><strong>Legal bases:</strong> running the service and answering an access request, performance of a contract (or steps you asked for before one); security, fault-fixing and telling you about changes, our legitimate interest; marketing email, only your consent.</li>
  <li><strong>Your rights</strong> under the GDPR: access, correction, erasure, restriction, objection and portability, as in Your rights above, and to withdraw consent at any time.</li>
  <li><strong>Representatives</strong> (Article 27): ${OPERATOR.euRepresentative && OPERATOR.ukRepresentative ? html`in the EU, ${OPERATOR.euRepresentative}; in the UK, ${OPERATOR.ukRepresentative}.` : "we'll appoint one in the EU and one in the UK, and name them here, before Reliquary is offered there."}</li>
  <li><strong>Data protection authority:</strong> you can complain to the authority where you live or work.${OPERATOR.supervisoryAuthority ? html` Our lead authority is ${OPERATOR.supervisoryAuthority}.` : ""}</li>
  <li><strong>Transfers:</strong> the database is in the EU; the app and some sub-processors are in the United States. ${OPERATOR.transferSafeguard ? html`Transfers rely on ${OPERATOR.transferSafeguard}.` : "Before Reliquary is offered there, this names the safeguard each transfer relies on."}</li>
  <li><strong>Breaches:</strong> we'll tell the authority within 72 hours of becoming aware of one that affects you, where the GDPR requires it.</li>
</ul>

<h2>Changes</h2>
<p>This policy took effect on ${OPERATOR.lastUpdated}. We'll post changes here with a new date, and email account holders about significant ones at least 30 days before they take effect.</p>`);
}

// Data processing -------------------------------------------------------------

function dpa(theme: Theme): string {
  return legalPage(theme, "/dpa", "Data processing", "A summary of how Reliquary by Red Mage processes personal data for its customers, as their processor or service provider.", html`
<p class="lede">A plain summary of the data processing terms that apply when your vault holds personal data: as your service provider under US state privacy laws, and as your processor under GDPR Article 28 once Reliquary is offered in the EU. To sign a data processing agreement, email ${mail(OPERATOR.contactEmail)}.</p>

<h2>Roles</h2>
<p>The vault's owner (you) is the controller (the business, under US state laws). ${OPERATOR.tradingName} is the processor (your service provider), and doesn't sell, share or use your data for anything but providing the service to you.</p>
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

<h2 id="transfers">Transfers outside the EU (once offered in the EU)</h2>
<p>The database is in the EU; the app runs in the United States, and other sub-processors may access data from outside the EU. ${OPERATOR.transferSafeguard ? html`Each such transfer relies on ${OPERATOR.transferSafeguard}.` : "Before Reliquary is offered in the EU, this names the safeguard each transfer relies on."} The <a href="/subprocessors">sub-processor list</a> names each provider and its location.</p>`);
}

// Sub-processors ----------------------------------------------------------------

type Sub = { name: string; what: string; where: string; data: string; link?: [string, string] };
const SUBPROCESSORS: Sub[] = [
  {
    name: "Supabase",
    what: "Database and sign-in (authentication), and the embedding model search uses (Edge Functions)",
    where: "EU: AWS Frankfurt (eu-central-1)",
    data: "All vault content, encrypted variable values, account emails",
    link: ["https://supabase.com/privacy", "Supabase privacy policy"],
  },
  {
    name: "Netlify",
    what: "Hosting and CDN for the web app and MCP endpoint",
    where: "Functions in the United States (AWS US East); CDN and request logs global (US company)",
    data: "Requests in transit, request logs with IP addresses",
    link: ["https://www.netlify.com/privacy/", "Netlify privacy policy"],
  },
  {
    name: "Resend",
    what: "Sending email: sign-in codes and links, account notices, vault invitations and access requests",
    where: "Sent from the EU (Ireland, eu-west-1); account data, email metadata and logs stored in the US (US company)",
    data: "Recipient email addresses and message content (codes, sign-in and invite links, vault names and roles, access requests); kept by Resend for 30 days",
    link: ["https://resend.com/legal/privacy-policy", "Resend privacy policy"],
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
    <tr><td><strong>Payment provider</strong></td><td data-label="What it does">Billing, once plans are paid</td><td colspan="2" data-label="Where and data">None yet: nothing is billed during the alpha. Added here before billing starts.</td></tr>
  </tbody>
</table></div>

<h2>Model providers: none</h2>
<p>Reliquary sends your content to no model provider. The one model it runs is gte-small, an embedding model inside Supabase (above), which turns file text into numbers so search can match by meaning. It writes nothing; the numbers are kept beside the text and removed with it. The AI tools you connect (Claude, ChatGPT, Cursor and others) receive what their agent reads through your account, under your own agreement with their provider. They are your choice, not our sub-processors.</p>

<h2>Changes</h2>
<p>We update this page and tell vault owners ${fill("subprocessorNoticeDays", "notice period")} before adding or replacing a sub-processor. To object, email ${mail(OPERATOR.contactEmail)}.</p>`);
}

// Security ------------------------------------------------------------------------

function security(theme: Theme): string {
  return legalPage(theme, "/security", "Security", "How Reliquary by Red Mage protects vaults: access enforced in the database, hostile tests on every push, encrypted variables, where it runs, and what we can't promise.", html`
<p class="lede">What protects your vaults, what doesn't, and how to report a problem.</p>

<h2 id="status">Status</h2>
<p>${ALPHA} This page is built from the same code as the running release${BUILD.version === "unknown" ? "" : html`, v${BUILD.version}`}, so it changes when a release does. <a href="/docs/changelog">The changelog</a> says what changed in each one.</p>

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
<p>The database is in the EU (Frankfurt); the app runs in the United States (Netlify). See the <a href="/subprocessors">sub-processors</a>. Backups: ${fill("backupRetention", "backup schedule and retention")}.</p>

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

// status: 200 unless given (a docs page that doesn't exist is 404).
type PublicReply = { status?: number; type: string; body: string; location?: string };

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
  if (path === "/sitemap.xml") return { type: "application/xml; charset=utf-8", body: sitemapXml(docsPaths()) };
  if (path === "/.well-known/security.txt") return { type: "text/plain; charset=utf-8", body: securityTxt() };
  // The docs, llms.txt and the /roadmap redirect (docs.ts).
  return docsRoute(path, theme);
}
