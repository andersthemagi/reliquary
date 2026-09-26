// The top bar's data, in one call per page (html.ts draws it). The database
// builds it (public.shell_summary, 20260926100000_shell_inbox.sql): who is
// signed in (email and display name), their vaults for the switcher, and
// their inbox: counts of proposals waiting on their review (snoozed ones
// left out), their own proposals sent back with changes requested, .env
// imports they may apply, invites to their address and vault deletion
// notices, with the newest few items. The Inbox page itself is pages.ts's
// inbox(), which asks for the full lists only where a count says so.

import type pg from "pg";
import type { Shell } from "./html.js";

// How many items the inbox menu lists.
export const INBOX_MENU_ITEMS = 5;

export async function loadShell(c: pg.PoolClient): Promise<Shell> {
  const s = (await c.query(`select public.shell_summary($1) as s`, [INBOX_MENU_ITEMS])).rows[0].s as Shell;
  return { ...s, total: Number(s.total) || 0 };
}
