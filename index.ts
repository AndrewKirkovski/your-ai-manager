import dotenv from 'dotenv';

dotenv.config();

import { startWebServer } from './webServer';

import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import cron from 'node-cron';
import { initLuxmedMonitor, runLuxmedMonitoringCycle } from './luxmedMonitor';
import { OpenAIProvider } from './aiProvider.openai';
import { AnthropicProvider } from './aiProvider.anthropic';
import type { AIProvider } from './aiProvider';
import {
    getSystemPrompt,
    GREETING_PROMPT,
    GOAL_SET_PROMPT,
    GOAL_CLEAR_PROMPT,
    ERROR_MESSAGE_PROMPT,
    DEFAULT_HELP_PROMPT, TASK_TRIGGERED_PROMPT, TASK_TRIGGERED_PROMPT_NO_ACTION
} from './constants';
import {
    getUser,
    setUser,
    getAllUsers,
    getAllRoutines,
    getAllTasks, Task, updateUserTask,
    cleanupOldTasks,
    addImageToCache,
    getTrackedStatNames, getLatestStat, getStatCount,
    getTodayStats,
    getAllUserMemoryRecords,
    deleteUserMemory,
} from "./userStore";
import {addUserTask, generateShortId, addMessageToHistory} from './userStore';
import {AIService} from './aiService';
import {safeSend, stripSystemTags, textify} from './telegramFormat';
import {runHistoryCompaction} from './historyCompaction';
import {runStyleScan} from './styleScan';
import {CronExpressionParser} from 'cron-parser';
import {formatDateHuman, formatCronHuman, getCurrentTime} from './dateUtils';
import {initializeMediaParser, getMediaParser} from './mediaParser';
import {initStatTools} from './tools.stats';
import {initStickerCacheTools} from './tools.stickercache';
import {shutdownTgsRenderer} from './tgsRenderer';
import db from './database';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPEN_AI_ENDPOINT = process.env.OPEN_AI_ENDPOINT;
const OPEN_AI_MODEL = process.env.OPENAI_MODEL || 'gpt-4-1106-preview';

// Single timezone for the whole bot (cron, stat windows, log timestamps, …).
// Per-user TZ is not planned — pin everything via env, default Warsaw. Also set
// process.env.TZ on the bot container in docker-compose.yml so Node's Date and
// luxon's local zone agree with this value.
const BOT_TZ = process.env.TZ || 'Europe/Warsaw';

// Owner-allowlist so random Telegram users can't DM the bot and consume the
// owner's API quota. Comma-separated list of Telegram numeric user IDs.
// If unset, ALL users are allowed (legacy/dev default — log a warning).
const ALLOWED_USER_IDS = new Set(
    (process.env.ALLOWED_USER_IDS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter(n => Number.isFinite(n))
);
if (ALLOWED_USER_IDS.size === 0) {
    console.warn('⚠️  ALLOWED_USER_IDS not set — any Telegram user can use the bot.');
}
function isAllowedUser(userId: number | undefined): boolean {
    if (userId == null) return false;
    if (ALLOWED_USER_IDS.size === 0) return true; // legacy: allow all
    return ALLOWED_USER_IDS.has(userId);
}

// Per-user serialization split into two concerns so a long Vision call on
// message N doesn't block side-effect processing on message N+1, and so a
// rapid burst of user messages produces ONE coalesced AI reply instead of N.
//
// 1. sideEffectsQueue — chains parseMedia + addMessageToHistory in arrival
//    order so history rows land in the right sequence even if the AI reply
//    is still streaming.
// 2. aiReplyQueue — chains the actual streamAIResponse calls so two replies
//    for the same user never run in parallel (would race on history reads).
// 3. burstTimer + inFlightReply — debounce the AI reply 800ms after the last
//    incoming message, and soft-abort an in-flight reply that hasn't yet
//    streamed visible text to Telegram.
const sideEffectsQueues = new Map<number, Promise<void>>();
const aiReplyQueues = new Map<number, Promise<void>>();

function enqueueChained(map: Map<number, Promise<void>>, userId: number, work: () => Promise<void>): Promise<void> {
    const prev = map.get(userId) ?? Promise.resolve();
    const next = prev.catch(() => { /* swallow prior error so chain continues */ }).then(work);
    map.set(userId, next);
    next.finally(() => {
        if (map.get(userId) === next) map.delete(userId);
    });
    return next;
}

function enqueueSideEffects(userId: number, work: () => Promise<void>): Promise<void> {
    return enqueueChained(sideEffectsQueues, userId, work);
}

// Back-compat alias for legacy call sites (cron, /command handlers). These
// already produce single replies and don't need the burst-debounce — they
// go straight onto the AI-reply queue.
function enqueuePerUser(userId: number, work: () => Promise<void>): Promise<void> {
    return enqueueChained(aiReplyQueues, userId, work);
}

// Burst-coalescing state per user.
type InFlightReply = { controller: AbortController; hasStreamedText: boolean };
const inFlightReplies = new Map<number, InFlightReply>();
const burstTimers = new Map<number, NodeJS.Timeout>();
const BURST_DEBOUNCE_MS = Math.max(0, parseInt(process.env.BURST_DEBOUNCE_MS ?? '800', 10) || 800);

// Set true by the side-effects work after a successful addMessageToHistory(user, …)
// for this user. Cleared when fireBurstReply commits to actually streaming a reply.
// Preferred over peeking the most-recent history role, because that approach
// silently swallowed bursts that landed AFTER a cron task ping ran (history's
// last row is then the cron's assistant, not the user's burst). The flag tracks
// "is there fresh user input that hasn't been picked up by a coalesced reply",
// which is the actual question we need to answer.
const pendingUserInput = new Map<number, boolean>();

/** Schedule (or refresh) the per-user debounce timer that fires a single
 * AI reply once `BURST_DEBOUNCE_MS` of silence elapses. Each new user message
 * resets the timer; the firing schedules the reply onto `aiReplyQueues` so it
 * still serializes behind any in-flight reply. */
function refreshBurstTimer(userId: number): void {
    const existing = burstTimers.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        burstTimers.delete(userId);
        void enqueuePerUser(userId, () => fireBurstReply(userId));
    }, BURST_DEBOUNCE_MS);
    burstTimers.set(userId, timer);
}

