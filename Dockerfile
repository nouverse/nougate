# ---- Stage 1: Build frontend ----
FROM node:22-alpine AS frontend-build
WORKDIR /build
COPY apps/frontend/ .
RUN npm ci && npm run build

# ---- Stage 2: Install backend deps ----
FROM oven/bun:alpine AS backend-deps
WORKDIR /app
COPY apps/backend/package.json apps/backend/bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- Stage 3: Runtime ----
FROM oven/bun:alpine
WORKDIR /app

# Backend deps
COPY --from=backend-deps /app/node_modules ./node_modules

# Backend source
COPY apps/backend/src ./src
COPY apps/backend/package.json ./

# Frontend build output (served as static files by backend)
COPY --from=frontend-build /build/dist ./static/

# Data directory for runtime persistence (accounts, config)
RUN mkdir -p /app/data && chown -R bun:bun /app/data

ENV ACCOUNTS_FILE=/app/data/antigravity-accounts.json
ENV STATIC_DIR=/app/static

EXPOSE 3000

USER bun
CMD ["bun", "run", "src/server.ts"]
