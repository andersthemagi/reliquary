// Preloaded (node --import) into a server that register_failure.test.mjs
// starts for itself: makes registering the one tool named in
// FAULT_REGISTER_TOOL throw, the way the SDK throws for a name registered
// twice, so a failure inside registerTools() can be tested without a
// production seam. Never loaded into the shared test server.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const name = process.env.FAULT_REGISTER_TOOL;
const register = McpServer.prototype.registerTool;
McpServer.prototype.registerTool = function (toolName, ...rest) {
  if (toolName === name) throw new Error("simulated: tool is already registered");
  return register.call(this, toolName, ...rest);
};
