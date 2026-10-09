// Preloaded (node --import) into a server that register_failure.test.mjs
// starts for itself: makes building a request's MCP server throw. That happens
// in serve() outside its try, so only the handler that wraps serve() can
// answer it. Never loaded into the shared test server.
import { Protocol } from "@modelcontextprotocol/sdk/shared/protocol.js";

Protocol.prototype.setRequestHandler = function () {
  throw new Error("simulated: the MCP server cannot be built");
};
