// The env API (docs/variables.md, "The env API"), with the sign-in's access
// token, refreshed when it expires or is refused once.

import { accessToken, forget } from "./auth.js";
import { type Server, getJson } from "./config.js";
import { CliError, NotSignedIn, UsageError } from "./errors.js";

export type Vault = { id: string; name: string; role: string; environments: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENVIRONMENT = /^[a-z][a-z0-9_-]{0,31}$/;
// docs/variables.md: the database refuses these names; so does the CLI, in
// case a server ever sends one, since `run` puts every variable into a process.
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const STARTUP_PREFIXES = ["LD_", "DYLD_", "BASH_FUNC_", "GIT_CONFIG_"];
const STARTUP_NAMES = new Set(
  (
    "PATH HOME SHELL USER IFS ENV BASH_ENV PS4 PROMPT_COMMAND SHELLOPTS BASHOPTS CDPATH NODE_OPTIONS NODE_PATH " +
    "PYTHONPATH PYTHONSTARTUP PYTHONHOME PERL5OPT PERL5LIB PERLLIB RUBYOPT RUBYLIB JAVA_TOOL_OPTIONS _JAVA_OPTIONS " +
    "JDK_JAVA_OPTIONS CLASSPATH GIT_SSH GIT_SSH_COMMAND GIT_EXEC_PATH GIT_ASKPASS SSH_ASKPASS EDITOR VISUAL PAGER TMPDIR"
  ).split(" "),
);
export const safeName = (n: string) =>
  NAME.test(n) && !STARTUP_NAMES.has(n.toUpperCase()) && !STARTUP_PREFIXES.some((p) => n.toUpperCase().startsWith(p));

async function get(server: Server, path: string): Promise<{ status: number; body: unknown }> {
  const url = `${server.issuer}/api/env${path}`;
  const once = (token: string) => getJson(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  let token = await accessToken(server);
  let r = await once(token);
  if (r.status === 401) {
    // Expired early, or revoked: refresh once (this fails if revoked).
    token = await accessToken(server, token);
    r = await once(token);
    if (r.status === 401) {
      await forget(server);
      throw new NotSignedIn(server.issuer, "The server no longer accepts your sign-in");
    }
  }
  return r;
}

function fail(status: number, body: unknown, what: string): never {
  const code = (body as { error?: unknown } | null)?.error;
  if (status === 403) throw new CliError(`Your role can't read ${what}.`);
  if (status === 404) throw new CliError(`No such vault or environment for this sign-in (${what}). \`reliquary vaults\` lists what you can reach.`);
  if (status === 503) throw new CliError("The server has no key for variables (VARIABLES_KEY), so it can't deliver values. Tell whoever runs it.");
  if (status === 500 && code === "decrypt_failed") {
    throw new CliError(`A value in ${what} can't be decrypted on the server; nothing was delivered. Ask an owner to set it again.`);
  }
  throw new CliError(`The server answered ${status}${typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? ` (${code})` : ""}. Try again later.`);
}

export async function listVaults(server: Server): Promise<Vault[]> {
  const { status, body } = await get(server, "/vaults");
  if (status !== 200) fail(status, body, "your vaults");
  const vaults = (body as { vaults?: unknown })?.vaults;
  if (!Array.isArray(vaults)) throw new CliError("The server sent an unexpected answer for your vaults.");
  return vaults
    .filter((v): v is Vault => !!v && typeof v.id === "string" && UUID.test(v.id) && typeof v.name === "string" && typeof v.role === "string" && Array.isArray(v.environments))
    .map((v) => ({ id: v.id, name: v.name, role: v.role, environments: v.environments.filter((e) => typeof e === "string") }));
}

// A vault by id or name, among those this sign-in reaches.
export function pickVault(vaults: Vault[], wanted: string | undefined): Vault {
  if (!wanted) {
    if (vaults.length === 1) return vaults[0];
    if (vaults.length === 0) throw new CliError("This sign-in reaches no vaults.");
    throw new UsageError(`Choose a vault with --vault (or "vault" in .reliquary.json):\n${vaults.map((v) => `  ${v.name}  ${v.id}`).join("\n")}`);
  }
  if (UUID.test(wanted.toLowerCase())) {
    const v = vaults.find((x) => x.id === wanted.toLowerCase());
    if (!v) throw new CliError(`No vault ${wanted} for this sign-in. \`reliquary vaults\` lists what you can reach.`);
    return v;
  }
  let hits = vaults.filter((v) => v.name === wanted);
  if (hits.length === 0) hits = vaults.filter((v) => v.name.toLowerCase() === wanted.toLowerCase());
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new CliError(`No vault named "${wanted}" for this sign-in. \`reliquary vaults\` lists what you can reach.`);
  throw new UsageError(`More than one vault is named "${wanted}"; pass its id with --vault:\n${hits.map((v) => `  ${v.name}  ${v.id}`).join("\n")}`);
}

// An environment's values. Held in memory only; the caller hands them to one
// process or one gitignored file.
export async function readEnvironment(server: Server, vault: Vault, environment: string): Promise<Map<string, string>> {
  if (!ENVIRONMENT.test(environment)) throw new UsageError(`"${environment}" isn't an environment name (like development, preview, production).`);
  const what = `${environment} in ${vault.name}`;
  const { status, body } = await get(server, `/${vault.id}/${environment}`);
  if (status !== 200) fail(status, body, what);
  const b = body as { vault?: unknown; environment?: unknown; variables?: unknown };
  if (b?.vault !== vault.id || b.environment !== environment || typeof b.variables !== "object" || b.variables === null || Array.isArray(b.variables)) {
    throw new CliError(`The server sent an unexpected answer for ${what}.`);
  }
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(b.variables as Record<string, unknown>)) {
    if (typeof value !== "string") throw new CliError(`The server sent an unexpected answer for ${what}.`);
    if (!safeName(name)) throw new CliError(`The server sent a variable whose name isn't allowed (it changes how programs start, or isn't a shell name); refusing all of ${what}.`);
    out.set(name, value);
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
