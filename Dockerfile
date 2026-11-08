# The HyperNear agent server as one image (TEE prep). Node 22 runs the TypeScript directly (type stripping), so there is no
# compile step for agent/; only the two workspace packages it imports (core, hypernear-client) are built to dist/.
# Build:   docker build -t hypernear-agent-tee:local .
# Run:     docker compose -f docker-compose.tee.yml up          (policy limits are in the compose file; see its comments)
# Pin for a deployment: push the image and reference it by digest (image: <registry>/hypernear-agent@sha256:...), because the
# image digest and the compose file are what the TEE measures.

FROM node:22-slim AS build
ENV CI=true
RUN corepack enable
WORKDIR /app

# 1. manifests only: this layer (the install) is cached until a dependency changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/hypernear-client/package.json packages/hypernear-client/
COPY agent/package.json agent/
# the lockfile lists every workspace project, so the other two manifests must exist; nothing of them is installed
COPY validation/package.json validation/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter "@hypernear/agent..."

# 2. sources, then build the two packages the agent imports
COPY packages packages
COPY agent agent
# the dry run (--dry-run --serve) replays recorded results from here; a few hundred KB
COPY validation/results validation/results
RUN pnpm --filter @perps-platform/core build && pnpm --filter @hypernear/client build

# 3. production dependencies only
RUN rm -rf node_modules packages/*/node_modules agent/node_modules \
 && pnpm install --frozen-lockfile --prod --filter "@hypernear/agent..." \
 && rm -rf /root/.local/share/pnpm /root/.cache

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
# nothing secret is baked in or written to the image; agent keys (server mode) go to HYPERNEAR_DATA_DIR, which compose mounts as tmpfs
USER node
EXPOSE 8787
CMD ["node", "agent/src/server.ts"]
