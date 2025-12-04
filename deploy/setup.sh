#!/bin/bash
set -e

echo "=== AI Manager Bot Setup ==="

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker $USER
    echo "Docker installed. Please log out and back in, then run this script again."
    exit 0
fi

# Install Docker Compose plugin if not present
if ! docker compose version &> /dev/null; then
    echo "Installing Docker Compose..."
    sudo apt-get update
    sudo apt-get install -y docker-compose-plugin
fi

# Create project directory
PROJECT_DIR=~/ai-manager-bot
mkdir -p $PROJECT_DIR
cd $PROJECT_DIR

# Login to GitHub Container Registry
echo ""
echo "Logging into GitHub Container Registry..."
echo "You'll need a GitHub Personal Access Token with 'read:packages' scope"
echo "Create one at: https://github.com/settings/tokens/new"
echo ""
read -p "Enter your GitHub username: " GH_USER
read -sp "Enter your GitHub token: " GH_TOKEN
echo
echo $GH_TOKEN | docker login ghcr.io -u $GH_USER --password-stdin

# Create .env file
echo ""
echo "Creating .env file..."
cat > .env << 'EOF'
TELEGRAM_TOKEN=your_telegram_token_here
OPENAI_API_KEY=your_api_key_here
OPEN_AI_ENDPOINT=https://api.anthropic.com/v1/
OPENAI_MODEL=claude-sonnet-4-20250514
# Optional: for voice transcription
# OPENAI_WHISPER_API_KEY=sk-...
# WHISPER_MODEL=whisper-1
# VISION_MODEL=claude-sonnet-4-20250514
EOF

# Download docker-compose.yml
cat > docker-compose.yml << 'EOF'
version: '3.8'

services:
  bot:
    image: ghcr.io/andrewkirkovski/your-ai-manager:latest
    container_name: ai-manager-bot
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - bot-data:/app/data
    labels:
      - "com.centurylinklabs.watchtower.enable=true"

  watchtower:
    image: containrrr/watchtower
    container_name: watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ~/.docker/config.json:/config.json:ro
    environment:
      - WATCHTOWER_CLEANUP=true
      - WATCHTOWER_POLL_INTERVAL=300
      - WATCHTOWER_LABEL_ENABLE=true
    command: --interval 300

volumes:
  bot-data:
EOF

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "1. Edit .env with your credentials:"
echo "   nano $PROJECT_DIR/.env"
echo ""
echo "2. Start the bot:"
echo "   cd $PROJECT_DIR && docker compose up -d"
echo ""
echo "3. View logs:"
echo "   docker compose logs -f bot"
echo ""
echo "4. The bot will auto-update when you push to GitHub!"
