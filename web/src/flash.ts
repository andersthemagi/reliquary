// A flash: a one-line message carried to the next page after a form (a
// redirect), with a tone that says what kind of news it is. Stored by the
// session (auth.ts): in memory for the local stand-in, and in a cookie signed
// with the session secret when hosted, so nobody can forge one. The encoding
// here is what goes inside that signature.

export type Tone = "info" | "success" | "warning" | "danger";
export type Flash = { text: string; tone: Tone };

const TONES: readonly Tone[] = ["info", "success", "warning", "danger"];
export const isTone = (t: unknown): t is Tone => typeof t === "string" && (TONES as readonly string[]).includes(t);

// A message that carries a reference is a failure: every refusal ends with
// "(ref 1a2b3c4d)" (errorpage.ts refusalText, failure.ts), and no success
// message has one. So a call site that doesn't name a tone still shows a
// refusal as danger; anything else without a tone is info.
const REF_AT_END = /\(ref [0-9a-f]{8}\)\.?$/;
export function flashTone(text: string, tone?: Tone): Tone {
  if (tone && isTone(tone)) return tone;
  return REF_AT_END.test(text) ? "danger" : "info";
}

export const toFlash = (text: string, tone?: Tone): Flash => ({ text, tone: flashTone(text, tone) });

// base64url of {"t": tone, "m": text}. The signature covers all of it, so a
// tone can't be changed without the secret.
export function encodeFlash(f: Flash): string {
  return Buffer.from(JSON.stringify({ t: f.tone, m: f.text }), "utf8").toString("base64url");
}

// The inverse; undefined for anything that isn't a flash. A plain message
// (the format before tones, still in a browser for up to five minutes after
// a deploy) is read as its text, its tone decided as above.
export function decodeFlash(body: string): Flash | undefined {
  let s: string;
  try {
    s = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  if (!s) return undefined;
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s) as { t?: unknown; m?: unknown };
      if (typeof o.m === "string" && o.m) return { text: o.m, tone: isTone(o.t) ? o.t : flashTone(o.m) };
    } catch {
      // not JSON: a plain message that starts with "{"
    }
  }
  return toFlash(s);
}
