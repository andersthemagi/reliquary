// Preloaded (node --import) into a server that link_lookup.test.mjs starts for
// itself: prints a line for every query that looks up the <link>.<tool> tools
// a person may call, so the test can count them. Never loaded into the shared
// test server.
import pg from "pg";

const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
  if (typeof text === "string" && text.includes("list_callable_link_tools")) console.info("link-tool lookup");
  return query.apply(this, args);
};
