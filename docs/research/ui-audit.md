# UI audit, page by page

2026-09-26 · Status: RESEARCH (read-only audit; nothing here is built yet)
· Companions: [ux-patterns.md](ux-patterns.md) (structure),
[ui-design-system.md](ui-design-system.md) (tokens and components)

The owner asked to "go through each page and see how we can make things
clearer, a bit more refined". This note walks every page a signed-in person
can reach, plus the signed-out ones, and says what to change, specifically
enough to implement.

The global shell (top bar, a search box, a notifications inbox replacing
"Needs your review", an account menu with an Account settings page) is being
redesigned in parallel. It is out of scope here, and nothing below depends on
its final shape. Where a page finding touches the shell, it is marked
**(shell)** and left to that work.

## How the audit was run

- Commit `e5a5f9b`, built with `npm run build` in `node:22-slim`, run with
  podman on slot 90: Postgres on 55232 with every migration, the web server
  in local mode as Ana on 9691 (with a test `VARIABLES_KEY`), a second
  server in `AUTH_MODE=supabase` against `web/test/fake-auth.mjs` on 9695
  for the signed-out pages, and a Caddy proxy that adds the session and
  theme cookies so headless Chromium can take screenshots.
- Seed (synthetic only, `example.test` addresses): Ana owns *Acme
  consulting* (Ben editor, Carla viewer, an invite waiting for Dee) with
  canon `canon/` and `clients/`, open `notes/`, nine files, and five
  proposals from Ben's agent (open with a thread, sent back and revised,
  rejected, a delete, a new file snoozed); *Personal notes*; Ben's
  *Northwind handover* where Ana is also an owner with a proposal waiting.
  Tokens in use, read-only, expired and revoked. Variables across
  development, preview, production and a custom `staging`, with reveals, a
  CLI read, a pending `env push` and a pasted `.env` draft. Ana's plan is
  set to 3 vaults, 4 people and 64 KB, so Acme sits at its people limit.
- Every page at 1280 and 375 px, light and dark: 73 pages, 4 shots each,
  plus result pages of form posts (flash messages, reveals, a refused
  decision, a vault over the limit). HTML and screenshots are in the
  session's scratchpad (`ui-audit/html`, `ui-audit/shots`), not committed.
- Not rendered: the OAuth consent page with a real client (it needs client
  metadata over the network; its error page was checked), environment
  rename and delete confirmations, the Revise page (needs your own
  proposal), and the invite page for a valid token.

## Summary: the ten changes that matter most

| # | Change | Why | Where |
|---|---|---|---|
| 1 | Give flash messages a tone: success, info, and **danger with `role="alert"`** for refusals, and show a refused form's error next to the form | Every message, including "Say why, so the proposer can act on it", renders as the same blue info box above the sidebar, far from the field that caused it | `html.ts` `page()`, `server.ts` (flash storage), every `ctx.setFlash(message(err))` |
| 2 | Label every activity event; no raw codes | Activity shows `variable.set`, `variable.rotate`, `environment.create`, `proposal.comment` as they are stored, and they can't be filtered | `activity.ts` `EVENTS` |
| 3 | Rebuild the Variables matrix: one compact status per cell and a `⋯` menu for Reveal / Rotate / Delete; Environments and Access log as tabs | 24 cells each carry three buttons and a reader sentence; the page is a wall of buttons and names break mid-word | `variablespage.ts` `list()`, `cell()` |
| 4 | Put destructive file actions in one place: **More ▾ → Delete file… / Erase content…**, both through confirm pages; take the Delete section off the editor | Delete sits under the editor's Save; Erase sits in a More menu on another page; the difference is explained only on the Erase page | `pages.ts` `editView()`, `moreMenu()`, `vaultadmin.ts` `erasePage()` |
| 5 | Tokens page: the list first, the form behind **New token** | The form fills the first screen; the tokens you came to check or revoke are below the fold, and the header "Create token" submits an empty form | `pages.ts` `tokens()` |
| 6 | Show limits before the form, not after the post: disable New vault and Invite when at a limit, with the reason | At 3 of 3 vaults the New vault form is still offered and fails on submit with two messages saying the same; Members offers an invite the database will refuse | `pages.ts` `home()`, `newVault()`, `members.ts` `membersPage()` |
| 7 | Fix the "Removes 2 of 4 lines" risk flag | Editing two lines is reported as removing them, so the one amber warning on most proposals is a false alarm and people learn to ignore it | `pages.ts` `risks()` |
| 8 | Use `tabular-nums` only where numbers line up | On `body` it gives Inter's tabular hyphen, so "read-only", "Pre-alpha" and dates show a wide gap round every hyphen | `style.css` line 157 |
| 9 | One time format: relative time with the exact UTC time in `title`, everywhere | Pages mix "6 min ago" with "2026-09-26 06:49 UTC"; the proposal meta wraps "UTC" onto its own line | `html.ts` `when()`, `pages.ts` `ago()`, `thread.ts` `ago()` (a copy) |
| 10 | Breadcrumbs that always start at the vault, and name what you're in | The proposal page's crumb is just "Proposals"; Erase says "Acme consulting / Settings" though you came from a file; Home's title is "Reliquary" | `pages.ts` `crumbs()`, `proposalView()`, `vaultadmin.ts` `crumb()` |

Ranking used below: **High** (misleads, blocks, or risks a mistake),
**Medium** (friction a person notices), **Low** (polish). Effort **S**
(under an hour, one function), **M** (a few hours, markup and CSS),
**L** (a day or more, or a new route).

A note on tests: most `web/test` files assert on copy. Any copy change
below changes a behaviour test, so it lands with a `Changes-behaviour:`
trailer and the registry row, as AGENTS.md says.

---

## Signed-in pages

### Home (`/`), `pages.ts` `home()`

**Purpose.** See what waits on me and get into a vault.

**What's unclear or clumsy**

- The title is "Reliquary", the nav item is "Vaults", and the tab title is
  "Home". Three names for one page.
- "Needs your review" duplicates the Review page and is going to the
  notifications inbox **(shell)**; once it goes, Home is only the vault
  list and the lede.
- Each review row ends in a bare "0 of 1". Nothing says it is approvals.
- The risk badge is the badge's full text: "Revised 1 time; earlier
  approvals don't count" is clipped at 375 px (the badge has
  `white-space: nowrap` inside a row that can't grow).
- Vault rows say "owner · 9 files" and nothing else: no open proposals, no
  last activity, no hint which vault needs attention. Northwind shows
  "0 files" though a proposal waits there.
- The plan line "Free plan · 2 of 3 vaults" is a link that looks like
  muted text, between the heading and the list.
- Role is lower case ("owner") here and title case ("Owner") on Members.

**Recommendations**

