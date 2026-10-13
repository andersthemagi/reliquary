// People by email, and by name where they gave one, where a page names
// someone (Activity, proposals, review lists), in one database call per page.
//
// A page doesn't know, while it is built, which of the people it names the
// reader may see the email of. So it writes personRef(id), a marker, and
// fillPeople() replaces every marker in the finished HTML at once, from
// public.co_member_people: how each person who shares a vault with the
// reader now, and the reader themself, is shown, label and all, decided in
// the database so pages and MCP responses can't drift apart: name and
// email, or name and a short tag for someone who hides their email
// (20261014150000_display_preferences.sql); "a deleted account" to anyone
// (20260926140200_delete_account.sql). Anyone else (a former member, say)
// keeps the short id pages showed before.
//
// The marker holds a random per-process nonce, so text a member wrote (a
// file, a comment, a vault name) can't forge one: nothing on a page carries
// the nonce but what this module wrote, and markers never reach a browser.

import { asPerson } from "./db.js";
import { esc } from "./html.js";
import { PERSON_MARK, shortId } from "./personref.js";

export { personRef, shortId } from "./personref.js";

// co_member_people takes at most 500 ids a call.
const BATCH = 500;

// How `userId` may see each of `ids` written: only the ones they may see
// (anyone else is missing from the map).
export async function peopleLabels(userId: string, ids: string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (!ids.length) return labels;
  await asPerson(userId, async (c) => {
    for (let i = 0; i < ids.length; i += BATCH) {
      const { rows } = await c.query(`select user_id, label from public.co_member_people($1::uuid[])`, [ids.slice(i, i + BATCH)]);
      for (const r of rows) labels.set(r.user_id, r.label);
    }
  });
  return labels;
}

// Replaces every marker in `html` as `userId` sees them.
export async function fillPeople(userId: string, html: string): Promise<string> {
  const ids = [...new Set(Array.from(html.matchAll(PERSON_MARK), (m) => m[1]))];
  if (!ids.length) return html;
  let emails = new Map<string, string>();
  try {
    emails = await peopleLabels(userId, ids);
  } catch {
    // Short ids, as before, rather than no page.
  }
  return html.replace(PERSON_MARK, (_m, id: string) => esc(emails.get(id) ?? shortId(id)));
}
