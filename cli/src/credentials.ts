// Where the CLI keeps its sign-ins: one per server (issuer), each the
// refresh token and the current access token with its expiry.
//
// In the OS keychain where there is one (docs/variables.md, "Credentials"):
//   - macOS: the login Keychain, through /usr/bin/security;
//   - Linux: the Secret Service (GNOME Keyring, KWallet), through
//     `secret-tool` (libsecret), when it's installed and answers;
//   - Windows: a file encrypted to your Windows account with DPAPI
//     (`credentials.dpapi`), through Windows PowerShell.
// Else a file, `credentials.json`, 0600 in a 0700 directory, written
// atomically. RELIQUARY_CREDENTIALS=file|keychain overrides the choice
// (`keychain` fails when there's none rather than falling back).
//
// The config directory (never the project) holds the file, the DPAPI file
// and the lock: RELIQUARY_CONFIG_DIR, else %APPDATA%\reliquary on Windows,
// else $XDG_CONFIG_HOME/reliquary, else ~/.config/reliquary.
//
// A token never goes into a process argument: the keychain tools get it on
// standard input (`security -i` reads its command there; `secret-tool store`
// reads the secret there; PowerShell reads what it encrypts there) and
// hand it back on standard output. Nothing a keychain tool prints is ever
// shown, only its exit code.
//
// Sign-ins made before the keychain (in credentials.json) keep working: a
// server missing from the keychain is read from the file, and the next write
// for it (a refresh, a login, a logout) moves it into the keychain and out
// of the file.
//
// Refreshing rotates the refresh token, and presenting a rotated one again
// revokes the whole grant, so two processes must never refresh at once:
// withLock() takes an exclusive lock file around read-refresh-write.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, fsFailure, UsageError } from "./errors.js";

export type Credential = {
  refreshToken: string;
  accessToken: string;
  expiresAt: number; // ms since the epoch
};

type Store = { version: 1; servers: Record<string, Credential> };

// One place sign-ins are kept.
export interface CredentialStore {
  readonly kind: "file" | "keychain";
  readonly where: string; // for people: "the macOS Keychain", a file's path
  get(server: string): Credential | null;
  set(server: string, c: Credential | null): void;
}

const REFRESH = /^rlr_[0-9a-f]{64}$/;
const ACCESS = /^rle_[0-9a-f]{64}$/;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

export const SERVICE = "reliquary-cli";

export function configDir(): string {
  if (process.env.RELIQUARY_CONFIG_DIR) return path.resolve(process.env.RELIQUARY_CONFIG_DIR);
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "reliquary");
  const base = process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME) ? process.env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config");
  return path.join(base, "reliquary");
}

export const credentialsFile = () => path.join(configDir(), "credentials.json");
export const dpapiFile = () => path.join(configDir(), "credentials.dpapi");

// The advice for any failure in the config directory: it is the one place a
// person can move.
const CONFIG_HINT = "Set RELIQUARY_CONFIG_DIR to a folder you can write to, or fix that folder's permissions.";

function ensureDir(): string {
  const dir = configDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
  } catch (err) {
    throw fsFailure("create", dir, err, CONFIG_HINT);
  }
  return dir;
}

function valid(c: unknown): c is Credential {
  const o = c as Credential;
  return !!o && typeof o === "object" && REFRESH.test(o.refreshToken) && ACCESS.test(o.accessToken) && Number.isFinite(o.expiresAt);
}

// A store's JSON, keeping only well-formed sign-ins. Throws without the text.
function parseStore(raw: string, what: string): Store {
  try {
    const s = JSON.parse(raw) as Store;
    const servers: Record<string, Credential> = {};
    for (const [k, v] of Object.entries(s?.servers ?? {})) if (valid(v)) servers[k] = v;
    return { version: 1, servers };
  } catch {
    // Never echo the file: it holds tokens.
    throw new CliError(`${what} is damaged. Delete it and run \`reliquary login\` again.`);
  }
}

