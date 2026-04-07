FROM node:20-alpine AS builder

# Required for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first (better caching)
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=false

# Copy source files
COPY *.ts ./
COPY tsconfig.json ./
COPY web/ ./web/

FROM node:20-alpine

# Required for better-sqlite3 native module at runtime
RUN apk add --no-cache libstdc++

WORKDIR /app

# Copy built node_modules and source from builder
COPY --from=builder /app .

# Create data directory for persistent volume
RUN mkdir -p /app/data

# Set database location to persistent volume
ENV DB_PATH=/app/data/db.sqlite

# Expose web UI port
EXPOSE 3000

# Run migration then start bot
CMD ["sh", "-c", "npx tsx migrate-to-sqlite.ts && yarn start"]
