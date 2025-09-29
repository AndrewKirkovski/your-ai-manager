# 🐺 AUF 1.0 - Your Personal ADHD Wolf Assistant

## 🚀 Deploy your own bot

Click below to roll out your own instance on [Railway](https://railway.app):

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://git.spiralscout.com/ryotsuke/ai-managers)


> *"Because sometimes you need a furry friend to remind you that yes, you should probably eat lunch"* 🐺

Meet your new AI manager - a Telegram bot with the personality of a supportive wolf who specializes in helping people with ADHD manage tasks, routines, and life in general. Think of it as having a very persistent, slightly quirky friend who never forgets your appointments (even when you do).

## ✨ What This Bot Does

- **🎯 Goal Setting**: Helps you set and remember your main life goals
- **📅 Smart Scheduling**: Creates routines and tasks with intelligent timing
- **🧠 Memory Management**: Remembers your preferences and patterns
- **🐺 Wolf Personality**: Responds with warmth and psychology expertise
- **⚡ Streaming Responses**: Real-time AI responses that feel more natural
- **🔄 Adaptive Communication**: Learns how you respond best and adjusts accordingly

## 🚀 Quick Start

### 1. Clone and Install
```bash
git clone <your-repo>
cd ai-managers
yarn install
```

### 2. Set Up Your Environment
Create a `.env` file in the root directory:

```env
# 🔑 Telegram Bot Token (Required)
TELEGRAM_TOKEN=your_telegram_bot_token_here

# 🤖 AI Provider Configuration
# Choose ONE of the following setups:

# Option A: Anthropic/Claude (Recommended)
OPEN_AI_ENDPOINT=https://api.anthropic.com/v1/
OPENAI_API_KEY=your_anthropic_api_key_here
OPENAI_MODEL=claude-sonnet-4-20250514

# Option B: OpenAI/ChatGPT
# OPENAI_API_KEY=your_openai_api_key_here
# OPENAI_MODEL=gpt-4-1106-preview
```

### 3. Run the Bot
```bash
yarn start
```

## 🔑 Getting Your API Keys

### Telegram Bot Token
1. **Find @BotFather** on Telegram
2. **Send `/newbot`** and follow the instructions
3. **Copy the token** (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
4. **Paste it** in your `.env` file

*Pro tip: Your bot will have a username ending in "bot" - that's normal!*

### Anthropic API Key (Claude) - Recommended
1. **Go to [Anthropic Console](https://console.anthropic.com/)**
2. **Sign up/Login** with your account
3. **Navigate to API Keys** section
4. **Click "Create Key"**
5. **Copy the key** (starts with `sk-ant-`)
6. **Paste it** in your `.env` file

*💰 Cost: ~$0.01-0.03 per conversation (very affordable!)*
*🎯 Why Claude? Better reasoning, more consistent personality, and excellent at task management!*

### OpenAI API Key (ChatGPT)
1. **Go to [OpenAI Platform](https://platform.openai.com/)**
2. **Sign up/Login** with your account
3. **Navigate to API Keys** in the left sidebar
4. **Click "Create new secret key"**
5. **Copy the key** (starts with `sk-`)
6. **Paste it** in your `.env` file

*💰 Cost: Similar to Claude, very reasonable*

## 🎛️ Environment Variables Explained

| Variable | What It Does | Required | Example |
|----------|-------------|----------|---------|
| `TELEGRAM_TOKEN` | Your bot's unique identifier | ✅ Yes | `123456789:ABCdef...` |
| `OPENAI_API_KEY` | Your AI provider's access key | ✅ Yes | `sk-...` or `sk-ant-...` |
| `OPEN_AI_ENDPOINT` | Custom API endpoint (for Anthropic) | ❌ No | `https://api.anthropic.com/v1/` |
| `OPENAI_MODEL` | Which AI model to use | ❌ No | `gpt-4-1106-preview` |

## 🐺 How to Use Your Wolf Assistant

### Basic Commands
- `/goal <your goal>` - Set your main life goal
- `/cleargoal` - Clear your current goal
- `/routines` - See your active routines
- `/tasks` - Check your pending tasks
- `/memory` - View saved preferences
- `/help` - Get help (duh! 🐺)

### Natural Conversation
Just chat normally! Your wolf assistant will:
- Remember your goals and preferences
- Create tasks and routines when you mention them
- Adapt to your communication style
- Provide psychological support and motivation

### Example Conversations
```
You: "I need to remember to take my medication at 9 AM every day"
Wolf: "Got it! 🐺 I'll set up a daily reminder for your medication at 9 AM. This is important stuff - I'll make sure you don't forget!"

You: "I want to exercise 3 times a week"
Wolf: "Excellent goal! 💪 I'll create a flexible routine for exercise 3 times per week. When would you prefer to work out - mornings, evenings, or mixed?"

You: "I'm done with my workout"
Wolf: "🎉 Amazing job! You crushed that workout! I've marked it as complete. How are you feeling?"
```

## 🧠 How It Works

### AI Command Processing
The bot uses a hybrid system where:
- **You see**: Natural, friendly responses from your wolf assistant
- **Behind the scenes**: The AI generates XML commands that program the bot
- **Result**: Seamless task management without you even realizing it's happening

### Smart Memory
- Learns your ADHD patterns and preferences
- Remembers what communication style works best for you
- Adapts reminder frequency based on your responses
- Stores important information about your routines and habits

### Streaming Responses
- Real-time typing indicators
- Live message updates as the AI responds
- More natural conversation flow
- No more waiting for complete responses


### Getting Help
- Check the logs in your terminal for error messages
- Cry
- Ask AI or bot author for help :)

---

**Ready to meet your new furry friend? Start the bot and let the wolf help you conquer your goals! 🐺✨**

*"Because sometimes the best productivity hack is having a supportive wolf in your pocket"* 🐺💪


