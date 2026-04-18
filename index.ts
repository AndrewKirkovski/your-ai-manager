import dotenv from 'dotenv';

dotenv.config();

// Start web server
import './webServer';

import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import cron from 'node-cron';
import { initLuxmedMonitor, runLuxmedMonitoringCycle } from './luxmedMonitor';
import { OpenAIProvider } from './aiProvider.openai';
import { AnthropicProvider } from './aiProvider.anthropic';
import type { AIProvider } from './aiProvider';
import {
    SYSTEM_PROMPT,
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
import {addUserTask, generateShortId} from './userStore';
import {AIService} from './aiService';
import {safeSend, stripSystemTags} from './telegramFormat';
import {runHistoryCompaction} from './historyCompaction';
import {runStyleScan} from './styleScan';
import {CronExpressionParser} from 'cron-parser';
import {formatDateHuman, formatCronHuman, getCurrentTime} from './dateUtils';
import {initializeMediaParser, getMediaParser} from './mediaParser';
import {initStatTools} from './tools.stats';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPEN_AI_ENDPOINT = process.env.OPEN_AI_ENDPOINT;
const OPEN_AI_MODEL = process.env.OPENAI_MODEL || 'gpt-4-1106-preview';

// AI provider selection
const AI_PROVIDER_TYPE = (process.env.AI_PROVIDER || 'openai') as 'openai' | 'anthropic';

// Media parsing configuration
const OPENAI_WHISPER_API_KEY = process.env.OPENAI_WHISPER_API_KEY;
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-1';
const VISION_MODEL = process.env.VISION_MODEL || 'claude-sonnet-4-20250514';

const bot = new TelegramBot(TELEGRAM_TOKEN, {polling: true});
initLuxmedMonitor(bot);

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

function formatMemoryBlock(memory: Record<string, { value: string; firstRecordedAt: Date; updatedAt: Date }>): string {
    const keys = Object.keys(memory);
    if (keys.length === 0) return '{}';
    const lines = keys.map(k => {
        const rec = memory[k];
        const sameDay = Math.abs(rec.updatedAt.getTime() - rec.firstRecordedAt.getTime()) < 86_400_000;
        const stamp = sameDay
            ? `recorded ${ageLabel(rec.firstRecordedAt)}`
            : `first recorded ${ageLabel(rec.firstRecordedAt)}, updated ${ageLabel(rec.updatedAt)}`;
        // Keys and values can be AI-written via UpdateMemory tool — strip <system> so
        // this block can't self-inject fake system messages when spliced into the prompt.
        return `  ${stripSystemTags(k)} [${stamp}]: ${stripSystemTags(rec.value)}`;
    });
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

async function replyToUser(userId: number, userMessage: string): Promise<string> {
    try {
        const user = await getUser(userId);
        if (!user) return 'Ошибка: пользователь не найден';

        const memory = await getCurrentInfo(userId);
        const fullPrompt = ` 
            ${SYSTEM_PROMPT}       
            
            ${memory}`;

        const result = await AIService.streamAIResponse({
            userId,
            userMessage,
            systemPrompt: fullPrompt,
            bot,
            provider,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: true,
            addUserToHistory: true,
            addAssistantToHistory: true,
            enableToolCalls: true,
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

        // Combine the clean message with command results if any
        if (result.commandResults.length > 0) {
            return `${result.message}\n\n${result.commandResults.join('\n')}`;
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

// Check routines and tasks every minute
cron.schedule('* * * * *', async () => {
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
                // Check if routine should fire based on cron
                const cronInterval = CronExpressionParser.parse(routine.cron);
                cronInterval.next(); // advance iterator so .prev() returns the last fire time
                const lastFireTime = cronInterval.prev().toDate();

                // If lastFireTime is within the last minute, this routine should fire
                const timeSinceLastFire = now.toMillis() - lastFireTime.getTime();
                if (timeSinceLastFire <= 60000) { // Within 1 minute
                    console.log('🔔 Firing routine to create task:', routine);

                    // Create new task instance from routine
                    const newTask: Task = {
                        id: generateShortId(),
                        name: routine.name,
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

                    const memory = await getCurrentInfo(user.userId);

                    // Generate AI response asking about the task
                    const taskPrompt = task.requiresAction ? TASK_TRIGGERED_PROMPT(memory, task) : TASK_TRIGGERED_PROMPT_NO_ACTION(memory, task);

                    const result = await AIService.streamAIResponse({
                        userId: user.userId,
                        userMessage: taskPrompt,
                        systemPrompt: SYSTEM_PROMPT,
                        bot,
                        provider,
                        model: OPEN_AI_MODEL,
                        addUserToHistory: false,
                        addAssistantToHistory: true,
                        enableToolCalls: true
                    });

                    console.log(result);


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
});

// Compact history once per hour
cron.schedule('0 * * * *', async () => {
    try {
        await runHistoryCompaction(provider, OPEN_AI_MODEL);
    } catch (error) {
        console.error('🗜️ History compaction cron error:', error instanceof Error ? error.message : error);
    }
});

// Daily user communication-style + ADHD-reaction scan at 04:00 Warsaw time
cron.schedule('0 4 * * *', async () => {
    try {
        await runStyleScan(provider, OPEN_AI_MODEL);
    } catch (error) {
        console.error('🎭 Style scan cron error:', error instanceof Error ? error.message : error);
    }
}, { timezone: 'Europe/Warsaw' });

// LuxMed monitoring — check every 10 minutes
cron.schedule('*/10 * * * *', async () => {
    try {
        await runLuxmedMonitoringCycle();
    } catch (error) {
        console.error('[LuxMed Monitor] Cron error:', error instanceof Error ? error.message : error);
    }
});

// Handle commands
bot.onText(/\/goal(.*)/, async (msg, match) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;

        const newGoal = match?.[1]?.trim();

        if (!newGoal) {
            // Show current goal
            const user = await getUser(userId);
            if (user && user.preferences.goal) {
                await safeSend(bot, msg.chat.id, `🎯 Твоя текущая цель: "${user.preferences.goal}"\n\nИспользуй /goal <новая цель> чтобы изменить`);
            } else {
                await safeSend(bot, msg.chat.id, `🎯 У тебя пока нет установленной цели\n\nИспользуй /goal <твоя цель> чтобы установить`);
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
            systemPrompt: SYSTEM_PROMPT,
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
            systemPrompt: SYSTEM_PROMPT,
            bot,
            provider,
            model: OPEN_AI_MODEL,
            addUserToHistory: false,
            addAssistantToHistory: false,
        });

        console.log(result);
    }
});

bot.onText(/\/cleargoal/, async (msg) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;

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
            systemPrompt: SYSTEM_PROMPT,
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
            systemPrompt: SYSTEM_PROMPT,
            bot,
            provider,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: false,
            addUserToHistory: false,
            addAssistantToHistory: false,
        });

        console.log(result);
    }
});

bot.onText(/\/routines/, async (msg) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;

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
            systemPrompt: SYSTEM_PROMPT,
            bot,
            provider,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: false,
            addUserToHistory: false,
            addAssistantToHistory: false,
        });

        console.log(result);
    }
});

