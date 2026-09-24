// People by email, where a page names someone (Activity, proposals, review
// lists, the Account menu), in one database call per page.
//
// A page doesn't know, while it is built, which of the people it names the
// reader may see the email of. So it writes personRef(id), a marker, and
// fillPeople() replaces every marker in the finished HTML at once, from
// public.co_member_emails: the emails of people who share a vault with the
// reader now, and the reader's own (20260925160000_membership_polish.sql).
// Anyone else (a former member, say) keeps the short id pages showed before.
//
// The marker holds a random per-process nonce, so text a member wrote (a
// file, a comment, a vault name) can't forge one: nothing on a page carries
// the nonce but what this module wrote, and markers never reach a browser.

import { asPerson } from "./db.js";
import { esc } from "./html.js";
import { PERSON_MARK, shortId } from "./personref.js";

export { personRef, shortId } from "./personref.js";

// co_member_emails takes at most 500 ids a call.
const BATCH = 500;

// Replaces every marker in `html` as `userId` sees them.
export async function fillPeople(userId: string, html: string): Promise<string> {
  const ids = [...new Set(Array.from(html.matchAll(PERSON_MARK), (m) => m[1]))];
  if (!ids.length) return html;
  const emails = new Map<string, string>();
  try {
    await asPerson(userId, async (c) => {
      for (let i = 0; i < ids.length; i += BATCH) {
        const { rows } = await c.query(`select user_id, email from public.co_member_emails($1::uuid[])`, [ids.slice(i, i + BATCH)]);
        for (const r of rows) emails.set(r.user_id, r.email);
      }
    });
  } catch {
    // Short ids, as before, rather than no page.
  }
  return html.replace(PERSON_MARK, (_m, id: string) => esc(emails.get(id) ?? shortId(id)));
}