/** Soft-abort the current in-flight reply if it hasn't yet pushed visible text
 * to Telegram. Called whenever a new user message arrives — gives us the
 * "softly stop" behaviour the user asked for: pre-text phase aborts cleanly,
 * post-text phase finishes naturally and the next coalesced reply addresses
 * the new messages. */
function softAbortIfPretext(userId: number): void {
    const flight = inFlightReplies.get(userId);
    if (flight && !flight.hasStreamedText) {
        flight.controller.abort();
        inFlightReplies.delete(userId);
    }
}

async function fireBurstReply(userId: number): Promise<void> {
    // Make sure every queued side-effect (parseMedia + history append) has
    // landed before we fire the AI — otherwise the AI sees stale history.
    const sideEffectsTail = sideEffectsQueues.get(userId);
    if (sideEffectsTail) await sideEffectsTail.catch(() => {});

    // If the timer fired but a new message arrived in the gap and reset the
    // timer with a future fire-time, bail and let the new timer fire instead.
    if (burstTimers.has(userId)) return;

    // Side-effects work may have decided not to append to history: new-user
    // greeting (dispatches its own reply, drops the user's first message),
    // unsupported type, fatal media error (already sent "Could not process…"),
    // or a thrown error that fired the 🐺 fallback. In those cases the
    // pendingUserInput flag was never set; firing a coalesced reply would
    // address phantom context with a non-sequitur. Skip cleanly.
    if (!pendingUserInput.get(userId)) {
        console.log(`[burst] ${userId}: no fresh user input pending, skipping coalesced reply`);
        return;
    }
    // Clear the flag now that we're committing to fire. If a new user msg
    // arrives mid-stream, its side-effects work will set the flag again,
    // and the next coalesced reply will pick it up.
    pendingUserInput.delete(userId);

    // Register the AbortController for softAbortIfPretext to find. Done
    // AFTER the pending-input check so we don't churn controller objects
    // when there's nothing to do.
    const controller = new AbortController();
    const flight: InFlightReply = { controller, hasStreamedText: false };
    inFlightReplies.set(userId, flight);
    try {
        await replyToUser(userId, '', {
            signal: controller.signal,
            onTextStreamed: () => { flight.hasStreamedText = true; },
            addUserToHistory: false, // history is already current — appended per-message in side-effects queue
        });
    } catch (err) {
        if (controller.signal.aborted) {
            console.log(`[burst] reply for ${userId} aborted (new burst arrived)`);
            return;
        }
        throw err;
    } finally {
        if (inFlightReplies.get(userId) === flight) inFlightReplies.delete(userId);
    }
}

// Wrapper for bot.onText handlers: auth gate + per-user serialization.
// Command handlers that call AI (/goal, /cleargoal, /help) race with the
// bot.on('message') catch-all on shared history; pure-read handlers
// (/tasks, /routines, etc.) don't corrupt data but still benefit from
// not interleaving display with an AI reply.
type TextHandler = (msg: TelegramBot.Message, match: RegExpExecArray | null) => Promise<void>;
function serialTextHandler(handler: TextHandler): (msg: TelegramBot.Message, match: RegExpExecArray | null) => void {
    return (msg, match) => {
        const userId = msg.from?.id;
        if (!userId) return;
        if (!isAllowedUser(userId)) return;
        // Fire-and-forget; node-telegram-bot-api doesn't await handler returns.
        void enqueuePerUser(userId, () => handler(msg, match));
    };
}

/**
 * Resolve every distinct custom-emoji entity in the user's text/caption through
 * the sticker_cache (analyzing on miss). Returns a multi-line context block
 * to prepend to the user's message so the AI knows what each premium emoji
 * means; returns '' if there are no custom emojis.
 */
async function buildCustomEmojiContextBlock(msg: TelegramBot.Message, userId: number): Promise<string> {
    const text = msg.text ?? msg.caption ?? '';
    const ents = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];
    const seen = new Map<string, string>();
    for (const e of ents) {
        if (e.type !== 'custom_emoji' || !e.custom_emoji_id) continue;
        if (!seen.has(e.custom_emoji_id)) {
            const ch = text.slice(e.offset, e.offset + e.length);
            seen.set(e.custom_emoji_id, ch);
        }
    }
    if (seen.size === 0) return '';

    const parser = getMediaParser();
    const lines: string[] = ['[Custom emojis in this message:'];
    const resolved = await Promise.all(
        Array.from(seen.entries()).map(async ([id, ch]) => {
            const parsed = await parser.parseCustomEmoji(id, ch, userId);
            if (parsed.error) {
                console.warn('[customEmoji] parse failed', { id, error: parsed.error });
                return `- ${ch} (cache_key=${id}): [analysis unavailable]`;
            }
            return `- ${ch} (cache_key=${id}): ${parsed.content}`;
        })
    );
    lines.push(...resolved);
    lines.push(']');
    return lines.join('\n');
}

// AI provider selection
const AI_PROVIDER_TYPE = (process.env.AI_PROVIDER || 'openai') as 'openai' | 'anthropic';

