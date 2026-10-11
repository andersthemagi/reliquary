// Encryption of variable values (docs/variables.md). Only this module ever
// holds the keys, and only the web app has them: the MCP app refuses to
// start with one set, and the database never sees a key or a plaintext value.
//
// AES-256-GCM with a random 12-byte nonce per value. The additional
// authenticated data is the vault id, the environment and the name, so a
// ciphertext moved to another row (another variable, environment or vault)
// fails to decrypt instead of delivering the wrong secret. Each ciphertext
// is stored with the id of the key that sealed it, so keys can rotate: the
// app holds several keys by id, seals with the current one and opens each
// value with the key its id names (docs/ops/runbook.md, "Rotating
// VARIABLES_KEY").
//
//   VARIABLES_KEYS    id:key pairs, comma-separated, the current (sealing)
//                     key first: "k2:<key>,k1:<key>". An id is
//                     [A-Za-z0-9_-]{1,32}; a key is 32 random bytes,
//                     base64url (43 characters, no padding).
//   VARIABLES_KEY     one key, as before; its id is VARIABLES_KEY_ID
//                     (default k1). With VARIABLES_KEYS too, it is one more
//                     key for opening (current only if it's alone), and must
//                     not contradict VARIABLES_KEYS.
//
// Hosted (NETLIFY set) or self-hosted (SELF_HOSTED=1), the web app refuses to
// start without a key. Locally
// it starts without one, and every value route answers 503. The server also
// refuses to start when a stored value names a key id it doesn't have
// (checkStoredKeyIds, from server.ts).
//
// No error, log line or exception message here contains a value or a key.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type Sealed = { keyId: string; nonce: Buffer; ciphertext: Buffer }; // ciphertext = encrypted bytes || 16-byte tag
export type Slot = { vaultId: string; environment: string; name: string };

export const MAX_VALUE_BYTES = 64 * 1024;
const TAG_BYTES = 16;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

export class SecretsError extends Error {}

// The keys by id, and the id of the one that seals.
let KEYS: Map<string, Buffer> = new Map();
let CURRENT: string | null = null;

// Parses and checks the configuration. Throws with a message naming the
// variable (and at most a well-formed key id), never a key. Returns whether
// values can be used.
export function configureVariables(env: NodeJS.ProcessEnv = process.env): boolean {
  const list = (env.VARIABLES_KEYS ?? "").trim();
  const single = env.VARIABLES_KEY ?? "";
  if (!list && !single) {
    if (env.NETLIFY) throw new Error("Refusing to start: NETLIFY is set but VARIABLES_KEY is not");
    if (env.SELF_HOSTED === "1") throw new Error("Refusing to start: SELF_HOSTED is set but neither VARIABLES_KEYS nor VARIABLES_KEY is");
    KEYS = new Map();
    CURRENT = null;
    return false;
  }
  const keys = new Map<string, Buffer>();
  let current: string | null = null;
  if (list) {
    for (const part of list.split(",")) {
      const pair = part.trim();
      const colon = pair.indexOf(":");
      const id = colon > 0 ? pair.slice(0, colon) : "";
      if (!KEY_ID.test(id)) throw new Error("VARIABLES_KEYS must be comma-separated id:key pairs, each id 1 to 32 letters, digits, - or _");
      if (keys.has(id)) throw new Error(`VARIABLES_KEYS names key id ${id} twice`);
      const key = parseKey(pair.slice(colon + 1), `VARIABLES_KEYS (key ${id})`);
      for (const [other, k] of keys) if (k.equals(key)) throw new Error(`VARIABLES_KEYS gives keys ${other} and ${id} the same key`);
      keys.set(id, key);
      current ??= id;
    }
  }
  if (single) {
    const id = env.VARIABLES_KEY_ID ?? "k1";
    if (!KEY_ID.test(id)) throw new Error("VARIABLES_KEY_ID must be 1 to 32 letters, digits, - or _");
    const key = parseKey(single, "VARIABLES_KEY");
    const known = keys.get(id);
    if (known && !known.equals(key)) throw new Error(`VARIABLES_KEY and VARIABLES_KEYS give key id ${id} different keys`);
    for (const [other, k] of keys) {
      if (other !== id && k.equals(key)) throw new Error(`VARIABLES_KEY is also key ${other} in VARIABLES_KEYS; give it one id`);
    }
    keys.set(id, key);
    current ??= id;
  }
  KEYS = keys;
  CURRENT = current;
  return true;
}

