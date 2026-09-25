// Build step (npm run build, after tsc): writes dist/version.json, which
// GET /version and the footer read. The same file is web/stamp-version.mjs;
// keep the two in step.
//
//   version  ../version.txt (the release, kept by release-please), else this
//            app's package.json version (release-please bumps it in the same
//            pull request), for a build that sees only this directory. If
//            both exist and disagree, the build fails.
//   commit   VERCEL_GIT_COMMIT_SHA (Vercel sets it at build time), else
//            GITHUB_SHA, else "unknown". Anything but 7 to 40 hex digits is
//            "unknown".
//
// VERSION_FILE and VERSION_OUT override the paths (tests).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const versionFile = process.env.VERSION_FILE || here("../version.txt");
const out = process.env.VERSION_OUT || here("./dist/version.json");

const fail = (msg) => {
  console.error(`stamp-version: ${msg}`);
  process.exit(1);
};

const pkg = JSON.parse(readFileSync(here("./package.json"), "utf8")).version;
let released = null;
try {
  released = readFileSync(versionFile, "utf8").trim();
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}
if (released !== null && released !== pkg) {
  fail(`version.txt says ${released} but package.json says ${pkg}; release-please keeps them in step, so one was edited by hand`);
}
const version = released ?? pkg;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`not a version: ${JSON.stringify(version)}`);

const sha = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || "").toLowerCase();
const commit = /^[0-9a-f]{7,40}$/.test(sha) ? sha : "unknown";

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ version, commit }) + "\n");
console.log(`stamp-version: ${version} (${commit}, from ${released !== null ? "version.txt" : "package.json"})`);