// Media parsing configuration
const OPENAI_WHISPER_API_KEY = process.env.OPENAI_WHISPER_API_KEY;
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-1';
const VISION_MODEL = process.env.VISION_MODEL || 'claude-sonnet-4-20250514';
const STICKER_LOOKUP_MODEL = process.env.STICKER_LOOKUP_MODEL || 'claude-haiku-4-5-20251001';

const bot = new TelegramBot(TELEGRAM_TOKEN, {polling: true});
initLuxmedMonitor(bot);
// Start the admin/webhook server after the bot exists so the LuxMed webhook
// can deliver notifications via bot.sendMessage.
startWebServer(bot);

// AI provider (switchable via AI_PROVIDER env var)
const provider: AIProvider = AI_PROVIDER_TYPE === 'anthropic'
    ? new AnthropicProvider(OPENAI_API_KEY)
    : new OpenAIProvider(OPENAI_API_KEY, OPEN_AI_ENDPOINT);

console.log(`🤖 AI provider: ${provider.name}`);

// OpenAI client kept for Whisper (voice) and Vision (image analysis via compat layer)
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    ...(OPEN_AI_ENDPOINT && {baseURL: OPEN_AI_ENDPOINT}),
});

// Separate OpenAI client for Whisper (voice transcription)
const openaiWhisper = OPENAI_WHISPER_API_KEY
    ? new OpenAI({ apiKey: OPENAI_WHISPER_API_KEY })
    : null;

// Initialize MediaParser with both clients
initializeMediaParser({
    bot,
    openaiWhisper,              // OpenAI for Whisper (null if not configured)
    anthropic: openai,          // Anthropic client (via OpenAI-compatible SDK) for vision
    visionModel: VISION_MODEL,
    whisperModel: WHISPER_MODEL,
    language: 'ru'
});

// Initialize stat tools with bot instance (for sending chart images)
initStatTools(bot);

// Initialize sticker cache tools with bot + Haiku lookup client for SendStickerToUser ranking
initStickerCacheTools(bot, openai, STICKER_LOOKUP_MODEL);

function ageLabel(d: Date): string {
    const ms = Date.now() - d.getTime();
    if (!Number.isFinite(ms) || isNaN(ms)) return '?';
    const days = Math.floor(ms / 86_400_000);
    if (days >= 1) return `${days}d ago`;
    const hours = Math.floor(ms / 3_600_000);
    if (hours >= 1) return `${hours}h ago`;
    const minutes = Math.max(0, Math.floor(ms / 60_000));
    return `${minutes}m ago`;
}

// Cap the memory block at MEMORY_BLOCK_CAP entries by recency (updatedAt desc)
// to stop token bloat as the memory table grows unbounded over the bot's lifetime.
// The AI can still read full memory via a tool call when it needs older facts.
const MEMORY_BLOCK_CAP = 50;

function formatMemoryBlock(memory: Record<string, { value: string; firstRecordedAt: Date; updatedAt: Date }>): string {
    const keys = Object.keys(memory);
    if (keys.length === 0) return '{}';
    const sortedKeys = keys.slice().sort((a, b) => memory[b].updatedAt.getTime() - memory[a].updatedAt.getTime());
    const shown = sortedKeys.slice(0, MEMORY_BLOCK_CAP);
    const truncated = keys.length - shown.length;
    const lines = shown.map(k => {
        const rec = memory[k];
        const sameDay = Math.abs(rec.updatedAt.getTime() - rec.firstRecordedAt.getTime()) < 86_400_000;
        const stamp = sameDay
            ? `recorded ${ageLabel(rec.firstRecordedAt)}`
            : `first recorded ${ageLabel(rec.firstRecordedAt)}, updated ${ageLabel(rec.updatedAt)}`;
        // Keys and values can be AI-written via UpdateMemory tool — strip <system> so
        // this block can't self-inject fake system messages when spliced into the prompt.
        return `  ${stripSystemTags(k)} [${stamp}]: ${stripSystemTags(rec.value)}`;
    });
    if (truncated > 0) {
        lines.push(`  … ${truncated} older memory entr${truncated === 1 ? 'y' : 'ies'} hidden (use a memory-read tool for full list)`);
    }
    return '\n' + lines.join('\n');
}

async function getCurrentInfo(userId: number): Promise<string> {
    const user = await getUser(userId);
    if (!user) throw new Error('Ошибка: пользователь не найден');

    const routines = await getAllRoutines(userId);
    const activeRoutines = routines.filter(r => r.isActive);

    const tasks = await getAllTasks(userId);
    const pendingTasks = tasks.filter(t => t.status === 'pending');
    const replanningTasks = tasks.filter(t => t.status === 'needs_replanning');

    let todayStatsStr = 'no stats tracked today';
    try {
        const todayStats = await getTodayStats(userId);
        if (todayStats.length > 0) {
            todayStatsStr = todayStats.map(s => `${stripSystemTags(s.name)}: ${s.total}${s.unit ? ' ' + stripSystemTags(s.unit) : ''} (${s.count} entries)`).join(', ');
        }
    } catch (e) {
        // Don't let stat errors break the entire context
    }

    const memoryRecords = await getAllUserMemoryRecords(userId);

    // Goal / routine-name / task-name are AI- or user-writable free text. Strip
    // <system> before interpolation so they can't forge fake system directives.
    const Memory = `
Goal: ${stripSystemTags(user.preferences.goal || 'not set')}

Routines/Schedule:
${activeRoutines.map(r => `id: ${r.id} cron: ${r.cron} defaultAnnoyance: ${r.defaultAnnoyance} name: ${stripSystemTags(r.name)} timesCompleted: ${r.stats.completed} timesFailed: ${r.stats.failed}`).join('\n') || 'no active routines'}

Pending Tasks:
${pendingTasks.map(t => `id: ${t.id} dueAt: ${t.dueAt?t.dueAt.toISOString():'none'} pingAt: ${formatDateHuman(t.pingAt)} annoyance: ${t.annoyance} postponeCount: ${t.postponeCount} name: ${stripSystemTags(t.name)}`).join('\n') || 'no active tasks'}

Tasks that need replanning (AI must update these):
${replanningTasks.map(t => `id: ${t.id} dueAt: ${t.dueAt?t.dueAt.toISOString():'none'} pingAt: ${formatDateHuman(t.pingAt)} annoyance: ${t.annoyance} postponeCount: ${t.postponeCount} name: ${stripSystemTags(t.name)}`).join('\n') || 'none'}

Memory (stale entries may not reflect current state — treat older facts with appropriate skepticism):${formatMemoryBlock(memoryRecords)}

Today's stats: ${todayStatsStr}
        `

    return Memory;
}

