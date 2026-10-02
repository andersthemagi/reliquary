// The work plan block (docs/design.md "Claims and work plans", item 6):
// a fenced ```work_plan block inside a plan file, listing a work plan's
// steps. This module only knows the grammar -- find the block, parse it
// into steps, or refuse with the line and reason. Registering a parsed
// plan into the database (cycles re-checked there too, item 12's "one way
// in") is CL-3.2, not here.
//
// Grammar, chosen for a person reading the plan file as much as a parser:
// each step opens with "- key: <key>", then zero or more two-space
// "field: value" lines (title, blocked_by, cites, gate), until the next
// "- key:" or the block's closing fence. blocked_by is a comma-separated
// list of other steps' keys; cites is a comma-separated list of
// "path@version" (version a file version id, matching tools-shared.ts's
// VERSION); gate, if given, is "review" (docs/design.md item 7). No
// nesting, no quoting: a strict, small syntax over a flexible one, the
// same choice web/scripts/docs-lib.mjs's parseRoadmap already made for
// roadmap.yml.

const FENCE_OPEN = "```work_plan";
const FENCE_CLOSE = "```";
const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_RE = /^[0-9a-fA-F-]{36}$/; // tools-shared.ts's VERSION
const TITLE_MAX = 200; // docs/design.md item 8, confirmed by the maintainer
const FIELDS = ["title", "blocked_by", "cites", "gate"] as const;

export type WorkPlanCite = { path: string; version: string };
export type WorkPlanStep = {
  key: string;
  title: string;
  blockedBy: string[];
  cites: WorkPlanCite[];
  gate: "review" | null;
  line: number; // the line its "- key:" opened on, 1-based
};
export type WorkPlan = { steps: WorkPlanStep[] };
export type WorkPlanParseResult = { ok: true; plan: WorkPlan } | { ok: false; errors: string[] };

export function parseWorkPlanBlock(fileText: string): WorkPlanParseResult {
  const lines = fileText.split("\n").map((l) => l.replace(/\r$/, ""));
  let openLine = -1;
  let closeLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== FENCE_OPEN) continue;
    if (openLine === -1) {
      openLine = i;
      continue;
    }
    return { ok: false, errors: [`line ${i + 1}: a second ${FENCE_OPEN} block (the first opened at line ${openLine + 1}); a plan file has exactly one`] };
  }
  if (openLine === -1) return { ok: false, errors: [`no ${FENCE_OPEN} block in this file`] };
  for (let i = openLine + 1; i < lines.length; i++) {
    if (lines[i] === FENCE_CLOSE) {
      closeLine = i;
      break;
    }
  }
  if (closeLine === -1) return { ok: false, errors: [`line ${openLine + 1}: unterminated ${FENCE_OPEN} block (no closing ${FENCE_CLOSE})`] };

  const errors: string[] = [];
  const steps: WorkPlanStep[] = [];
  let cur: WorkPlanStep | null = null;
  const seenFields = new Set<string>();

  const finish = () => {
    if (!cur) return;
    if (!seenFields.has("title")) errors.push(`line ${cur.line}: step "${cur.key}" has no title`);
    steps.push(cur);
  };

  for (let i = openLine + 1; i < closeLine; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    if (/^\s*$/.test(raw)) continue;

    const open = /^- key:\s*(.*)$/.exec(raw);
    if (open) {
      finish();
      const key = open[1].trim();
      if (!KEY_RE.test(key)) {
        errors.push(`line ${lineNo}: "${key}" isn't a valid step key (lowercase letters, digits and hyphens, e.g. "fetch-data")`);
      }
      cur = { key, title: "", blockedBy: [], cites: [], gate: null, line: lineNo };
      seenFields.clear();
      continue;
    }

    const field = /^  ([a-z_]+):\s*(.*)$/.exec(raw);
    if (!field) {
      errors.push(`line ${lineNo}: expected "- key: ..." or an indented field ("  name: value")`);
      continue;
    }
    if (!cur) {
      errors.push(`line ${lineNo}: a field before any step ("- key: ..." must come first)`);
      continue;
    }
    const [, name] = field;
    const value = field[2].trim();
    if (!(FIELDS as readonly string[]).includes(name)) {
      errors.push(`line ${lineNo}: unknown field "${name}" (expected ${FIELDS.join(", ")})`);
      continue;
    }
    if (seenFields.has(name)) {
      errors.push(`line ${lineNo}: step "${cur.key}" already has a ${name}`);
      continue;
    }
    seenFields.add(name);

    if (name === "title") {
      if (!value) errors.push(`line ${lineNo}: title can't be empty`);
      else if (value.length > TITLE_MAX) errors.push(`line ${lineNo}: title is longer than ${TITLE_MAX} characters`);
      else cur.title = value;
    } else if (name === "blocked_by") {
      const keys = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      if (!keys.length) errors.push(`line ${lineNo}: blocked_by has no steps (remove the field instead)`);
      for (const k of keys) {
        if (!KEY_RE.test(k)) errors.push(`line ${lineNo}: blocked_by has an invalid step key "${k}"`);
      }
      cur.blockedBy = keys;
    } else if (name === "cites") {
      const entries = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      if (!entries.length) errors.push(`line ${lineNo}: cites has no entries (remove the field instead)`);
      for (const entry of entries) {
        const at_ = entry.lastIndexOf("@");
        const version = at_ === -1 ? "" : entry.slice(at_ + 1).trim();
        const path = (at_ === -1 ? entry : entry.slice(0, at_)).trim();
        if (!path || !VERSION_RE.test(version)) {
          errors.push(`line ${lineNo}: cites entry "${entry}" isn't "path@version"`);
          continue;
        }
        cur.cites.push({ path, version });
      }
    } else if (name === "gate") {
      if (value !== "review") errors.push(`line ${lineNo}: gate must be "review"`);
      else cur.gate = "review";
    }
  }
  finish();

  const byKey = new Map<string, WorkPlanStep>();
  for (const s of steps) {
    if (byKey.has(s.key)) errors.push(`line ${s.line}: duplicate step key "${s.key}" (first used at line ${byKey.get(s.key)!.line})`);
    else byKey.set(s.key, s);
  }

  for (const s of steps) {
    for (const ref of s.blockedBy) {
      if (!byKey.has(ref)) errors.push(`line ${s.line}: step "${s.key}" is blocked by unknown step "${ref}"`);
    }
  }

  const cycle = findCycle(byKey);
  if (cycle) {
    const [first, ...rest] = cycle;
    const line = byKey.get(first)!.line;
    if (cycle.length === 1) errors.push(`line ${line}: step "${first}" can't be blocked by itself`);
    else errors.push(`line ${line}: a cycle in blocked_by: ${[first, ...rest].join(" -> ")}`);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, plan: { steps } };
}

