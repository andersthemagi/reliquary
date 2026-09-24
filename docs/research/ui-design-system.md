# A design system for the web UI

2026-09-24 · Status: BUILT 2026-09-24 (steps 1 to 9 and 11; step 10, form
errors, still to do; the "Review changes" popover superseded, see "As built")
· Companion to [ux-patterns.md](ux-patterns.md) (structure, already decided)

The owner's brief: the current look suits Red Mage, but Reliquary is a
separate product. It should be friendly and conventional for anyone, not
only for its author. Primary actions go at the top of a page, never hidden
at the bottom. This note looks at how leading design systems handle the
same parts, then proposes tokens, components and a migration.

Sources were checked on 2026-09-24. Claims marked *(unverified)* came from
search snippets or third-party summaries, not the system's own page.

## 1. What makes the current UI hard

All references are to `web/public/style.css`, `web/src/html.ts` and
`web/src/pages.ts` at commit 59d7e3c.

| Problem | Where | Why it hurts |
|---|---|---|
| Page titles in an all-caps display face | `h1 { font: 400 3rem/0.92 "Bebas Neue" }`. Bebas Neue has no lowercase, so "Proposals" renders as PROPOSALS | All-caps words lose their shape and read slower ([NN/g](https://www.nngroup.com/articles/glanceable-fonts/) *(unverified)*). A 48px condensed title with 0.92 line height shouts on every page |
| Two title systems | Bebas for Home, Review, Proposals, Rules, Tokens; `h1.path` in Barlow 26px for files, folders, proposals | The title changes size, face and position as you move around, so there is no stable anchor at the top of the page |
| Uppercase, letter-spaced labels everywhere | Top nav, every `h2`, `th`, `.tag`, `legend`, `.pane-label`, split diff headers (11 rules) | Section headings (`h2`) are 13px muted caps, smaller than body text, so the hierarchy is inverted: the headings that should guide scanning look like fine print |
| Faceted shapes | `.primary` and `.facet` use `clip-path` to cut a corner; `.primary::after` adds an arrow to every primary button | An unfamiliar button shape. The arrow says "go forward" even on Approve or Save. `clip-path` also clips focus outlines and shadows, so the code works around it |
| Surfaces that barely separate | Parchment ground `#ede4d8`, panel `#f6f0e8`: 1.11:1. Dark: 1.10:1 | Panels, forms, diffs and file text are told apart by fill alone, at a ratio people can't see on many screens. Inputs use the ground color inside a lighter panel, which inverts the usual "field is lighter" cue |
| Red means everything | Links, danger buttons, risk badges, "Changes requested" and "Stale" states all use `--accent-ink` | A red link looks like an error. Reject and a plain link share a color. Nothing is left to mean "danger" |
| Actions at the bottom | Proposal page: the decision form comes after the diff, reason and approvals. Edit page: Save after a 280px textarea, Delete in a section below. Theme switch in the footer | The owner's main complaint. On a long diff the controls are a scroll away and easy to miss |
| Weak button hierarchy | Default buttons are a thin 50% outline; `.quiet` buttons have no padding and look like text ("Edit, then approve" next to Reject) | Hard to tell what is clickable and which action matters |
| Small uppercase badges | `.tag` is 11px, 0.1em tracking, caps | Below a comfortable size; GOV.UK dropped uppercase tags for this reason ([GOV.UK tag](https://design-system.service.gov.uk/components/tag/)) |
| Brand leak | Footer says "Red Mage · Reliquary"; the stylesheet header cites the Red Mage DESIGN.md | Reliquary is its own product |

What already works and should stay: server-rendered pages with no client
JavaScript, `<details>` for the tree and folds, a sticky vault sidebar,
light and dark themes with an explicit switch, tabular numbers, the
reduced-motion rule, and the diff views from phase 2.

## 2. Findings by topic

### Page header

| Pattern | Who does it | For Reliquary |
|---|---|---|
| Breadcrumbs or a parent link above the title; title with an optional status label after it; description below | [Primer PageHeader](https://primer.style/product/components/page-header/), [Atlassian page header](https://atlassian.design/components/page-header/examples) | One `pageHeader()` helper for every page: crumbs, title, status badge, meta line |
| Page actions at the end of the title row (top right), grouped, primary last | Primer PageHeader, Atlassian page header, [Primer Button](https://primer.style/product/components/button/guidelines/) ("primary at the group's end") | Every page's actions move into the header. This is the owner's rule and the industry default |
| Action buttons in the header so they stay visible when content scrolls; below the content only when nothing scrolls | [Stripe Apps action buttons](https://docs.stripe.com/stripe-apps/patterns/action-buttons) | Long pages (proposal, file, editor) put actions in the header. Short forms may also keep a submit at the end |
| Underline tabs directly under the header | Primer (UnderlineNav in PageHeader), GitHub file and PR pages | File tabs (Preview, Source, History) and proposal status tabs sit under the header |
| A "Review changes" button at the top of the diff that opens a small form with verdict and note | GitHub pull requests ([docs](https://docs.github.com/articles/reviewing-proposed-changes-in-a-pull-request); not re-fetched) | Solves "controls at top" without the anti-pattern in ux-patterns.md of one-click approve above the diff: the button opens a form, the diff is the page body |

### Navigation

| Pattern | Who does it | For Reliquary |
|---|---|---|
| Top bar for a few global sections; left sidebar for a large or growing local structure | [NN/g vertical nav](https://www.nngroup.com/articles/vertical-nav/) *(unverified)*, GitHub (top repo nav, file tree left), Linear and Vercel (sidebar) | Keep both: top bar for Review, Vaults, Activity, Connect, Tokens; the vault sidebar for search, sections and the folder tree |
| Quieter sidebar so content wins | [Linear redesign](https://linear.app/now/how-we-redesigned-the-linear-ui) ("a few notches dimmer") | Sidebar on a subtle background, 14px, muted until hovered or current |
| Breadcrumbs as small muted links above the title | Primer, Atlassian | Keep `crumbs()`, move it into the header helper |
| Account and theme in a top-right menu | GitHub, Vercel, Linear | Move the theme switch out of the footer into a `<details>` account menu |

### Typography

| Pattern | Who does it | For Reliquary |
|---|---|---|
| One neutral sans with system fallbacks | Primer: Mona Sans then `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial` ([Primer typography](https://primer.style/product/primitives/typography/)). Atlassian Sans, derived from Inter, with a system stack ([Atlassian](https://atlassian.design/foundations/typography) *(unverified)*). Linear: Inter and Inter Display ([Linear](https://linear.app/now/how-we-redesigned-the-linear-ui)). Vercel: Geist ([Geist](https://vercel.com/geist/introduction)) | One self-hosted neutral sans, Inter, with a system fallback. Drop Bebas Neue and Barlow |
| Sentence case for titles, headings, buttons, labels, menus | [Atlassian language](https://atlassian.design/foundations/content/language-and-grammar) *(unverified)*, [Primer Button](https://primer.style/product/components/button/guidelines/), [Polaris](https://polaris-react.shopify.com/components/actions/button) *(unverified)*, GOV.UK | No `text-transform: uppercase` anywhere |
| Small, tested scale in rem; body 14 to 16px in dense apps, larger for reading; unitless line heights on a 4px grid | Primer: body 16/14/12, titles 32/20/16 at weight 600, line heights 1.25 to 1.75. [GOV.UK type scale](https://design-system.service.gov.uk/styles/type-scale/): 16/19/24/36/48, smaller headings below 640px | Seven steps, 12 to 30px, in rem (section 3) |
| Headings bold and larger than body, not smaller caps | All of the above | `h2` becomes 18px 600 ink, not 13px muted caps |

### Color

| Pattern | Who does it | For Reliquary |
|---|---|---|
| Neutral gray scale for nearly everything; steps assigned to backgrounds, borders and text | [Geist colors](https://vercel.com/geist/colors) (100-300 backgrounds, 400-600 borders, 900-1000 text); [Primer color usage](https://primer.style/product/getting-started/foundations/color-usage/) | Neutral tokens: `bg`, `bg-subtle`, `bg-muted`, `border`, `border-strong`, `fg`, `fg-muted` |
| One accent, used sparingly; less chroma for a calmer UI | Linear cut "how much chrome (blue) was used" and derives a theme from base, accent and contrast | Vermilion stays as the only brand hue, used for identity and "you are here", not for text |
| Functional roles separate from brand: accent (links, focus), success, attention, danger, done | Primer functional colors | Blue for links and focus, green success, amber attention, red danger. Brand vermilion never means danger |
| Don't use color alone | [GOV.UK tag](https://design-system.service.gov.uk/components/tag/), WCAG 1.4.1 | Every status has a text label; canon/open also has a filled or hollow mark |
| Dark mode from the same token names | Primer, Geist, Linear ("same theme generation" for light and dark) | Same tokens, redefined under `prefers-color-scheme` and `data-theme`, as today |

### Spacing, radius, shadow

| Pattern | Who does it | For Reliquary |
|---|---|---|
| 4px-based spacing scale: 2, 4, 8, 12, 16, 24, 32, 40, 48 | [Carbon spacing](https://carbondesignsystem.com/elements/spacing/overview/) *(values from snippet)* | `--space-1` to `--space-9` on the same steps |
| Small radius, graded by role: 2px detail, 4px labels, 6px buttons and inputs, 8px cards and menus, 12px modals, full for avatars and counts | [Atlassian radius](https://atlassian.design/foundations/radius) (verified); Geist uses about 6px on controls *(unverified)* | 4px badges, 6px controls, 8px containers, full for counts. A little crisper than Atlassian, in keeping with a sharp brand, without the cut corners |
| Borders, not shadows, for in-page containers; shadows only for things that float | Primer, Geist, GitHub | One shadow token for `<details>` menus. Cards and diffs get a 1px border |

### Buttons

| Pattern | Who does it | For Reliquary |
|---|---|---|
| Primary, secondary (default), invisible or tertiary, danger | [Primer Button](https://primer.style/product/components/button/guidelines/), [GOV.UK button](https://design-system.service.gov.uk/components/button/) (primary, secondary, warning), [Polaris](https://polaris-react.shopify.com/components/actions/button) *(unverified)* | Four variants: primary, secondary, ghost, danger |
| One primary per page or view | Primer ("Only use one primary Button on a page, whenever possible"), GOV.UK | One primary per page header. The proposal page's primary is "Review changes" |
| Sentence case, verb first, no decoration | Primer, GOV.UK ("Save and continue", "Delete account") | No arrow icon, no clip-path |
| Destructive actions in red, and behind a confirmation when irreversible | GOV.UK warning button, Primer danger | Danger buttons are outlined red; Delete and Revoke go through a confirm page or sit in a "More" menu |

### Forms

| Pattern | Who does it | For Reliquary |
|---|---|---|
| Label above the field, hint under the label, error message above the field | GOV.UK ([validation](https://design-system.service.gov.uk/patterns/validation/)) | Same order in every form |
| Validate on the server; error summary at the top linking to fields; keep what the user typed; "Error:" in the title | GOV.UK validation (works with no JavaScript) | Fits our no-JS pages exactly. Today errors come back as a flash; move to a summary plus inline messages |
| Input borders at 3:1 when the border is what shows a field is there | [WCAG 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) | `--border-strong` is 3.6:1 on white, 3.4:1 on dark |

### Tables and lists

| Pattern | Who does it | For Reliquary |
|---|---|---|
| Row heights as a density choice: 24, 32, 40, 48, 64px | [Carbon data table](https://carbondesignsystem.com/components/data-table/style/) *(unverified)* | 40px rows for files, tokens, activity; 56px list rows for proposals (two lines) |
| Header row on a subtle fill, sentence case, numbers right-aligned | Primer, Carbon, GitHub file lists | `th` 13px 600 muted on `bg-subtle`, no caps |
| The whole list in a bordered box with a header bar | GitHub file list, issues list | `.box` wrapper: 1px border, 8px radius, optional header with count and filters |

### Empty states

| Pattern | Who does it | For Reliquary |
|---|---|---|
| Say why it's empty and give the next step; title and action as call and response ("No customers yet." / "Add customer") | [Stripe empty state](https://docs.stripe.com/stripe-apps/patterns/empty-state), [NN/g](https://www.nngroup.com/articles/empty-state-interface-design/) *(unverified)* | "No files yet." / "New file". Our copy is already close |
| Filtered-to-zero is different from nothing-exists: no "create" button, offer "Clear filters" | Stripe | Activity and search empty states say "No results match" and link to clear |
| Section-level empty state: compact, dashed 1px border, centered | Stripe | `.empty` becomes a dashed box inside the section |

### Status labels

| Pattern | Who does it | For Reliquary |
|---|---|---|
| Short adjective, normal case, colored by meaning, never a link or button, few statuses | [GOV.UK tag](https://design-system.service.gov.uk/components/tag/) | `.badge` with tones: neutral, info, success, attention, danger |
| Workflow states with fixed colors: open, closed, done | Primer (open, closed, done roles), GitHub PR states | Open: info. Changes requested: attention. Applied: success. Rejected: neutral. Stale: neutral with "base changed" text |

### Diffs

| Pattern | Who does it | For Reliquary |
|---|---|---|
| Line tint plus a stronger word-level tint; separate tokens for each | GitHub (`diffBlob-*` tokens in [Primer primitives](https://github.com/primer/primitives)) | Keep our line and word tints, move to green and red tokens with dark variants |
| Bordered file box with a header: path, change counts, view switch | GitHub | Diff box header holds the Rendered / Unified / Split switch |
| Monospace with line numbers for unified and split; rendered view in the reading font | GitHub | Unified and split in the mono stack with a line-number gutter |

### Methodology checks

| Principle | Source | What it asks of us |
|---|---|---|
| Consistency and standards; recognition rather than recall; aesthetic and minimalist design | [NN/g 10 heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) (#4, #6, #8) | Look like the tools people already use; the same header on every page; labels, not icons alone |
| F-pattern: people scan the top and the left edge | [NN/g F-pattern](https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content/) | Title and status top left, actions top right, first two words of headings carry meaning |
| Progressive disclosure, at most two levels | [NN/g](https://www.nngroup.com/articles/progressive-disclosure/) | Rare or dangerous actions in a "More" menu; the decision form in the Review popover |
| Contrast 4.5:1 text, 3:1 large text and UI parts | WCAG 1.4.3, [1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) | All pairs below are checked |
| Target size at least 24 by 24 CSS px (AA) | [WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) | Smallest control 28px; default 36px |
| Focus never hidden (2.4.11, AA); a 2px outline with 3:1 change is the safe pattern (2.4.13, AAA) | [WCAG focus appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html) | 2px blue outline, 2px offset, on everything; sticky elements must not cover it |

### Staying distinctive while conventional

| Pattern | Who does it | For Reliquary |
|---|---|---|
| Neutral UI, one hue, a logo mark | Vercel (black and white, triangle), Linear (one accent, low chroma), GitHub (Octicons and green) | Neutral grays, vermilion, the diamond |
| A display cut of the body face for headings, not a second family | Linear (Inter Display for headings) | Optional: Inter's display optical size for page titles, if the variable font includes `opsz` |
| A small signature detail used with meaning | GitHub's colored PR state icons | Diamonds mark canon (filled) and open (hollow) in the tree, badges and rule lines |

## 3. Proposed design system

### Principles

1. **Conventional first.** If GitHub, Linear and GOV.UK agree on a
   pattern, use it.
2. **Top of the page does the work.** Title, status and primary action
   are visible without scrolling on every page.
3. **Neutral surfaces, one brand hue, functional colors with fixed
   meanings.** Red only means danger.
4. **Sentence case everywhere.** No uppercase transforms.
5. **No client JavaScript.** Menus and popovers are `<details>`; a header
   button can submit a form elsewhere on the page with the `form`
   attribute.

### Font

**Inter**, self-hosted, one variable `woff2` (latin subset, weights 400 to
600), with the system stack as fallback. Mono uses the system stack.

Why Inter rather than the system stack alone:

- The owner runs Linux, where `system-ui` falls back to whatever the
  distribution ships (Cantarell, Noto, DejaVu). The look and metrics would
  drift between machines and screenshots.
- It is the most common neutral UI face: Linear uses it, and Atlassian
  Sans is derived from it *(unverified)*.
- Tall x-height, tabular figures (`tnum`), and SIL Open Font License, like
  Barlow today. Self-hosting fits `style-src 'self'` and the CSP.

Why not Geist: also OFL and good, but it reads as Vercel's. Why not keep
Barlow: it is the Red Mage face. Size of a latin variable Inter is about
100 KB *(unverified; measure after subsetting)*.

```css
--font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
--font-mono: ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
```

### Type scale

| Token | Size | Line height | Weight | Use |
|---|---|---|---|---|
| `--text-xs` | 0.75rem (12px) | 1rem | 500 | Counts, badge text |
| `--text-sm` | 0.875rem (14px) | 1.25rem | 400/500 | Tables, sidebar, meta, hints, buttons, labels |
| `--text-md` | 1rem (16px) | 1.5rem | 400 | Body, form fields, prose |
| `--text-lg` | 1.125rem (18px) | 1.75rem | 600 | Section headings (`h2`) |
| `--text-xl` | 1.25rem (20px) | 1.75rem | 600 | Card and box titles, prose `h2` |
| `--text-2xl` | 1.5rem (24px) | 2rem | 600 | Page title (`h1`), prose `h1` |
| `--text-3xl` | 1.875rem (30px) | 2.25rem | 600 | Home greeting only, if at all |

Below 640px, `--text-2xl` drops to 1.25rem, as GOV.UK does for headings.
Prose stays at 16px with a 1.65 line height and a 72ch measure. Page
titles use `letter-spacing: -0.01em`; nothing else is tracked.

### Color tokens

Light theme. Ratios are WCAG contrast, computed for this note.

| Token | Value | Role | Checked against |
|---|---|---|---|
| `--bg` | `#ffffff` | Page, inputs, cards | |
| `--bg-subtle` | `#f7f6f5` | Top bar, sidebar, table header, diff header | |
| `--bg-muted` | `#efedeb` | Hover, current sidebar item | |
| `--border` | `#e2dfdc` | Dividers, box borders (decorative) | |
| `--border-strong` | `#8c8580` | Input and checkbox borders | 3.63 on bg, 3.36 on bg-subtle (≥3, 1.4.11) |
| `--fg` | `#1c1917` | Text | 17.5 on bg, 16.2 on bg-subtle |
| `--fg-muted` | `#5c5652` | Secondary text | 7.2 on bg, 6.7 on bg-subtle, 6.2 on bg-muted |
| `--link` | `#0a58ca` | Links, focus ring, info | 6.4 on bg, 6.0 on bg-subtle |
| `--brand` | `#e8393a` | Vermilion: logo, current-page bars, tab underline | 4.1 on bg (≥3 for non-text) |
| `--brand-strong` | `#c8302c` | Count pill fill, brand text if ever needed | white on it 5.4 |
| `--primary-bg` | `#1c1917` | Primary button | white on it 17.5 |
| `--success` | `#1a7f37` | Success text, Applied | 5.1 on bg, 4.6 on `--success-bg #dafbe1` |
| `--attention` | `#9a6700` | Warnings, risk reasons | 4.9 on bg, 4.5 on `--attention-bg #fff8c5` |
| `--danger` | `#cf222e` | Danger buttons, errors | 5.4 on bg, 4.7 on `--danger-bg #ffebe9` |
| `--info-bg` | `#ddf4ff` | Info callout, Open badge | link on it 5.7 |
| `--diff-add` / `--diff-add-word` | `#e6ffec` / `#abf2bc` | Added line / word | fg on them 16.6 / 13.5 |
| `--diff-del` / `--diff-del-word` | `#ffebe9` / `#ffcecb` | Removed line / word | fg on them 15.3 / 12.4 |

Dark theme, same names.

| Token | Value | Checked against |
|---|---|---|
| `--bg` | `#141312` | |
| `--bg-subtle` | `#1c1a19` | |
| `--bg-muted` | `#262322` | |
| `--border` | `#34302e` | |
| `--border-strong` | `#6f6863` | 3.39 on bg, 3.17 on bg-subtle |
| `--fg` | `#edebe9` | 15.6 on bg, 14.6 on bg-subtle |
| `--fg-muted` | `#a8a19c` | 7.3 on bg, 6.8 on bg-subtle, 6.1 on bg-muted |
| `--link` | `#6cb6ff` | 8.6 on bg, 8.1 on bg-subtle |
| `--brand` | `#ff5f57` | 6.2 on bg |
| `--brand-strong` | `#ff5f57` | count text `#141312` on it 6.2 |
| `--primary-bg` / `--primary-fg` | `#edebe9` / `#141312` | 15.6 |
| `--success` on `--success-bg` | `#6bc46d` on `#1b2e1f` | 6.7 (8.6 on bg) |
| `--attention` on `--attention-bg` | `#d4a72c` on `#2e2615` | 6.7 (8.3 on bg) |
| `--danger` on `--danger-bg` | `#ff7b72` on `#3a1d1b` | 6.1 (7.4 on bg) |
| `--info-bg` | `#172a3d` | link on it 6.8 |
| `--diff-add` / `--diff-add-word` | `#1b3524` / `#2b6a3c` | fg on them 11.2 / 5.5 |
| `--diff-del` / `--diff-del-word` | `#40201f` / `#7a2e2b` | fg on them 12.2 / 7.8 |

The grays carry a slight warm tint (stone rather than slate), a quiet
echo of the parchment without being beige.

**Why the primary button is ink, not vermilion.** Reliquary's most common
pair of buttons is Approve next to Reject. A vermilion Approve beside a
red Reject puts the same hue on opposite meanings, and vermilion
(`#c8302c`) is almost the same color as the danger red (`#cf222e`). A
near-black primary (as in Vercel's Geist) keeps red free to mean danger.
Vermilion stays on everything that says "this is Reliquary" or "you are
here". The alternative, a vermilion primary with danger shifted to
another hue, breaks a universal convention and is not recommended.

### Spacing, radius, shadow, size

```css
--space-1: 2px;  --space-2: 4px;  --space-3: 8px;  --space-4: 12px; --space-5: 16px;
--space-6: 24px; --space-7: 32px; --space-8: 40px; --space-9: 48px; --space-10: 64px;

--radius-sm: 4px;   /* badges, code spans, checkboxes */
--radius-md: 6px;   /* buttons, inputs, sidebar items, tabs' focus */
--radius-lg: 8px;   /* boxes, callouts, diff, menus, prose panels */
--radius-full: 999px; /* count pills */

--shadow-menu: 0 8px 24px -6px rgb(28 25 23 / 0.18), 0 0 0 1px var(--border);
/* dark: 0 8px 24px -6px rgb(0 0 0 / 0.6), 0 0 0 1px var(--border) */

--control-sm: 28px; --control-md: 36px;   /* heights, both above the 24px AA minimum */
--topbar-h: 56px;   --sidebar-w: 248px;   --content-max: 1280px; --measure: 72ch;
--focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--link);
```

Focus: `outline: 2px solid var(--link); outline-offset: 2px` on
`:focus-visible`, never removed. No `clip-path` anywhere, so nothing clips
the outline.

### Components

**Top bar.** Full width, 56px, `--bg-subtle`, 1px bottom border. Left: the
diamond mark (10px, `--brand`, rotated square) and "Reliquary" in 16px
600, sentence case. Then the main nav: Review (count pill), Vaults,
Activity, Connect, Tokens, in 14px 500 `--fg-muted`. Current item: `--fg`
with a 2px `--brand` bar under it, and `aria-current="page"` as today.
Right: an account `<details>` menu with the user's name, Theme (Auto /
Light / Dark as a form) and Sign out. Below 640px the nav moves to a
second row that scrolls sideways inside itself
(`overflow-x: auto`), so the page never does.

**Page header** (new `pageHeader()` in `html.ts`).

```
crumbs:   Acme vault / clients /
row:      [h1 title] [status badge]                [secondary] [secondary] [Primary]
meta:     By Hermes (agent) · 2 hours ago · Revision 2
tabs:     Preview  Source  History
```

- Title row is `display: flex; flex-wrap: wrap; justify-content:
  space-between; gap: 12px 24px`. Actions wrap under the title on narrow
  screens, left-aligned, still above the content.
- Actions: at most one primary, placed last. Rare or destructive actions
  go in a "More" `<details>` menu (ghost button with a caret).
- A button in the header may submit a form further down with
  `form="edit-form"`: no JavaScript, and Save sits at the top of a long
  editor as it does in GitHub's web editor *(unverified)*.
- Bottom border unless tabs follow, as in Primer.

**Buttons.** Height 36px (28px small), padding 0 14px, 14px 500, radius
6px, 1px border, sentence case, optional leading icon, no arrows.

| Variant | Light | Use |
|---|---|---|
| Primary | `--primary-bg` fill, white text | The one main action per page |
| Secondary | `--bg` fill, `--border-strong` border, `--fg` text | Everything else |
| Ghost | No fill or border, `--fg-muted` text, hover `--bg-muted` | Cancel, toolbar actions, "More" |
| Danger | `--bg` fill, `--danger` border and text; hover `--danger-bg` | Reject, Revoke, Delete |

Disabled buttons keep their label and explain why nearby, as Primer's
"inactive" guidance suggests.

**Inputs.** Height 36px, `--bg` fill, 1px `--border-strong`, radius 6px,
16px text (avoids iOS zoom). Hover `--fg-muted` border. Focus: the outline
above. Label 14px 600 above, hint 14px `--fg-muted` under the label,
"(optional)" on optional fields. Error: 14px `--danger` message above the
field, 2px `--danger` border, and an error summary box at the top of the
form linking to each field. Checkboxes and radios: native, with
`accent-color: var(--fg)`, 16px, the whole label clickable.

**Box, table and rows.** A `.box` is a 1px `--border`, 8px radius,
`--bg` container with an optional `--bg-subtle` header bar (title, count,
filters, actions). Tables inside a box: `th` 13px 600 `--fg-muted` on
`--bg-subtle`, sentence case; rows 40px, 1px `--border` between, hover
`--bg-subtle`; numbers and dates right-aligned with tabular figures.
Proposal lists use two-line rows: title link (16px 500) with status
badge, then meta in 14px muted.

**Badges.** `inline-flex`, 20px high, padding 0 8px, 12px 500, radius
4px, 1px border in the tone color at low alpha, tone background, tone
text. Tones: neutral, info, success, attention, danger. Canon: neutral
badge with a filled 6px diamond before "Canon". Open: neutral outline
with a hollow diamond before "Open". Counts use the full-round pill on
`--brand-strong` with white text in the nav, neutral elsewhere. Badges
are never links.

**Tabs.** Underline nav under the header: 14px 500 `--fg-muted`, 40px
high, current `--fg` 600 with a 2px `--brand` underline. Counts inside
tabs in a neutral pill ("Open 3").

**Callouts.** Replace `.flash`, `.note`, `.caution`, `.reveal`. 1px tone
border, tone background, radius 8px, padding 12px 16px, bold first
sentence. Tones: info (your own agent's proposal), success (saved,
applied), attention (risk reasons, stale), danger (errors). Flash
messages render as a callout at the top of `<main>` with `role="status"`,
or `role="alert"` for errors. The one-time token reveal is an attention
callout with the secret in a mono field.

**Diff.** A `.box` whose header holds the path, `+n −m` counts and a
segmented Rendered / Unified / Split switch (links styled as a button
group). Unified and split: mono 13px, 20px lines, a 48px line-number
gutter in `--fg-muted`, +/− markers, line tints from `--diff-add` and
`--diff-del`, word tints from the `-word` tokens. Folded lines: a
`--bg-subtle` strip, "Show 12 unchanged lines". Rendered: two prose panes,
labelled "Current" and "Proposed" in 14px 600 sentence case.

**Proposal review popover.** Header primary "Review changes" is a
`<details>` whose panel (`--shadow-menu`, 8px radius, 360px wide, right
aligned) holds the note textarea, three radios (Approve, Request changes,
Reject, with one-line descriptions as on GitHub) and a "Submit review"
button. Links from the Review inbox add `?review=1`, and the server then renders
the `<details>` with `open`. The full-width form after the thread stays
for people who read to the end.

**Sidebar.** 248px, `--bg-subtle`, right border, sticky under the top bar.
Vault name 16px 600, search input, section links (Files, Proposals n,
Activity, Rules) as 32px items with 6px radius: hover `--bg-muted`,
current `--bg-muted`, `--fg` 600 and a 2px `--brand` bar on the left.
The tree under it in 14px, with diamond marks for canon/open. Below
768px it collapses into the existing `<details>` "Browse vault", styled
as a secondary button.

**Empty state.** Inside its section: dashed 1px `--border-strong` box,
8px radius, centered, 24px padding, a short title ("No files yet."), one
line on when content appears, and the matching action as a secondary
button. Filtered-to-zero shows "No results match these filters" and a
"Clear filters" link, no create button.

### Brand signatures to keep

| Keep | How |
|---|---|
| Vermilion | Only for the logo mark, current-page bars (top nav, sidebar, tabs), the Review count pill and text selection. Never for text, links or status |
| The diamond | Logo mark and favicon; filled and hollow diamonds for canon and open in the tree, badges and rule line. The one shape with a product meaning |
| Warm neutrals | Stone-tinted grays instead of cool slate, a trace of parchment |
| The name | "Reliquary" in sentence case, 600, next to the diamond. Footer drops "Red Mage" |

Dropped: Bebas Neue, Barlow, uppercase labels, cut corners, the arrow on
primary buttons, parchment backgrounds.

## 4. Migration plan

Other work is in flight in `web/src`, so each step is a small, separate
commit that keeps `./web/test.sh` green. Tests assert text and structure,
not classes, so most steps need no test changes; check before merging.

| Step | Change | Files |
|---|---|---|
| 1 | Tokens and base. Replace the `:root` blocks with the tokens above (light, dark media query, `data-theme="dark"`). Add Inter `@font-face`; remove Bebas and Barlow files and preloads. Body font, sizes, focus ring. Remove every `text-transform: uppercase`, `letter-spacing` on labels, `clip-path`, `.facet`, `.primary::after`. Update the stylesheet header comment | `style.css`, `public/fonts/`, `html.ts` (preload) |
| 2 | Top bar and account menu. Full-width bar with the new nav; theme form moves from the footer into a `<details>` menu; footer keeps only small print without "Red Mage" | `html.ts` `page()` |
| 3 | Page header helper. `pageHeader({ crumbs, title, badge, meta, actions, tabs })` returning `Raw`; `h1` always the same style (retire `h1.path`) | `html.ts` |
| 4 | Move each page onto `pageHeader` with actions top right: Home, Review, vault and folder (New file, Connect an agent), file (Edit or Propose a change; More: History, Delete), Rules (Add rule), Tokens (New token), Activity, Connect, Search | `pages.ts`, `activity.ts` |
| 5 | Editors: `id="edit-form"` on the form, Save and Cancel in the header with `form="edit-form"`, keep a Save at the end. Move "Delete this file" off the edit page into the file page's More menu, through a confirm page | `pages.ts` |
| 6 | Proposal page: header with status badge and "Review changes" popover; Edit, then approve as a secondary header button; risk reasons as attention badges; keep the bottom form | `pages.ts`, `thread.ts` |
| 7 | Components: buttons, inputs, badges (replace `.tag`, `.state`, `.risks`), callouts (replace `.flash`, `.note`, `.reveal`, `.caution`), `.box` around tables and lists, empty states | `style.css`, small markup changes in `pages.ts` |
| 8 | Diff: box header with counts and the view switch, mono for unified and split, line-number gutter, new add/del tokens | `diffview.ts`, `style.css` |
| 9 | Sidebar restyle and diamond marks in the tree; mobile `<details>` as a button | `pages.ts` `vaultShell`, `style.css` |
| 10 | Forms: error summary plus inline errors, "(optional)" labels. Needs routes to return the form with values instead of redirecting with a flash, so it is its own change | `pages.ts`, `server.ts` |
| 11 | Docs: update ux-patterns.md "Where we are", `web/README.md`, and AGENTS.md's done list | docs |

### As built (2026-09-24)

Where the build differs from the plan above, and why:

- **No "Review changes" popover.** Superseded by the owner's decision in
  ux-patterns.md ("Controls at the top"): the decision form (note, Approve,
  Request changes, Reject) stays visible under the header without opening
  anything, as a compact box; "Edit, then approve" is the header's
  secondary action. No `?review=1`.
- **Nav order stays Vaults, Review, Activity, Connect, Tokens**, as
  ux-patterns.md and the tests have it, not Review first.
- **Measure is 60ch, not 72ch.** In Inter, `ch` (the width of a zero) is
  wider than an average letter; 60ch is about 75 characters a line, which
  the Impeccable detector and the usual 65 to 75 guidance want.
- **Page titles stay 24px on phones** instead of dropping to 20px: with
  `h2` at 18px, 20px left no clear step between them.
- **Unified diff rows are 24px** (18px lines plus 3px above and below), so
  the tint doesn't sit flush on the text.
- **Delete stays on the edit page**, in a bordered danger section, rather
  than moving to a More menu with a confirm page: that is a new route, left
  for the forms change (step 10).
- **Font files:** `@fontsource-variable/inter` 5.3.0, latin subset. Upright
  is the `opsz` + `wght` file (73 KB), so titles get Inter's display cut
  automatically; italic is `wght` only (52 KB, loaded only when used).
- **Favicon**: the vermilion diamond, `public/favicon.svg`.
- **Checks:** `web/test/contrast.test.mjs` parses the three token blocks,
  asserts every pair in the tables above (and the diff and callout pairs
  the CSS uses) in both themes, and that the explicit dark theme matches the
  automatic one. The detector is clean on the main pages in light, dark and
  at 390px, except `overused-font` for Inter, which this design chooses on
  purpose (waived in `style.css`).

### What to test after each step

| Check | How | Pass |
|---|---|---|
| End-to-end | `./web/test.sh` | Green |
| Impeccable detector | `~/Projects/repositio-arcanum/.claude/skills/impeccable/scripts/impeccable detect web/public/style.css` and against the running server's pages (`detect <url>`) | No new findings; note any that the design accepts |
| Contrast | Recompute every token pair in both themes (a small script in `web/test/` that parses the `:root` blocks and asserts the table above) | Text ≥4.5, large text and UI parts ≥3 |
| 375px mobile | Browser at 375 by 812 on Home, a folder, a file, a proposal with a split diff, Tokens, Activity | No page-level horizontal scroll; header actions visible without scrolling; nav row scrolls inside itself |
| Keyboard | Tab through each page from the top | Skip link to main (add one), visible focus on every control, `<details>` menus open with Enter and Space, the Review popover reachable before the diff, order matches reading order, focus not hidden under the sticky bar or sidebar |
| Targets | Inspect smallest controls (tree links, count pills, snooze buttons) | ≥24 by 24px or spaced per WCAG 2.5.8 |
| Zoom and text | 200% zoom, and 400% at 1280px wide | No lost content or overlap; header wraps |
| Themes | Auto, Light, Dark, and OS dark with `data-theme="light"` | Every token defined in all three |
| No JavaScript | CSP unchanged (`script-src` none) | Menus, popovers and tabs work with scripts off |
| Hallway test | Two people who haven't seen Reliquary: "approve the pending proposal", "make a read-only token", "find who changed clients/acme.md" | Each done without help, no scrolling to find the control |