// Written beside, then renamed into place: never half a file.
function writeAtomic(file: string, text: string): void {
  const dir = ensureDir();
  const tmp = path.join(dir, `.${path.basename(file)}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    if (process.platform !== "win32") chmodSync(file, 0o600);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the reason it failed is what matters
    }
    throw fsFailure("save your connection in", file, err, CONFIG_HINT);
  }
}

// One sign-in as a single line of [a-z0-9_:], so no keychain tool has to
// quote it: `v1:<refresh>:<access>:<expiresAt>`.
export function encodeCredential(c: Credential): string {
  return `v1:${c.refreshToken}:${c.accessToken}:${Math.trunc(c.expiresAt)}`;
}

export function decodeCredential(s: string): Credential | null {
  const m = /^v1:(rlr_[0-9a-f]{64}):(rle_[0-9a-f]{64}):(\d{1,16})$/.exec(s.trim());
  return m ? { refreshToken: m[1], accessToken: m[2], expiresAt: Number(m[3]) } : null;
}

// ---------------------------------------------------------------------------
// The file (the fallback, and where sign-ins made before the keychain are)

export function fileStore(): CredentialStore & { has(server: string): boolean } {
  const load = (): Store => {
    let raw: string;
    try {
      raw = readFileSync(credentialsFile(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, servers: {} };
      throw fsFailure("read", credentialsFile(), err, CONFIG_HINT);
    }
    return parseStore(raw, credentialsFile());
  };
  return {
    kind: "file",
    get where() {
      return credentialsFile();
    },
    has: (server) => existsSync(credentialsFile()) && Object.prototype.hasOwnProperty.call(load().servers, server),
    get: (server) => load().servers[server] ?? null,
    set(server, c) {
      const store = load();
      if (c) store.servers[server] = c;
      else delete store.servers[server];
      writeAtomic(credentialsFile(), JSON.stringify(store, null, 2) + "\n");
    },
  };
}

// ---------------------------------------------------------------------------
// Running a keychain tool: no shell, the secret (if any) on standard input.

export type ExecResult = { status: number | null; stdout: string; stderr: string; failed: boolean };
export type Exec = (file: string, args: string[], opts?: { input?: string; timeoutMs?: number }) => ExecResult;

export const realExec: Exec = (file, args, opts = {}) => {
  const r = spawnSync(file, args, {
    input: opts.input ?? "",
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: opts.timeoutMs ?? 20_000,
    maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", failed: !!r.error };
};

// A server's origin as a keychain account name: it goes into an argument
// (not a secret) and, on macOS, into a `security -i` command line, so it
// must need no quoting.
function account(server: string): string {
  if (!/^https?:\/\/[A-Za-z0-9.\-[\]:]+$/.test(server)) throw new CliError("That server's address can't be used as a keychain name.");
  return server;
}

const keychainError = (where: string, what: string, r: ExecResult) =>
  new CliError(
    `Couldn't ${what} ${where} (${r.failed ? "it didn't run" : `exit ${r.status}`}). ` +
      "Unlock it and try again, or set RELIQUARY_CREDENTIALS=file to keep the connection in a file instead.",
  );

// macOS: /usr/bin/security. Reading takes the account in arguments and
// prints the secret; writing runs `security -i`, which reads its command
// line, secret included, from standard input, so the secret is in no
// process's arguments.
export function macosKeychain(exec: Exec = realExec, bin = "/usr/bin/security", service = SERVICE): CredentialStore {
  const where = "the macOS Keychain";
  const find = (server: string): Credential | null => {
    const r = exec(bin, ["find-generic-password", "-s", service, "-a", account(server), "-w"]);
    if (r.status === 0) return decodeCredential(r.stdout);
    if (r.status === 44) return null; // errSecItemNotFound
    throw keychainError(where, "read your connection from", r);
  };
  return {
    kind: "keychain",
    where,
    get: find,
    set(server, c) {
      if (!c) {
        const r = exec(bin, ["delete-generic-password", "-s", service, "-a", account(server)]);
        if (r.status !== 0 && r.status !== 44) throw keychainError(where, "remove your connection from", r);
        return;
      }
      const secret = encodeCredential(c);
      const r = exec(bin, ["-i"], { input: `add-generic-password -U -s ${service} -a ${account(server)} -w ${secret}\n` });
      // `security -i` may exit 0 even when its command failed: read it back.
      const back = r.status === 0 ? find(server) : null;
      if (!back || encodeCredential(back) !== secret) throw keychainError(where, "save your connection in", r);
    },
  };
}

// Linux: libsecret's `secret-tool`. `store` reads the secret from standard
// input; `lookup` prints it.
export function secretTool(exec: Exec = realExec, bin = "secret-tool", service = SERVICE): CredentialStore & { available(): boolean } {
  const where = "your keyring (Secret Service)";
  return {
    kind: "keychain",
    where,
    // Installed, and a Secret Service answers (not found is an answer; no
    // D-Bus session or no keyring daemon is not).
    available() {
      const r = exec(bin, ["lookup", "service", service, "account", "availability-check"]);
      return !r.failed && (r.status === 0 || (r.status === 1 && r.stderr.trim() === ""));
    },
    get(server) {
      const r = exec(bin, ["lookup", "service", service, "account", account(server)]);
      if (r.status === 0) return decodeCredential(r.stdout);
      if (r.status === 1 && r.stdout === "" && r.stderr.trim() === "") return null;
      throw keychainError(where, "read your connection from", r);
    },
    set(server, c) {
      if (!c) {
        const r = exec(bin, ["clear", "service", service, "account", account(server)]);
        if (r.status !== 0 && !(r.status === 1 && r.stderr.trim() === "")) throw keychainError(where, "remove your connection from", r);
        return;
      }
      const r = exec(bin, ["store", `--label=Reliquary CLI connection for ${account(server)}`, "service", service, "account", account(server)], { input: encodeCredential(c) });
      if (r.status !== 0) throw keychainError(where, "save your connection in", r);
    },
  };
}

// Windows: DPAPI, the Windows account's own encryption, through Windows
// PowerShell. The whole store is encrypted into credentials.dpapi; only
// this Windows user on this computer can decrypt it. The script is fixed
// (no secret in it); what it encrypts or decrypts goes in and out, base64,
// on standard input and output.
const PS_PROTECT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
  "$e = [Text.Encoding]::UTF8.GetBytes('reliquary-cli')",
  "$out = [Security.Cryptography.ProtectedData]::Protect($in, $e, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($out))",
].join("; ");
const PS_UNPROTECT = PS_PROTECT.replace("::Protect(", "::Unprotect(");

