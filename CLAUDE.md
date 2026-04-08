# AI Managers - Telegram ADHD Wolf Bot

## What This Is
Telegram bot — an anthropomorphic wolf character that helps with ADHD task management, routines, and reminders. Uses Claude AI (via OpenAI-compatible SDK) with tool calling for all state changes.

## Tech Stack
- **Runtime**: Node.js 20 + TypeScript (via `tsx`, no build step)
- **AI**: Anthropic Claude (OpenAI-compatible endpoint), OpenAI Whisper for voice
- **Bot**: `node-telegram-bot-api` (polling mode)
- **DB**: LowDB (JSON file) — migrating to SQLite
- **Web**: Express admin UI on port 3000 (Tailwind CSS, vanilla JS)
- **Scheduling**: `node-cron` (1-minute tick for task reminders)
- **Deploy**: Docker (Alpine), auto-update via Watchtower, GHCR

## Architecture

### Message Flow
```
Telegram msg → bot.on('message') → mediaParser.parseMedia(msg)
  → formatForAI(parsed) + caption → replyToUser(userId, content)
  → AIService.streamAIResponse({systemPrompt: SYSTEM_PROMPT + getCurrentInfo(), ...})
  → stream chunks → update Telegram message in-place
  → if tool_calls: executeTool() → recursive call (max depth 5)
  → save to messageHistory
```

### Key Files
| File | Purpose |
|------|---------|
| `index.ts` | Entry point, bot setup, cron jobs, command handlers, message routing |
| `aiService.ts` | Streaming AI responses, tool call execution, Telegram message updates |
| `userStore.ts` | Data layer (all DB access). Every other file goes through this. |
| `constants.ts` | System prompts: CHARACTER, API, MEMORY, MEDIA, combined SYSTEM_PROMPT |
| `mediaParser.ts` | Voice/photo/sticker/location parsing, Claude Vision calls |
| `tools.ts` | Tool registry + `executeTool()` dispatcher |
| `tools.*.ts` | Individual tool implementations (tasks, routines, memory, user, search, location, weather, meta) |
| `historyCompaction.ts` | Hourly: summarizes consecutive assistant messages to save tokens |
| `webServer.ts` | Express API for admin dashboard |
| `aiCommandService.ts` | DEPRECATED — only strips legacy XML tags |

### Tool Pattern
Every tool follows this interface (`tool.types.ts`):
```typescript
interface Tool {
  name: string;
  description: string;
  parameters: { type: 'object', properties: {...}, required?: string[] };
  execute: (args: any) => Promise<any>;
}
```
`executeTool()` in `tools.ts` parses JSON args and injects `userId` as a number. New tools should type userId as `number` (some old tools type it as `string` + `parseInt()`).

### System Prompt Assembly
`replyToUser()` in `index.ts` constructs:
```
SYSTEM_PROMPT (from constants.ts: CHARACTER + API + MEMORY + MEDIA + RULES)
+
getCurrentInfo(userId) → Goal, Active Routines, Pending Tasks, Memory dump
```
Only last 30 messages sent as context. History capped at 5000 per user.

### Cron Jobs
- **Every minute**: Check routines (create task from cron), check pending tasks (ping if `pingAt <= now`)
- **Every hour**: History compaction (summarize consecutive assistant messages)

## Running Locally
```bash
yarn install
# Copy .env.example to .env and fill in tokens
yarn start   # runs tsx index.ts
```

### LuxMed Sidecar (luxmed-bot submodule)
**Prerequisites**: JDK 11+ (Temurin via Scoop: `scoop bucket add java && scoop install temurin11-jdk`), Docker

```bash
# Option A: Docker Compose (recommended — builds from source inside Docker)
docker compose -f docker-compose.dev.yml up -d

# Option B: Build locally (needs JDK 11)
export JAVA_HOME="$HOME/scoop/apps/temurin11-jdk/current"
export PATH="$JAVA_HOME/bin:$PATH"
cd luxmed-bot && ./gradlew.bat :server:build -x test  # use :server:build, NOT bare build
```

**Fork & update workflow** (submodule = AndrewKirkovski/luxmed-bot, branch rest-api):
```bash
cd luxmed-bot
git fetch upstream              # get dyrkin's latest
git rebase upstream/master      # replay our patches on top
git push origin rest-api        # push to fork
```

## Environment Variables
- `TELEGRAM_TOKEN` — required
- `OPENAI_API_KEY` — Anthropic API key (despite the name)
- `OPEN_AI_ENDPOINT` — `https://api.anthropic.com/v1/`
- `OPENAI_MODEL` — e.g. `claude-opus-4-5-20251101`
- `VISION_MODEL` — for image analysis
- `OPENAI_WHISPER_API_KEY` — optional, actual OpenAI key for voice
- `GOOGLE_SEARCH_ENGINE_ID` + `GOOGLE_SEARCH_API_KEY` — optional, for web search
- `DB_PATH` — database file path (default: `./db.json`)
- `WEB_PORT` — admin UI port (default: 3000)
- `LUXMED_SIDECAR_URL` — LuxMed sidecar REST API (default: `http://localhost:8080`)
- `GOOGLE_MAPS_API_KEY` — for GetDirections tool and LuxMed transit filtering (Geocoding, Directions, Distance Matrix APIs)

## Deployment — Acer Revo Box (murzik)

### Connection
- **Credentials**: `.local/ssh-credentials.txt` (host, user, password — gitignored)
- **SSH key**: `.local/revo-key` (ED25519, no passphrase)
- **OS**: Ubuntu 25.10 with OpenSSH 10.0
- **Docker**: Bot runs via `docker-compose.yml`, auto-updates via Watchtower from GHCR
- **CI/CD**: Push to `main` → GitHub Actions → GHCR → Watchtower pulls on Revo

### Container Layout
- **Container name**: `ai-manager-bot`
- **Volume**: `ai-manager-bot_bot-data` → `/app/data/` inside container
- **DB file**: `/app/data/db.json` (migrating to `/app/data/bot.sqlite`)

### Debugging on Revo
```bash
# SSH in (host/user from .local/ssh-credentials.txt)
ssh -i .local/revo-key <user>@<host>

# Container status / logs
docker ps
docker logs ai-manager-bot --tail 50
docker logs -f ai-manager-bot

# Restart
docker compose restart ai-manager-bot

# Copy db out of container for local inspection
docker cp ai-manager-bot:/app/data/db.json /tmp/db.json
```

## Conventions
- Bot speaks Russian (`ANSWER IN RUSSIAN` in prompt, Whisper language: `ru`)
- All times in Warsaw timezone (`Europe/Warsaw`)
- IDs are 8-char alphanumeric (`generateShortId()`)
- Dates stored as ISO 8601 strings, parsed to `Date` on read
- `<system>` tags in messages are metadata injected by the bot, never generated by AI
