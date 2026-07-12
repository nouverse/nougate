# ---- Stage 1: Install backend deps ----
FROM oven/bun:alpine AS backend-deps
WORKDIR /app
COPY apps/backend/package.json apps/backend/bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- Stage 2: Runtime ----
FROM oven/bun:alpine
WORKDIR /app

# Backend deps
COPY --from=backend-deps /app/node_modules ./node_modules

# Backend source (includes src/frontend/ dashboard)
COPY apps/backend/src ./src
COPY apps/backend/package.json ./

# Runtime config files
COPY config.json ./config.json
COPY providers/ ./providers/

# Data directory for runtime persistence (accounts, config)
RUN mkdir -p /app/data/providers/antigravity && chown -R bun:bun /app/data

EXPOSE 3000

USER bun
CMD ["bun", "run", "src/server.ts"]