export function parseKey(raw: string, name = "VARIABLES_KEY"): Buffer {
  const bad = () => new Error(`${name} must be 32 random bytes in base64url (43 characters, no padding)`);
  if (!KEY_TEXT.test(raw)) throw bad();
  const key = Buffer.from(raw, "base64url");
  if (key.length !== 32) throw bad();
  return key;
}

// The id new values are sealed with, and every id this server can open.
export const currentKeyId = () => CURRENT;
export const keyIds = () => [...KEYS.keys()];

// Stored key ids (from private.variable_key_ids()) this server has no key
// for. The server refuses to start when there are any.
export function missingKeyIds(stored: string[]): string[] {
  return [...new Set(stored)].filter((id) => !KEYS.has(id)).sort();
}

export const variablesConfigured = () => CURRENT !== null;

function aad(s: Slot): Buffer {
  return Buffer.from(JSON.stringify(["reliquary.variable.v1", s.vaultId, s.environment, s.name]), "utf8");
}

export function seal(value: string, slot: Slot): Sealed {
  if (!CURRENT) throw new SecretsError("variables are not configured (VARIABLES_KEY)");
  // An environment variable can't hold NUL: `reliquary run` couldn't start
  // a process with it, and `env pull` would write it raw.
  if (value.includes("\u0000")) throw new SecretsError("a value can't contain a NUL character");
  const plain = Buffer.from(value, "utf8");
  if (plain.length > MAX_VALUE_BYTES) throw new SecretsError("a value is at most 64 KiB");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEYS.get(CURRENT)!, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(slot));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { keyId: CURRENT, nonce, ciphertext };
}

// Opens with the key the value's id names. Throws SecretsError (naming the
// variable, never its value) if this server has no key by that id, or the
// ciphertext was altered or belongs to another slot.
export function open(sealed: Sealed, slot: Slot): string {
  if (!CURRENT) throw new SecretsError("variables are not configured (VARIABLES_KEY)");
  const fail = () => new SecretsError(`${slot.name} in ${slot.environment} could not be decrypted`);
  const key = KEYS.get(sealed.keyId);
  if (!key || sealed.nonce.length !== 12 || sealed.ciphertext.length < TAG_BYTES) throw fail();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(slot));
    decipher.setAuthTag(sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES)), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    throw fail();
  }
}

// The database returns nonce and ciphertext in base64 (jsonb).
export const fromDb = (r: { key_id: string; nonce: string; ciphertext: string }): Sealed => ({
  keyId: r.key_id,
  nonce: Buffer.from(r.nonce, "base64"),
  ciphertext: Buffer.from(r.ciphertext, "base64"),
});

// A value sealed again under the current key, for `from` (as stored) and
// `to` (its slot now: the same, or a renamed environment's). The plaintext
// lives only inside this call.
export function reseal(sealed: Sealed, from: Slot, to: Slot = from): Sealed {
  return seal(open(sealed, from), to);
}

// A link's credential (docs/design.md, "Links"). Scoped to the vault only,
// not the link's name: unlike a variable's (vault, environment, name) key,
// a link's credential is keyed in storage by link_id alone (one row,
// primary key), and renaming a link (update_link) never touches
// link_secrets, so there is nothing to reseal on rename. The AAD still
// binds the ciphertext to its vault, so a row moved to another vault's link
// fails to decrypt instead of leaking a credential across vaults.
function linkAad(vaultId: string): Buffer {
  return Buffer.from(JSON.stringify(["reliquary.link.v1", vaultId]), "utf8");
}

export function sealLink(value: string, vaultId: string): Sealed {
  if (!CURRENT) throw new SecretsError("variables are not configured (VARIABLES_KEY)");
  if (value.includes("\u0000")) throw new SecretsError("a credential can't contain a NUL character");
  const plain = Buffer.from(value, "utf8");
  if (plain.length > MAX_VALUE_BYTES) throw new SecretsError("a credential is at most 64 KiB");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEYS.get(CURRENT)!, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(linkAad(vaultId));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { keyId: CURRENT, nonce, ciphertext };
}

export function openLink(sealed: Sealed, vaultId: string): string {
  if (!CURRENT) throw new SecretsError("variables are not configured (VARIABLES_KEY)");
  const fail = () => new SecretsError("this link's credential could not be decrypted");
  const key = KEYS.get(sealed.keyId);
  if (!key || sealed.nonce.length !== 12 || sealed.ciphertext.length < TAG_BYTES) throw fail();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(linkAad(vaultId));
    decipher.setAuthTag(sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES)), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    throw fail();
  }
}