export const powershellArgs = (script: string) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
export const PS_SCRIPTS = { protect: PS_PROTECT, unprotect: PS_UNPROTECT };

export function windowsPowershell(): string {
  return path.win32.join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function windowsDpapi(exec: Exec = realExec, bin = windowsPowershell(), file = dpapiFile): CredentialStore {
  const where = "a file encrypted to your Windows account (DPAPI)";
  const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
  const load = (): Store => {
    let data: string;
    try {
      data = readFileSync(file(), "utf8").trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, servers: {} };
      throw fsFailure("read", file(), err, CONFIG_HINT);
    }
    if (!B64.test(data)) throw new CliError(`${file()} is damaged. Delete it and run \`reliquary login\` again.`);
    const r = exec(bin, powershellArgs(PS_UNPROTECT), { input: data });
    const out = r.stdout.trim();
    if (r.status !== 0 || !B64.test(out)) throw keychainError(where, "decrypt your connections in", r);
    return parseStore(Buffer.from(out, "base64").toString("utf8"), file());
  };
  return {
    kind: "keychain",
    where,
    get: (server) => load().servers[server] ?? null,
    set(server, c) {
      const store = load();
      if (c) store.servers[server] = c;
      else delete store.servers[server];
      const r = exec(bin, powershellArgs(PS_PROTECT), { input: Buffer.from(JSON.stringify(store), "utf8").toString("base64") });
      const out = r.stdout.trim();
      if (r.status !== 0 || !B64.test(out)) throw keychainError(where, "encrypt your connections for", r);
      writeAtomic(file(), out + "\n");
    },
  };
}

// ---------------------------------------------------------------------------
// Choosing

// The keychain first; a server it doesn't have is read from the file (a
// sign-in from before), and any write for a server moves it out of the file.
export function withFileFallback(keychain: CredentialStore, file: ReturnType<typeof fileStore>): CredentialStore {
  return {
    kind: "keychain",
    where: keychain.where,
    get: (server) => keychain.get(server) ?? file.get(server),
    set(server, c) {
      keychain.set(server, c);
      if (file.has(server)) file.set(server, null);
    },
  };
}

// This platform's keychain, if it has one that answers.
export function platformKeychain(platform: NodeJS.Platform = process.platform, exec: Exec = realExec): CredentialStore | null {
  if (platform === "darwin") return existsSync("/usr/bin/security") ? macosKeychain(exec) : null;
  if (platform === "win32") {
    const ps = windowsPowershell();
    return existsSync(ps) ? windowsDpapi(exec, ps) : null;
  }
  const st = secretTool(exec);
  return st.available() ? st : null;
}

// RELIQUARY_CREDENTIALS: unset (or `auto`) picks the keychain when there is
// one, else the file; `file` and `keychain` force one.
export function chooseStore(setting: string | undefined, keychain: () => CredentialStore | null): CredentialStore {
  const want = (setting ?? "").trim().toLowerCase() || "auto";
  if (!["auto", "file", "keychain"].includes(want)) throw new UsageError("RELIQUARY_CREDENTIALS must be file or keychain (or unset to choose by itself).");
  const file = fileStore();
  if (want === "file") return file;
  const kc = keychain();
  if (kc) return withFileFallback(kc, file);
  if (want === "keychain") {
    throw new CliError("RELIQUARY_CREDENTIALS=keychain, but no OS keychain answers here (macOS Keychain, Secret Service through secret-tool, or Windows DPAPI). Unset it to use a file.");
  }
  return file;
}

let chosen: CredentialStore | null = null;
export function credentialStore(): CredentialStore {
  chosen ??= chooseStore(process.env.RELIQUARY_CREDENTIALS, () => platformKeychain());
  return chosen;
}

export function getCredential(server: string): Credential | null {
  return credentialStore().get(server);
}

// Call only inside withLock().
export function setCredential(server: string, c: Credential | null): void {
  credentialStore().set(server, c);
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
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw fsFailure("create the lock file", lock, err, CONFIG_HINT);
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
