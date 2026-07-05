# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace manifests first — better layer caching
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY apps/api/package*.json        ./apps/api/
COPY apps/admin/package*.json      ./apps/admin/
COPY apps/status/package*.json     ./apps/status/

RUN npm ci

# Copy source and build everything
COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/     ./apps/

RUN npm run build

# ── Stage 2: Production image ─────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Copy workspace manifests + shared package (needed for workspace symlink resolution)
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY apps/api/package*.json        ./apps/api/
COPY apps/admin/package*.json      ./apps/admin/
COPY apps/status/package*.json     ./apps/status/
COPY --from=builder /app/packages/shared ./packages/shared

# Production dependencies only
RUN npm ci --omit=dev

# Copy compiled API and built frontends
COPY --from=builder /app/apps/api/dist    ./apps/api/dist
COPY --from=builder /app/apps/admin/dist  ./apps/admin/dist
COPY --from=builder /app/apps/status/dist ./apps/status/dist

# Data directory — mount a volume here to persist db + uploads
RUN mkdir -p /app/data/uploads

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/db.sqlite
ENV UPLOAD_DIR=/app/data/uploads

CMD ["node", "apps/api/dist/index.js"]
