#!/usr/bin/env node
// reliquary: a vault's environment variables on this computer
// (docs/variables.md, "CLI"). Values go to exactly two places: one process
// (`run`) or one gitignored file (`env pull`). Nothing here prints a value
// or a token; messages go to stderr, the vault list to stdout.

import { readFileSync } from "node:fs";
import { listVaults, pickVault, readEnvironment, type Vault } from "./api.js";
import { login, logout } from "./auth.js";
import { DEFAULT_SERVER, discover, projectConfig, serverOrigin, type ProjectConfig } from "./config.js";
import { credentialsFile } from "./credentials.js";
import { CliError, UsageError } from "./errors.js";
import { checkTarget, formatDotenv, writePrivate } from "./pull.js";
import { runWith } from "./run.js";

const HELP = `reliquary: a vault's environment variables on this computer

Usage:
  reliquary login [--no-browser]        sign in with your browser
  reliquary logout                      revoke this computer's sign-in and forget it
  reliquary vaults                      the vaults and environments you can read
  reliquary run [--vault V] [--env E] -- <command> [args...]
                                        run a command with the variables in its environment
  reliquary env pull [--vault V] [--env E] [--file .env] [--outside-repo]
                                        write them to a file git ignores (mode 600)

Options:
  --server <url>   the Reliquary server (else RELIQUARY_URL, else "server" in
                   .reliquary.json, else ${DEFAULT_SERVER})
  --vault <v>      a vault's name or id (else "vault" in .reliquary.json;
                   not needed if you can reach only one)
  --env <e>        development (the default), preview or production
                   (else "environment" in .reliquary.json)
  --file <path>    env pull's file (default .env)
  --outside-repo   env pull: allow a file outside any git repository
  --no-browser     login: print the link without opening a browser
  -h, --help       this help
  -v, --version    the version

Values are never printed. Sign-ins are kept in ${credentialsFile()} (mode 600).`;

type Spec = { values: string[]; flags: string[] };
type Parsed = { opts: Record<string, string | true>; positionals: string[]; rest: string[] | null };

// `--name value`, `--name=value` and flags. With stopAtCommand, the first
// positional or `--` ends option parsing (the rest is a command line).
function parse(tokens: string[], spec: Spec, stopAtCommand = false): Parsed {
  const opts: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") return { opts, positionals, rest: tokens.slice(i + 1) };
    if (t === "-h" || t === "--help") {
      opts.help = true;
      continue;
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = t.slice(2, eq === -1 ? undefined : eq);
      if (spec.flags.includes(name)) {
        if (eq !== -1) throw new UsageError(`--${name} takes no value.`);
        opts[name] = true;
      } else if (spec.values.includes(name)) {
        const v = eq !== -1 ? t.slice(eq + 1) : tokens[++i];
        if (v === undefined || v === "") throw new UsageError(`--${name} needs a value.`);
        opts[name] = v;
      } else {
        throw new UsageError(`Unknown option ${t.slice(0, eq === -1 ? undefined : eq)}. See \`reliquary --help\`.`);
      }
      continue;
    }
    if (t.startsWith("-") && t !== "-") throw new UsageError(`Unknown option ${t}. See \`reliquary --help\`.`);
    if (stopAtCommand) return { opts, positionals, rest: tokens.slice(i) };
    positionals.push(t);
  }
  return { opts, positionals, rest: null };
}

const say = (line: string) => process.stderr.write(`${line}\n`);
const val = (o: Parsed["opts"], k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);

function version(): string {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "unknown";
  }
}

function describe(v: Vault): string {
  return `${v.name} (${v.role}): ${v.environments.length ? v.environments.join(", ") : "no environments your role may read"}`;
}

