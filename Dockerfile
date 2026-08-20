# ---- Stage 1: Build Frontend ----
FROM oven/bun:1.4-alpine AS frontend-builder
WORKDIR /app
COPY package.json ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/backend/package.json ./apps/backend/
RUN bun install
COPY apps/frontend ./apps/frontend
RUN cd apps/frontend && bun run build

# ---- Stage 2: Install backend deps ----
FROM oven/bun:1.4-alpine AS backend-deps
WORKDIR /app
COPY apps/backend/package.json ./
RUN bun install --production

# ---- Stage 3: Runtime ----
FROM oven/bun:1.4-alpine
WORKDIR /app

# Backend deps
COPY --from=backend-deps /app/node_modules ./node_modules

# Backend source
COPY apps/backend/src ./src
COPY apps/backend/package.json ./
COPY apps/backend/tsconfig.json ./

# Built Frontend
COPY --from=frontend-builder /app/apps/frontend/dist ./frontend/dist

# All runtime state — config, provider accounts, SQLite — lives in this one
# directory, which is expected to be a mounted volume. Nothing config-like is
# baked into the image, so there is only ever one file to look at.
RUN mkdir -p /app/data/providers && chown -R bun:bun /app/data

EXPOSE 3000

USER bun
CMD ["bun", "run", "src/server.ts"]
