// `reliquary run`: one process gets the variables in its environment.
// Spawned directly (no shell), stdio inherited, signals forwarded, and its
// exit code (or 128 + signal) becomes ours. Nothing is written to disk and
// no value is printed; an override of an inherited variable is named.
//
// Windows: a bare name is looked up on PATH with PATHEXT, like cmd.exe does
// (but not in the current directory; name it `.\tool.exe` for that).
// `.exe` and `.com` start directly. `.cmd` and `.bat` (npm, npx, pnpm, yarn
// shims) can only be started by cmd.exe, which reads its command line as
// commands, so they go through `cmd.exe /d /v:off /s /c "..."` with every
// argument in double quotes, where & | < > ^ ( ) are plain text; an argument
// holding what quotes can't protect there (" % or a line break) is refused
// rather than passed on (Node's advice after CVE-2024-27980, "BatBadBut").
// Environment names are case-insensitive on Windows: a variable replaces an
// inherited one of any case instead of sitting beside it, and two names in
// one environment that differ only in case are refused.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isatty } from "node:tty";
import { CliError } from "./errors.js";

const POSIX_FORWARD: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGUSR2"];
// The two a terminal sends itself, to every process in its foreground group.
const FROM_TERMINAL = new Set<NodeJS.Signals>(["SIGINT", "SIGQUIT"]);

// ---------------------------------------------------------------------------
// The environment

export function mergeEnv(
  base: NodeJS.ProcessEnv,
  variables: Map<string, string>,
  platform: NodeJS.Platform = process.platform,
): { env: NodeJS.ProcessEnv; overridden: string[] } {
  // No prototype: every name is a plain key (`__proto__` would otherwise be
  // a setter that drops the variable), and only own keys are inherited ones
  // (`toString` isn't "in" the environment unless someone set it).
  const env: NodeJS.ProcessEnv = Object.assign(Object.create(null), base);
  const overridden: string[] = [];
  if (platform !== "win32") {
    for (const [name, value] of variables) {
      if (Object.prototype.hasOwnProperty.call(base, name)) overridden.push(name);
      env[name] = value;
    }
    return { env, overridden };
  }
  const seen = new Map<string, string>();
  for (const name of variables.keys()) {
    const other = seen.get(name.toUpperCase());
    if (other !== undefined) {
      throw new CliError(`${other} and ${name} differ only in case, and Windows treats them as one variable. Rename one in the vault; nothing was run.`);
    }
    seen.set(name.toUpperCase(), name);
  }
  const inherited = new Map<string, string>();
  for (const k of Object.keys(env)) inherited.set(k.toUpperCase(), k);
  for (const [name, value] of variables) {
    const old = inherited.get(name.toUpperCase());
    if (old !== undefined) {
      overridden.push(name);
      delete env[old];
    }
    env[name] = value;
  }
  return { env, overridden };
}

// ---------------------------------------------------------------------------
// Windows: what to start

const envGet = (env: NodeJS.ProcessEnv, name: string) => {
  const k = Object.keys(env).find((key) => key.toUpperCase() === name);
  return k === undefined ? undefined : env[k];
};

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// The file a command names, by PATH and PATHEXT, or null.
export function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv, cwd: string, exists: (p: string) => boolean = isFile): string | null {
  const exts = (envGet(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^\.[a-z0-9]+$/.test(e));
  const withExts = (base: string) => (path.win32.extname(base) ? [base, ...exts.map((e) => base + e)] : exts.map((e) => base + e));
  if (/[\\/]/.test(command) || path.win32.isAbsolute(command)) {
    return withExts(path.win32.resolve(cwd, command)).find(exists) ?? null;
  }
  for (const raw of (envGet(env, "PATH") ?? "").split(";")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !path.win32.isAbsolute(dir)) continue; // a relative entry would mean the current directory
    const hit = withExts(path.win32.join(dir, command)).find(exists);
    if (hit) return hit;
  }
  return null;
}

