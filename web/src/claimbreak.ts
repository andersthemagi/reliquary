// The two pieces the Break flow shares between the claim banner (the file
// page and the editor, claimbanner.ts) and the Claims page's confirm page
// (claimspage.ts): the confirm page's address, and where it may send a
// person back to afterwards.
//
// The return target arrives in a query string and in a form field, both of
// which anyone can write, so it is only ever followed when it is a page of
// this same vault. Anything else, however it is spelled, is dropped and
// the person lands on the Claims page as they would have before.

import { safeNext } from "./signin.js";
import { q, vaultPath } from "./pages.js";

// The Claims route's confirm page, optionally with the page to come back to.
export const breakHref = (id: string, path: string, back?: string) =>
  `${vaultPath(id, "/claims")}?break=${q(path)}${back ? `&return=${q(back)}` : ""}`;

// `value` if it is a local address inside vault `id`'s own pages, else null.
// safeNext refuses what points off this site (another host, //host, /\host,
// control characters, backslashes); the pathname check then refuses another
// vault's pages and every spelling of "../" that climbs out of this one,
// since the URL parser resolves dot segments, encoded ones included, the same
// way the browser will when it follows the redirect.
export function returnTarget(id: string, value: string | null | undefined): string | null {
  const v = value ?? "";
  if (!v || safeNext(v) !== v) return null;
  const { pathname } = new URL(v, "http://x");
  return pathname === vaultPath(id) || pathname.startsWith(vaultPath(id, "/")) ? v : null;
}
