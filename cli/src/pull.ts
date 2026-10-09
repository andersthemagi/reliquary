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
import { CliError, fsFailure, plain } from "./errors.js";
import { resolveWindowsCommand } from "./run.js";

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

// Windows looks a bare name up in the working directory before PATH, and git
// is run with the repository about to be inspected as its working directory:
// a git.exe committed there would run. So on Windows it is found on PATH
// only, as `run` finds its command; null if it isn't there.
export function gitCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  exists?: (p: string) => boolean,
): string | null {
  return platform === "win32" ? resolveWindowsCommand("git", env, cwd, exists) : "git";
}

type Git = { status: number | null; stdout: string; stderr: string; missing: boolean; error: string | null };
function git(cwd: string, args: string[]): Git {
  const bin = gitCommand();
  if (!bin) return { status: null, stdout: "", stderr: "", missing: true, error: "ENOENT" };
  // English, so "not a git repository" can be told from the other reasons git
  // exits 128 (a repository owned by someone else, a corrupt one).
  const env = { ...process.env, LC_ALL: "C", LANGUAGE: "C" };
  const r = spawnSync(bin, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", missing: code === "ENOENT", error: r.error ? (code ?? "error") : null };
}

// Why git said no, in git's words (which include its own fix, such as the
// safe.directory command), as one plain line.
const gitSays = (g: Git) => (g.error ? `git didn't run (${g.error})` : `git said: "${plain(g.stderr.replace(/\s+/g, " ")).trim().slice(0, 300) || `exit ${g.status}, no message`}"`);

// Where to write, and whether the temporary name is safe too. Throws with a
// fix when the file isn't ignored.
export function checkTarget(file: string, outsideRepo: boolean): { abs: string; tmp: string | null } {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  let isDirectory = false;
  try {
    isDirectory = statSync(dir).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw fsFailure("look at", dir, err);
  }
  if (!isDirectory) throw new CliError(`${dir} isn't a directory.`);
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new CliError(`${file} is a symbolic link; pull into a plain file.`);
    if (!st.isFile()) throw new CliError(`${file} isn't a regular file.`);
  } catch (err) {
    if (err instanceof CliError) throw err;
    // Not there yet is fine; anything else (no permission to look) is not.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw fsFailure("look at", abs, err);
  }
  const tmpBase = `${base}.reliquary-${randomBytes(4).toString("hex")}.tmp`; // ignored by ".env*" or ".env.*"

  const inside = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.missing) {
    if (outsideRepo) return { abs, tmp: path.join(dir, tmpBase) };
    throw new CliError("git isn't installed, so reliquary can't check that the file is ignored. Pass --outside-repo if this directory isn't in a repository.");
  }
  // Outside is git saying so: "not a git repository", or inside a .git
  // directory or a bare repository. Any other refusal means there may well be
  // a repository here that git won't open (it belongs to someone else, as in
  // a dev container), and --outside-repo must not skip the ignore check for it.
  const outside = inside.status === 0 ? inside.stdout.trim() !== "true" : inside.status === 128 && /not a git repository/i.test(inside.stderr);
  if (outside) {
    if (outsideRepo) return { abs, tmp: path.join(dir, tmpBase) };
    throw new CliError(
      `${dir} isn't in a git repository, so nothing says ${base} stays private. Pull inside your project (with ${base} in .gitignore), or pass --outside-repo if you mean it.`,
    );
  }
  if (inside.status !== 0) {
    throw new CliError(`git wouldn't look at ${dir}, so reliquary can't tell whether ${base} is ignored; ${gitSays(inside)}. Fix that, then pull again. Nothing was written.`);
  }
  // Exit 0: ignored. 1: not ignored, or tracked (tracked files are never
  // reported as ignored). Anything else: git couldn't say.
  const ignored = git(dir, ["check-ignore", "-q", "--", base]);
  if (ignored.status === 1) {
    throw new CliError(
      `${file} isn't ignored by git (or it's tracked), so its values could be committed. Add it to .gitignore (and \`git rm --cached ${base}\` if it's tracked), then pull again.`,
    );
  }
  if (ignored.status !== 0) throw new CliError(`git couldn't say whether ${file} is ignored (${gitSays(ignored)}); refusing to write it.`);
  const tmpIgnored = git(dir, ["check-ignore", "-q", "--", tmpBase]).status === 0;
  return { abs, tmp: tmpIgnored ? path.join(dir, tmpBase) : null };
}

// What to tell a person about who can read the file. Windows has no Unix
// modes: opening with 0o600 there only sets the read-only attribute, and the
// file keeps its folder's access list, so "mode 600" would be untrue.
export const privacyNote = (platform: NodeJS.Platform = process.platform) =>
  platform === "win32" ? "Windows can't limit it to you: it keeps its folder's permissions" : "mode 600";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// Mode 0600 from the first byte. With a temporary file: write, fsync,
// rename. Without (its name isn't ignored): truncate the target in place.
export function writePrivate(target: { abs: string; tmp: string | null }, text: string): void {
  try {
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
        try {
          rmSync(target.tmp, { force: true });
        } catch {
          // the reason it failed is what matters
        }
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
  } catch (err) {
    throw fsFailure("write", target.abs, err);
  }
}
