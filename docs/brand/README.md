# Brand assets

- `logo.svg`: the mark. Copied to `web/public/logo.svg`, which the stylesheet's
  `.logo` uses as a mask, so its colour comes from `--brand`, not the file.
- `logo-border.svg`: the mark in its rounded square. Copied to
  `web/public/favicon.svg`; `web/public/apple-touch-icon.png` is it at 180x180
  on white (`rsvg-convert -w 180 -h 180 -b white logo-border.svg`).
- `web/public/img/`: the product pictures on the landing page and in the
  README (eight screens, light and dark; the reel as `reel-<theme>.webm`
  with its `-poster.webp`, and `reel.gif` for the README). Photographed from the running app, of
  a fictional vault, by `scripts/demo-shots.sh` (needs `./mcp/dev.sh up`,
  and chromium, node and ffmpeg on the host); never edited by hand, and
  regenerated whenever the UI they show changes.

- `og.svg`: source of `web/public/og.png` (1200x630 link preview). Regenerate:

  ```bash
  podman run --rm -v "$PWD/docs/brand":/w:Z -w /w docker.io/library/debian:trixie-slim sh -c 'apt-get -qq update && apt-get -qq install -y librsvg2-bin fonts-inter && rsvg-convert -w 1200 -h 630 og.svg -o og.png' && mv docs/brand/og.png web/public/og.png
  ```