// One cycle among defined keys (ignoring an unknown blocker, reported on
// its own above), by depth-first search with a white/gray/black coloring;
// returns the cycle as an ordered list of keys, or null. Stops at the
// first back edge: enough to refuse registration, not an enumeration of
// every cycle in the graph.
function findCycle(byKey: Map<string, WorkPlanStep>): string[] | null {
  const color = new Map<string, 0 | 1 | 2>(); // 1 = in progress, 2 = done
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    color.set(key, 1);
    stack.push(key);
    for (const ref of byKey.get(key)!.blockedBy) {
      if (!byKey.has(ref)) continue;
      const c = color.get(ref) ?? 0;
      if (c === 1) return stack.slice(stack.indexOf(ref));
      if (c === 0) {
        const found = visit(ref);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(key, 2);
    return null;
  };
  for (const key of byKey.keys()) {
    if ((color.get(key) ?? 0) === 0) {
      const found = visit(key);
      if (found) return found;
    }
  }
  return null;
}

// The canonical text form of a parsed plan: what a round trip through
// parseWorkPlanBlock should reproduce, field for field. Field order
// matches the grammar comment above; a step with no blocked_by, cites or
// gate omits those lines rather than writing them empty.
export function renderWorkPlanBlock(plan: WorkPlan): string {
  const lines = [FENCE_OPEN];
  for (const step of plan.steps) {
    lines.push(`- key: ${step.key}`, `  title: ${step.title}`);
    if (step.blockedBy.length) lines.push(`  blocked_by: ${step.blockedBy.join(", ")}`);
    if (step.cites.length) lines.push(`  cites: ${step.cites.map((c) => `${c.path}@${c.version}`).join(", ")}`);
    if (step.gate) lines.push(`  gate: ${step.gate}`);
  }
  lines.push(FENCE_CLOSE);
  return lines.join("\n");
}
