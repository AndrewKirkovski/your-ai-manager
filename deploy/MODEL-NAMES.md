# Anthropic Model Names Reference

## ⚠️ Important: Model Name Format

When using Anthropic API with the OpenAI-compatible SDK, model names follow a specific format.

## ✅ Correct Model Names (as of 2025)

### Claude Sonnet (Recommended for most tasks)
- `claude-sonnet-4-20250514` - Sonnet 4 (May 2025) - **CURRENTLY USED**
- `claude-3-5-sonnet-20241022` - Latest Sonnet 3.5 (October 2024)
- `claude-3-5-sonnet-20240620` - Previous Sonnet version

### Claude Opus (Most powerful, more expensive)
- `claude-3-opus-20240229` - Opus 3 (February 2024)
- `claude-opus-4-5-20251101` - Opus 4.5 (November 2025) - **Use this instead of 20251120**
- `claude-opus-4-1-20250805` - Opus 4.1 (August 2025)

### Claude Haiku (Fastest, cheapest) 💰
- `claude-3-haiku-20240307` - Haiku 3 (March 2024) - **CHEAPEST option**

## ❌ Common Mistakes

- ❌ `claude-opus-4-5-20251120` - Wrong date format
- ✅ `claude-opus-4-5-20251101` - Correct

- ❌ `claude-sonnet-4.5` - Wrong format (no dots)
- ✅ `claude-3-5-sonnet-20241022` - Correct

## 🔍 How to Find Current Models

Check Anthropic's API documentation:
- https://docs.anthropic.com/claude/docs/models-overview
- Or use their API to list available models

## 💡 Recommendation for Your Bot

For task management and ADHD assistance:
- **💰 Cheapest**: `claude-3-haiku-20240307` (fastest, lowest cost)
- **⚖️ Best balance**: `claude-3-5-sonnet-20241022` (good quality, reasonable cost) - **RECOMMENDED**
- **🚀 Most powerful**: `claude-opus-4-5-20251101` (best quality, higher cost)

## 💰 Cost Comparison (approximate)
- Haiku: ~$0.25 per 1M input tokens, ~$1.25 per 1M output tokens
- Sonnet: ~$3 per 1M input tokens, ~$15 per 1M output tokens  
- Opus: ~$15 per 1M input tokens, ~$75 per 1M output tokens

