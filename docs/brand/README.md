# Brand assets

- `logo.svg`: the mark. Copied to `web/public/logo.svg`, which the stylesheet's
  `.logo` uses as a mask, so its colour comes from `--brand`, not the file.
- `logo-border.svg`: the mark in its rounded square. Copied to
  `web/public/favicon.svg`; `web/public/apple-touch-icon.png` is it at 180x180
  on white (`rsvg-convert -w 180 -h 180 -b white logo-border.svg`).
- `og.svg`: source of `web/public/og.png` (1200x630 link preview). Regenerate:

  ```bash
  podman run --rm -v "$PWD/docs/brand":/w:Z -w /w docker.io/library/debian:trixie-slim sh -c 'apt-get -qq update && apt-get -qq install -y librsvg2-bin fonts-inter && rsvg-convert -w 1200 -h 630 og.svg -o og.png' && mv docs/brand/og.png web/public/og.png
  ```