| Rank | Effort | Change |
|---|---|---|
| High | S | Title "Vaults"; tab title "Vaults"; keep `nav: "home"`. Lede stays. |
| High | S | `reviewRow()`: replace "0 of 1" with "0 of 1 approvals" (or a `badge` "0/1 approved"), and show only the badge's short label: `risks()` returns `{short, long}`; short goes in the badge ("Revised", "Deletes file", "Large removal", "New agent"), long goes in `title` and on the proposal page. |
| Medium | M | Vault rows become a `.box` table: Name, Your role (Owner/Editor/Viewer), Files, Open proposals (count, links to `/v/:id/proposals`), Last activity (relative). Sort by last activity, not name. |
| Medium | S | Move the plan line under the page header's meta row: "You own 2 of 3 vaults on the Free plan · Plan and usage". When at the limit, the New vault button becomes a disabled secondary button with the line "At your plan's limit of 3 vaults" beside it. |
| Low | S | Empty state keeps its copy but loses the second paragraph about templates (the New vault page says it). |

### Review (`/review`), `pages.ts` `review()`, `thread.ts` `rowSnooze()`, `snoozedSection()`, `variablespage.ts` `pendingList()`

**Purpose.** Clear everything waiting on my decision, across vaults.

**What's unclear or clumsy**

- No count in the header, and no order the person controls; groups are by
  vault name, rows by age.
- The pending `.env` push is a yellow box above the proposals, with
  different row styling (its own inner card and a "Review" button) from
  the proposal rows below.
- Row meta repeats "by ben@example.test via Claude Code · 6 min ago" on
  two lines on phones; the path is the only thing that tells rows apart.
- "Waiting on the proposer" (changes you requested) is below the fold and
  styled like the waiting list.
- "Show snoozed (1)" is a link at the bottom; snoozed items are easy to
  forget.
