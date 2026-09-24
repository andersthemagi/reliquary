// Errors the CLI shows as a plain sentence and an exit code. Messages never
// carry a value, a token or a server response body: only fixed text, names
// the person typed, and the API's error codes.

import { DEFAULT_SERVER } from "./config.js";

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

// Wrong arguments: exit 2, like most command lines.
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}

// No sign-in for this server, or it was revoked or expired.
export class NotSignedIn extends CliError {
  constructor(server: string, why = "You're not signed in") {
    super(`${why} to ${server}. Run \`reliquary login${loginFlag(server)}\`.`);
    this.name = "NotSignedIn";
  }
}

const loginFlag = (server: string) => (server === DEFAULT_SERVER ? "" : ` --server ${server}`);
