// Which paths a watch covers, as an SQL expression: the path itself, or, for a
// watch on a folder (a target ending in "/"), anything under it. Named once
// for the web: the Watch button on a page (watching.ts) and the Watching
// filter on Changes (changes.ts) both build their queries from it.
//
// public.list_flags states the same rule inline (supabase/migrations/
// 20260928150000_flags.sql), mixed in with watermarks and "what you did
// yourself isn't flagged to you", so it can't be called from here.
// web/test/changes_page.test.mjs runs both on one set of paths and fails if
// they ever disagree.

export const watchCovers = (target: string, path: string): string =>
  `(${path} = ${target} or (right(${target}, 1) = '/' and starts_with(${path}, ${target})))`;
