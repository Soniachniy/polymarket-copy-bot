# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: production image ────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV DATA_DIR=/data

# Install only production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Create persistent data directory and non-root user
RUN addgroup -S botgroup && adduser -S botuser -G botgroup && \
    mkdir -p /data && chown botuser:botgroup /data

USER botuser

EXPOSE 3000

CMD ["node", "dist/api-server.js"]