bot.onText(/\/tasks/, async (msg) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;

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
            systemPrompt: SYSTEM_PROMPT,
            bot,
            provider,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: false,
            addUserToHistory: false,
            addAssistantToHistory: false,
        });

        console.log(result);
    }
});

bot.onText(/\/memory/, async (msg) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;

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
            systemPrompt: SYSTEM_PROMPT,
            bot,
            provider,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: false,
            addUserToHistory: false,
            addAssistantToHistory: false,
        });

        console.log(result);
    }
});

bot.onText(/\/forget(?:\s+(.+))?/, async (msg, match) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;

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
                `🧠 Укажи ключ: /forget <ключ>\n\nДоступные ключи:\n${keys.map(k => `• ${k}`).join('\n')}`,
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
});

bot.onText(/\/stats/, async (msg) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;

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
});

bot.onText(/\/help/, async (msg) => {
    try {
        const result = await AIService.streamAIResponse({
            userId: msg.from?.id || 0,
            userMessage: DEFAULT_HELP_PROMPT(),
            systemPrompt: SYSTEM_PROMPT,
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
});



// Handle regular messages (now with AI command processing AND media support)
bot.on('message', async (msg) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;

        // TEMP emoji-harvest (remove after 2026-05-01): log custom emoji IDs +
        // sticker metadata to populate TG_EMOJI_CATALOG in telegramFormat.ts.
        const harvestText = msg.text ?? msg.caption ?? '';
        const ents = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];
        for (const e of ents) {
            if (e.type !== 'custom_emoji') continue;
            const ch = harvestText.slice(e.offset, e.offset + e.length);
            console.log(`[emoji-harvest] entity char="${ch}" id=${e.custom_emoji_id} from userId=${userId}`);
        }
        if (msg.sticker) {
            const s = msg.sticker;
            console.log(`[emoji-harvest] sticker emoji=${s.emoji ?? ''} set=${s.set_name ?? ''} fileUnique=${s.file_unique_id} customEmojiId=${s.custom_emoji_id ?? '-'} animated=${s.is_animated} video=${s.is_video}`);
        }

        // Skip commands - they have their own handlers
        if (msg.text?.startsWith('/')) return;

        // Detect message type and parse content
        const mediaParser = getMediaParser();
        const hasMedia = mediaParser.hasParseableMedia(msg);

        let processedContent: string;
        let logIndicator: string;

        if (hasMedia) {
            // Show typing indicator while processing media
            await bot.sendChatAction(msg.chat.id, 'typing');

            // Parse the media
            const parsed = await mediaParser.parseMedia(msg);

            if (parsed.error && !parsed.content) {
                // Complete failure - notify user
                await safeSend(
                    bot,
                    msg.chat.id,
                    'Could not process this media. Please try sending text instead.'
                );
                return;
            }

            // Format for AI conversation
            processedContent = mediaParser.formatForAI(parsed);
            logIndicator = mediaParser.getMediaIndicator(parsed);

            // Cache photo for re-analysis via AnalyzeImage tool
            if (parsed.type === 'photo' && parsed.metadata?.fileId) {
                await addImageToCache(userId, parsed.metadata.fileId, msg.caption, parsed.content);
            }

            // Include any caption with photos/stickers
            if (msg.caption) {
                processedContent = `${msg.caption}\n\n${processedContent}`;
            }
        } else if (msg.text) {
            processedContent = msg.text;
            logIndicator = '[Text]';
        } else {
            // Unsupported message type (documents, animations, etc.)
            return;
        }

        console.log('📨 Received user message:', {
            userId,
            type: logIndicator,
            contentPreview: processedContent.substring(0, 100) + (processedContent.length > 100 ? '...' : ''),
            timestamp: new Date().toISOString()
        });

        let existing = await getUser(userId);

        if (!existing) {
            console.log('👤 New user detected, creating profile:', {
                userId,
                chatId: msg.chat.id,
                timestamp: new Date().toISOString()
            });

            const newUser = {
                userId,
                chatId: msg.chat.id,
                preferences: {
                    goal: ''
                },
                tasks: [],
                routines: [],
                memory: {},
                messageHistory: []
            };
            await setUser(newUser);

            const result = await AIService.streamAIResponse({
                userId,
                userMessage: GREETING_PROMPT,
                systemPrompt: SYSTEM_PROMPT,
                bot,
                provider,
                model: OPEN_AI_MODEL,
                shouldUpdateTelegram: false,
                addUserToHistory: true,
                addAssistantToHistory: true,
                enableToolCalls: true
            });

            console.log(result);

            return;
        }

        // Ensure chatId and messageHistory are set
        if (!existing.chatId) {
            existing.chatId = msg.chat.id;
        }
        if (!existing.messageHistory) {
            existing.messageHistory = [];
        }
        await setUser(existing);

        // Use AI to respond with command processing
        await replyToUser(userId, processedContent);

    } catch (error) {
        console.error('❌ Error handling message:', {
            userId: msg.from?.id,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        });
        const result = await AIService.streamAIResponse({
            userId: msg.from?.id || 0,
            userMessage: ERROR_MESSAGE_PROMPT,
            systemPrompt: SYSTEM_PROMPT,
            bot,
            provider,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: false,
            addUserToHistory: false,
            addAssistantToHistory: false,
        });

        console.log(result);
    }
});

// Handle bot errors
bot.on('error', (error) => {
    console.error('Bot error:', error);
});
