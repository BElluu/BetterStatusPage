# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:26.10.0-alpine AS builder

WORKDIR /app

# Copy workspace manifests first — better layer caching
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY packages/contracts/package*.json ./packages/contracts/
COPY packages/db/package*.json ./packages/db/
COPY packages/audit/package*.json ./packages/audit/
COPY packages/auth/package*.json ./packages/auth/
COPY packages/vault/package*.json ./packages/vault/
COPY packages/notify/package*.json ./packages/notify/
COPY packages/backup/package*.json ./packages/backup/
COPY packages/mirror/package*.json ./packages/mirror/
COPY packages/config-as-code/package*.json ./packages/config-as-code/
COPY packages/mcp/package*.json ./packages/mcp/
COPY packages/runtime/package*.json ./packages/runtime/
COPY packages/ui/package*.json ./packages/ui/
COPY apps/api/package*.json        ./apps/api/
COPY apps/admin/package*.json      ./apps/admin/
COPY apps/status/package*.json     ./apps/status/
COPY apps/template/package*.json   ./apps/template/

RUN npm ci

# Copy source and build everything
COPY tsconfig.base.json ./
COPY scripts/build-kit.mjs ./scripts/build-kit.mjs
COPY packages/ ./packages/
COPY apps/     ./apps/
COPY docs/changelog.md ./docs/changelog.md

RUN npm run build

# ── Stage 2: Production image ─────────────────────────────────────────────────
FROM node:26.10.0-alpine AS runner

WORKDIR /app

ARG SOURCE_REPOSITORY="https://github.com/BElluu/BetterStatusPage"
ARG IMAGE_VERSION="dev"
ARG IMAGE_REVISION="unknown"

LABEL org.opencontainers.image.source=$SOURCE_REPOSITORY
LABEL org.opencontainers.image.description="Self-hosted uptime monitoring and public status page"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version=$IMAGE_VERSION
LABEL org.opencontainers.image.revision=$IMAGE_REVISION

# Copy workspace manifests (needed for workspace symlink resolution)
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY packages/contracts/package*.json ./packages/contracts/
COPY packages/db/package*.json ./packages/db/
COPY packages/audit/package*.json ./packages/audit/
COPY packages/auth/package*.json ./packages/auth/
COPY packages/vault/package*.json ./packages/vault/
COPY packages/notify/package*.json ./packages/notify/
COPY packages/backup/package*.json ./packages/backup/
COPY packages/mirror/package*.json ./packages/mirror/
COPY packages/config-as-code/package*.json ./packages/config-as-code/
COPY packages/mcp/package*.json ./packages/mcp/
COPY packages/runtime/package*.json ./packages/runtime/
COPY packages/ui/package*.json ./packages/ui/
COPY apps/api/package*.json        ./apps/api/
COPY apps/admin/package*.json      ./apps/admin/
COPY apps/status/package*.json     ./apps/status/
COPY apps/template/package*.json   ./apps/template/

# Production dependencies only
RUN npm ci --omit=dev

# Copy compiled workspace artifacts
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
# The UI package is consumed by the admin build only, so it is not needed at runtime.
COPY --from=builder /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/audit/dist ./packages/audit/dist
COPY --from=builder /app/packages/auth/dist ./packages/auth/dist
COPY --from=builder /app/packages/vault/dist ./packages/vault/dist
COPY --from=builder /app/packages/notify/dist ./packages/notify/dist
COPY --from=builder /app/packages/backup/dist ./packages/backup/dist
COPY --from=builder /app/packages/mirror/dist ./packages/mirror/dist
COPY --from=builder /app/packages/config-as-code/dist ./packages/config-as-code/dist
COPY --from=builder /app/packages/mcp/dist ./packages/mcp/dist
COPY --from=builder /app/packages/runtime/dist ./packages/runtime/dist
COPY --from=builder /app/apps/api/dist    ./apps/api/dist
COPY --from=builder /app/apps/admin/dist  ./apps/admin/dist
COPY --from=builder /app/apps/status/dist ./apps/status/dist

# Data directory — mount a volume here to persist db + uploads
RUN mkdir -p /app/data/uploads

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV APP_VERSION=$IMAGE_VERSION
ENV DATABASE_PATH=/app/data/db.sqlite
ENV UPLOAD_DIR=/app/data/uploads
ENV BACKUP_DIR=/app/backups

# Run unprivileged. The writable directories belong to the built-in "node" user; a fresh named
# volume inherits this ownership. Volumes created by older images that ran as root need a one-off
# `chown -R 1000:1000` (see docs/deployment.md).
RUN mkdir -p /app/backups && chown -R node:node /app/data /app/backups

USER node

CMD ["node", "apps/api/dist/index.js"]