- The lede tells people how to review ("Read the change itself before the
  reason"), which belongs on the proposal page.

**Recommendations**

| Rank | Effort | Change |
|---|---|---|
| High | S | Header: title "Review", badge with the count ("4 waiting"), no lede beyond one line: "Changes waiting on your approval, across your vaults." |
| Medium | M | Tabs under the header (the `.tabs` component): **Waiting (4)** · **Sent back (1)** · **Snoozed (1)**, each a query string on `/review`. Replaces the three stacked sections. |
| Medium | S | Pushes render with `reviewRow()`'s markup: title "Set 3 variables in preview", meta "Acme consulting · Ben via the CLI · 6 min ago · expires in 24 h", badge "Variables". Drop the yellow wrapper; the attention tone moves to the push's own page. |
| Low | S | Row meta order: vault · agent (person) · age, e.g. "Acme consulting · Claude Code for ben@example.test · 6 min ago", so the agent, the more useful fact, comes first. |

This page may become the notifications inbox **(shell)**; the tabs and row
markup apply either way.

### Activity (`/activity`) and vault Activity (`/v/:id/activity`), `activity.ts`

**Purpose.** Find who changed what, when.

**What's unclear or clumsy**

- **Raw codes**: `variable.set`, `variable.rotate`, `environment.create`,
  `proposal.comment` appear as stored, because `EVENTS` lacks them, and
  the Action filter can't select them.
- Seven filter fields fill the first screen on a phone before any event.
- The `#` column (log sequence) means nothing to a person.
- On a phone the table scrolls sideways inside itself and the "By" column
  is off screen.
- Fifteen identical "variable.set" rows in a row: no grouping.
- "Changed members" appears when a person is added; "Changed a rule" says
  nothing of which way.

**Recommendations**

| Rank | Effort | Change |
|---|---|---|
| High | S | Add labels to `EVENTS`: `proposal.comment` "Commented", `variable.set` "Set a variable", `variable.rotate` "Rotated a variable", `variable.delete` "Deleted a variable", `environment.create` "Added an environment", `environment.rename` "Renamed an environment", `environment.delete` "Deleted an environment", and every other event the migrations log (grep `log_event(` in `supabase/migrations`). Add a group "Any variable change" (`variable.`). A test: every event in the migrations has a label. |
| High | M | Filters in a `<details class="filters">` summary "Filters" with the active ones as removable chips beside it ("Agent: Claude Code ×"); open by default only on desktop when a filter is set. The table follows the header directly. |
| Medium | M | Below 640 px, each row as a two-line list item: "**Set a variable** · Acme consulting" / "you · 6 min ago · canon/pricing.md". CSS only, using `data-label` like the variables table. |
| Medium | S | Drop the `#` column (keep `seq` as the row's `id` for linking). |
| Low | M | Collapse consecutive identical events by the same actor within a minute: "Set 15 variables" with a `<details>` listing them. |
| Low | S | `Changed members` becomes "Added ben@example.test as Editor" etc. from `detail` (role and user are already there; never show anything else from `detail`). |

The vault Activity lede ("This log can only be added to: nothing in it is
ever edited or deleted") is a guarantee worth keeping, but as the page's
meta line, not a paragraph.

### Connect (`/connect`), `pages.ts` `connect()`

**Purpose.** Hook up one specific client, quickly.

**What's unclear or clumsy**

- The client list looks like tabs (`nav.tabs`) but is a row of anchor
  links; nothing is selected, and all sections are on the page anyway.
- The lede is three sentences of concepts before the first instruction.
- The primary action is "Create a token", though the first two
  clients (Claude Code, Claude.ai, ChatGPT) need no token.
- Every command is a `<pre>` with no copy affordance (no JS, so no copy
  button), and long commands wrap on phones.
- "Hermes and others" mixes a raw header with a local-development recipe
  (`./mcp/dev.sh`), which is for contributors, not customers.

**Recommendations**

| Rank | Effort | Change |
|---|---|---|
| High | S | Replace the fake tabs with a plain "On this page" list, or make them real: `/connect?client=claude-code` renders one section, `aria-current` on the chosen one. Real tabs are better on phones (one section, no scrolling). |
| Medium | S | Primary action: none. Secondary "Create a token" stays, as a ghost button labelled "Tokens for other clients". |
| Medium | S | Lede, one line: "Connect any MCP client to your vaults with this URL." Then the URL box. Move the ceiling sentence into a callout at the end of each section: "The agent acts as you, but can't approve, change rules or manage members." |
| Low | S | Move "Local development" out of the product page into the docs (`docs/public/how-to/connect-other-clients.md` already exists). |
| Low | S | Each `pre.code` gets `tabindex="0"` and `user-select: all` so one click selects the whole command. |

### Tokens (`/tokens`), `pages.ts` `tokens()`, `createToken()`, `revokeToken()`

**Purpose.** See what can reach my vaults, revoke one, occasionally make one.

**What's unclear or clumsy**

- The create form fills the first screen; the list is below the fold.
- The header's "Create token" submits the form at the top with an empty
  name: the browser's own "Please fill in this field" is the feedback.
- Expired and revoked tokens sit in the same table as live ones, faded.
- The page is called Tokens but also lists CLI sign-ins and OAuth
  connections ("Reliquary CLI", "MCP app"); Members calls the same things
  "Agent connections". The lede talks only about tokens.
- After creating, the one-time token appears in an attention callout above
  the form, and the form is still there, empty, inviting a second token.
- Revoke is one click with no confirmation, for a live agent.
- "from claude-code 2.1" runs into the time ("24 min agofrom") in the HTML,
  relying on CSS for the gap.

**Recommendations**

| Rank | Effort | Change |
|---|---|---|
| High | M | Page title "Connections" (nav label too, **(shell)** decides), lede "Everything that can act as you: MCP tokens, apps you signed in to, and the CLI." Header primary **New token** links to `/tokens/new`, a page with today's form. After creating, `/tokens/new` shows only the reveal callout and a "Done" button back to the list. |
| High | S | Split the list: "Active" table; "Expired and revoked" in a `<details>` below, collapsed. |
| Medium | M | Revoke through a confirm page (`GET /tokens/:id/revoke`) naming the token, its scope and last use: "Claude Code on laptop stops working on its next request. Agents using it lose access to all your vaults." Button: "Revoke Claude Code on laptop". |
| Medium | S | A "Type" column: MCP token / App (OAuth) / Reliquary CLI, instead of folding the type into "Access". |
| Low | S | `<span class="muted token-client"> · from …</span>` with a real separator in the markup. |

### Plan and usage (`/account`), `plans.ts` `accountPage()`

**Purpose.** Know how close I am to a limit, and what to do about it.

This page is likely to fold into Account settings **(shell)**. Findings for
its content:

- The nav marks "Vaults" as current (`nav: "home"`).
- "Standard (Free) · 3 of 4 people · 1.8 KB of 64 KB" is one run of text;
  the limit you are at isn't visually tied to the "At a limit" badge.
- The paragraph mixes three ideas (plan vs tier, billing, the operator).

| Rank | Effort | Change |
|---|---|---|
| Medium | M | A table: Vault, People (3 of 4, with a thin meter), Storage (1.8 KB of 64 KB, meter), Status (badge "People full"). The badge names which limit. |
| Low | S | Split the paragraph: one line under the title ("Free plan: up to 3 vaults you own"), the billing sentence as a small note at the end. |

### New vault (`/vaults/new`), `pages.ts` `newVault()`, `templates.ts` `templateChoices()`

**Purpose.** Make a vault that starts right.

**What's unclear or clumsy**

- Two choices that interact (template and default policy) with no hint
  that a template already sets folder rules; "Default policy" is jargon at
  this point.
- Template descriptions are long single lines with a dense "Canon: …
  · Open: … · suggested variables: …" tail.
- At the vault limit the form stays usable; submitting it produces both a
  flash and a callout saying the same thing, and the name typed is lost.

| Rank | Effort | Change |
|---|---|---|
| High | S | At the limit: hide the form, keep the callout, make it the page's only content with "Plan and usage" as a secondary button. |
| Medium | M | Templates as selectable cards (radio inside a `.choice-card`), each with a one-line description and a small "Canon: brief/, decisions/ · Open: notes/" line in mono. |
| Medium | S | Rename the fieldset "Files without a rule are" with the two radios "Open (written directly)" and "Canon (changed by approved proposals)"; hint "Templates set rules for their folders; this applies to everything else." |
| Low | M | Keep the typed name on a refused post (part of design-system step 10, form errors). |

### Vault and folder pages (`/v/:id`, `/v/:id/tree?path=`), `pages.ts` `folder()`, `vaultShell()`, `crumbs()`, `ruleLine()`

**Purpose.** Find a file; understand the folder's rules; add something.

**What's unclear or clumsy**

- In the table, folders have an empty Policy cell, though the sidebar tree
  marks them canon or open. On a canon folder page the rule line explains
  it, but the root page shows no rule line at all (the vault default is
  never stated there).
- The README renders under an `h2` "README.md" and then its own `h1`: two
  headings for one thing, the second bigger.
- "Connect an agent" is the root page's secondary action, repeated on every
  vault, while Search, Proposals and Settings, which are the vault's
  own, are only in the sidebar.
- On phones the whole vault navigation (Files, Proposals, Activity,
  Variables, Settings) is hidden inside "Browse Acme consulting". Nothing
  shows that the vault has proposals waiting.
- The mobile `<details>` has no count on Proposals (the desktop sidebar has).
- Empty vault: "This vault is empty" even when a proposal to create its
  first file is waiting (Northwind).

| Rank | Effort | Change |
|---|---|---|
| High | M | Below 768 px, the vault sections become a horizontally scrolling `.tabs` row under the vault name (Files · Proposals 4 · Activity · Variables · Settings), always visible; the `<details>` keeps only the folder tree ("Browse files"). |
| High | S | Folder rows get their policy badge (the `dirs` map in `vaultShell()` already has it; pass it to `folder()`). |
| Medium | S | Root page meta: "Files without a rule are **Open** · 3 rules · Rules" linking to `/v/:id/rules`. |
| Medium | S | README: drop the `h2`; render the README in a `.box` whose header bar says "README.md" in small mono, like GitHub. |
| Medium | S | Empty state: if open proposals exist, "No files yet. 1 proposal waits to create one: Review it". |
| Low | S | Replace "Connect an agent" on every vault with it only in the empty state; the header's secondary action becomes "Search" (a link to `/v/:id/search`) on phones where the sidebar search is hidden. |

### File page (`/v/:id/file?path=`), `pages.ts` `fileView()`, `moreMenu()`

**Purpose.** Read a file; know whether I can change it and how.

**What's unclear or clumsy**

- Meta "Last written by you2026-09-26 06:49 UTC": two spans with no
  separator in the HTML; absolute time while the rule line says "6 min ago".
- "More ▾" with one item, "Erase this file…", appears before the primary
  action; Delete is not in it (it's at the bottom of the editor).
- The open-proposal callout is blue info; it deserves more weight on a
  canon file ("a change to this file is waiting").
- Source tab shows plain text with no line numbers; long lines wrap.
- History reuses the whole activity filter form for a list of four events.

| Rank | Effort | Change |
|---|---|---|
| High | M | More menu for writers (not only owners): "Delete file…" (canon: "Propose deleting…"), and for owners "Erase content…", each with a one-line description in the menu ("Removes the file; history stays" / "Blanks every version; for personal data"). Order: primary action last in the header, More before it. |
| Medium | S | Meta: "Last written by you · 6 min ago" with `title` = UTC time. |
| Medium | S | Pending callout: attention tone, "A proposed change to this file is waiting for review. Review it". |
| Low | M | Source tab: the unified diff's line-number gutter style (mono, numbers), no wrap, horizontal scroll inside the box. |
| Low | S | History tab: no filter form when the file has fewer than 50 events. |

### Edit / Propose a change (`/v/:id/edit?path=`), `pages.ts` `editView()`

**Purpose.** Change the text and save (open) or propose (canon).

**What's unclear or clumsy**

- A "Delete" `h2` and a red button sit directly under Save and Cancel.
  One mis-aimed click on a long editor page deletes the file (open files
  delete at once, with no confirm).
- The textarea label "Text" and the canon hint "Reviewers see this after
  the diff" are fine; but on canon, "Why this change" is required and is
  below the textarea, so the header's "Propose change" fails with a
  browser tooltip scrolled out of view.

| Rank | Effort | Change |
|---|---|---|
| High | S | Remove the Delete section from `editView()`; delete lives in the file page's More menu (above) through a confirm page. |
| Medium | S | On canon files put "Why this change" above the textarea (one line input), so the required field is on screen with the header button. |
| Low | S | Title "Edit ideas.md" stays; canon title "Propose a change to pricing.md" stays. |

### New file (`/v/:id/new?dir=`), `pages.ts` `newFile()`

- "Why (only used if this becomes a proposal)" with "New file" prefilled
  is confusing: the page knows the folder's rule.

| Rank | Effort | Change |
|---|---|---|
| Medium | S | Show the rule line for `dir` (reuse `ruleFor()`/`ruleLine()`); show the Why field only when that rule is canon, with the header button "Propose file" instead of "Create file". The path field can still move it; the post already handles either. |
| Low | S | Placeholder `notes/standup.md` → the folder plus a name: `${dir}new-file.md`. |

### Proposals list (`/v/:id/proposals`), `pages.ts` `proposalList()`

**Purpose.** See this vault's proposals by state.

- Tabs have no counts; "Changes requested", "Stale" and "Rejected" are
  usually empty and look as important as "Open".
- Closed proposals still show "0 of 1" (approvals needed) and risk badges
  lose meaning after a decision.
- No header action and no crumb to the vault.

| Rank | Effort | Change |
|---|---|---|
| Medium | S | Counts in the tabs ("Open 4", "Applied 2"): one `count(*) group by status` query. |
| Medium | S | Closed rows show the outcome instead: "Applied by you · 2 days ago", "Rejected by you". |
| Low | S | Merge "Rejected" and "Stale" into "Closed" with the state as a badge on each row; tabs become Open · Sent back · Applied · Closed. |

### Proposal page (`/v/:id/proposals/:pid`), `pages.ts` `proposalView()`, `thread.ts`, `diffview.ts`

**Purpose.** Decide on a change with the evidence on screen.

This page is the best in the app: controls at the top, the diff directly
under them, the unverified reason after. What remains:

- **The risk heuristic misfires.** `risks()` counts a line as removed when
  its exact text is gone, so the pricing change (two lines edited) says
  "Removes 2 of 4 lines". It's the first thing a reviewer reads.
- "Creates a new file" is an amber risk here but a neutral "New file"
  badge in lists.
- The crumb is "Proposals" only; the vault name is only in the sidebar.
- Meta "Revision 1 · By … · 2026-09-26 06:49 UTC" wraps "UTC" alone onto a
  second line at 1280 px; "Revision 1" is noise when there's one.
- The snooze row (three buttons and a hint) sits between the decision and
  the diff, pushing the diff down; on the Review list it is a quiet menu.
- "Approvals: 0 of 1 for revision 1." is shown on rejected proposals.
- A refused decision (Reject without a note) comes back as a blue info
  flash above the page: "Say why, so the proposer can act on it. (ref …)"
  instead of an error on the Note field.
- The own-agent callout ("You're reviewing a change your own agent …
  proposed") is good; keep.

| Rank | Effort | Change |
|---|---|---|
| High | S | `risks()`: compute removals from the line diff (`diff.ts`), counting only removed lines with no paired addition, or rename the flag "Rewrites 2 of 4 lines" when lines are replaced. Only a net removal of half or more is "Large removal". |
| High | M | A refused decision re-renders the page (status 400) with `callout danger role="alert"` inside the decision box and `aria-invalid` on the note, keeping the typed note. (Form errors, design-system step 10, starting here.) |
| Medium | S | Crumb: "Acme consulting / Proposals". |
| Medium | S | Snooze as the same `<details>` "Snooze ▾" menu as Review rows, placed in the header actions (secondary). The snoozed note stays where it is. |
| Medium | S | Meta: "By Claude Code for ben@example.test · 6 min ago" plus "Revision 2" only when revision > 1. |
| Low | S | "Creates a new file" joins "New file" as a neutral badge on the page too. |
| Low | S | Decided proposals: replace the Approvals section with the outcome line ("Rejected by you, 6 min ago") and hide the empty "No comments yet." for closed threads. |

### Edit, then approve / Revise (`/proposals/:pid/edit`, `/revise`), `pages.ts` `proposalEdit()`, `proposalRevise()`

- Crumb is "Back to the proposal", a different pattern from every other
  crumb; the title doesn't name the file.
- The editor shows the proposed text with no view of what it's changing.

| Rank | Effort | Change |
|---|---|---|
| Medium | S | Crumb "Acme consulting / Proposals / Change canon/pricing.md"; title "Edit, then approve pricing.md". |
| Low | M | A collapsed `<details>` "Current file" above the editor, rendered read-only, so the approver can compare without leaving. |

### Rules (`/v/:id/rules`), `pages.ts` `rules()`, `setRule()`

**Purpose.** Decide which paths are canon and how many approvals they need.

- The page opens with a paragraph, then the Add form, then the checker,
  then the list: the current rules, the thing people come to see, are last.
- "Approvals" is a free text field clamped silently to 1 to 20.
- **Rule paths aren't validated.** Saving `../x` succeeds ("../x is now
  canon.") and lists a rule that can never match. `public.set_policy` never
  checks the path. (A separate task was suggested for the database fix.)
- Remove is a quiet text button with no confirm; the removed rule's
  effect (files becoming open) isn't stated.
- Rules is reached through Settings, but it's a daily page for owners.

| Rank | Effort | Change |
|---|---|---|
| High | S | Order: header (title, primary "Add rule" that opens a `<details>` form, or links to `#add-rule`), the rules table, then the checker, then the explanation as a short hint. |
| High | S | Quorum as `<input type="number" min="1" max="20">`, label "Approvals needed". Refuse out-of-range values with a message rather than clamping. |
| Medium | M | Remove through a confirm step listing what changes: "Files under clients/ become Open (the vault default). 2 proposals waiting there stay open." |
| Medium | S | The table's "Set" column: "you · 6 min ago" (drop the comma). |

### Search (`/v/:id/search`), `pages.ts` `search()`

- Good empty and no-results copy. Snippets are the file's start, not the
  match, so the query isn't visible in the result.

| Rank | Effort | Change |
|---|---|---|
| Medium | M | Snippet around the first match with `<mark>` (escaped text, `<mark>` added after escaping). |
| Low | S | Header shows the search box on the page itself (the sidebar one is hidden on phones). |

### Variables (`/v/:id/variables`), `variablespage.ts` `list()`, `cell()`

**Purpose.** See which secrets exist where, and change one.

**What's unclear or clumsy**

- Each set cell holds "Set v1 · you, 6 min ago", sometimes a reader
  sentence and "Revoke a sign-in", then Reveal, Rotate and a red Delete.
  Six variables × four environments is 70 buttons. On a phone it is a
  very long list.
- Names wrap mid-word (`NEXT_PUBLIC_API_BA` / `SE`).
- "v1", "v2": versions of a value are an internal concept.
- "production (owners)": the column head is the only place the rule shows.
- Header actions: Environments, Import .env, Access log, Add a variable.
  Two of them are navigation (sub-pages), two are actions.
- The bottom "Use them" section is the same as Connect's CLI section, plus
  two important warnings in small type.
- The pending push box repeats (well) from Review, in yellow.

**Recommendations**

| Rank | Effort | Change |
|---|---|---|
| High | M | Cells: "Set · 6 min ago" (with `title` "v2, set by you at …"), a small "Read since" dot/label when readers exist, and a `<details class="menu-wrap">` `⋯` with Reveal (a form button), Rotate, Delete. "Not set" cells show a ghost "Set" link on hover/focus and always on phones. |
| High | S | `white-space: nowrap` on the name `code`, the name column sticky on the left and the table scrolling sideways inside its box when environments overflow. |
| Medium | S | Sub-navigation as `.tabs` under the header: Variables · Environments · Access log · Imports (when any). Header actions: "Import .env" (secondary), "Add a variable" (primary). |
| Medium | S | Owners-only columns get a lock badge "Owners only" under the environment name instead of "(owners)". |
| Medium | S | "Use them" becomes one line with a link: "Programs get these with the Reliquary CLI. How to use them" → `/connect?client=cli`; the two warnings move into one attention callout at the top of the page, shown once (collapsible `<details open>`). |
| Low | S | "Revoke a sign-in" link text → "Manage CLI sign-ins". |

### Add, rotate, delete a value; reveal (`/variables/set`, `/delete`, `/reveal`), `variablespage.ts` `setForm()`, `confirmDelete()`, `reveal()`

- Rotate and Add share the form; Rotate's lede ("Anyone who already read
  the old value still has it: rotate it at its provider too") is exactly
  right.
- Delete confirm: the actions sit under the lede, but the header has none
  (the pattern elsewhere puts them in the header); fine for a short page.
- Reveal shows the value in a callout with a "Done" button in the header;
  good. The value has no "select all" affordance.

| Rank | Effort | Change |
|---|---|---|
| Medium | S | Environment on Add: radio buttons (usually 3 or 4) rather than a select, disabled with "(owners only)" where the role can't write. |
| Low | S | Revealed value in a read-only `<textarea class="secret-input">` sized to content with `user-select: all`, so it selects in one click and long values wrap safely. |
| Low | S | Delete button text "Delete FEATURE_FLAGS from development" (names both). |

### Environments (`/variables/environments`), `variablespage.ts` `environmentsPage()`

- A plain list "development · 4 values · default" with Rename / Delete as
  links only on custom ones; the add form below.

| Rank | Effort | Change |
|---|---|---|
| Low | S | A `.box` table: Environment, Values, Who can set (Everyone who edits / Owners only), actions. "Default" as a neutral badge. |

### Import a .env and review an import (`/variables/import`, `/variables/imports/:id`), `variablespage.ts` `importForm()`, `reviewImport()`, `decideImport()`

**Purpose.** Bring a `.env` in without exposing values, then apply it.

- Import form: the hint on accepted syntax is a long sentence; the only
  primary action is at the bottom (header has just Cancel).
- Review page: Apply and Reject sit under the table, contrary to the
  controls-at-top rule. For a 200-variable import they are far away.
- Badge "Replaces v1" beside "value set, hidden": two messages in one cell,
  "v1" again.
- Draft "Not taken" reasons are good ("Line 4: the name isn't letters,
  digits and underscores").
- The push callout says who sent it and warns an agent may have run it:
  keep.

| Rank | Effort | Change |
|---|---|---|
| High | S | Review page: Apply (primary) and Reject/Discard (danger) in the page header; keep them at the bottom too for long lists. |
| Medium | S | Cell: badge "New" or "Replaces a value", no "value set, hidden" (the lede says values aren't shown). |
| Medium | S | Import form: primary "Review the import" in the header with `form=`; accepted-syntax hint in a `<details>` "What's understood". |

### Access log (`/variables/log`), `variablespage.ts` `log()`, `detail()`

- "Environment added" rows show "none in staging" in the Variables column
  (`variablespage.ts` line 740 prints "none" when no names).
- Who and from run together in the HTML ("youfrom web UI"), relying on CSS.
- No "Clear filters"; no pager seen with 22 rows (check what happens past
  a page).

| Rank | Effort | Change |
|---|---|---|
| Medium | S | Empty names cell renders "—" and the environment alone ("staging"). |
| Low | S | Who cell: "you · web UI" / "ben@example.test · CLI". |
| Low | S | Reuse the activity filter pattern (collapsible, chips, Clear filters). |

### Settings (`/v/:id/config`), `vaultadmin.ts` `settings()`, `saveSettings()`

**Purpose.** Change the vault's name and defaults; reach its admin pages.

- A long stack: General form, then Members, Plan and usage, Rules, Export,
  Leave, Danger zone, each a heading with a sentence and a link. It reads
  as an index page, and Rules and Members, used often, are one link each.
- The limit callout "This vault is at a limit" is good but its sentence is
  hard: "Its places are full (counting invites waiting)".
- Leave shows for the only owner with an explanation instead of a control
  (good), but lives under Export.

| Rank | Effort | Change |
|---|---|---|
| High | M | A settings sub-navigation (a second-level `.tabs` row, or a left list inside the content on desktop): **General · Members · Rules · Usage · Export · Danger zone**, each its own page (Rules and Members already are). The sidebar's Settings stays the entry point and is current on all of them. |
| Medium | S | Limit copy: "Acme consulting has 4 of 4 places filled: 3 members and 1 invite waiting. To invite someone, revoke an invite or remove a member." |
| Low | S | Leave moves into Danger zone, above Delete, as a secondary danger button. |

### Members (`/v/:id/config/members`), `members.ts` `membersPage()`, `removePage()`, `createInvite()`

**Purpose.** Who's in, with what role; invite; cut off an agent.

- The invite form is offered when the vault is full; the post will be
  refused. The page doesn't mention the limit.
- The header "Invite someone" jumps to a form that is always open further
  down; after creating, the one-time link is at the top and the form stays.
- Role change is a select plus a quiet "Change" per row; the select is
  taller than the buttons (misaligned row).
- Agent connections: two identical rows "Reliquary CLI · Reliquary CLI
  (environment variables) · this computer" for Ben. "this computer" is the
  stored client name (`env_imports.sql`, `create_cli_grant`), which reads
  as *my* computer to the owner looking at Ben's row; name and type repeat.
- Revoke on invites and connections is one click with no confirm (Remove
  member has a good confirm page).

| Rank | Effort | Change |
|---|---|---|
| High | S | When places are full: replace the invite form with the limit callout (same copy as Settings), and disable the header "Invite someone" with that reason. |
| Medium | M | Invite form behind the header button (`<details>` opened by `#invite` or a `/config/members/invite` page), like Tokens. |
| Medium | S | Connections: show "Reliquary CLI" once, then "Environment variables · signed in 6 min ago" as the detail; add Created to tell duplicates apart. In the query, display `client_name = 'this computer'` as "a computer" (or fix the stored name in a migration: "the CLI's computer"). |
| Low | S | Role select and Change button: same control height (`--control-sm`); or submit on a per-row "Save role" only when changed. |
| Low | M | Revoke invite / connection through confirm pages consistent with Remove. |

### Export, Delete vault, Erase file, Leave (`vaultadmin.ts` `exportPage()`, `deletePage()`, `erasePage()`; `members.ts` `leavePage()`)

These confirm pages are strong: each says what happens, what is kept, and
what can't be undone, with a typed confirmation where it matters.

- Erase's crumb is "Acme consulting / Settings" though Erase starts from a
  file; its copy says "all 1 version" (the plural helper gives "1 version";
  "all" should drop for one).
- Export has two identical "Download export" buttons in one short view.

| Rank | Effort | Change |
|---|---|---|
| Medium | S | Erase crumb: vault / folders / file (reuse `crumbs()`), Cancel back to the file. |
| Low | S | "blanks the text of its only version" when there is one; "all 3 versions" otherwise. |
| Low | S | Export: drop the header button (the page is short), or the bottom one. |

### Invite page (`/invite?token=`), `members.ts` `invitePageBody()`

- Invalid link: "Invite not found" and a "Your vaults" link. No reference
  code, unlike every other failure (AGENTS.md: never a failure without a
  ref).

| Rank | Effort | Change |
|---|---|---|
| Medium | S | Render through `errorPage()` with where "invites" and why "This link isn't a valid invite: it may be cut short, or already replaced." |

### Not found and error pages, `errorpage.ts` `errorPage()`, `pages.ts` `notFound()`

- The what/where/why/ref model is followed everywhere checked, and the
  copy is honest. For an everyday 404 the "Copy details" block (a second
  heading and a mono box repeating the same four facts) is heavy.
- "Why" repeats the lede word for word.
- "Opening vault 00000000" names an id people never see.

| Rank | Effort | Change |
|---|---|---|
| Medium | S | Keep the lede and the four facts; put "Copy details" inside a closed `<details>` "Details to send if you report this". |
| Low | S | When why equals the lede, omit the Why row. |

---

## Signed-out pages

### Landing (`/`), `landing.ts` `landing()`, `site.ts` `sitePage()`

Clear and well ordered: promise, problem, how it works, difference,
audience, the ceiling, pricing, questions.

- "What your agent can't do" uses full-round pills that look like buttons
  and break the sharp-corner look.
- The hero's demo card has real-looking Approve / Request changes buttons.

| Rank | Effort | Change |
|---|---|---|
| Low | S | The five "can't" items as a list with a small ✕ mark (or neutral badges with `--radius-sm`), not pills. |
| Low | S | Demo buttons: add `aria-hidden="true"` and `tabindex="-1"` if they're `<button>`s, or render as spans styled as buttons with `inert` on the card. |

### Sign in, code, confirm (`/signin`, `/signin/code`, `/auth/confirm`), `signin.ts`

- Short and clear. The invite-only hint is under the form; a person
  without an invite has no next step (no "Request access" link here,
  though the landing page has one).
- The wordmark goes to `/`; there is no visible way back to the site from
  the sign-in form on the app host.
- Wrong code: an attention callout "That code didn't work…" with
  `role="alert"`: good. It should be danger-toned, as for every refusal.
- "Link incomplete" (`/auth/confirm` without a token) is a `notice()` with
  no reference.

| Rank | Effort | Change |
|---|---|---|
| Medium | S | Hint: "Reliquary is invite-only. Have an invite? Open its link. Otherwise, request access" linking `requestAccessHref`. |
| Low | S | Bad code callout in the danger tone; `aria-invalid` and `aria-describedby` on the code field. |
| Low | S | "Link incomplete" through `errorPage()` with a ref. |

### Docs, roadmap, legal (`docs.ts`, `legal.ts`)

Out of scope in depth; checked for consistency. They share the site frame,
sidebar and sentence case. The roadmap's four columns work at 1280 and
stack at 375. No findings beyond the shared hyphen spacing (summary #8).

---

## Cross-cutting findings

### 1. Page header pattern

`pageHeader()` (`html.ts`) is used on nearly every page and is right in
shape. Gaps:

- **No description slot.** Pages add a `p.lede` after the header, often
  two or three sentences of concepts (Tokens, Connect, Members, Variables,
  Import). Add `description?: Raw` to `pageHeader()`, rendered under the
  title row in `--fg-muted` 14 to 16 px, **one sentence**, and move
  explanations into hints next to the controls they explain, or into docs
  links.
- **No tabs slot.** File, Proposals, Connect and (proposed) Variables,
  Settings and Review render `.tabs` after the header by hand. Add
  `tabs?: {href, label, count?, current}[]` so tabs always sit flush under
  the header with the header's bottom border removed, as the design system
  says.
- **Primary action rules.** One primary, last, in the header. Today:
  Tokens' primary submits a form the person hasn't filled; Connect's
  primary is the less common path; Import review has no header actions.
  Rule: the header primary is either a link to a page/form, or submits a
  form **visible on the first screen** with its required fields.
- **Titles.** Page title = what the page is ("Vaults", "Review",
  "pricing.md", "Change canon/pricing.md"). Never the product name.

### 2. Breadcrumbs

`crumbs()` builds vault / folder / … for files and folders; other pages
hand-roll theirs: "Proposals", "Back to the proposal", "Acme consulting /
Settings", "Acme consulting" on Variables. Proposal:

- One `crumb(parts: {href?, label}[])` helper in `html.ts`.
- Every page inside a vault starts with the vault: `Acme consulting /
  canon / pricing.md`, `Acme consulting / Proposals / Change
  canon/pricing.md`, `Acme consulting / Variables / Access log`, `Acme
  consulting / Settings / Members`.
- The current page is the last crumb, not a link (`aria-current="page"`),
  and the `h1` may repeat it shorter.
- Wrapped in `<nav aria-label="Breadcrumb"><ol>`, not a `<p>`.

### 3. Tables vs lists

Use a **table** when rows are compared across columns (files, rules,
tokens, members, activity, access log, variables). Use a **row list**
(`ul.rows`) when each item is read on its own with one title and a meta
line (review, proposals, vaults on Home, search results). Today Home's
vault list is a row list that would benefit from columns, and Activity is
a table that fails on phones. Every table needs a phone rendering: either
the `data-label` stacked cells used by Variables (make it a shared
`.table-stack` class) or a list variant.

### 4. Buttons

- Destructive buttons are consistent (outlined red), but some destructive
  actions have no confirm (token revoke, invite revoke, connection revoke,
  rule remove, open-file delete from the editor) while others have strong
  ones (remove member, delete vault, erase). Rule: **anything that stops
  a person or an agent working, or loses text, goes through a confirm
  page** naming the thing and the consequence; the confirm button repeats
  the verb and the object ("Revoke Claude Code on laptop").
- "Quiet" buttons ("Change", "Remove", "Unsnooze") read as text. Use the
  ghost variant from the design system with a visible hover background and
  at least 28 px height.
- Button groups of three peers (snooze: For a day / For a week / Until it
  changes) belong in a menu when they aren't the page's main job.

### 5. Forms

- Required fields must be on screen when the header submit is used
  (Tokens name, canon "Why this change").
- Server-side errors come back as a flash on a redirect, lose what was
  typed, and aren't next to the field. Design-system step 10 (error summary
  plus inline errors, re-render with values, status 400) is the fix; start
  with the three places errors are common: the decision form (note
  required), New vault (limit, name), Rules (path, quorum).
- Number inputs as `type="number"` with `min`/`max`; free-text fields that
  get silently clamped (quorum) should refuse instead.
- Labels above fields; hints under labels (the design system's order) are
  mostly followed; the proposal Note puts its hint inside the `<label>`,
  which makes the accessible name long ("Note Required to request changes
  or reject. The proposer sees it."). Use `aria-describedby` for hints.

### 6. Flash and confirmation messages

`page()` renders every flash as `<p class="callout info flash"
role="status">`, placed above the vault layout, for success and refusal
alike. Proposal:

- `ctx.setFlash(message, tone)` with tone `success | info | danger`
  (stored with the message; `server.ts` keeps it in the session as today).
- `success`: "Saved notes/ideas.md.", "Approved and applied.", green,
  `role="status"`.
- `danger`: every `message(err)` path, red, `role="alert"`, with the ref.
- Inside a vault, render the flash in the content column under the page
  header, not above the sidebar.
- Success messages name what happened and the next step when there is one
  ("Invite link created for eli@example.test. Copy it now: it won't be
  shown again.").

### 7. Time

`when()` prints "2026-09-26 06:49 UTC" and `ago()` prints "6 min ago"; pages
pick either, and `thread.ts` has its own copy of `ago()`. Proposal: one
`time(d)` helper in `html.ts` returning `<time datetime="…"
title="2026-09-26 06:49 UTC">6 min ago</time>`, used everywhere; absolute
time only where exactness is the point (token expiry, invite expiry, the
error page's timestamp). Delete `ago()` from `thread.ts`.

### 8. Terminology

| Term | Where it's explained today | Problem | Proposal |
|---|---|---|---|
| Canon / Open | New vault radio, Rules lede, docs | The badge and the tree's diamonds appear on every vault page with no explanation; "canon" is not an everyday word | `title` on every policy badge: "Canon: changes are proposals that people approve" / "Open: members and agents write directly"; a "What's canon?" link to `/docs/concepts/canon-and-rules` in the vault root's meta line |
| Proposal | Nowhere in the app | Clear enough in context | Keep |
| Quorum / Approvals | Rules table header "Approvals" | Also "0 of 1" with no noun | Always "n of m approvals" |
| Revision | Proposal meta | Fine when > 1 | Show only when > 1 |
| Stale | Proposals tab and callout | The tab empty state explains it; the badge doesn't | Badge `title`: "The file changed before this was approved" |
| v1, v2 (variables) | Nowhere | Internal version numbers | Hide; show "set 6 min ago", keep versions in `title` and the access log |
| Reveal / Rotate | Buttons only | Rotate is jargon for "replace the value" | Keep "Rotate" (the industry word) but the page title "Replace the value of DATABASE_URL (rotate)"; `title` on the button |
| Push / Import / Draft | Import pages | Three words for one thing | "Import" for both, with the source: "Import from the CLI" / "Import you pasted" |
| Token / Connection / Sign-in | Tokens, Members, Variables ("Revoke a sign-in") | Four words across three pages | "Connection" for all; types MCP token, App, Reliquary CLI |
| Delete / Erase | Only on the Erase page | People don't know they differ | Menu item descriptions (see File page) |
| Snooze | Review lede | Fine | Keep |

### 9. Accessibility

- **Hyphen spacing**: `font-variant-numeric: tabular-nums` on `body`
  (`style.css` line 157) gives Inter's tabular hyphen everywhere; words like
  "read-only", "sign-in", "Pre-alpha" and dates get wide gaps. Scope
  `tabular-nums` to `.num`, `td`, `time`, `.count`, `.diff-stat`.
- Breadcrumbs in `<p>` (see 2). Tabs on Connect are links in
  `nav.tabs` with no current item (see Connect).
- Duplicate navigation: `vaultShell()` renders the vault links and the tree
  twice (sidebar and mobile `<details>`); confirm the hidden copy is
  `display: none` at each breakpoint so screen readers get one.
- Labels with hints inside them (proposal Note).
- Phone: Activity's table hides a column off screen; the Review risk badge
  is clipped.
- Targets: quiet buttons ("Change", "Remove") and tree links are close to
  24 px; check each against WCAG 2.5.8 after the ghost-button change.
- Contrast: the tokens pass (`web/test/contrast.test.mjs`); nothing new
  found in the screenshots, light or dark.

### 10. Density and length

Long pages where the job is small: Variables (buttons), Tokens (form
first), Members (form always open), Settings (index of links). The
consistent fix is the same: **list first, the create form behind the
header's primary action, rare actions in a `⋯` or More menu**.

---

## Proposed component inventory

What exists (`html.ts`, `style.css`) and what to add or change. Names are
the classes or helpers to use.

| Component | Status | Notes |
|---|---|---|
| `pageHeader({crumb, title, badge, description, meta, actions, tabs})` | Extend | Add `description` and `tabs`; `crumb` takes parts |
| `crumb(parts)` | New | `<nav aria-label="Breadcrumb"><ol>`; used by every vault page |
| `.tabs` with counts | Extend | Via `pageHeader({tabs})`; count pill inside |
| Buttons: primary, secondary, ghost, danger | Exists | "quiet" becomes ghost with hover fill; min height 28 px |
| `menu(label, items)` (`<details class="menu-wrap">`) | Generalise | One helper for More, `⋯`, Snooze; items can be links or one-button forms; optional description line per item |
| `callout(tone, body)` | Exists as classes | Add a helper; tones info, success, attention, danger |
| `flash` with tone | Change | See cross-cutting 6 |
| `badge(tone, label, title?)` | Exists as classes | Short labels only; long text in `title` |
| `policyBadge(policy)` | Exists (`tag()` in `pages.ts`, `policyBadge` in `vaultadmin.ts`) | One shared helper with the explanatory `title` |
| `.box` + `.table-stack` | Partly | Every table in a box; `.table-stack` gives the stacked phone layout |
| `rowList(items)` | Exists as `ul.rows` | Title, meta, end slot (badges, counts, menu) |
| `emptyState({title, body, action})` | Exists as `.empty` | Helper so copy follows "what's missing / when it appears / action" |
| `time(d)` | New | See cross-cutting 7 |
| `confirmPage({title, consequences, typed?, button})` | New helper | Remove member, delete vault, erase, leave, revoke token/invite/connection, remove rule, delete file all share it |
| `formError(summary, fields)` | New | Design-system step 10 |
| `filters(form, active)` | New | Collapsible filter bar with chips and Clear filters; Activity and Access log |
| `meter(used, max)` | New | Plan and usage, Settings |

---

## Implementation plan

The work splits into independent packages that parallel agents can do
without touching the same files. Two constraints decide the order:

1. **The shell redesign owns `html.ts` and the top of `style.css` right
   now.** Package A (components) touches both, so it starts once the shell
   lands, and packages B to H use A's helpers. Packages that don't need A's
   helpers (marked *independent*) can start at once.
2. **`pages.ts` is 1525 lines and holds six of the pages.** Package 0 splits
   it first, as a pure refactor, so B, C and D don't collide.

Every package: copy changes break text assertions in `web/test`; update
them with a `Changes-behaviour:` trailer and the `tests/features.md` row,
add tests for new behaviour (a confirm page, a refused form re-rendering),
update the public docs that name buttons (`docs/public/how-to/*`), run
`./test.sh` on its own `TEST_SLOT`. Page CSS goes in a section at the end of
`style.css` headed with the package's name, so packages append rather than
edit the same lines; shared component CSS is only in package A.

| Pkg | Scope | Files | Depends on | Size |
|---|---|---|---|---|
| **0** | Split `pages.ts` into `files.ts` (folder, file, edit, new, fileAction, vaultShell, crumbs, ruleLine), `proposals.ts` (list, view, edit, revise, decide, repropose, risks, reviewRow), `access.ts` (connect, tokens), `rules.ts` (rules, setRule, search); `pages.ts` keeps home, review, newVault, routing. `refactor(web):` commit, `Test-refactor:` trailer, no behaviour change | `web/src/pages.ts`, new `web/src/{files,proposals,access,rules}.ts` | none | S |
| **A** | Components: `pageHeader` description/tabs, `crumb()`, `time()`, `menu()`, `callout()`, flash tones (`setFlash(msg, tone)`, rendering in the content column), `policyBadge()` with `title`, `.table-stack`, ghost buttons, `tabular-nums` scoping, `confirmPage()`, `emptyState()` | `web/src/html.ts`, `web/src/server.ts` (flash storage), `web/public/style.css` (components section), `web/src/pages.ts` `render()`/`Ctx` type only | shell redesign merged | M |
| **B** | Files and folders: folder policy badges, root rule line, README box, phone vault tabs, More menu with Delete/Erase, delete off the editor, canon "Why" above the editor, New file knows the rule, file meta time | `web/src/files.ts`, `web/src/vaultadmin.ts` (`erasePage` crumb and copy only) | 0, A | M |
| **C** | Proposals and review: `risks()` fix with short/long labels, crumbs, snooze menu in header, refused decision re-rendered with inline error, decided-proposal outcome, list tab counts and closed-row outcomes; Review page tabs and push rows | `web/src/proposals.ts`, `web/src/thread.ts`, `web/src/pages.ts` (`review()`, `home()` rows) | 0, A | M |
| **D** | Access: Connections page (list first, `/tokens/new`, revoke confirm, type column, expired in `<details>`), Connect real tabs and trimmed lede | `web/src/access.ts`, `docs/public/concepts/connections.md`, `docs/public/how-to/rotate-a-leaked-token.md` | 0, A | M |
| **E** | Activity: event labels for every logged event (with a test that fails on an unlabelled event), collapsible filters with chips, no `#` column, phone list layout, member-change detail | `web/src/activity.ts` | A for the filter bar; the labels are *independent* | S (labels) + M |
| **F** | Variables: compact cells with `⋯` menu, nowrap names, sticky name column, sub-tabs, owners-only badge, import review actions at the top, badge copy, access log "—" and who cell, environment radios on Add | `web/src/variablespage.ts` | A | M |
| **G** | Vault admin and members: settings sub-navigation, limit copy, Leave into Danger zone, invite form behind the button, full-vault state, connection rows (and the `'this computer'` client name, display-side), confirm pages for invite and connection revokes, Export single button | `web/src/vaultadmin.ts` (except `erasePage`, done in B), `web/src/members.ts`, `web/src/plans.ts` | A | M |
| **H** | Vault creation and limits: Home as "Vaults" with the vault table and plan line, New vault at the limit, template cards, default-policy wording | `web/src/pages.ts` (`home()`, `newVault()`), `web/src/templates.ts` | 0, A; coordinate with C, which edits `review()` and the rows in `home()` (do C's `home()` change in H instead) | M |
| **I** | Signed-out and errors: sign-in hint with request access, danger tone for bad code, "Link incomplete" and invalid invite through `errorPage()`, collapsible Copy details, landing pills and demo card | `web/src/signin.ts`, `web/src/errorpage.ts`, `web/src/landing.ts`, `web/src/members.ts` `invitePageBody()` only (coordinate with G, or move the function to `invites.ts` in package 0) | *independent* of A except the danger callout class, which exists | S |
| **J** | Rules: order, number input with refusal, remove confirm, set column | `web/src/rules.ts` | 0, A; the database path validation is a separate fix (suggested as its own task) | S |

**Suggested order.** Now: 0, E (labels only), I. After the shell merges: A.
Then B, C, D, F, G, H, J in parallel (H after C's decision on `home()`
rows). Each package is one or a few `feat(web):` / `fix(web):` commits whose
subjects read well in the changelog ("feat(web): variables page shows one
menu per value instead of three buttons").

**Out of scope here, worth their own notes:** the OAuth consent page
(needs a live client to audit), the docs site's navigation, and email
templates once invites are emailed.