async function target(opts: Parsed["opts"], project: ProjectConfig | null) {
  const server = await discover(serverOrigin(val(opts, "server"), project));
  const vaults = await listVaults(server);
  const vault = pickVault(vaults, val(opts, "vault") ?? project?.vault);
  const environment = val(opts, "env") ?? project?.environment ?? "development";
  return { server, vault, environment };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(`${HELP}\n`);
    return command ? 0 : 2;
  }
  if (command === "-v" || command === "--version" || command === "version") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  const project = () => projectConfig();

  switch (command) {
    case "login": {
      const { opts, positionals } = parse(args, { values: ["server"], flags: ["no-browser"] });
      if (opts.help) return help();
      if (positionals.length) throw new UsageError("login takes no arguments.");
      const server = await discover(serverOrigin(val(opts, "server"), project()));
      await login(server, { openBrowser: !opts["no-browser"] && !process.env.RELIQUARY_NO_BROWSER, print: say });
      const vaults = await listVaults(server);
      say(`Signed in to ${server.issuer}. This computer can read:`);
      if (!vaults.length) say("  no vaults yet");
      for (const v of vaults) say(`  ${describe(v)}`);
      say("Revoke it any time on the Tokens page, or with `reliquary logout`.");
      return 0;
    }
    case "logout": {
      const { opts, positionals } = parse(args, { values: ["server"], flags: [] });
      if (opts.help) return help();
      if (positionals.length) throw new UsageError("logout takes no arguments.");
      const server = await discover(serverOrigin(val(opts, "server"), project()));
      const r = await logout(server);
      if (!r.had) say(`You weren't signed in to ${server.issuer}.`);
      else if (r.revoked) say(`Signed out of ${server.issuer}: the sign-in is revoked and forgotten.`);
      else say(`Forgot the sign-in for ${server.issuer}, but the server didn't confirm revoking it; check the Tokens page.`);
      return 0;
    }
    case "vaults": {
      const { opts, positionals } = parse(args, { values: ["server"], flags: [] });
      if (opts.help) return help();
      if (positionals.length) throw new UsageError("vaults takes no arguments.");
      const server = await discover(serverOrigin(val(opts, "server"), project()));
      const vaults = await listVaults(server);
      if (!vaults.length) say("This sign-in reaches no vaults.");
      for (const v of vaults) process.stdout.write(`${v.id}  ${describe(v)}\n`);
      return 0;
    }
    case "run": {
      const { opts, rest } = parse(args, { values: ["server", "vault", "env"], flags: [] }, true);
      if (opts.help) return help();
      if (!rest || rest.length === 0) throw new UsageError("Name a command to run: reliquary run [--vault V] [--env E] -- <command> [args...]");
      const { server, vault, environment } = await target(opts, project());
      const variables = await readEnvironment(server, vault, environment);
      say(`reliquary: ${variables.size} variable${variables.size === 1 ? "" : "s"} from ${vault.name} (${environment}) for ${rest[0]}`);
      return runWith(rest, variables, (l) => say(`reliquary: ${l}`));
    }
    case "env": {
      const [sub, ...more] = args;
      if (sub !== "pull") {
        if (sub === "-h" || sub === "--help") return help();
        throw new UsageError("Did you mean `reliquary env pull`?");
      }
      const { opts, positionals } = parse(more, { values: ["server", "vault", "env", "file"], flags: ["outside-repo"] });
      if (opts.help) return help();
      if (positionals.length) throw new UsageError("env pull takes no arguments; name the file with --file.");
      const file = val(opts, "file") ?? ".env";
      // Check the file before fetching anything.
      checkTarget(file, !!opts["outside-repo"]);
      const { server, vault, environment } = await target(opts, project());
      const variables = await readEnvironment(server, vault, environment);
      const where = checkTarget(file, !!opts["outside-repo"]); // again: it may have changed meanwhile
      writePrivate(where, formatDotenv(variables, { server: server.issuer, vaultName: vault.name, vaultId: vault.id, environment, at: new Date() }));
      const names = [...variables.keys()];
      say(`Wrote ${names.length} variable${names.length === 1 ? "" : "s"} from ${vault.name} (${environment}) to ${file} (mode 600)${names.length ? `: ${names.join(", ")}` : "."}`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown command "${command}". See \`reliquary --help\`.`);
  }
}

function help(): number {
  process.stdout.write(`${HELP}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof CliError) {
      say(`reliquary: ${err.message}`);
      process.exit(err.exitCode);
    }
    // Unexpected: the kind of error only, never a message that might carry
    // something from a response.
    say(`reliquary: unexpected error (${(err as NodeJS.ErrnoException)?.code ?? (err as Error)?.name ?? "unknown"}). Please report it.`);
    process.exit(1);
  },
);
