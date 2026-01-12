FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better caching)
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=false

# Copy source files
COPY *.ts ./
COPY tsconfig.json ./
COPY web/ ./web/

# Create data directory for persistent volume
RUN mkdir -p /app/data

# Set db.json location to persistent volume
ENV DB_PATH=/app/data/db.json

# Expose web UI port
EXPOSE 3000

CMD ["yarn", "start"]
