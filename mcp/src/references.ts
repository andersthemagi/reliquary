// References between files (docs/public/concepts/vaults-and-files.md,
// "References between files"; docs/design.md, "Encryption at rest", section
// 5; #464): the vault paths a file's text points at, found by the server
// that writes the version, since SQL can't read a sealed body. Passed as
// p_references to write_file, decide and edit_and_approve, which replace
// the file's rows. Deterministic: no model, no outbound call. The same file
// as mcp/src/references.ts.
//
// [[path]] and [[path|label]] are from the vault's root, and one with no
// extension means the .md file, as Obsidian reads them. Markdown links are
// relative to the source's folder unless they start with "/", and only
// links to .md files count. "#anchor" and "?query" are dropped; a URL (any
// "scheme:"), an anchor alone, a path that climbs above the root and the
// source itself are not references. "![[...]]" and "![...](...)" are
// embedded images.
// ponytail: references inside code blocks count too; skip fenced code if
// that turns out to mislead.

const WIKI = /(?<!!)\[\[([^\]|\n]*)(?:\|[^\]\n]*)?\]\]/g;
const LINK = /(?<!!)\[[^\]\n]*\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\)/g;

function target(source: string, ref: string, wiki: boolean): string | null {
  let t = ref.split("#")[0].split("?")[0].replaceAll("%20", " ").trim();
  if (t === "" || /^[a-z][a-z0-9+.-]*:/i.test(t)) return null;
  if (wiki) {
    if (!/\.[^/.]+$/.test(t)) t += ".md";
  } else if (!/\.md$/i.test(t)) {
    return null;
  } else if (!t.startsWith("/")) {
    t = source.replace(/[^/]*$/, "") + t;
  }
  const parts: string[] = [];
  for (const seg of t.split("/")) {
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else if (seg !== "" && seg !== ".") {
      parts.push(seg);
    }
  }
  t = parts.join("/");
  if (t === "" || t === source || t.length > 1024) return null;
  return t;
}

// The vault paths a file's text refers to, each once, sorted.
export function referencesIn(source: string, body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(WIKI)) {
    const t = target(source, m[1], true);
    if (t) out.add(t);
  }
  for (const m of body.matchAll(LINK)) {
    const t = target(source, m[1] ?? m[2], false);
    if (t) out.add(t);
  }
  return [...out].sort();
}
