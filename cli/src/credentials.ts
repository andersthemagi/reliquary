// Where the CLI keeps its sign-ins: one per server (issuer), each the
// refresh token and the current access token with its expiry.
//
// A file, `credentials.json`, in the user's config directory (never the
// project): RELIQUARY_CONFIG_DIR, else %APPDATA%\reliquary on Windows, else
// $XDG_CONFIG_HOME/reliquary, else ~/.config/reliquary. The directory is
// 0700 and the file 0600, written atomically (a temporary file, then a
// rename). No OS keychain yet (docs/variables.md allows the file when there
// is none; see cli/README.md).
//
// Refreshing rotates the refresh token, and presenting a rotated one again
// revokes the whole grant, so two processes must never refresh at once:
// withLock() takes an exclusive lock file around read-refresh-write.

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";

export type Credential = {
  refreshToken: string;
  accessToken: string;
  expiresAt: number; // ms since the epoch
};

type Store = { version: 1; servers: Record<string, Credential> };

const REFRESH = /^rlr_[0-9a-f]{64}$/;
const ACCESS = /^rle_[0-9a-f]{64}$/;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

export function configDir(): string {
  if (process.env.RELIQUARY_CONFIG_DIR) return path.resolve(process.env.RELIQUARY_CONFIG_DIR);
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "reliquary");
  const base = process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME) ? process.env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config");
  return path.join(base, "reliquary");
}

export const credentialsFile = () => path.join(configDir(), "credentials.json");

function ensureDir(): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  return dir;
}

function valid(c: unknown): c is Credential {
  const o = c as Credential;
  return !!o && typeof o === "object" && REFRESH.test(o.refreshToken) && ACCESS.test(o.accessToken) && Number.isFinite(o.expiresAt);
}

function load(): Store {
  let raw: string;
  try {
    raw = readFileSync(credentialsFile(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, servers: {} };
    throw new CliError(`Couldn't read ${credentialsFile()} (${(err as NodeJS.ErrnoException).code ?? "error"}).`);
  }
  try {
    const s = JSON.parse(raw) as Store;
    const servers: Record<string, Credential> = {};
    for (const [k, v] of Object.entries(s?.servers ?? {})) if (valid(v)) servers[k] = v;
    return { version: 1, servers };
  } catch {
    // Never echo the file: it holds tokens.
    throw new CliError(`${credentialsFile()} is damaged. Delete it and run \`reliquary login\` again.`);
  }
}

function save(store: Store): void {
  const dir = ensureDir();
  const file = credentialsFile();
  const tmp = path.join(dir, `.credentials-${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

export function getCredential(server: string): Credential | null {
  return load().servers[server] ?? null;
}

// Call only inside withLock().
export function setCredential(server: string, c: Credential | null): void {
  const store = load();
  if (c) store.servers[server] = c;
  else delete store.servers[server];
  save(store);
}

// An exclusive lock around a read-modify-write of the store. A lock older
// than 30 s is a crashed process's and is taken over.
export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const dir = ensureDir();
  const lock = path.join(dir, "credentials.lock");
  const start = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // gone in between: try again
      }
      if (Date.now() - start > LOCK_WAIT_MS) {
        throw new CliError(`Another reliquary process holds ${lock}. If none is running, delete that file.`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
