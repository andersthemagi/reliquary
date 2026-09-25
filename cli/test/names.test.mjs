// The CLI refuses the same start-up names as the database (and the web
// app, which shares dotenv.ts), including Windows, trust-store and npm ones.

import assert from "node:assert/strict";
import { test } from "node:test";
import { safeName } from "../dist/api.js";

test("names: Windows, trust-store and npm config names are refused", () => {
  for (const n of ["COMSPEC", "ComSpec", "PATHEXT", "SYSTEMROOT", "WINDIR", "PSModulePath",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "npm_config_script_shell", "NPM_CONFIG_PREFIX"]) {
    assert.equal(safeName(n), false, n);
  }
  for (const n of ["NPM_TOKEN", "SSL_ENABLED", "DATABASE_URL"]) assert.equal(safeName(n), true, n);
});
