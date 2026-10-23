// Sealing every stored body under the current content key: the backfill of
// rows written before writes sealed (#465, step 3 of #238), and the middle
// step of rotating CONTENT_KEYS (docs/ops/runbook.md, "Sealing content and
// rotating CONTENT_KEYS"). scripts/seal-content.sh runs this file in a
// container with the web app's keys, as reliquary_ops (only it may call the
// functions below; neither server's role may), the way rekey.ts re-encrypts
// variable values:
//
//   node dist/seal-content.js            seal, then report
//   node dist/seal-content.js --check    report only: plain rows, and which key ids hold how many
//
// Table by table, a batch at a time: read the bodies that aren't under the
// current key (private.content_to_seal, plain bytes or another key), open
// each (plain bytes as they are) and seal it under the current key with its
// vault's id, and swap it in (private.seal_content) unless the row changed
// since it was read. A batch is its own transaction, so a run stopped
// anywhere is resumed by running it again.
//
// It prints counts and key ids, never a key, a body, a vault id or a
// connection string. Exit 0: every body is on the current key. 1: something
// isn't (a body that doesn't open, or one written by an older deployment
// meanwhile): keep the old keys and run it again. 2: it couldn't run.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { configureContent, ContentError, contentKeyIds, openBytes, sealBytes } from "./content.js";
import { opsDatabaseUrl } from "./rekey.js";

const CONTENT = [
  ["file_versions", "file versions"],
  ["proposals", "proposals"],
  ["proposal_notes", "notes"],
  ["thread_messages", "thread messages"],
  ["file_embeddings", "search vectors"],
] as const;
// ponytail: a batch holds up to BATCH bodies of up to 1 MiB in memory; fine for an operator's run.
const BATCH = 100;

type Count = { content: string; keyId: string | null; n: number };
type Result = { sealed: number; failed: number; changed: number };

async function counts(pool: pg.Pool): Promise<Count[]> {
  return (await pool.query("select content, key_id, n from private.content_key_ids()")).rows.map((r) => ({
    content: r.content,
    keyId: r.key_id,
    n: Number(r.n),
  }));
}

async function sealTable(pool: pg.Pool, content: string, keyId: string): Promise<Result> {
  const total: Result = { sealed: 0, failed: 0, changed: 0 };
  let after = "";
  for (;;) {
    const rows: { ref: string; vault_id: string; body: Buffer }[] = (
      await pool.query("select ref, vault_id, body from private.content_to_seal($1, $2, $3, $4)", [content, keyId, after, BATCH])
    ).rows;
    if (!rows.length) return total;
    after = rows[rows.length - 1].ref;
    const items = [];
    for (const r of rows) {
      try {
        items.push({
          ref: r.ref,
          vault: r.vault_id,
          old: createHash("sha256").update(r.body).digest("hex"),
          body: sealBytes(openBytes(r.body, r.vault_id), r.vault_id).toString("base64"),
        });
      } catch (err) {
        if (!(err instanceof ContentError)) throw err;
        total.failed++;
      }
    }
    const n = items.length ? Number((await pool.query("select private.seal_content($1, $2) as n", [content, JSON.stringify(items)])).rows[0].n) : 0;
    total.sealed += n;
    total.changed += items.length - n;
  }
}

const describe = (cs: Count[]) => {
  const byKey = new Map<string, string[]>();
  for (const c of cs) {
    const key = c.keyId ?? "plaintext";
    const label = CONTENT.find(([t]) => t === c.content)?.[1] ?? c.content;
    byKey.set(key, [...(byKey.get(key) ?? []), `${c.n} ${label}`]);
  }
  return byKey.size ? [...byKey].map(([k, parts]) => `${k}: ${parts.join(", ")}`).join("; ") : "nothing stored";
};

export async function main(argv: string[], env: NodeJS.ProcessEnv, say: (line: string) => void): Promise<number> {
  const check = argv.includes("--check");
  if (argv.some((a) => a !== "--check")) {
    say("usage: seal-content.js [--check]");
    return 2;
  }
  try {
    if (!configureContent({ CONTENT_KEYS: env.CONTENT_KEYS })) {
      say("No CONTENT_KEYS in the environment: nothing to seal with.");
      return 2;
    }
  } catch (err) {
    say((err as Error).message); // names the variable and at most a key id, never a key
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
    const current = contentKeyIds()[0];
    const before = await counts(pool);
    say(`Current key: ${current}. Stored now: ${describe(before)}.`);
    const missing = [...new Set(before.map((c) => c.keyId).filter((k): k is string => k !== null && !contentKeyIds().includes(k)))];
    if (missing.length) {
      say(`No key for ${missing.join(", ")}: add ${missing.length === 1 ? "it" : "them"} to CONTENT_KEYS (after the current key) and run this again.`);
      return 1;
    }
    if (!check) {
      const r: Result = { sealed: 0, failed: 0, changed: 0 };
      for (const [content] of CONTENT) {
        const t = await sealTable(pool, content, current);
        r.sealed += t.sealed;
        r.failed += t.failed;
        r.changed += t.changed;
      }
      say(
        `Sealed ${r.sealed} under ${current}` +
          `${r.changed ? `; ${r.changed} changed meanwhile (run this again)` : ""}` +
          `${r.failed ? `; ${r.failed} could not be decrypted with their key and stay as they are` : ""}.`,
      );
    }
    const after = check ? before : await counts(pool);
    if (!check) say(`Stored now: ${describe(after)}.`);
    const left = after.filter((c) => c.keyId !== current);
    if (left.length) {
      const n = left.reduce((s, c) => s + c.n, 0);
      const keys = [...new Set(left.map((c) => c.keyId).filter((k) => k !== null))];
      say(`${n} not yet on ${current}${keys.length ? `; keep ${keys.join(", ")} in CONTENT_KEYS` : ""}${check ? "" : "; run this again"}.`);
      return 1;
    }
    say(`Everything is on ${current}. Older keys can be dropped from CONTENT_KEYS.`);
    return 0;
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Never the error's text: it could hold a row.
    if (code === "42501") say("Failed: 42501 (only reliquary_ops may seal content; is OPS_DB_PASSWORD the operator's?)");
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