async function replyToUser(
    userId: number,
    userMessage: string,
    opts?: { signal?: AbortSignal; onTextStreamed?: () => void; addUserToHistory?: boolean }
): Promise<string> {
    try {
        const user = await getUser(userId);
        if (!user) return 'Ошибка: пользователь не найден';

        const memory = await getCurrentInfo(userId);
        // Split static prefix (cacheable) from per-turn dynamic memory so Anthropic
        // prompt-caching reuses the long scaffolding across turns. The provider
        // handles concatenation for the OpenAI-compat path internally.
        const result = await AIService.streamAIResponse({
            userId,
            userMessage,
            systemPromptCachePrefix: getSystemPrompt(),
            systemPrompt: memory,
            bot,
            provider,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: true,
            addUserToHistory: opts?.addUserToHistory ?? true,
            addAssistantToHistory: true,
            enableToolCalls: true,
            signal: opts?.signal,
            onTextStreamed: opts?.onTextStreamed,
            // Send images from search results as a gallery (not in history)
            onImageResults: async (images: string[]) => {
                const imagesToSend = images.slice(0, 5); // Max 5 images in gallery
                if (imagesToSend.length === 0) return;

                try {
                    if (imagesToSend.length === 1) {
                        // Single image - use sendPhoto
                        await bot.sendPhoto(userId, imagesToSend[0], {
                            disable_notification: true
                        });
                    } else {
                        // Multiple images - use sendMediaGroup for gallery
                        const mediaGroup = imagesToSend.map(url => ({
                            type: 'photo' as const,
                            media: url
                        }));
                        await bot.sendMediaGroup(userId, mediaGroup, {
                            disable_notification: true
                        });
                    }
                } catch (e) {
                    console.log(`Failed to send images:`, e);
                }
            }
        });

        // Cleanup old tasks after processing (keep last 50 per user)
        const removedCount = await cleanupOldTasks(userId, 50);
        if (removedCount > 0) {
            console.log(`🧹 Cleaned up old tasks:`, {
                userId,
                removedCount,
                timestamp: new Date().toISOString()
            });
        }

        return result.message;
    } catch (error) {
        console.error('❌ Error generating AI response:', {
            userId,
            userMessage: userMessage.substring(0, 50) + '...',
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        }, error);
        return 'Извини, проблемы с генерацией ответа 🐺';
    }
}

