// The Welcome tour (/welcome): six short slides, one page each, with Back,
// Next, step dots and Skip. Server-rendered, no script (the CSP forbids
// scripts): the slides are links, and Skip and Get started are small forms
// (a POST with the form token) that mark the tour seen.
//
// Who sees it and when: the database keeps a per-person "seen" row, in person
// only (public.welcome_seen, 20260926180000_welcome_tour.sql), and says
// whether it is missing in the top bar's one call (shell_summary's
// welcome_unseen). A person who has not seen it is sent to slide 1 once,
// right after the sign-in that made their account, on landing at Home or a
// vault: signin.ts leaves a
// short-lived cookie, and Home reads it (pages.ts) and clears it (server.ts).
// Accounts that existed before the tour was added are marked seen by the
// migration. Anyone can open /welcome any time, from the account menu.

import { asPerson } from "./db.js";
import { refusalText } from "./errorpage.js";
import { csrfField, html, pageHeader, type Raw } from "./html.js";
import { notFound, render, type Ctx, type Reply } from "./pages.js";

type Slide = { title: string; body: Raw };

// Words match docs/public/concepts: vault, canon, open, proposal, connection.
export const SLIDES: Slide[] = [
  {
    title: "What Reliquary is",
    body: html`<p>Reliquary is a shared vault for you, your team and your AI agents. It keeps the files everyone works from, the rules for who may change them, and the secrets your tools need.</p>
      <p>Everyone, people and agents, reads and writes the same place, so nobody works from an old copy.</p>`,
  },
  {
    title: "Files: open and canon",
    body: html`<p><strong>Open</strong> files can be changed by anyone with access. <strong>Canon</strong> files are the ones you rely on: they change only through a proposal that a person approves.</p>
      <p>Rules say which folders are canon. You can change them any time under a vault’s <strong>Rules</strong>.</p>`,
  },
  {
    title: "Proposals and review",
    body: html`<p>Agents propose changes to canon files, and people approve them. Nothing becomes canon without a person.</p>
      <p>Your <strong>Inbox</strong>, in the top bar, shows what is waiting for you. Open a proposal to see what changed, then approve, ask for changes or reject.</p>`,
  },
  {
    title: "Connections",
    body: html`<p>Connect Claude, ChatGPT, Cursor or the command line from the <a href="/connect">Connect</a> page. Each one is a <strong>connection</strong>, and you manage them on the <a href="/connections">Connections</a> page.</p>
      <p>An agent acts as you, with a ceiling: it can’t approve, reveal secret values, or manage people. It never sees a secret’s value.</p>`,
  },
  {
    title: "Environment variables",
    body: html`<p>Keep environment variables in a vault, stored encrypted, by environment such as development or production.</p>
      <p>Run a program with them using <code>reliquary run</code>. Agents can see the names of variables, never the values.</p>`,
  },
  {
    title: "Tell us what you think",
    body: html`<p>Reliquary is pre-alpha, so things change and some will break. Use the <strong>Feedback</strong> button in the top bar for bugs and ideas, or ask your agent to send feedback for you.</p>
      <p>The <a href="/docs">docs</a> explain each of these in more detail. You can open this tour again from the account menu, under <strong>Welcome tour</strong>.</p>`,
  },
];

// The step in /welcome/<n>: 1 to the number of slides, or nothing.
function stepOf(path: string): number | undefined {
  if (path === "/welcome") return 1;
  const m = /^\/welcome\/([1-9][0-9]?)$/.exec(path);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= SLIDES.length ? n : undefined;
}
// The pages a fresh sign-in may be sent to the tour from: Home, and a
// vault's front page (where accepting an invite ends).
export const welcomeLanding = (path: string): boolean =>
  path === "/" || /^\/v\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(path);

const href = (n: number) => (n === 1 ? "/welcome" : `/welcome/${n}`);

export async function welcomeRoutes(ctx: Ctx): Promise<Reply> {
  const p = ctx.url.pathname;
  if (ctx.method === "POST") return p === "/welcome/done" ? done(ctx) : notFound(ctx);
  const n = stepOf(p);
  return n ? slide(ctx, n) : notFound(ctx);
}

function slide(ctx: Ctx, n: number): Reply {
  const s = SLIDES[n - 1];
  const last = n === SLIDES.length;
  const dots = SLIDES.map(
    (x, i) => html`<li><a href="${href(i + 1)}" class="welcome-dot" aria-label="Step ${i + 1} of ${SLIDES.length}: ${x.title}"${i + 1 === n ? html` aria-current="step"` : ""}></a></li>`,
  );
  const body = html`<section class="welcome" aria-labelledby="welcome-title">
    <p class="welcome-step">Step ${n} of ${SLIDES.length}</p>
    <h1 id="welcome-title">${n === 1 ? "Welcome to Reliquary" : s.title}</h1>
    ${n === 1 ? html`<h2 class="welcome-sub">${s.title}</h2>` : ""}
    <div class="welcome-body">${s.body}</div>
    <nav class="welcome-dots" aria-label="Welcome steps"><ol>${dots}</ol></nav>
    <div class="welcome-actions">
      ${n > 1 ? html`<a class="button" href="${href(n - 1)}" rel="prev">Back</a>` : html`<span></span>`}
      ${last
        ? html`<form method="post" action="/welcome/done">${csrfField(ctx.csrf)}<input type="hidden" name="to" value="start"><button class="primary">Get started</button></form>`
        : html`<a class="button primary" href="${href(n + 1)}" rel="next">Next</a>`}
    </div>
    ${last
      ? ""
      : html`<form method="post" action="/welcome/done" class="welcome-skip">${csrfField(ctx.csrf)}<button class="quiet">Skip</button></form>`}
  </section>`;
  return render(ctx, n === 1 ? "Welcome to Reliquary" : `${s.title}: welcome ${n} of ${SLIDES.length}`, body, "welcome");
}

// Skip and Get started: mark the tour seen (harmless if already), then Home,
// or, on Get started, New vault for a person with no vault.
async function done(ctx: Ctx): Promise<Reply> {
  try {
    const anyVault = await asPerson(ctx.userId, async (c) => {
      await c.query(`select public.mark_welcome_seen()`);
      return (await c.query(`select exists (select 1 from public.vault_members where user_id = $1) as any`, [ctx.userId])).rows[0].any as boolean;
    });
    return { redirect: ctx.form.get("to") === "start" && !anyVault ? "/vaults/new" : "/" };
  } catch (err) {
    ctx.setFlash(refusalText(err));
    return { redirect: "/welcome" };
  }
}
