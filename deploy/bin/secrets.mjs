// New secrets for a self-hosted Reliquary, one `NAME=value` per line on
// stdout, for deploy/setup.sh to write into .env (mode 600). setup.sh runs
// this in a node container with no network and keeps only the lines for
// settings that are still empty, so an existing secret is never replaced.
// Never run it where its output is shown or logged.
//
//   POSTGRES_PASSWORD, AUTH_DB_PASSWORD,   database passwords: 32 random
//   WEB_DB_PASSWORD, MCP_DB_PASSWORD       bytes, hex
//   GOTRUE_JWT_SECRET                      required by Supabase Auth; signs
//                                          nothing here (tokens are ES256)
//   GOTRUE_JWT_KEYS                        a JSON array holding one ES256
//                                          private JWK: Auth signs sessions
//                                          with it, the web app verifies them
//                                          against its public half (JWKS)
//   SESSION_SECRET                         the web app's CSRF key
//   VARIABLES_KEYS                         k1:<32 bytes, base64url>, the key
//                                          that encrypts variable values
//   LINK_PROXY_SECRET                      shared by the web and mcp
//                                          services, authenticating mcp/'s
//                                          own calls to the web app's
//                                          internal link-call endpoint

import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";

const hex = () => randomBytes(32).toString("hex");
const b64url = (n) => randomBytes(n).toString("base64url");

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = privateKey.export({ format: "jwk" });
const keys = [{ ...jwk, kid: randomUUID(), alg: "ES256", use: "sig", key_ops: ["sign", "verify"] }];

const out = {
  POSTGRES_PASSWORD: hex(),
  AUTH_DB_PASSWORD: hex(),
  WEB_DB_PASSWORD: hex(),
  MCP_DB_PASSWORD: hex(),
  GOTRUE_JWT_SECRET: b64url(48),
  GOTRUE_JWT_KEYS: JSON.stringify(keys),
  SESSION_SECRET: b64url(32),
  VARIABLES_KEYS: `k1:${b64url(32)}`,
  LINK_PROXY_SECRET: b64url(24),
};
for (const [k, v] of Object.entries(out)) process.stdout.write(`${k}=${v}\n`);