// Check routines and tasks every minute. `isRunning` guard prevents overlap
// if a slow AI call from a previous tick hasn't finished yet (otherwise two
// ticks can stack and double-fire reminders).
let routineTickRunning = false;
cron.schedule('* * * * *', async () => {
    if (routineTickRunning) {
        console.warn('⏰ Previous routine tick still running, skipping this cycle');
        return;
    }
    routineTickRunning = true;
    try {

    const now = getCurrentTime();
    const users = await getAllUsers();

    console.log('⏰ Checking routines and tasks for all users:', {
        userCount: users.length,
        timestamp: now.toISO()
    });

    for (const user of users) {
        if (!user.chatId) continue;

        // Ensure user has collections initialized
        if (!user.routines) user.routines = [];
        if (!user.tasks) user.tasks = [];

        // 1. Check routines for firing (create new task instances)
        for (const routine of user.routines) {
            if (!routine.isActive) continue;

            try {
                // Check if routine should fire based on cron. Pin parser to BOT_TZ
                // so e.g. "0 9 * * *" fires at 09:00 BOT_TZ regardless of host TZ
                // and survives DST transitions.
                const cronInterval = CronExpressionParser.parse(routine.cron, { tz: BOT_TZ });
                cronInterval.next(); // advance iterator so .prev() returns the last fire time
                const lastFireTime = cronInterval.prev().toDate();

                // If lastFireTime is within the last minute, this routine should fire
                const timeSinceLastFire = now.toMillis() - lastFireTime.getTime();
                if (timeSinceLastFire <= 60000) { // Within 1 minute
                    console.log('🔔 Firing routine to create task:', routine);

                    // Create new task instance from routine. Re-textify name in case
                    // the routine was created before textify-at-write landed.
                    const newTask: Task = {
                        id: generateShortId(),
                        name: textify(routine.name),
                        routineId: routine.id,
                        requiresAction: routine.requiresAction,
                        status: 'pending',
                        annoyance: routine.defaultAnnoyance,
                        pingAt: now.toJSDate(),
                        postponeCount: 0,
                        createdAt: now.toJSDate()
                    };

                    await addUserTask(user.userId, newTask);

                    console.log('✅ Created task from routine:', newTask);
                } else {
                    /* console.log('⏳ Routine not ready to fire yet:', {
                        userId: user.userId,
                        routineId: routine.id,
                        nextFireTime: nextFireTime.toISOString(),
                        lastFireTime: lastFireTime.toISOString(),
                        now: now.toISO()
                    }); */
                }
            } catch (error) {
                console.error('❌ Error checking routine:', {
                    userId: user.userId,
                    routineId: routine.id,
                    error: error instanceof Error ? error.message : String(error),
                    timestamp: now.toISO()
                });
            }
        }

        // 2. Check pending tasks for pinging users
        const pendingTasks = user.tasks.filter(t => t.status === 'pending');
        for (const task of pendingTasks) {
            try {
                // Check if task should ping user
                if (task.pingAt <= now.toJSDate()) {
                    console.log('📱 Pinging user about pending task:', task);

                    if (!task.requiresAction) {
                        await updateUserTask(user.userId, task.id, (t) => {
                            t.status = 'completed';
                        })
                    } else {
                        await updateUserTask(user.userId, task.id, (t) => {
                            t.status = 'needs_replanning'
                        });
                    }

                    // Serialize with the live bot.on('message') path via enqueuePerUser —
                    // otherwise a user typing at the same minute a routine fires produces
                    // two concurrent streams that interleave addMessageToHistory writes.
                    // Fire-and-forget: the queue itself enforces per-user serialization,
                    // so this tick can return immediately and other users' tasks can run
                    // in parallel. Awaiting here would block the whole tick on one user's
                    // AI roundtrip and cause routineTickRunning to skip the next minute
                    // for everyone.
                    void enqueuePerUser(user.userId, async () => {
                        const memory = await getCurrentInfo(user.userId);

                        const taskPrompt = task.requiresAction
                            ? TASK_TRIGGERED_PROMPT(memory, task)
                            : TASK_TRIGGERED_PROMPT_NO_ACTION(memory, task);

                        const result = await AIService.streamAIResponse({
                            userId: user.userId,
                            userMessage: taskPrompt,
                            systemPromptCachePrefix: getSystemPrompt(),
                            systemPrompt: '', // memory is already inlined into taskPrompt
                            bot,
                            provider,
                            model: OPEN_AI_MODEL,
                            addUserToHistory: false,
                            addAssistantToHistory: true,
                            enableToolCalls: true
                        });

                        console.log(result);
                    });


                } else {
                    /* console.log('⏳ Task not ready for ping yet:', {
                        userId: user.userId,
                        taskId: task.id,
                        pingAt: task.pingAt.toISOString(),
                        now: now.toISO()
                    }); */
                }
            } catch (error) {
                console.error('❌ Error pinging task:', {
                    userId: user.userId,
                    taskId: task.id,
                    error: error instanceof Error ? error.message : String(error),
                    timestamp: now.toISO()
                });
            }
        }
    }
    } catch (error) {
        // Outer try/catch around getAllUsers + iteration. Without this, a DB
        // error would reject the async cron callback (node-cron swallows it
        // but the unhandled rejection handler would see it).
        console.error('❌ Routine tick fatal error:', error instanceof Error ? error.message : String(error));
    } finally {
        routineTickRunning = false;
    }
}, { timezone: BOT_TZ });

// Compact history once per hour
cron.schedule('0 * * * *', async () => {
    try {
        await runHistoryCompaction(provider, OPEN_AI_MODEL);
    } catch (error) {
        console.error('🗜️ History compaction cron error:', error instanceof Error ? error.message : error);
    }
}, { timezone: BOT_TZ });

// Daily user communication-style + ADHD-reaction scan at 04:00 (BOT_TZ)
cron.schedule('0 4 * * *', async () => {
    try {
        await runStyleScan(provider, OPEN_AI_MODEL);
    } catch (error) {
        console.error('🎭 Style scan cron error:', error instanceof Error ? error.message : error);
    }
}, { timezone: BOT_TZ });

// LuxMed monitoring — check every 10 minutes
cron.schedule('*/10 * * * *', async () => {
    try {
        await runLuxmedMonitoringCycle();
    } catch (error) {
        console.error('[LuxMed Monitor] Cron error:', error instanceof Error ? error.message : error);
    }
}, { timezone: BOT_TZ });

// Handle commands
bot.onText(/\/goal(.*)/, serialTextHandler(async (msg, match) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;
        if (!isAllowedUser(userId)) return;

        const newGoal = match?.[1]?.trim();

        if (!newGoal) {
            // Show current goal
            const user = await getUser(userId);
            if (user && user.preferences.goal) {
                await safeSend(bot, msg.chat.id, `🎯 Твоя текущая цель: "${user.preferences.goal}"\n\nИспользуй /goal &lt;новая цель&gt; чтобы изменить`);
            } else {
                await safeSend(bot, msg.chat.id, `🎯 У тебя пока нет установленной цели\n\nИспользуй /goal &lt;твоя цель&gt; чтобы установить`);
            }
            return;
        }

        // Update goal
        let user = await getUser(userId);
        if (!user) {
            user = {
                userId,
                chatId: msg.chat.id,
                preferences: {goal: newGoal},
                tasks: [],
                routines: [],
                memory: {},
                messageHistory: []
            };
        } else {
            user.preferences.goal = newGoal;
            if (!user.chatId) {
                user.chatId = msg.chat.id;
            }
            if (!user.messageHistory) {
                user.messageHistory = [];
            }
        }
        await setUser(user);

        const result = await AIService.streamAIResponse({
            userId,
            userMessage: GOAL_SET_PROMPT(newGoal),
            systemPromptCachePrefix: getSystemPrompt(),
            systemPrompt: '',
            bot,
            provider,
            model: OPEN_AI_MODEL,
            addUserToHistory: true,
            addAssistantToHistory: true,
        });

        console.log(result);

    } catch (error) {
        console.error('Error updating goal:', error);
        const result = await AIService.streamAIResponse({
            userId: msg.from?.id || 0,
            userMessage: ERROR_MESSAGE_PROMPT,
            systemPromptCachePrefix: getSystemPrompt(),
            systemPrompt: '',
            bot,
            provider,
            model: OPEN_AI_MODEL,
            addUserToHistory: false,
            addAssistantToHistory: false,
        });

        console.log(result);
    }
}));

