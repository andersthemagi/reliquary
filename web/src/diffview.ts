// The evidence section of a proposal page: Unified, Split and Rendered views
// of a change, chosen with ?diff= links (no script: the CSP forbids it).
// Text is escaped through html``; rendered markdown goes through
// renderMarkdown, which escapes raw HTML.

import { diffLines, fold, splitRows, type DiffLine, type SplitRow } from "./diff.js";
import { html, raw, type Raw } from "./html.js";
import { renderMarkdown } from "./markdown.js";

export const DIFF_MODES = ["unified", "split", "rendered"] as const;
export type DiffMode = (typeof DIFF_MODES)[number];

// ?diff=unified|split|rendered; the older ?view=result means rendered.
export function diffMode(params: URLSearchParams): DiffMode {
  const d = params.get("diff");
  if (DIFF_MODES.includes(d as DiffMode)) return d as DiffMode;
  return params.get("view") === "result" ? "rendered" : "unified";
}

// Line text with changed words in <del>/<ins>.
function words(l: DiffLine): Raw {
  if (!l.segs) return html`${l.text}`;
  const tag = l.kind === "del" ? "del" : "ins";
  return html`${l.segs.map((s) => (s.changed ? html`${raw(`<${tag}>`)}${s.text}${raw(`</${tag}>`)}` : html`${s.text}`))}`;
}

const folded = (n: number, rows: Raw) =>
  html`<details class="fold"><summary>${n} unchanged line${n === 1 ? "" : "s"}</summary>${rows}</details>`;

// Unified: both line numbers in a gutter (hidden from screen readers), then
// the line, marked + or - by its class.
export function unified(lines: DiffLine[]): Raw {
  const line = (l: DiffLine) =>
    html`<div class="${l.kind}"><span class="ln" aria-hidden="true">${l.a ?? ""}</span><span class="ln" aria-hidden="true">${l.b ?? ""}</span><span>${words(l)}</span></div>`;
  return html`<div class="diff unified" aria-label="Changes">${fold(lines, (l) => l.kind === "same").map((c) =>
    c.fold ? folded(c.items.length, html`${c.items.map(line)}`) : html`${c.items.map(line)}`,
  )}</div>`;
}

export function split(lines: DiffLine[]): Raw {
  const cell = (l: DiffLine | undefined, side: "a" | "b") =>
    l
      ? html`<span class="ln" aria-hidden="true">${side === "a" ? l.a : l.b}</span><span class="${l.kind}">${words(l)}</span>`
      : html`<span class="ln" aria-hidden="true"></span><span class="none"></span>`;
  const row = (r: SplitRow) => html`<div class="row">${cell(r.left, "a")}${cell(r.right, "b")}</div>`;
  const same = (r: SplitRow) => r.left?.kind === "same";
  return html`<div class="split-scroll"><div class="diff split" aria-label="Changes, side by side">
    <div class="row head"><span></span><span>Current</span><span></span><span>Proposed</span></div>
    ${fold(splitRows(lines), same).map((c) =>
      c.fold ? folded(c.items.length, html`${c.items.map(row)}`) : html`${c.items.map(row)}`,
    )}</div></div>`;
}

export function rendered(current: string | null, proposed: string | null): Raw {
  const panel = (label: string, cls: string, body: string | null, missing: string) =>
    html`<section class="${cls}" aria-label="${label}"><h2 class="pane-label">${label}</h2>${
      body === null ? html`<div class="empty">${missing}</div>` : html`<div class="prose entry">${raw(renderMarkdown(body))}</div>`
    }</section>`;
  return html`<div class="rendered">
    ${panel("Proposed", "proposed", proposed, "This proposal deletes the file.")}
    ${panel("Current", "current", current, "There’s no current version: this creates the file.")}
  </div>`;
}

// The whole section, in one bordered box: a header with the change counts
// and the view switch, then the chosen view. `href` builds the link for each
// mode. `before` is null for a new file; `after` null for a delete.
export function diffSection(opts: {
  before: string | null;
  after: string | null;
  mode: DiffMode;
  href: (mode: DiffMode) => string;
}): Raw {
  const { before, after, mode } = opts;
  const label: Record<DiffMode, string> = { unified: "Unified", split: "Split", rendered: "Rendered" };
  const lines = diffLines(before ?? "", after ?? "");
  const added = lines?.filter((l) => l.kind === "add").length ?? 0;
  const removed = lines?.filter((l) => l.kind === "del").length ?? 0;
  const stat = lines
    ? html`<p class="diff-stat"><span class="plus">+${added}</span> <span class="minus">\u2212${removed}</span> <span class="muted">lines</span></p>`
    : html`<p class="diff-stat muted">Whole-file replacement</p>`;
  const head = html`<div class="diff-head">${stat}<nav class="segmented" aria-label="Diff view">${DIFF_MODES.map(
    (m) => html`<a href="${opts.href(m)}#changes"${m === mode ? raw(' aria-current="page"') : ""}>${label[m]}</a>`,
  )}</nav></div>`;
  const view =
    mode === "rendered"
      ? rendered(before, after)
      : !lines
        ? html`<p class="diff-note muted">Too large to compare line by line. Read it as a whole-file replacement: this is the full proposed text.</p>
      <div class="file">${after ?? ""}</div>`
        : mode === "split"
          ? split(lines)
          : unified(lines);
  return html`<section class="diff-box" id="changes" aria-label="Proposed change">${head}${view}</section>`;
}
