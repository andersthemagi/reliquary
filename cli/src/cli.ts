#!/usr/bin/env node
// reliquary: a vault's environment variables on this computer
// (docs/variables.md, "CLI"). Values go to exactly two places: one process
// (`run`) or one gitignored file (`env pull`). `env push` sends a .env's
// values to the server for a person to apply there; it sets nothing itself.
// Nothing here prints a value or a token; messages go to stderr, the vault
// list and a push's approval link to stdout.

import { readFileSync } from "node:fs";
import { listVaults, pickVault, pushEnvironment, readEnvironment, type Vault } from "./api.js";
import { login, logout } from "./auth.js";
import { DEFAULT_SERVER, discover, projectConfig, serverOrigin, type ProjectConfig } from "./config.js";
import { credentialStore, credentialsFile } from "./credentials.js";
import { CliError, fsFailure, UsageError } from "./errors.js";
import { checkTarget, formatDotenv, privacyNote, writePrivate } from "./pull.js";
import { readDotenv, waitForDecision } from "./push.js";
import { runWith } from "./run.js";

// The help text is also data: web/scripts/docs-lib.mjs (cliDefinitions) reads
// this declaration with a regex, from its opening backtick to the first
// backtick followed by a semicolon, and builds docs/public/reference/cli.md
// from it. So the text must stay one plain template literal with no backtick
// inside; the only interpolations it understands are DEFAULT_SERVER and
// credentialsFile() (any other fails the docs build until docs-lib.mjs is
// taught); and every command needs a usage line in this form,
//   "  reliquary <command> ...",
// because the docs' command list comes from those lines. Option names come
// from the --flags listed here and from the parse() specs below, and
// web/test/docs.test.mjs fails when the docs and either of them disagree.
const HELP = `reliquary: a vault's environment variables on this computer

Usage:
  reliquary login [--no-browser]        connect the Reliquary CLI to your account
  reliquary logout                      revoke this connection and forget it
  reliquary vaults                      the vaults and environments you can read
  reliquary run [--vault V] [--env E] -- <command> [args...]
                                        run a command with the variables in its environment
  reliquary env pull [--vault V] [--env E] [--file .env] [--outside-repo]
                                        write them to a file git ignores (mode 600;
                                        on Windows, its folder's permissions)
  reliquary env push [--vault V] [--env E] [--file .env] [--wait [--timeout 15m]]
                                        send a .env's values for a person to apply
                                        in the web UI (nothing is set until then)

Options:
  --server <url>   the Reliquary server (else RELIQUARY_URL, else "server" in
                   .reliquary.json, else ${DEFAULT_SERVER})
  --vault <v>      a vault's name or id (else "vault" in .reliquary.json;
                   not needed if you can reach only one)
  --env <e>        development (the default), preview or production
                   (else "environment" in .reliquary.json)
  --file <path>    env pull's or push's file (default .env)
  --wait           env push: wait until a person applies or rejects it
  --timeout <t>    env push --wait: how long, like 90s, 15m or 2h (default 15m)
  --outside-repo   env pull: allow a file outside any git repository
  --no-browser     login: print the link without opening a browser
  -h, --help       this help
  -v, --version    the version

Values are never printed. The connection is kept in the OS keychain when
there is one (macOS Keychain, Secret Service, Windows DPAPI), else in
${credentialsFile()} (mode 600); RELIQUARY_CREDENTIALS=file or keychain
chooses.`;

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
      say(`Connected the Reliquary CLI to ${server.issuer}. It can read:`);
      if (!vaults.length) say("  no vaults yet");
      for (const v of vaults) say(`  ${describe(v)}`);
      say(`The connection is kept in ${credentialStore().where}.`);
      say("It shows on the Connections page as Reliquary CLI. Revoke it there any time, or with `reliquary logout`.");
      return 0;
    }
    case "logout": {
      const { opts, positionals } = parse(args, { values: ["server"], flags: [] });
      if (opts.help) return help();
      if (positionals.length) throw new UsageError("logout takes no arguments.");
      const server = await discover(serverOrigin(val(opts, "server"), project()));
      const r = await logout(server);
      if (!r.had) say(`The Reliquary CLI wasn't connected to ${server.issuer}.`);
      else if (r.revoked) say(`Disconnected from ${server.issuer}: the connection is revoked and forgotten.`);
      else say(`Forgot the connection to ${server.issuer}, but the server didn't confirm revoking it; check the Connections page.`);
      return 0;
    }
    case "vaults": {
      const { opts, positionals } = parse(args, { values: ["server"], flags: [] });
      if (opts.help) return help();
      if (positionals.length) throw new UsageError("vaults takes no arguments.");
      const server = await discover(serverOrigin(val(opts, "server"), project()));
      const vaults = await listVaults(server);
      if (!vaults.length) say("This connection reaches no vaults.");
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
      const code = await runWith(rest, variables, (l) => say(`reliquary: ${l}`));
      // Whose error it was, for someone who installed this minutes ago and
      // blames it for the command's own. 128 and up is a signal or a Ctrl-C
      // the command handled (npm exits 130): stopping a dev server isn't a
      // failure to explain.
      if (code > 0 && code < 128) say(`reliquary: ${rest[0]} exited with code ${code}. Anything printed above that isn't a "reliquary:" line came from ${rest[0]}, not Reliquary.`);
      return code;
    }
    case "env": {
      const [sub, ...more] = args;
      if (sub === "push") return push(more, project());
      if (sub !== "pull") {
        if (sub === "-h" || sub === "--help") return help();
        throw new UsageError("Did you mean `reliquary env pull` or `reliquary env push`?");
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
      say(`Wrote ${names.length} variable${names.length === 1 ? "" : "s"} from ${vault.name} (${environment}) to ${file} (${privacyNote()})${names.length ? `: ${names.join(", ")}` : "."}`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown command "${command}". See \`reliquary --help\`.`);
  }
}