bot.onText(/\/cleargoal/, serialTextHandler(async (msg) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;
        if (!isAllowedUser(userId)) return;

        let user = await getUser(userId);
        if (!user) {
            user = {
                userId,
                chatId: msg.chat.id,
                preferences: {goal: ''},
                tasks: [],
                routines: [],
                memory: {},
                messageHistory: []
            };
        } else {
            user.preferences.goal = '';
            if (!user.chatId) {
                user.chatId = msg.chat.id;
            }
            if (!user.messageHistory) {
                user.messageHistory = [];
            }
        }
        await setUser(user);

        const result = await AIService.streamAIResponse({
            userId,
            userMessage: GOAL_CLEAR_PROMPT(),
            systemPromptCachePrefix: getSystemPrompt(),
            systemPrompt: '',
            bot,
            provider,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: false,
            addUserToHistory: false,
            addAssistantToHistory: true,
        });

        console.log(result);

    } catch (error) {
        console.error('Error clearing goal:', error);
        const result = await AIService.streamAIResponse({
            userId: msg.from?.id || 0,
            userMessage: ERROR_MESSAGE_PROMPT,
            systemPromptCachePrefix: getSystemPrompt(),
            systemPrompt: '',
            bot,
            provider,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: false,
            addUserToHistory: false,
            addAssistantToHistory: false,
        });

        console.log(result);
    }
}));

bot.onText(/\/routines/, serialTextHandler(async (msg) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;
        if (!isAllowedUser(userId)) return;

        const user = await getUser(userId);
        if (!user) {
            await safeSend(bot, msg.chat.id, 'Ошибка: пользователь не найден.');
            return;
        }

        const routines = user.routines || [];
        const activeRoutines = routines.filter(r => r.isActive).map(r => ({
            id: r.id,
            name: r.name,
            cron: r.cron,
            annoyance: r.defaultAnnoyance
        }));

        if (activeRoutines.length === 0) {
            await safeSend(bot, msg.chat.id, 'У тебя пока нет активных рутин.');
            return;
        }

        const routineText = activeRoutines.map(r => `- ${r.name} (${formatCronHuman(r.cron)}, Annoyance: ${r.annoyance})`).join('\n');
        await safeSend(bot, msg.chat.id, `🔗 Активные рутины:\n\n${routineText}`);

    } catch (error) {
        console.error('Error showing routines:', error);
        const result = await AIService.streamAIResponse({
            userId: msg.from?.id || 0,
            userMessage: ERROR_MESSAGE_PROMPT,
            systemPromptCachePrefix: getSystemPrompt(),
            systemPrompt: '',
            bot,
            provider,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: false,
            addUserToHistory: false,
            addAssistantToHistory: false,
        });

        console.log(result);
    }
}));

bot.onText(/\/tasks/, serialTextHandler(async (msg) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;
        if (!isAllowedUser(userId)) return;

        const user = await getUser(userId);
        if (!user) {
            await safeSend(bot, msg.chat.id, 'Ошибка: пользователь не найден.');
            return;
        }

        const tasks = user.tasks || [];
        const pendingTasks = tasks.filter(t => t.status === 'pending');

        if (pendingTasks.length === 0) {
            await safeSend(bot, msg.chat.id, 'У тебя пока нет активных задач.');
            return;
        }

        const taskText = pendingTasks.map(t => `- ${t.name} (Next: ${formatDateHuman(t.pingAt)}, Annoyance: ${t.annoyance})`).join('\n');
        await safeSend(bot, msg.chat.id, `📋 Активные задачи:\n\n${taskText}`);

    } catch (error) {
        console.error('Error showing tasks:', error);
        const result = await AIService.streamAIResponse({
            userId: msg.from?.id || 0,
            userMessage: ERROR_MESSAGE_PROMPT,
            systemPromptCachePrefix: getSystemPrompt(),
            systemPrompt: '',
            bot,
            provider,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: false,
            addUserToHistory: false,
            addAssistantToHistory: false,
        });

        console.log(result);
    }
}));

bot.onText(/\/memory/, serialTextHandler(async (msg) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;
        if (!isAllowedUser(userId)) return;

        const records = await getAllUserMemoryRecords(userId);
        const keys = Object.keys(records).sort();

        if (keys.length === 0) {
            await safeSend(bot, msg.chat.id, '🧠 Пока нечего помнить.\n\nУдалить запись: /forget <ключ>');
            return;
        }

        const lines = keys.map(k => {
            const rec = records[k];
            const sameDay = Math.abs(rec.updatedAt.getTime() - rec.firstRecordedAt.getTime()) < 86_400_000;
            const stamp = sameDay
                ? `записано ${ageLabel(rec.firstRecordedAt)}`
                : `впервые ${ageLabel(rec.firstRecordedAt)}, обновлено ${ageLabel(rec.updatedAt)}`;
            return `• ${k} (${stamp})\n  ${rec.value}`;
        });

        const body = lines.join('\n\n');
        const footer = '\n\nУдалить запись: /forget <ключ>';
        await safeSend(bot, msg.chat.id, `🧠 Сохранённая информация:\n\n${body}${footer}`);

    } catch (error) {
        console.error('Error showing memory:', error);
        const result = await AIService.streamAIResponse({
            userId: msg.from?.id || 0,
            userMessage: ERROR_MESSAGE_PROMPT,
            systemPromptCachePrefix: getSystemPrompt(),
            systemPrompt: '',
            bot,
            provider,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: false,
            addUserToHistory: false,
            addAssistantToHistory: false,
        });

        console.log(result);
    }
}));

