// The content key set (docs/design.md, "Encryption at rest: the content
// key", #238): the keys that seal vault content (file text, proposed text,
// notes, thread messages, search vectors), separate from the variables key
// set so a content key opens no value and the two rotate on their own. Both
// servers hold it: the MCP server serves files, so it must open them; it
// still refuses the variables key. The same file as mcp/src/content.ts.
//
//   CONTENT_KEYS      id:key pairs, comma-separated, the current (sealing)
//                     key first, in the format VARIABLES_KEYS uses.
//
// A sealed body is one bytea: a NUL marker (text can't start with one, so a
// plaintext row from before the backfill is told apart by its first byte),
// the key id's length and the key id, a 12-byte nonce, then AES-256-GCM
// ciphertext and its 16-byte tag. The additional data is the vault id and
// nothing else, so SQL can copy a body between rows of one vault (approve)
// and a body moved to another vault fails to open.
//
// No error, log line or exception message here contains a body or a key.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const MARKER = 0;
const MAX_BODY_BYTES = 1024 * 1024;

export class ContentError extends Error {}

export type KeySet = { keys: Map<string, Buffer>; current: string | null };

export function parseKey(raw: string, name: string): Buffer {
  const bad = () => new Error(`${name} must be 32 random bytes in base64url (43 characters, no padding)`);
  if (!KEY_TEXT.test(raw)) throw bad();
  const key = Buffer.from(raw, "base64url");
  if (key.length !== 32) throw bad();
  return key;
}

// "k2:<key>,k1:<key>" into keys by id, the first one current. Throws with a
// message naming the variable and at most a well-formed key id, never a key.
export function parseKeySet(list: string, name: string): KeySet {
  const keys = new Map<string, Buffer>();
  let current: string | null = null;
  for (const part of list.split(",")) {
    const pair = part.trim();
    const colon = pair.indexOf(":");
    const id = colon > 0 ? pair.slice(0, colon) : "";
    if (!KEY_ID.test(id)) throw new Error(`${name} must be comma-separated id:key pairs, each id 1 to 32 letters, digits, - or _`);
    if (keys.has(id)) throw new Error(`${name} names key id ${id} twice`);
    const key = parseKey(pair.slice(colon + 1), `${name} (key ${id})`);
    for (const [other, k] of keys) if (k.equals(key)) throw new Error(`${name} gives keys ${other} and ${id} the same key`);
    keys.set(id, key);
    current ??= id;
  }
  return { keys, current };
}

let KEYS: Map<string, Buffer> = new Map();
let CURRENT: string | null = null;

// Parses CONTENT_KEYS. `taken` says whether a key is already a variables key
// (the web app passes secrets.ts's check; the MCP app holds no variables
// key). Returns whether content can be sealed; hosted (NETLIFY) and
// self-hosted (SELF_HOSTED=1) refuse to start without it.
export function configureContent(env: NodeJS.ProcessEnv = process.env, taken: (key: Buffer) => boolean = () => false): boolean {
  const list = (env.CONTENT_KEYS ?? "").trim();
  if (!list) {
    if (env.NETLIFY) throw new Error("Refusing to start: NETLIFY is set but CONTENT_KEYS is not");
    if (env.SELF_HOSTED === "1") throw new Error("Refusing to start: SELF_HOSTED is set but CONTENT_KEYS is not");
    KEYS = new Map();
    CURRENT = null;
    return false;
  }
  const set = parseKeySet(list, "CONTENT_KEYS");
  for (const [id, key] of set.keys) {
    if (taken(key)) throw new Error(`CONTENT_KEYS key ${id} is also a variables key; content and values need keys of their own`);
  }
  KEYS = set.keys;
  CURRENT = set.current;
  return true;
}

export const contentConfigured = () => CURRENT !== null;
export const contentKeyIds = () => [...KEYS.keys()];

function aad(vaultId: string): Buffer {
  return Buffer.from(JSON.stringify(["reliquary.content.v1", vaultId]), "utf8");
}

// Bytes sealed under the current key. The text form checks the 1 MiB
// ceiling the database keeps for a body.
export function sealBytes(plain: Buffer, vaultId: string): Buffer {
  if (!CURRENT) throw new ContentError("content keys are not configured (CONTENT_KEYS)");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", KEYS.get(CURRENT)!, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(vaultId));
  const id = Buffer.from(CURRENT, "utf8");
  return Buffer.concat([Buffer.from([MARKER, id.length]), id, nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export function sealBody(text: string, vaultId: string): Buffer {
  const plain = Buffer.from(text, "utf8");
  if (plain.length > MAX_BODY_BYTES) throw new ContentError("a body is at most 1 MiB");
  return sealBytes(plain, vaultId);
}

// What a write stores: sealed when this server holds a content key, the
// plain bytes otherwise (a development server with no CONTENT_KEYS; hosted
// and self-hosted servers refuse to start without one, configureContent).
export const storeBody = (text: string, vaultId: string): Buffer => (CURRENT ? sealBody(text, vaultId) : Buffer.from(text, "utf8"));
export const storeBytes = (plain: Buffer, vaultId: string): Buffer => (CURRENT ? sealBytes(plain, vaultId) : plain);

export const isSealed = (body: Buffer) => body.length > 0 && body[0] === MARKER;

// The bytes of a stored body: opened if sealed, as they are if plaintext
// (a row from before the backfill; refused once #238's last step lands).
// Throws ContentError naming nothing if this server has no key by the
// envelope's id, or the body was altered or belongs to another vault.
export function openBytes(body: Buffer, vaultId: string): Buffer {
  if (!isSealed(body)) return body;
  const fail = () => new ContentError("this content could not be decrypted");
  const idLength = body[1] ?? 0;
  const id = body.subarray(2, 2 + idLength).toString("utf8");
  const nonce = body.subarray(2 + idLength, 2 + idLength + NONCE_BYTES);
  const sealed = body.subarray(2 + idLength + NONCE_BYTES);
  const key = KEYS.get(id);
  if (!key || nonce.length !== NONCE_BYTES || sealed.length < TAG_BYTES) throw fail();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(vaultId));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw fail();
  }
}

export const openBody = (body: Buffer, vaultId: string): string => openBytes(body, vaultId).toString("utf8");

// A nullable body column as read from a row (null: erased or redacted).
export const openText = (body: Buffer | null, vaultId: string): string | null => (body === null ? null : openBody(body, vaultId));
// A body carried inside JSON as base64 (encode(body, 'base64') in SQL).
export const openB64 = (body: string | null, vaultId: string): string | null => (body === null ? null : openBody(Buffer.from(body, "base64"), vaultId));
// Rows with a `body` column, opened in place.
export function openRows<T extends { body: Buffer | null }>(rows: T[], vaultId: string): (Omit<T, "body"> & { body: string | null })[] {
  return rows.map((r) => ({ ...r, body: openText(r.body, vaultId) }));
}

// A thread message's text as private.thread_body read it before bodies were
// sealed: leading blank lines and trailing whitespace go, the first line's
// indent stays; blank is "" (the function refuses it); null when it holds a
// control character other than a line break or a tab, for the caller to
// refuse in the function's words.
export function threadText(message: string | undefined): string | null {
  const text = (message ?? "").replace(/^\s*\n|\s+$/g, "");
  if (/^\s*$/.test(text)) return "";
  return /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) ? null : text;
}
export const CONTROL_CHARS = "a message can't contain control characters other than line breaks and tabs";
