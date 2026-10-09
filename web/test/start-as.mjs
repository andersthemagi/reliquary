// A second web server signed in as another seeded person, for the cases where
// the person the file's own server is signed in as isn't the one needed (the
// seed's one person with a single vault, say). Starts dist/server.js as
// web/test.sh does and signs in with the one-time login link it writes.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
// web/test.sh puts Postgres at 54332 + 10 * slot and the server at 8791 + 10 * slot.
const PG_PORT = 54332 + (Number(WEB.port) - 8791);

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

export async function startAs(user, env = {}) {
  const port = await freePort();
  const loginFile = `/tmp/start-as-login-${process.pid}-${user.slice(-1)}`;
  const proc = spawn(process.execPath, ["dist/server.js"], {
    env: {
      ...process.env,
      DATABASE_URL: `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`,
      LOCAL_USER_ID: user,
      LOGIN_FILE: loginFile,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_URL: "",
      ...env,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${url}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  return { url, cookie: r.headers.get("set-cookie").split(";")[0], stop: () => proc.kill() };
}
