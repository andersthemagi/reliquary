// `reliquary env pull`: an environment into a dotenv file that git ignores.
//
// The guardrail (AGENTS.md) is "only into a gitignored .env", so the file
// must be inside a git work tree and ignored there (`git check-ignore`
// exits 0; a tracked file never is). Outside any repository it is refused
// too, unless the person passes --outside-repo, saying they know. Written
// with mode 0600, atomically where the temporary name is ignored as well.
// Prints the file and the names, never a value.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, ftruncateSync, lstatSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { CliError } from "./errors.js";

// docs/variables.md: NAME="value", escaping \ " newline and carriage return.
export function escapeValue(v: string): string {
  return v.replace(/[\\"\n\r]/g, (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r" })[c]!);
}

// Header text comes from the server (a vault's name): keep it on one line.
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ");

export function formatDotenv(
  variables: Map<string, string>,
  source: { server: string; vaultName: string; vaultId: string; environment: string; at: Date },
): string {
  const lines = [
    `# Environment variables from Reliquary: vault "${oneLine(source.vaultName)}" (${source.vaultId}), environment ${source.environment}, ${source.server}.`,
    `# Written by \`reliquary env pull\` at ${source.at.toISOString()}. Keep it out of git; pull again to update it.`,
  ];
  for (const [name, value] of variables) lines.push(`${name}="${escapeValue(value)}"`);
  return lines.join("\n") + "\n";
}

type Git = { status: number | null; stdout: string; missing: boolean };
function git(cwd: string, args: string[]): Git {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return { status: r.status, stdout: r.stdout ?? "", missing };
}

// Where to write, and whether the temporary name is safe too. Throws with a
// fix when the file isn't ignored.
export function checkTarget(file: string, outsideRepo: boolean): { abs: string; tmp: string | null } {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  try {
    if (!statSync(dir).isDirectory()) throw new Error();
  } catch {
    throw new CliError(`${dir} isn't a directory.`);
  }
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new CliError(`${file} is a symbolic link; pull into a plain file.`);
    if (!st.isFile()) throw new CliError(`${file} isn't a regular file.`);
  } catch (err) {
    if (err instanceof CliError) throw err;
    // doesn't exist yet: fine
  }
  const tmpBase = `${base}.reliquary-${randomBytes(4).toString("hex")}.tmp`; // ignored by ".env*" or ".env.*"

  const inside = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.missing) {
    if (outsideRepo) return { abs, tmp: path.join(dir, tmpBase) };
    throw new CliError("git isn't installed, so reliquary can't check that the file is ignored. Pass --outside-repo if this directory isn't in a repository.");
  }
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    if (outsideRepo) return { abs, tmp: path.join(dir, tmpBase) };
    throw new CliError(
      `${dir} isn't in a git repository, so nothing says ${base} stays private. Pull inside your project (with ${base} in .gitignore), or pass --outside-repo if you mean it.`,
    );
  }
  // Exit 0: ignored. 1: not ignored, or tracked (tracked files are never
  // reported as ignored). Anything else: git couldn't say.
  const ignored = git(dir, ["check-ignore", "-q", "--", base]);
  if (ignored.status === 1) {
    throw new CliError(
      `${file} isn't ignored by git (or it's tracked), so its values could be committed. Add it to .gitignore (and \`git rm --cached ${base}\` if it's tracked), then pull again.`,
    );
  }
  if (ignored.status !== 0) throw new CliError(`git couldn't say whether ${file} is ignored; refusing to write it.`);
  const tmpIgnored = git(dir, ["check-ignore", "-q", "--", tmpBase]).status === 0;
  return { abs, tmp: tmpIgnored ? path.join(dir, tmpBase) : null };
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// Mode 0600 from the first byte. With a temporary file: write, fsync,
// rename. Without (its name isn't ignored): truncate the target in place.
export function writePrivate(target: { abs: string; tmp: string | null }, text: string): void {
  if (target.tmp) {
    const fd = openSync(target.tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try {
      try {
        writeSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(target.tmp, target.abs);
    } catch (err) {
      rmSync(target.tmp, { force: true });
      throw err;
    }
    return;
  }
  const fd = openSync(target.abs, constants.O_WRONLY | constants.O_CREAT | NOFOLLOW, 0o600);
  try {
    if (process.platform !== "win32") fchmodSync(fd, 0o600); // before any value lands
    ftruncateSync(fd, 0);
    writeSync(fd, text, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
