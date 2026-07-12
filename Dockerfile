# ---- Stage 1: Build Frontend ----
FROM oven/bun:alpine AS frontend-builder
WORKDIR /app
COPY package.json ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/backend/package.json ./apps/backend/
RUN bun install
COPY apps/frontend ./apps/frontend
RUN cd apps/frontend && bun run build

# ---- Stage 2: Install backend deps ----
FROM oven/bun:alpine AS backend-deps
WORKDIR /app
COPY apps/backend/package.json ./
RUN bun install --production

# ---- Stage 3: Runtime ----
FROM oven/bun:alpine
WORKDIR /app

# Backend deps
COPY --from=backend-deps /app/node_modules ./node_modules

# Backend source
COPY apps/backend/src ./src
COPY apps/backend/package.json ./
COPY apps/backend/tsconfig.json ./

# Built Frontend
COPY --from=frontend-builder /app/apps/frontend/dist ./frontend/dist

# Runtime config files
COPY config.json ./config.json
COPY providers/ ./providers/

# Data directory for runtime persistence (accounts, config)
RUN mkdir -p /app/data/providers/antigravity && chown -R bun:bun /app/data

EXPOSE 3000

USER bun
CMD ["bun", "run", "src/server.ts"]
