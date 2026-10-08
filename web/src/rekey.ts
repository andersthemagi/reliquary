// Re-encrypting every stored value under the current key: the middle step of
// rotating VARIABLES_KEY (docs/ops/runbook.md, "Rotating VARIABLES_KEY";
// docs/variables.md, "Key rotation"). An operator runs it with
// scripts/rotate-variables-key.sh, which runs this file in a container with
// the web app's keys, as the operator's database role (reliquary_ops: only
// it may call the functions below; the web app's own role may not):
//
//   node dist/rekey.js            re-encrypt, then report
//   node dist/rekey.js --check    report only: which key ids hold how many
//
// Vault by vault, in one transaction each: read the sealed values, pending
// imports' values and link credentials that aren't under the current key
// (private.sealed_rows), open each with the key its id names and the
// additional data of its slot, seal it again under the current key for the
// same slot, and swap it in (private.reseal), which changes no version or
// "updated" field and logs one `rotate_key` row for the vault. A value a
// person set meanwhile is left alone (its nonce changed), and is on the
// current key already.
//
// The connection: DATABASE_URL is the web app's (reliquary_web, as in
// supabase/.vercel-web.env), and OPS_DB_PASSWORD the operator's; this logs
// in to the same database as reliquary_ops (keeping the pooler's
// `.project-ref` suffix). A DATABASE_URL for reliquary_ops is used as it is.
//
// It prints counts and key ids, never a key, a value, a name, a vault id or
// a connection string. Exit 0: nothing is left on another key. 1: something
// is (a value that doesn't open with its key, or one written by an older
// deployment meanwhile): keep the old key and run it again. 2: it couldn't
// run.

import { pathToFileURL } from "node:url";
import pg from "pg";
import { configureVariables, currentKeyId, missingKeyIds, openLink, reseal, sealLink, SecretsError } from "./secrets.js";

// The operator's connection string from the web app's and the operator's
// password. Errors never include either.
export function opsDatabaseUrl(url: string | undefined, password: string | undefined): string {
  let u: URL;
  try {
    u = new URL(url ?? "");
  } catch {
    throw new Error("DATABASE_URL isn't a postgres:// URL.");
  }
  const m = /^reliquary_(web|ops)(\.[A-Za-z0-9]+)?$/.exec(decodeURIComponent(u.username));
  if (!/^postgres(ql)?:$/.test(u.protocol) || !m) {
    throw new Error("DATABASE_URL must be the web app's (reliquary_web) or the operator's (reliquary_ops).");
  }
  if (!password) {
    if (m[1] === "ops") return u.toString();
    throw new Error("No OPS_DB_PASSWORD: the re-encryption logs in as reliquary_ops. Run scripts/set-role-passwords.sh ops first.");
  }
  u.username = `reliquary_ops${m[2] ?? ""}`;
  u.password = encodeURIComponent(password);
  return u.toString();
}

// A link's environment is null: its additional data is the vault alone.
type Row = { kind: "value" | "import" | "link"; ref: string; name: string; environment: string | null; key_id: string; nonce: Buffer; ciphertext: Buffer };
export type KeyCount = { keyId: string; values: number; imports: number; links: number };
export type RekeyResult = { vaults: number; moved: number; failed: number; changed: number };

export async function keyCounts(db: pg.Pool | pg.PoolClient): Promise<KeyCount[]> {
  return (await db.query(`select key_id, "values", imports, links from private.variable_key_ids()`)).rows.map((r) => ({
    keyId: r.key_id,
    values: Number(r.values),
    imports: Number(r.imports),
    links: Number(r.links),
  }));
}

