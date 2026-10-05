// Contrast of the design tokens in public/style.css, in every theme: the
// light :root block, the dark prefers-color-scheme block and the explicit
// data-theme="dark" block (which must match it). WCAG 2 ratios: text 4.5,
// UI parts (input borders, focus ring, current-page bars) 3.
// Pairs follow docs/research/ui-design-system.md and where the CSS uses them.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(re) {
  const m = re.exec(css);
  assert.ok(m, `missing block ${re}`);
  const vars = {};
  for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)) vars[k] = v.toLowerCase();
  return vars;
}

const light = block(/^:root\s*\{([\s\S]*?)\n\}/m);
const darkAuto = block(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n\s*\}/);
const darkSet = block(/^:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/m);
const dark = { ...light, ...darkAuto };

function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// [foreground, background, minimum]
const TEXT = 4.5;
const UI = 3;
const PAIRS = [
  ["fg", "bg", TEXT], ["fg", "bg-subtle", TEXT], ["fg", "bg-muted", TEXT],
  ["fg-muted", "bg", TEXT], ["fg-muted", "bg-subtle", TEXT], ["fg-muted", "bg-muted", TEXT],
  ["link", "bg", TEXT], ["link", "bg-subtle", TEXT], ["link", "info-bg", TEXT],
  ["primary-fg", "primary-bg", TEXT], ["primary-fg", "primary-hover", TEXT],
  ["on-brand", "brand-strong", TEXT],
  ["success", "bg", TEXT], ["success", "success-bg", TEXT], ["success", "bg-subtle", TEXT],
  ["attention", "bg", TEXT], ["attention", "attention-bg", TEXT],
  ["danger", "bg", TEXT], ["danger", "danger-bg", TEXT], ["danger", "bg-subtle", TEXT],
  ["info", "info-bg", TEXT],
  ["fg", "info-bg", TEXT], ["fg", "attention-bg", TEXT], ["fg-muted", "attention-bg", TEXT],
  ["fg", "diff-add", TEXT], ["fg", "diff-del", TEXT],
  ["fg-muted", "diff-add", TEXT], ["fg-muted", "diff-del", TEXT],
  ["diff-word-fg", "diff-add-word", TEXT], ["diff-word-fg", "diff-del-word", TEXT],
  ["border-strong", "bg", UI], ["border-strong", "bg-subtle", UI],
  ["link", "bg", UI], ["brand", "bg", UI], ["brand", "bg-subtle", UI], ["danger", "bg", UI],
];

export function check(name, t) {
  const rows = [];
  for (const [f, b, min] of PAIRS) {
    assert.ok(t[f] && t[b], `${name}: --${f} or --${b} is not defined`);
    rows.push({ pair: `${f} on ${b}`, ratio: ratio(t[f], t[b]), min });
  }
  return rows;
}

for (const [name, t] of [["light", light], ["dark", dark]]) {
  test(`contrast: every token pair meets WCAG AA in the ${name} theme`, () => {
    const low = check(name, t).filter((r) => r.ratio < r.min);
    assert.deepEqual(low.map((r) => `${r.pair} ${r.ratio.toFixed(2)} < ${r.min}`), []);
  });
}

// "Set" in an empty variable cell is faded until hover, with a pointer; the
// blend of its muted text over the cell is what a person sees at rest.
for (const [name, t] of [["light", light], ["dark", dark]]) {
  test(`contrast: the faded Set in an empty variable cell stays visible, 3:1 over the cell, in the ${name} theme`, () => {
    const alpha = Number(/\.var-grid \.var-add \{ opacity: ([\d.]+);/.exec(css)?.[1]);
    assert.ok(alpha > 0 && alpha < 1, "faded, not hidden");
    const blend = (i) => Math.round(alpha * parseInt(t["fg-muted"].slice(i, i + 2), 16) + (1 - alpha) * parseInt(t.bg.slice(i, i + 2), 16));
    const seen = `#${[1, 3, 5].map((i) => blend(i).toString(16).padStart(2, "0")).join("")}`;
    assert.ok(ratio(seen, t.bg) >= UI, `${seen} on ${t.bg} is ${ratio(seen, t.bg).toFixed(2)}`);
  });
}

test("contrast: the explicit dark theme matches the automatic one", () => {
  assert.deepEqual(darkSet, darkAuto);
});

if (process.env.CONTRAST_REPORT) {
  for (const [name, t] of [["light", light], ["dark", dark]]) {
    console.log(`\n${name}`);
    for (const r of check(name, t)) console.log(`  ${r.pair.padEnd(34)} ${r.ratio.toFixed(2).padStart(6)}  (min ${r.min})`);
  }
}
