// Photographs the demo web app (demo-shots.sh) with headless Chromium over
// the DevTools protocol, no browser library: Node's own WebSocket is enough
// for the six commands this needs. Writes web/public/img/<name>-<theme>.webp
// for each screen, then the reel (reel-<theme>.webm with its poster, and
// reel.gif) from the core loop as it actually runs: the proposal is
// approved by clicking Approve on the page, not by a database call.
//
// LOGIN_URL is the demo account's one-time sign-in link (the shell script
// reads it from the file); it's used once here and never written anywhere.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8791";
const OUT = "web/public/img";
const WIDTH = 1440;
const HEIGHT = 900;
const HOLD = 2.8; // seconds a reel frame stays
const FADE = 0.5; // seconds of crossfade between frames (the webm only)

const login = process.env.LOGIN_URL;
if (!login) throw new Error("LOGIN_URL is not set: run this through scripts/demo-shots.sh");

const work = await mkdtemp(join(tmpdir(), "reliquary-shots-"));
await mkdir(OUT, { recursive: true });

const chromium = spawn(
  process.env.CHROMIUM ?? "chromium",
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${join(work, "profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--disable-gpu",
    `--window-size=${WIDTH},${HEIGHT}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const wsUrl = await new Promise((resolve, reject) => {
  let err = "";
  chromium.stderr.on("data", (d) => {
    err += d;
    const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  chromium.on("exit", (code) => reject(new Error(`chromium exited with ${code}: ${err}`)));
});
const port = new URL(wsUrl).port;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
const waiters = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(`${m.error.message}`)) : resolve(m.result);
  } else if (m.method && waiters.has(m.method)) {
    waiters.get(m.method)();
    waiters.delete(m.method);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const loaded = () => new Promise((resolve) => waiters.set("Page.loadEventFired", resolve));

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });

async function go(path) {
  const done = loaded();
  await send("Page.navigate", { url: path.startsWith("http") ? path : BASE + path });
  await done;
  await send("Runtime.evaluate", { expression: "document.fonts.ready.then(() => 1)", awaitPromise: true });
}
// Reduced motion too: the stylesheet's 120ms transitions would otherwise be
// mid-way when a screenshot lands right after the theme switch.
async function theme(name) {
  await send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: name },
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  });
  await send("Runtime.evaluate", { expression: "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))", awaitPromise: true });
}
async function png(file) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(file, Buffer.from(data, "base64"));
  return file;
}
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
const webp = (from, to) => ffmpeg("-i", from, "-c:v", "libwebp", "-quality", "82", to);

// Sign in: the one-time link sets the session cookie and lands on Home.
await go(login);

// The screens. The vault and the open runbook proposal are found from the
// pages themselves, so the ids the seed produced don't matter.
const vault = await send("Runtime.evaluate", { expression: `document.querySelector('a[href^="/v/"]').getAttribute("href")`, returnByValue: true }).then((r) => r.result.value);
await go(`${vault}/proposals`);
const proposal = await send("Runtime.evaluate", {
  expression: `[...document.querySelectorAll('a[href*="/proposals/"]')].find(a => a.textContent.includes("runbook")).getAttribute("href")`,
  returnByValue: true,
}).then((r) => r.result.value);

const screens = [
  ["home", "/"],
  ["inbox", "/inbox"],
  ["proposal", proposal],
  ["file", `${vault}/file?path=canon%2Frunbook.md`],
  ["variables", `${vault}/variables`],
  ["links", `${vault}/links`],
  ["changes", `${vault}/changes`],
  ["connect", "/connect"],
];
for (const [name, path] of screens) {
  await go(path);
  for (const t of ["light", "dark"]) {
    await theme(t);
    await webp(await png(join(work, `${name}-${t}.png`)), join(OUT, `${name}-${t}.webp`));
  }
}

// The reel, at 1x, each step in both themes (the theme is emulated, so a
// step is photographed twice without reloading): inbox, the proposal,
// Approve clicked, the file now canon, the log.
await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
const frames = { light: [], dark: [] };
const frame = async (name) => {
  for (const t of ["light", "dark"]) {
    await theme(t);
    frames[t].push(await png(join(work, `reel-${frames[t].length}-${name}-${t}.png`)));
  }
};
await go("/inbox");
await frame("inbox");
await go(proposal);
await frame("proposal");
const approved = loaded();
await send("Runtime.evaluate", { expression: `document.querySelector('button[name="decision"][value="approve"]').click()` });
await approved;
await frame("approved");
await go(`${vault}/file?path=canon%2Frunbook.md`);
await frame("file");
await go(`${vault}/changes`);
await frame("changes");

for (const [t, list] of Object.entries(frames)) {
  // WebM: each frame held, crossfading into the next.
  const inputs = list.flatMap((f) => ["-loop", "1", "-t", String(HOLD + FADE), "-i", f]);
  const chain = list
    .slice(1)
    .map((_, i) => `[${i === 0 ? "0" : `v${i}`}][${i + 1}]xfade=transition=fade:duration=${FADE}:offset=${((i + 1) * HOLD).toFixed(2)}[v${i + 1}]`)
    .join(";");
  ffmpeg(...inputs, "-filter_complex", `${chain};[v${list.length - 1}]scale=1280:-2,format=yuv420p[out]`, "-map", "[out]", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-an", join(OUT, `reel-${t}.webm`));
  await webp(list[1], join(OUT, `reel-${t}-poster.webp`));
}
// GIF (the README): the light frames, each held, no fades (fades cost a GIF dearly).
const list = frames.light.map((f) => `file '${f}'\nduration ${HOLD}`).join("\n") + `\nfile '${frames.light.at(-1)}'\n`;
await writeFile(join(work, "frames.txt"), list);
ffmpeg("-f", "concat", "-safe", "0", "-i", join(work, "frames.txt"), "-vf", "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3", "-loop", "0", join(OUT, "reel.gif"));

ws.close();
chromium.kill();
await new Promise((resolve) => chromium.on("exit", resolve)); // it writes its profile until it's gone
await rm(work, { recursive: true, force: true });
console.log(`wrote ${screens.length * 2} screens and the reel to ${OUT}/`);