// Durations like 90s, 15m, 2h (a bare number is minutes), up to a day.
function duration(raw: string): number {
  const m = /^(\d{1,5})(s|m|h)?$/.exec(raw);
  if (!m) throw new UsageError("--timeout takes a duration like 90s, 15m or 2h.");
  const ms = Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "m") as "s" | "m" | "h"];
  if (ms < 1000 || ms > 24 * 3_600_000) throw new UsageError("--timeout is between 1s and 24h.");
  return ms;
}

// `reliquary env push`: exit 0 when sent (with --wait: when applied), 1 when
// refused, rejected or expired, 3 when --wait ran out of time first or
// couldn't check the push three times running (it may still be pending).
async function push(args: string[], project: ProjectConfig | null): Promise<number> {
  const { opts, positionals } = parse(args, { values: ["server", "vault", "env", "file", "timeout"], flags: ["wait"] });
  if (opts.help) return help();
  if (positionals.length) throw new UsageError("env push takes no arguments; name the file with --file.");
  if (opts.timeout && !opts.wait) throw new UsageError("--timeout goes with --wait.");
  const timeout = duration(val(opts, "timeout") ?? "15m");
  const file = val(opts, "file") ?? ".env";
  // Read and check the file before asking the server anything.
  const { entries, refused } = readDotenv(file);
  for (const r of refused) say(`reliquary: ${file} line ${r.line}${r.name ? ` (${r.name})` : ""}: ${r.reason}; not sent.`);
  if (!entries.length) throw new CliError(`Nothing in ${file} can be sent.`);
  const { server, vault, environment } = await target(opts, project);
  if (!vault.environments.includes(environment)) {
    throw new CliError(`Your role can't set values in ${environment} of ${vault.name}${vault.environments.length ? ` (you can in ${vault.environments.join(", ")})` : ""}.`);
  }
  const p = await pushEnvironment(server, vault, environment, entries, refused);
  const fresh = p.names.filter((n) => !p.overwrites.includes(n));
  say(
    `reliquary: sent ${p.names.length} variable${p.names.length === 1 ? "" : "s"} for ${vault.name} (${environment}) for approval` +
      `${fresh.length ? `; new: ${fresh.join(", ")}` : ""}${p.overwrites.length ? `; replacing: ${p.overwrites.join(", ")}` : ""}.`,
  );
  say("reliquary: nothing is set until a person applies it in the web UI (it expires in 24 hours):");
  process.stdout.write(`${p.url}\n`);
  if (!opts.wait) return 0;
  say("reliquary: waiting for approval...");
  const outcome = await waitForDecision(server, p.id, timeout);
  if (outcome === "applied") {
    say(`reliquary: applied. ${vault.name} (${environment}) now has ${p.names.join(", ")}.`);
    return 0;
  }
  if (outcome === "pending") {
    say("reliquary: still waiting for approval; it stays open until it expires. Run again with --wait, or check the link.");
    return 3;
  }
  throw new CliError(outcome === "rejected" ? "The push was rejected; nothing was set." : "The push expired before anyone applied it; nothing was set.");
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
    const e = err as NodeJS.ErrnoException | undefined;
    // A file the system refused that nothing wrapped is the computer's
    // trouble, not a bug in the CLI.
    if (typeof e?.syscall === "string" && typeof e.path === "string" && typeof e.code === "string") {
      say(`reliquary: ${fsFailure(e.syscall, e.path, e).message}`);
      process.exit(1);
    }
    // A bug in the CLI: which command, the error's kind and code, and where
    // in the CLI it was thrown; never its message, which might carry
    // something from a response or a value.
    const kind = `${e?.name ?? "Error"}${typeof e?.code === "string" ? ` ${e.code}` : ""}`;
    const at = /\/(dist\/[\w.-]+\.js:\d+)(?::\d+)?\)?$/m.exec(typeof e?.stack === "string" ? e.stack.split("\n").slice(1).join("\n") : "");
    const [first, second] = process.argv.slice(2);
    const command = ["login", "logout", "vaults", "run"].includes(first) ? first : first === "env" && ["pull", "push"].includes(second) ? `env ${second}` : "the command";
    say(`reliquary: ${command === "the command" ? command : `\`reliquary ${command}\``} stopped on a bug in the CLI: ${kind}${at ? ` at ${at[1]}` : ""}. Nothing more is shown in case it holds a value. Please report this line (\`reliquary --version\` too).`);
    process.exit(1);
  },
);
