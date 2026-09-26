#!/bin/bash
set -euo pipefail
umask 077

PROJECT_DIR="${PROJECT_DIR:-$HOME/ai-manager-bot}"
if [ -e "$PROJECT_DIR/.env" ] || [ -e "$PROJECT_DIR/docker-compose.yml" ]; then
    echo "An existing deployment was found. Setup is for fresh installations only."
    echo "Existing hosts update through Watchtower. See deploy/README.md for manual configuration changes."
    exit 1
fi

echo "=== AI Manager Bot Setup ==="

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker "$USER"
    echo "Docker installed. Please log out and back in, then run this script again."
    exit 0
fi

# Install Docker Compose plugin if not present
if ! docker compose version &> /dev/null; then
    echo "Installing Docker Compose..."
    sudo apt-get update
    sudo apt-get install -y docker-compose-plugin
fi

if ! command -v openssl &> /dev/null; then
    echo "Installing OpenSSL..."
    sudo apt-get update
    sudo apt-get install -y openssl
fi

# Create project directory
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

# Login to GitHub Container Registry
echo ""
echo "Logging into GitHub Container Registry..."
echo "You'll need a GitHub Personal Access Token with 'read:packages' scope"
echo "Create one at: https://github.com/settings/tokens/new"
echo ""
read -p "Enter your GitHub username: " GH_USER
read -sp "Enter your GitHub token: " GH_TOKEN
echo
printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin
unset GH_TOKEN

# Create the secrets for this fresh installation.
echo ""
echo "Creating .env file..."
cat > .env << EOF
TELEGRAM_TOKEN=your_telegram_token_here
OPENAI_API_KEY=your_api_key_here
OPEN_AI_ENDPOINT=https://api.anthropic.com/v1/
OPENAI_MODEL=claude-sonnet-4-20250514
LUXMED_SIDECAR_SECRET=$(openssl rand -hex 32)
LUXMED_SECURITY_SECRET=$(openssl rand -hex 32)
LUXMED_WEBHOOK_SECRET=$(openssl rand -hex 32)
LUXMED_DB_PASSWORD=$(openssl rand -hex 32)
TZ=Europe/Warsaw
# Optional: for voice transcription
# OPENAI_WHISPER_API_KEY=sk-...
# WHISPER_MODEL=whisper-1
# VISION_MODEL=claude-sonnet-4-20250514
EOF

# Use the repository's fresh-install Compose configuration.
COMPOSE_URL="${COMPOSE_URL:-https://raw.githubusercontent.com/AndrewKirkovski/your-ai-manager/main/docker-compose.yml}"
COMPOSE_TMP="$(mktemp docker-compose.yml.XXXXXX)"
trap 'rm -f "$COMPOSE_TMP"' EXIT
curl -fsSL "$COMPOSE_URL" -o "$COMPOSE_TMP"
docker compose --env-file .env -f "$COMPOSE_TMP" config -q
mv "$COMPOSE_TMP" docker-compose.yml
trap - EXIT

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "1. Edit .env with your credentials:"
echo "   nano $PROJECT_DIR/.env"
echo ""
echo "2. Start the bot and LuxMed sidecar:"
echo "   cd $PROJECT_DIR && docker compose pull && docker compose up -d"
echo ""
echo "3. View logs:"
echo "   docker compose logs -f bot luxmed-sidecar"
echo ""
echo "4. Watchtower updates existing images. Do not rerun setup on an existing deployment."
