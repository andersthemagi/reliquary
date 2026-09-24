# Brand assets

- `og.svg`: source of `web/public/og.png` (1200x630 link preview). Regenerate:

  ```bash
  podman run --rm -v "$PWD/docs/brand":/w:Z -w /w docker.io/library/debian:trixie-slim sh -c 'apt-get -qq update && apt-get -qq install -y librsvg2-bin fonts-inter && rsvg-convert -w 1200 -h 630 og.svg -o og.png' && mv docs/brand/og.png web/public/og.png
  ```
