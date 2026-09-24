// `reliquary run`: one process gets the variables in its environment.
// Spawned directly (no shell), stdio inherited, signals forwarded, and its
// exit code (or 128 + signal) becomes ours. Nothing is written to disk and
// no value is printed; an override of an inherited variable is named.

import { spawn } from "node:child_process";
import os from "node:os";
import { CliError } from "./errors.js";

const FORWARD: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGUSR2"];

export function runWith(command: string[], variables: Map<string, string>, say: (line: string) => void): Promise<number> {
  const [file, ...args] = command;
  const env: NodeJS.ProcessEnv = { ...process.env };
  const overridden: string[] = [];
  for (const [name, value] of variables) {
    if (name in process.env) overridden.push(name);
    env[name] = value;
  }
  if (overridden.length) say(`overriding ${overridden.join(", ")} from your environment`);

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { stdio: "inherit", env, shell: false });
    } catch (err) {
      reject(spawnError(err as NodeJS.ErrnoException, file));
      return;
    }
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const sig of FORWARD) {
      if (process.platform === "win32" && sig !== "SIGINT" && sig !== "SIGTERM") continue;
      const h = () => {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      };
      handlers.set(sig, h);
      process.on(sig, h);
    }
    const detach = () => {
      for (const [sig, h] of handlers) process.off(sig, h);
    };
    child.on("error", (err) => {
      detach();
      reject(spawnError(err as NodeJS.ErrnoException, file));
    });
    child.on("exit", (code, signal) => {
      detach();
      if (code !== null) resolve(code);
      else resolve(128 + (signal ? (os.constants.signals[signal] ?? 0) : 0));
    });
  });
}

function spawnError(err: NodeJS.ErrnoException, file: string): CliError {
  // The command's name only: never its environment.
  if (err.code === "ENOENT") return new CliError(`Command not found: ${file}`, 127);
  if (err.code === "EACCES") return new CliError(`Permission denied running ${file}`, 126);
  if (err.code === "E2BIG") return new CliError(`The environment is too large to start ${file}.`, 126);
  return new CliError(`Couldn't start ${file} (${err.code ?? "error"}).`, 126);
}