// Inside double quotes on cmd.exe's command line, and again when a batch
// file passes %* on, these still act: " ends the quotes, % expands a
// variable, a line break ends the command. NUL can't be in a command line.
const CMD_UNSAFE = /["%\r\n\u0000]/;

// One argument, quoted for cmd.exe and then for the program's own parsing
// (CommandLineToArgvW): backslashes before the closing quote are doubled.
export const quoteForCmd = (arg: string) => `"${arg.replace(/(\\+)$/, "$1$1")}"`;

export type SpawnPlan = { file: string; args: string[]; verbatim: boolean };

export function windowsSpawnPlan(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, exists?: (p: string) => boolean): SpawnPlan {
  const file = resolveWindowsCommand(command, env, cwd, exists);
  if (!file) throw new CliError(`Command not found: ${command}`, 127);
  const ext = path.win32.extname(file).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { file, args, verbatim: false };
  if (ext === ".cmd" || ext === ".bat") {
    if (CMD_UNSAFE.test(file)) throw new CliError(`Can't start ${command} safely: its path holds a character cmd.exe would act on.`, 126);
    const bad = args.findIndex((a) => CMD_UNSAFE.test(a));
    if (bad !== -1) {
      throw new CliError(
        `Can't pass argument ${bad + 1} to ${command} safely: Windows starts ${ext} files through cmd.exe, which would act on its " % or line break. ` +
          "Run the program it wraps directly (for example `node <script>`), or put that argument in a file. Nothing was run.",
        2,
      );
    }
    const systemRoot = envGet(env, "SYSTEMROOT") || "C:\\Windows";
    const line = [file, ...args].map(quoteForCmd).join(" ");
    return { file: path.win32.join(systemRoot, "System32", "cmd.exe"), args: ["/d", "/v:off", "/s", "/c", `"${line}"`], verbatim: true };
  }
  throw new CliError(`${command} is a ${ext || "file without an extension"}, which Windows can't start directly (only .exe, .com, .cmd and .bat). Run it through its interpreter.`, 126);
}

// ---------------------------------------------------------------------------
// Running it

export function runWith(command: string[], variables: Map<string, string>, say: (line: string) => void): Promise<number> {
  const [name, ...rest] = command;
  const win = process.platform === "win32";
  const { env, overridden } = mergeEnv(process.env, variables);
  // Resolved with the environment we were started with: a vault can't
  // change which program runs.
  const plan: SpawnPlan = win ? windowsSpawnPlan(name, rest, process.env, process.cwd()) : { file: name, args: rest, verbatim: false };
  if (overridden.length) say(`overriding ${overridden.join(", ")} from your environment`);

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(plan.file, plan.args, { stdio: "inherit", env, shell: false, windowsVerbatimArguments: plan.verbatim });
    } catch (err) {
      reject(spawnError(err as NodeJS.ErrnoException, name));
      return;
    }
    const handlers = new Map<NodeJS.Signals, () => void>();
    const on = (sig: NodeJS.Signals, h: () => void) => {
      handlers.set(sig, h);
      process.on(sig, h);
    };
    if (!win) {
      // At a terminal the command is in the foreground group and gets Ctrl-C
      // and Ctrl-\ without us; passing them on as well would deliver each
      // twice, and a program that reads the second as "force quit" skips its
      // clean shutdown. We only wait for it, as on Windows below. Without a
      // terminal (CI, an editor, `kill -INT`) nothing else delivers them.
      const atTerminal = isatty(0);
      for (const sig of POSIX_FORWARD) {
        if (atTerminal && FROM_TERMINAL.has(sig)) {
          on(sig, () => {});
          continue;
        }
        on(sig, () => {
          try {
            child.kill(sig);
          } catch {
            // already gone
          }
        });
      }
    } else {
      // Ctrl+C and Ctrl+Break reach every process on the console, the
      // command (and anything cmd.exe started) included: wait for it to
      // finish rather than kill it. SIGHUP (the console closing) and SIGTERM
      // end its whole tree, since killing cmd.exe alone would leave the
      // program it started running.
      on("SIGINT", () => {});
      on("SIGBREAK", () => {});
      const end = () => killTree(child.pid);
      on("SIGHUP", end);
      on("SIGTERM", end);
    }
    const detach = () => {
      for (const [sig, h] of handlers) process.off(sig, h);
    };
    child.on("error", (err) => {
      detach();
      reject(spawnError(err as NodeJS.ErrnoException, name));
    });
    child.on("exit", (code, signal) => {
      detach();
      if (code !== null) resolve(code);
      else resolve(128 + (signal ? (os.constants.signals[signal] ?? 0) : 0));
    });
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  const taskkill = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  try {
    spawn(taskkill, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
  } catch {
    // nothing more to do
  }
}

function spawnError(err: NodeJS.ErrnoException, file: string): CliError {
  // The command's name only: never its environment.
  if (err.code === "ENOENT") return new CliError(`Command not found: ${file}`, 127);
  if (err.code === "EACCES") return new CliError(`Permission denied running ${file}`, 126);
  if (err.code === "E2BIG") return new CliError(`The environment is too large to start ${file}.`, 126);
  return new CliError(`Couldn't start ${file} (${err.code ?? "error"}).`, 126);
}
