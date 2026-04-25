FROM node:20-bookworm-slim AS builder

# Toolchain for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Skip Chromium download — we use system Chromium via puppeteer-core
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install dependencies first (better caching)
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=false

# Copy source files
COPY *.ts ./
COPY tsconfig.json ./
COPY web/ ./web/

FROM node:20-bookworm-slim

# Chromium + runtime libraries for puppeteer-core (TGS Lottie rendering)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libgbm1 \
    libxkbcommon0 \
    libasound2 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built node_modules and source from builder
COPY --from=builder /app .

# Create data directory for persistent volume
RUN mkdir -p /app/data

# Persistent SQLite path (matches docker-compose volume)
ENV DB_PATH=/app/data/db.sqlite

# Puppeteer points at the system Chromium installed above
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Expose web UI port
EXPOSE 3000

# JSON→SQLite migration is one-shot for first-time deployments. Gate behind
# MIGRATE_FROM_JSON=1 so production cold-starts don't burn time on a no-op
# (and a migration script crash doesn't kill the container into a restart loop).
# Schema additions / ADD COLUMN migrations always run via database.ts on startup.
CMD ["sh", "-c", "if [ \"$MIGRATE_FROM_JSON\" = \"1\" ]; then npx tsx migrate-to-sqlite.ts; fi && yarn start"]
