// A stand-in Reliquary server for the unit tests, so they need no database:
// the OAuth metadata `discover` reads, plus whatever routes a test supplies.
// Not a test file (no .test.mjs), so cli/test.sh and `npm test` skip it.

import http from "node:http";

// `route(req, res)` answers a request and returns true, or returns false to
// let the stub say 404.
export async function stubServer(route = () => false) {
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.url === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/oauth/authorize`,
          token_endpoint: `${origin}/oauth/token`,
          revocation_endpoint: `${origin}/oauth/revoke`,
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }
    if (!(await route(req, res))) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))),
  };
}

export const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
  return true;
};
