// The release this build is (dist/version.json, written by stamp-version.mjs
// at build time): GET /version and the footer. Never a secret: a version
// number and a commit SHA from a public tag. The same file is
// mcp/src/version.ts; keep the two in step.
import { readFileSync } from "node:fs";

export type BuildVersion = { version: string; commit: string };

function load(): BuildVersion {
  try {
    const v = JSON.parse(readFileSync(new URL("./version.json", import.meta.url), "utf8"));
    if (typeof v?.version === "string" && typeof v?.commit === "string") return { version: v.version, commit: v.commit };
  } catch {
    // Built with bare tsc, without the stamp: say so rather than guess.
  }
  return { version: "unknown", commit: "unknown" };
}

export const BUILD: BuildVersion = load();

// The body of GET /version: exactly these two fields.
export const versionJson = (): string => JSON.stringify({ version: BUILD.version, commit: BUILD.commit });