bot.onText(/\/forget(?:\s+(.+))?/, serialTextHandler(async (msg, match) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;
        if (!isAllowedUser(userId)) return;

        const key = match?.[1]?.trim();

        if (!key) {
            const records = await getAllUserMemoryRecords(userId);
            const keys = Object.keys(records).sort();
            if (keys.length === 0) {
                await safeSend(bot, msg.chat.id, '🧠 Нечего удалять — память пуста.');
                return;
            }
            await safeSend(
                bot,
                msg.chat.id,
                `🧠 Укажи ключ: /forget &lt;ключ&gt;\n\nДоступные ключи:\n${keys.map(k => `• ${k}`).join('\n')}`,
            );
            return;
        }

        const removed = await deleteUserMemory(userId, key);
        if (removed) {
            await safeSend(bot, msg.chat.id, `🧠 Забыл: ${key}`);
        } else {
            await safeSend(bot, msg.chat.id, `🧠 Ключа ${key} не было в памяти.`);
        }

    } catch (error) {
        console.error('Error forgetting memory:', error);
        await safeSend(bot, msg.chat.id, 'Ошибка при удалении записи.');
    }
}));

bot.onText(/\/stats/, serialTextHandler(async (msg) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;
        if (!isAllowedUser(userId)) return;

        const statNames = await getTrackedStatNames(userId);
        if (statNames.length === 0) {
            await safeSend(bot, msg.chat.id, 'Пока нет отслеживаемых статистик. Просто скажи мне что-то вроде "выпил 500мл воды" или "настроение 7/10".');
            return;
        }

        const lines = await Promise.all(statNames.map(async (s) => {
            const latest = await getLatestStat(userId, s.name);
            const count = await getStatCount(userId, s.name);
            const lastVal = latest ? `${latest.value}${s.unit ? ' ' + s.unit : ''}` : '—';
            return `• ${s.name} — последнее: ${lastVal}, записей: ${count}`;
        }));

        await safeSend(bot, msg.chat.id, `📊 Отслеживаемые статистики:\n\n${lines.join('\n')}`);
    } catch (error) {
        console.error('Error showing stats:', error);
        await safeSend(bot, msg.chat.id, 'Ошибка при загрузке статистик.');
    }
}));

bot.onText(/\/help/, serialTextHandler(async (msg) => {
    try {
        const result = await AIService.streamAIResponse({
            userId: msg.from?.id || 0,
            userMessage: DEFAULT_HELP_PROMPT(),
            systemPromptCachePrefix: getSystemPrompt(),
            systemPrompt: '',
            bot,
            provider,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: false,
            addUserToHistory: false,
            addAssistantToHistory: true,
        });

        console.log(result);
    } catch (error) {
        console.error('Error showing help:', error);
        await safeSend(bot, msg.chat.id, `Доступные команды:
/goal - установить цель
/cleargoal - очистить цель
/routines - показать активные рутины
/tasks - показать задачи
/stats - показать отслеживаемые статистики
/memory - показать сохраненную информацию
/forget <ключ> - удалить запись из памяти
/help - эта справка`);
    }
}));



// Handle regular messages (now with AI command processing AND media support)
/** Process the side-effects of a single incoming message: custom-emoji
 * resolution, media parsing (Vision, sticker analysis), photo cache, caption
 * folding, and <system>-tag stripping. Returns the formatted content ready
 * for history append, or null if the message should be ignored / handled
 * specially (greeting on new user, unsupported type, fatal media error). */
async function processIncomingMessage(
    msg: TelegramBot.Message,
    userId: number,
): Promise<{ content: string; logIndicator: string } | null> {
    // Resolve any custom (premium) emoji entities in the user's text/caption
    // through the sticker_cache, so the AI sees descriptions of unfamiliar
    // emojis instead of just unicode fallback chars.
    const customEmojiBlock = await buildCustomEmojiContextBlock(msg, userId);

    const mediaParser = getMediaParser();
    const hasMedia = mediaParser.hasParseableMedia(msg);

    let processedContent: string;
    let logIndicator: string;

    if (hasMedia) {
        // Show typing indicator while processing media
        await bot.sendChatAction(msg.chat.id, 'typing');

        const parsed = await mediaParser.parseMedia(msg, userId);

        if (parsed.error && !parsed.content) {
            await safeSend(bot, msg.chat.id, 'Could not process this media. Please try sending text instead.');
            return null;
        }

        processedContent = mediaParser.formatForAI(parsed);
        logIndicator = mediaParser.getMediaIndicator(parsed);

        // Cache photo for re-analysis via AnalyzeImage tool. Strip <system> at the
        // write boundary so a user-supplied caption or vision-model description
        // containing our prompt marker can't escape the wrapper when AnalyzeImage
        // later surfaces this data back through tool results.
        if (parsed.type === 'photo' && parsed.metadata?.fileId) {
            await addImageToCache(userId, parsed.metadata.fileId,
                msg.caption != null ? stripSystemTags(msg.caption) : undefined,
                stripSystemTags(parsed.content));
        }

        if (msg.caption) {
            processedContent = `${msg.caption}\n\n${processedContent}`;
        }
    } else if (msg.text) {
        processedContent = msg.text;
        logIndicator = '[Text]';
    } else {
        return null;
    }

    // Prepend custom-emoji descriptions (if any). Goes before stripSystemTags
    // so any cached description containing a stray </system> is neutralized.
    if (customEmojiBlock) {
        processedContent = `${customEmojiBlock}\n\n${processedContent}`;
    }

    // Real-user-ingress trust boundary: strip <system> so a user typing
    // `</system>evil<system>` can't escape our prompt wrappers. Bot-synthesized
    // prompts (TASK_TRIGGERED_PROMPT, GREETING_PROMPT, …) bypass this — they
    // INTENTIONALLY wrap in <system> and go directly to streamAIResponse.
    processedContent = stripSystemTags(processedContent);

    return { content: processedContent, logIndicator };
}

