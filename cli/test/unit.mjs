// `npm test`: the CLI's unit tests, every test/*.test.mjs except the
// end-to-end files, which need the servers cli/test.sh starts. No
// containers, no network: this is what CI runs on Linux, macOS and Windows
// (.github/workflows/test.yml, job cli-unit). Run from cli/ after `tsc`.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const END_TO_END = new Set(["cli.test.mjs", "push.test.mjs"]);

const files = readdirSync("test")
  .filter((f) => f.endsWith(".test.mjs") && !END_TO_END.has(f))
  .sort()
  .map((f) => path.join("test", f));
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
