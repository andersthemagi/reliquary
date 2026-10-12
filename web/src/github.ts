// The public repository and its star count, shown on the landing page so
// visitors see the code is public. The page loads nothing from elsewhere,
// so the server asks GitHub's API and the page carries the number.

export const REPO_URL = "https://github.com/andersthemagi/reliquary";
const API = `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/andersthemagi/reliquary`;

// An hour per answer keeps a warm instance inside GitHub's unauthenticated
// limit (60 an hour per address); a failure waits five minutes, not an hour.
// The short timeout bounds what a slow GitHub adds to a landing page: past
// it the page shows the link without a number.
let cached: { stars: number | null; until: number } = { stars: null, until: 0 };

export async function githubStars(): Promise<number | null> {
  const now = Date.now();
  if (now < cached.until) return cached.stars;
  try {
    const r = await fetch(API, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(800) });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const n = (await r.json() as { stargazers_count?: unknown }).stargazers_count;
    if (typeof n !== "number") throw new Error("GitHub's answer had no stargazers_count");
    cached = { stars: n, until: now + 3_600_000 };
  } catch (e) {
    console.warn(`landing page: reading the star count from ${API} failed (${(e as Error).message}); the GitHub link shows without it for 5 minutes`);
    cached = { stars: cached.stars, until: now + 300_000 };
  }
  return cached.stars;
}
