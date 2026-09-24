// The env API (docs/variables.md, "The env API"), with the sign-in's access
// token, refreshed when it expires or is refused once.

import { accessToken, forget } from "./auth.js";
import { type Server, getJson } from "./config.js";
import { isVariableName, startsPrograms, type DotenvRefusal } from "./dotenv.js";
import { CliError, NotSignedIn, UsageError } from "./errors.js";

export type Vault = { id: string; name: string; role: string; environments: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENVIRONMENT = /^[a-z][a-z0-9_-]{0,31}$/;
// docs/variables.md: the database refuses these names; so does the CLI, in
// case a server ever sends one, since `run` puts every variable into a process.
export const safeName = (n: string) => isVariableName(n) && !startsPrograms(n);

// Text from the server that the CLI prints (a vault's name, a role): no
// control characters (a terminal would act on escape sequences) and no
// bidirectional overrides (they reorder what is shown). The database
// refuses control characters in vault names already; this is the CLI not
// trusting that.
export const shown = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, "\ufffd");

// One call to the env API, refreshing the access token once if it's refused.
async function request(server: Server, path: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: unknown }> {
  const url = `${server.issuer}/api/env${path}`;
  const once = (token: string) =>
    getJson(url, {
      method: init.method ?? "GET",
      body: init.body,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
    });
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
const get = (server: Server, path: string) => request(server, path);

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
    .map((v) => ({
      id: v.id,
      name: shown(v.name),
      role: shown(v.role),
      environments: v.environments.filter((e): e is string => typeof e === "string" && ENVIRONMENT.test(e)),
    }));
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
    // The server refuses NUL in values; an environment variable can't hold
    // one, and a .env would carry it raw. Not trusting that either.
    if (value.includes("\u0000")) throw new CliError(`The server sent ${name} with a NUL character, which no environment variable can hold; refusing all of ${what}.`);
    out.set(name, value);
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ---------------------------------------------------------------------------
// Pushes (docs/variables.md, "Imports"): values sent for a person to apply in
// the web UI. The server seals them on receipt; nothing is set until then.

export type Pushed = { id: string; names: string[]; overwrites: string[]; expiresAt: string; url: string };
export type PushStatus = "pending" | "applied" | "rejected" | "expired";

function pushFail(status: number, body: unknown, what: string): never {
  const code = (body as { error?: unknown } | null)?.error;
  if (status === 403 && code === "push_not_allowed") {
    throw new CliError("This sign-in wasn't allowed to send values. Run `reliquary login` again and leave \"Also let it send .env files\" ticked.");
  }
  if (status === 403) throw new CliError(`Your role can't set values in ${what}.`);
  if (status === 413) throw new CliError("That's too much to send at once (the limit is 1 MiB). Split the file.");
  if (status === 429) throw new CliError("Too many pushes are waiting. Apply or reject some on the Variables page, or try again in an hour.");
  if (status === 400) throw new CliError("The server refused the file's contents (a name or a value it doesn't take). Nothing was sent for approval.");
  fail(status, body, what);
}

// Sends values for approval. Returns the pending import.
export async function pushEnvironment(
  server: Server,
  vault: Vault,
  environment: string,
  entries: { name: string; value: string }[],
  refused: DotenvRefusal[],
): Promise<Pushed> {
  if (!ENVIRONMENT.test(environment)) throw new UsageError(`"${environment}" isn't an environment name (like development, preview, production).`);
  const what = `${environment} in ${vault.name}`;
  const variables = Object.fromEntries(entries.map((e) => [e.name, e.value]));
  const { status, body } = await request(server, `/${vault.id}/${environment}/imports`, {
    method: "POST",
    body: JSON.stringify({ variables, refused }),
  });
  if (status !== 201) pushFail(status, body, what);
  const b = body as { import?: unknown; names?: unknown; overwrites?: unknown; expires_at?: unknown; url?: unknown };
  // The link is printed: plain printable ASCII on this server only.
  if (
    typeof b?.import !== "string" || !UUID.test(b.import) || !Array.isArray(b.names) || typeof b.url !== "string" ||
    !b.url.startsWith(`${server.issuer}/`) || !/^[\x21-\x7e]+$/.test(b.url)
  ) {
    throw new CliError(`The server sent an unexpected answer for ${what}.`);
  }
  const names = (xs: unknown[]) => xs.filter((n): n is string => typeof n === "string" && isVariableName(n));
  return {
    id: b.import,
    names: names(b.names),
    overwrites: Array.isArray(b.overwrites) ? names(b.overwrites) : [],
    expiresAt: typeof b.expires_at === "string" ? b.expires_at : "",
    url: b.url,
  };
}

// A push's status, for --wait.
export async function pushStatus(server: Server, id: string): Promise<PushStatus> {
  const { status, body } = await get(server, `/imports/${id}`);
  if (status !== 200) fail(status, body, "that push");
  const s = (body as { status?: unknown } | null)?.status;
  if (s !== "pending" && s !== "applied" && s !== "rejected" && s !== "expired") throw new CliError("The server sent an unexpected answer for that push.");
  return s;
}
