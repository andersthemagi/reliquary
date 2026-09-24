// Encryption of variable values (docs/variables.md). Only this module ever
// holds VARIABLES_KEY, and only the web app has it: the MCP app refuses to
// start with it set, and the database never sees it or a plaintext value.
//
// AES-256-GCM with a random 12-byte nonce per value. The additional
// authenticated data is the vault id, the environment and the name, so a
// ciphertext moved to another row (another variable, environment or vault)
// fails to decrypt instead of delivering the wrong secret. Each ciphertext
// is stored with the id of the key that sealed it (VARIABLES_KEY_ID, "k1" by
// default), so a later rotation can tell old from new.
//
//   VARIABLES_KEY     32 random bytes, base64url (43 characters, no padding)
//   VARIABLES_KEY_ID  optional, [A-Za-z0-9_-]{1,32}, default k1
//
// Hosted (VERCEL set), the web app refuses to start without the key. Locally
// it starts without one, and every value route answers 503.
//
// No error, log line or exception message here contains a value or the key.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type Sealed = { keyId: string; nonce: Buffer; ciphertext: Buffer }; // ciphertext = encrypted bytes || 16-byte tag
export type Slot = { vaultId: string; environment: string; name: string };

export const MAX_VALUE_BYTES = 64 * 1024;
const TAG_BYTES = 16;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export class SecretsError extends Error {}

let KEY: { id: string; key: Buffer } | null = null;

// Parses and checks the configuration. Throws with a message naming the
// variable, never its value. Returns whether values can be used.
export function configureVariables(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.VARIABLES_KEY ?? "";
  if (!raw) {
    if (env.VERCEL) throw new Error("Refusing to start: VERCEL is set but VARIABLES_KEY is not");
    KEY = null;
    return false;
  }
  const id = env.VARIABLES_KEY_ID ?? "k1";
  if (!KEY_ID.test(id)) throw new Error("VARIABLES_KEY_ID must be 1 to 32 letters, digits, - or _");
  KEY = { id, key: parseKey(raw) };
  return true;
}

export function parseKey(raw: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) {
    throw new Error("VARIABLES_KEY must be 32 random bytes in base64url (43 characters, no padding)");
  }
  const key = Buffer.from(raw, "base64url");
  if (key.length !== 32) throw new Error("VARIABLES_KEY must be 32 random bytes in base64url (43 characters, no padding)");
  return key;
}

export const variablesConfigured = () => KEY !== null;

function aad(s: Slot): Buffer {
  return Buffer.from(JSON.stringify(["reliquary.variable.v1", s.vaultId, s.environment, s.name]), "utf8");
}

export function seal(value: string, slot: Slot): Sealed {
  if (!KEY) throw new SecretsError("variables are not configured (VARIABLES_KEY)");
  const plain = Buffer.from(value, "utf8");
  if (plain.length > MAX_VALUE_BYTES) throw new SecretsError("a value is at most 64 KiB");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY.key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(slot));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { keyId: KEY.id, nonce, ciphertext };
}

// Throws SecretsError (naming the variable, never its value) if the key id is
// unknown, or the ciphertext was altered or belongs to another slot.
export function open(sealed: Sealed, slot: Slot): string {
  if (!KEY) throw new SecretsError("variables are not configured (VARIABLES_KEY)");
  const fail = () => new SecretsError(`${slot.name} in ${slot.environment} could not be decrypted`);
  if (sealed.keyId !== KEY.id || sealed.nonce.length !== 12 || sealed.ciphertext.length < TAG_BYTES) throw fail();
  try {
    const decipher = createDecipheriv("aes-256-gcm", KEY.key, sealed.nonce, { authTagLength: TAG_BYTES });
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