bot.on('message', (msg) => {
    const userId = msg.from?.id;
    if (!userId) return;
    if (!isAllowedUser(userId)) {
        console.warn(`[auth] Rejected message from non-allowlisted userId=${userId}`);
        return;
    }
    // Commands have their own dispatch path (serialTextHandler) and bypass burst.
    if (msg.text?.startsWith('/')) return;

    // Acknowledge receipt with a typing action immediately so the user gets
    // visual feedback during the 800ms debounce window (otherwise pure-text
    // messages would feel unresponsive). Telegram auto-clears after ~5s.
    bot.sendChatAction(msg.chat.id, 'typing').catch(() => { /* non-fatal */ });

    // 1) Side-effects (parseMedia, history append) — chained per user so they
    //    land in arrival order, but independent of any in-flight AI reply.
    void enqueueSideEffects(userId, async () => {
        try {
            // New-user greeting: handled inline, fires immediately, no debounce.
            // We dispatch from inside the side-effects queue so it serializes
            // with any subsequent message processing for this brand-new user.
            const existing = await getUser(userId);
            if (!existing) {
                console.log('👤 New user detected, creating profile:', {
                    userId, chatId: msg.chat.id, timestamp: new Date().toISOString(),
                });
                await setUser({
                    userId, chatId: msg.chat.id,
                    preferences: { goal: '' },
                    tasks: [], routines: [], memory: {}, messageHistory: [],
                });
                // Fire greeting immediately on the AI-reply queue (bypasses burst).
                void enqueuePerUser(userId, () => AIService.streamAIResponse({
                    userId,
                    userMessage: GREETING_PROMPT,
                    systemPromptCachePrefix: getSystemPrompt(),
                    systemPrompt: '',
                    bot, provider, model: OPEN_AI_MODEL,
                    shouldUpdateTelegram: false,
                    addUserToHistory: true,
                    addAssistantToHistory: true,
                    enableToolCalls: true,
                }).then(() => {}));
                return;
            }

            // Ensure chatId and messageHistory are set
            if (!existing.chatId) existing.chatId = msg.chat.id;
            if (!existing.messageHistory) existing.messageHistory = [];
            await setUser(existing);

            const processed = await processIncomingMessage(msg, userId);
            if (!processed) return; // unsupported type or fatal media error already-notified

            console.log('📨 Received user message:', {
                userId,
                type: processed.logIndicator,
                contentPreview: processed.content.substring(0, 100) + (processed.content.length > 100 ? '...' : ''),
                timestamp: new Date().toISOString(),
            });

            // Append to history NOW — the burst reply path uses
            // addUserToHistory=false and reads recent history straight from DB.
            await addMessageToHistory(userId, 'user', processed.content);
            // Mark fresh user input pending so fireBurstReply knows there's
            // something to address (and isn't fooled by an intervening cron
            // ping leaving an assistant row as the most-recent history entry).
            pendingUserInput.set(userId, true);
        } catch (error) {
            console.error('❌ Error handling message side-effects:', {
                userId: msg.from?.id,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString(),
            });
            // Run the user-facing 🐺 error fallback OUTSIDE the side-effects
            // queue so we don't block subsequent messages on it.
            void enqueuePerUser(userId, () => AIService.streamAIResponse({
                userId,
                userMessage: ERROR_MESSAGE_PROMPT,
                systemPromptCachePrefix: getSystemPrompt(),
                systemPrompt: '',
                bot, provider, model: OPEN_AI_MODEL,
                shouldUpdateTelegram: false,
                addUserToHistory: false,
                addAssistantToHistory: false,
            }).then(() => {}));
        }
    });

    // 2) Soft-abort the in-flight reply if it hasn't shown text yet, then
    //    refresh the debounce timer. Both are synchronous; no awaits — this
    //    means the new message can reset the timer while prior parseMedia is
    //    still running, which is exactly what we want.
    softAbortIfPretext(userId);
    refreshBurstTimer(userId);
});

// Handle bot errors
bot.on('error', (error) => {
    console.error('Bot error:', error);
});

// Polling errors are the most common runtime failure (network hiccup, 429).
// Without an explicit listener node-telegram-bot-api surfaces warnings and
// some Node versions treat it as unhandled.
bot.on('polling_error', (error) => {
    console.error('Bot polling_error:', error instanceof Error ? error.message : error);
});

// Last-resort handlers — a floating promise rejection from any tool, cron,
// or stream callback should be logged and swallowed, not take down the bot.
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (error) => {
    console.error('[uncaughtException]', error instanceof Error ? error.stack : error);
});

// Shut down the puppeteer/lottie renderer cleanly so Chromium doesn't linger.
async function gracefulShutdown(signal: string): Promise<void> {
    console.log(`[shutdown] received ${signal}, closing browser`);
    await shutdownTgsRenderer().catch(err => console.error('[shutdown] tgs renderer:', err));
    try { db.close(); } catch (err) { console.error('[shutdown] db close:', err); }
    process.exit(0);
}
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
