# Reliquary's web app as a container image, for self-hosting (deploy/,
# docs/public/how-to/self-host.md). Build from the repository root, which
# the docs build reads (docs/public, the MCP contract, the CLI's help, the
# changelog):
#
#   podman build -f web/Dockerfile -t reliquary-web --build-arg GIT_COMMIT=$(git rev-parse HEAD) .
#
# The hosted service doesn't use this image (it runs on Vercel from source).
# The image runs as the unprivileged `node` user, writes nothing to its
# filesystem (run it read-only), listens on PORT (8790) on all interfaces,
# and answers GET /healthz. SELF_HOSTED=1 is set: the server refuses to start
# without the settings a real deployment needs (deploy/compose/.env.example).

ARG NODE_IMAGE=docker.io/library/node:22-slim

FROM ${NODE_IMAGE} AS build
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /repo/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error
COPY version.txt CHANGELOG.md /repo/
COPY docs/public /repo/docs/public
COPY cli/src/cli.ts cli/src/config.ts /repo/cli/src/
COPY mcp/test/contract.snapshot.json /repo/mcp/test/
COPY web/tsconfig.json web/stamp-version.mjs web/supabase-ca.crt ./
COPY web/scripts ./scripts
COPY web/src ./src
COPY web/public ./public
# The commit is stamped into /version (stamp-version.mjs reads GITHUB_SHA).
ARG GIT_COMMIT=unknown
RUN GITHUB_SHA="$GIT_COMMIT" npm run -s build && npm prune --omit=dev --no-audit --no-fund --loglevel=error

FROM ${NODE_IMAGE}
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8790 SELF_HOSTED=1
WORKDIR /app
COPY --from=build /repo/web/package.json ./
COPY --from=build /repo/web/node_modules ./node_modules
COPY --from=build /repo/web/dist ./dist
COPY --from=build /repo/web/docs-build ./docs-build
COPY --from=build /repo/web/public ./public
COPY --from=build /repo/web/supabase-ca.crt ./
USER node
EXPOSE 8790
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
