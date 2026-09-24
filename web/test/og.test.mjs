// Link previews: the landing page names a 1200x630 PNG served from this site.

import assert from "node:assert/strict";
import { test } from "node:test";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";

test("og: the preview image is served as a PNG and named with its size", async () => {
  const img = await fetch(`${BASE}/og.png`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  const bytes = new Uint8Array(await img.arrayBuffer());
  assert.deepEqual([...bytes.slice(1, 4)], [0x50, 0x4e, 0x47]); // "PNG"
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(16), 1200);
  assert.equal(view.getUint32(20), 630);
});

test("og: the landing page points previews at the image, full size", async () => {
  const A = process.env.WEB_AUTH_A_URL;
  const origin = new URL(process.env.WEB_AUTH_PUBLIC_URL).origin;
  const h = await (await fetch(`${A}/`, { redirect: "manual" })).text();
  assert.match(h, new RegExp(`<meta property="og:image" content="${origin.replace(/[.]/g, "\\.")}/og\\.png">`));
  assert.match(h, /<meta property="og:image:width" content="1200">/);
  assert.match(h, /<meta name="twitter:card" content="summary_large_image">/);
});
