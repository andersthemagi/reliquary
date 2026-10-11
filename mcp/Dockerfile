# Reliquary's MCP server as a container image, for self-hosting (deploy/,
# docs/public/how-to/self-host.md). Build from the repository root:
#
#   podman build -f mcp/Dockerfile -t reliquary-mcp --build-arg GIT_COMMIT=$(git rev-parse HEAD) .
#
# The hosted service doesn't use this image (it runs on Netlify from source).
# The image runs as the unprivileged `node` user, writes nothing to its
# filesystem (run it read-only), listens on PORT (8787) on all interfaces,
# and answers GET /healthz. SELF_HOSTED=1 is set: the server refuses to start
# without MCP_RESOURCE, AUTH_ISSUER and a database TLS choice. It never holds
# the variables key.

ARG NODE_IMAGE=docker.io/library/node:22-slim

FROM ${NODE_IMAGE} AS build
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /repo/mcp
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error
COPY version.txt /repo/
COPY mcp/tsconfig.json mcp/stamp-version.mjs mcp/supabase-ca.crt ./
COPY mcp/src ./src
ARG GIT_COMMIT=unknown
RUN GITHUB_SHA="$GIT_COMMIT" npm run -s build && npm prune --omit=dev --no-audit --no-fund --loglevel=error

FROM ${NODE_IMAGE}
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 SELF_HOSTED=1
WORKDIR /app
COPY --from=build /repo/mcp/package.json ./
COPY --from=build /repo/mcp/node_modules ./node_modules
COPY --from=build /repo/mcp/dist ./dist
COPY --from=build /repo/mcp/supabase-ca.crt ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
