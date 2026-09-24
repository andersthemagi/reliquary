// HTML helpers. Everything user- or agent-written goes through esc(); there
// is no other way to put text on a page. File text is shown as plain text,
// never rendered as markdown or HTML.

export function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Tagged template: interpolated values are escaped unless wrapped in raw().
export class Raw {
  constructor(readonly html: string) {}
}
export const raw = (html: string) => new Raw(html);

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  values.forEach((v, i) => {
    if (v instanceof Raw) out += v.html;
    else if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.html : esc(x))).join("");
    else out += esc(v);
    out += strings[i + 1];
  });
  return raw(out);
}

export function page(title: string, body: Raw, opts: { user?: string; flash?: string } = {}): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Reliquary</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="top">
  <a class="brand" href="/">Reliquary</a>
  ${opts.user ? html`<nav><a href="/">Vaults</a><a href="/tokens">Tokens</a></nav>` : ""}
</header>
<main>
${opts.flash ? html`<p class="flash">${opts.flash}</p>` : ""}
${body}
</main>
</body>
</html>`.html;
}

export function when(d: Date | null | undefined): string {
  if (!d) return "";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

// Hidden field carrying the CSRF token for every form.
export const csrfField = (token: string) => html`<input type="hidden" name="csrf" value="${token}">`;
