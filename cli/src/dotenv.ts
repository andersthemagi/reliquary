// Parsing a .env file (docs/variables.md, "Imports"). The same file is in
// web/src/dotenv.ts (the Variables page's paste) and cli/src/dotenv.ts
// (`reliquary env push`); cli/test checks they are identical, and both
// suites run web/test/dotenv-vectors.json. Change both, or neither.
//
// The syntax, as dotenv tools write it:
//   - a UTF-8 byte order mark at the start is dropped; lines end in LF, CRLF
//     or CR;
//   - blank lines and lines starting with # are skipped;
//   - `export ` before a name is allowed and ignored;
//   - NAME=value, with spaces around the = and before the value ignored;
//   - unquoted values end at the line's end or at a # after a space or tab
//     (a comment), trailing spaces dropped; an = inside is kept;
//   - "double quotes" take the escapes \n \r \t \" \\ and \$ (any other
//     backslash is kept as it is), and may span lines;
//   - 'single quotes' and `backticks` are literal, and may span lines;
//   - after a closing quote only spaces and a # comment may follow;
//   - no ${VAR} expansion: every value is taken as written.
//
// A line that isn't taken is refused with its number and a reason, and its
// name only when the name is a well-formed variable name. A refusal never
// holds any of the value, and neither does anything else this returns but
// the entries themselves. A quote that is never closed stops the parse
// there, so the rest of a value can't be read as more variables.

export type DotenvEntry = { line: number; name: string; value: string };
export type DotenvRefusal = { line: number; name: string | null; reason: string };
export type DotenvResult = { entries: DotenvEntry[]; refused: DotenvRefusal[] };

export const DOTENV_MAX_BYTES = 512 * 1024;
export const DOTENV_MAX_LINES = 5000;
export const DOTENV_MAX_ENTRIES = 200;
export const DOTENV_MAX_VALUE_BYTES = 64 * 1024;

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// Names that change how a program starts or finds its code: the database
// refuses them (private.valid_variable_name), so they're refused here first.
const STARTUP_PREFIXES = ["LD_", "DYLD_", "BASH_FUNC_", "GIT_CONFIG_"];
const STARTUP_NAMES = new Set(
  (
    "PATH HOME SHELL USER IFS ENV BASH_ENV PS4 PROMPT_COMMAND SHELLOPTS BASHOPTS CDPATH NODE_OPTIONS NODE_PATH " +
    "PYTHONPATH PYTHONSTARTUP PYTHONHOME PERL5OPT PERL5LIB PERLLIB RUBYOPT RUBYLIB JAVA_TOOL_OPTIONS _JAVA_OPTIONS " +
    "JDK_JAVA_OPTIONS CLASSPATH GIT_SSH GIT_SSH_COMMAND GIT_EXEC_PATH GIT_ASKPASS SSH_ASKPASS EDITOR VISUAL PAGER TMPDIR"
  ).split(" "),
);

export const isVariableName = (n: string) => NAME.test(n);
export const startsPrograms = (n: string) =>
  STARTUP_NAMES.has(n.toUpperCase()) || STARTUP_PREFIXES.some((p) => n.toUpperCase().startsWith(p));

// Why a whole text can't be parsed (too big), or null.
export function dotenvTooBig(text: string): string | null {
  if (Buffer.byteLength(text, "utf8") > DOTENV_MAX_BYTES) return `the file is over ${DOTENV_MAX_BYTES / 1024} KiB`;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  if (lines > DOTENV_MAX_LINES) return `the file has over ${DOTENV_MAX_LINES} lines`;
  return null;
}

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\", $: "$" };
const QUOTE_NAME: Record<string, string> = { '"': "double quote", "'": "single quote", "`": "backtick" };

export function parseDotenv(text: string): DotenvResult {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  const found: DotenvEntry[] = [];
  const refused: DotenvRefusal[] = [];
  const refuse = (line: number, name: string | null, reason: string) => refused.push({ line, name, reason });

  let i = 0;
  parse: while (i < lines.length) {
    const lineNo = i + 1;
    let s = lines[i++].replace(/^[ \t]+/, "");
    if (s === "" || s.startsWith("#")) continue;
    s = s.replace(/^export[ \t]+/, "");
    const eq = s.indexOf("=");
    if (eq === -1) {
      refuse(lineNo, null, "not NAME=value (no = sign)");
      continue;
    }
    const key = s.slice(0, eq).replace(/[ \t]+$/, "");
    const named = NAME.test(key) ? key : null;
    const after = s.slice(eq + 1);
    const rest = after.replace(/^[ \t]+/, "");
    let value: string;

    const q = rest[0];
    if (q === '"' || q === "'" || q === "`") {
      let buf = "";
      let cur = rest.slice(1);
      let tail: string | null = null;
      for (;;) {
        for (let j = 0; j < cur.length; j++) {
          const c = cur[j];
          if (q === '"' && c === "\\" && j + 1 < cur.length) {
            const e = cur[j + 1];
            buf += ESCAPES[e] ?? `\\${e}`;
            j++;
            continue;
          }
          if (c === q) {
            tail = cur.slice(j + 1);
            break;
          }
          buf += c;
        }
        if (tail !== null || i >= lines.length) break;
        buf += "\n";
        cur = lines[i++];
      }
      if (tail === null) {
        refuse(lineNo, named, `the ${QUOTE_NAME[q]} opened here is never closed, so nothing from line ${lineNo} on was read`);
        break parse;
      }
      if (!/^[ \t]*(#.*)?$/.test(tail)) {
        refuse(lineNo, named, "text after the closing quote");
        continue;
      }
      value = buf;
    } else if (/^[ \t]+#/.test(after)) {
      value = ""; // only a comment after the =
    } else {
      const hash = rest.search(/[ \t]#/);
      value = (hash === -1 ? rest : rest.slice(0, hash)).replace(/[ \t]+$/, "");
    }

    if (!named) {
      refuse(lineNo, null, "the name isn't letters, digits and underscores (not starting with a digit, at most 128)");
    } else if (startsPrograms(key)) {
      refuse(lineNo, key, "changes how programs start, so it can't be a shared variable");
    } else if (value === "") {
      refuse(lineNo, key, "no value");
    } else if (value.includes("\u0000")) {
      refuse(lineNo, key, "the value holds a NUL character");
    } else if (Buffer.byteLength(value, "utf8") > DOTENV_MAX_VALUE_BYTES) {
      refuse(lineNo, key, "the value is over 64 KiB");
    } else {
      found.push({ line: lineNo, name: key, value });
    }
  }

  // A name given twice: the later one is used, like a shell would.
  const last = new Map<string, number>();
  found.forEach((e, n) => last.set(e.name, n));
  const entries: DotenvEntry[] = [];
  found.forEach((e, n) => {
    const later = found[last.get(e.name)!];
    if (last.get(e.name) !== n) refuse(e.line, e.name, `given again on line ${later.line}, which is used`);
    else if (entries.length >= DOTENV_MAX_ENTRIES) refuse(e.line, e.name, `over ${DOTENV_MAX_ENTRIES} variables; import the rest separately`);
    else entries.push(e);
  });
  refused.sort((a, b) => a.line - b.line);
  return { entries, refused };
}