// Re-encrypts one vault's values under the current key, in one transaction.
async function rekeyVault(pool: pg.Pool, vaultId: string, keyId: string): Promise<{ moved: number; failed: number; changed: number }> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const rows: Row[] = (
      await c.query("select kind, ref, name, environment, key_id, nonce, ciphertext from private.sealed_rows($1, null, $2)", [vaultId, keyId])
    ).rows;
    const items = [];
    let failed = 0;
    for (const r of rows) {
      const sealed = { keyId: r.key_id, nonce: r.nonce, ciphertext: r.ciphertext };
      try {
        const s =
          r.kind === "link"
            ? sealLink(openLink(sealed, vaultId), vaultId)
            : reseal(sealed, { vaultId, environment: r.environment!, name: r.name });
        items.push({
          kind: r.kind,
          ref: r.ref,
          name: r.name,
          environment: r.environment,
          old_nonce: r.nonce.toString("base64"),
          key_id: s.keyId,
          nonce: s.nonce.toString("base64"),
          ciphertext: s.ciphertext.toString("base64"),
        });
      } catch (err) {
        if (!(err instanceof SecretsError)) throw err;
        failed++;
      }
    }
    const moved = items.length
      ? Number((await c.query("select private.reseal($1, 'rotate_key', $2) as n", [vaultId, JSON.stringify(items)])).rows[0].n)
      : 0;
    await c.query("commit");
    return { moved, failed, changed: items.length - moved };
  } catch (err) {
    await c.query("rollback").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

// Every vault with anything on another key. Needs configureVariables() first.
export async function rekeyAll(pool: pg.Pool): Promise<RekeyResult> {
  const keyId = currentKeyId();
  if (!keyId) throw new Error("no VARIABLES_KEYS: nothing to re-encrypt with");
  const vaults: string[] = (await pool.query("select v from private.rekey_vaults($1) v", [keyId])).rows.map((r) => r.v);
  const total: RekeyResult = { vaults: 0, moved: 0, failed: 0, changed: 0 };
  for (const v of vaults) {
    const r = await rekeyVault(pool, v, keyId);
    total.vaults++;
    total.moved += r.moved;
    total.failed += r.failed;
    total.changed += r.changed;
  }
  return total;
}

const describe = (counts: KeyCount[]) =>
  counts.length
    ? counts
        .map(
          (c) =>
            `${c.keyId}: ${c.values} value${c.values === 1 ? "" : "s"}, ${c.imports} pending import value${c.imports === 1 ? "" : "s"}` +
            (c.links ? `, ${c.links} link credential${c.links === 1 ? "" : "s"}` : ""),
        )
        .join("; ")
    : "nothing stored";

export async function main(argv: string[], env: NodeJS.ProcessEnv, say: (line: string) => void): Promise<number> {
  const check = argv.includes("--check");
  if (argv.some((a) => a !== "--check")) {
    say("usage: rekey.js [--check]");
    return 2;
  }
  try {
    if (!configureVariables(env)) {
      say("No VARIABLES_KEYS (or VARIABLES_KEY) in the environment: nothing to re-encrypt with.");
      return 2;
    }
  } catch (err) {
    say((err as Error).message); // names the variable, never a key
    return 2;
  }
  let pool: pg.Pool;
  try {
    const { poolConfig } = await import("./db.js");
    pool = new pg.Pool(poolConfig({ ...env, DATABASE_URL: opsDatabaseUrl(env.DATABASE_URL, env.OPS_DB_PASSWORD) }));
  } catch (err) {
    say((err as Error).message); // names the variable, never its value
    return 2;
  }
  try {
    const current = currentKeyId()!;
    const before = await keyCounts(pool);
    say(`Current key: ${current}. Stored now: ${describe(before)}.`);
    const missing = missingKeyIds(before.map((c) => c.keyId));
    if (missing.length) {
      say(`No key for ${missing.join(", ")}: add ${missing.length === 1 ? "it" : "them"} to VARIABLES_KEYS (after the current key) and run this again.`);
      return 1;
    }
    if (!check) {
      const r = await rekeyAll(pool);
      say(
        `Re-encrypted ${r.moved} in ${r.vaults} vault${r.vaults === 1 ? "" : "s"}` +
          `${r.changed ? `; ${r.changed} changed meanwhile (already on a newer key)` : ""}` +
          `${r.failed ? `; ${r.failed} could not be decrypted with their key and stay as they are` : ""}.`,
      );
    }
    const after = check ? before : await keyCounts(pool);
    if (!check) say(`Stored now: ${describe(after)}.`);
    const left = after.filter((c) => c.keyId !== current).reduce((n, c) => n + c.values + c.imports + c.links, 0);
    if (left) {
      say(`${left} still on another key: keep ${after.filter((c) => c.keyId !== current).map((c) => c.keyId).join(", ")} in VARIABLES_KEYS${check ? "" : " and run this again"}.`);
      return 1;
    }
    say(`Everything is on ${current}. Older keys can be dropped from VARIABLES_KEYS.`);
    return 0;
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Never the error's text: it could hold a row.
    if (code === "42501") say("Failed: 42501 (only reliquary_ops may re-encrypt; is OPS_DB_PASSWORD the operator's?)");
    else if (code === "28P01" || code === "28000") say(`Failed: ${code} (reliquary_ops couldn't log in: run scripts/set-role-passwords.sh ops)`);
    else say(`Failed: ${code ?? (err as Error).name}`);
    return 2;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env, (line) => console.log(line)).then((code) => process.exit(code));
}
