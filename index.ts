import dotenv from 'dotenv';

dotenv.config();

import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import cron from 'node-cron';
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
    getAllTasks, Task, updateUserTask
} from "./userStore";
import {addUserTask, generateShortId} from './userStore';
import {AIService} from './aiService';
import {CronExpressionParser} from 'cron-parser';
import {formatDateHuman, formatCronHuman, getCurrentTime} from './dateUtils';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPEN_AI_ENDPOINT = process.env.OPEN_AI_ENDPOINT;
const OPEN_AI_MODEL = process.env.OPENAI_MODEL || 'gpt-4-1106-preview';

const bot = new TelegramBot(TELEGRAM_TOKEN, {polling: true});

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    ...(OPEN_AI_ENDPOINT && {baseURL: OPEN_AI_ENDPOINT}),
});

async function getCurrentInfo(userId: number): Promise<string> {
    const user = await getUser(userId);
    if (!user) throw new Error('Ошибка: пользователь не найден');

    const routines = await getAllRoutines(userId);
    const activeRoutines = routines.filter(r => r.isActive);

    const tasks = await getAllTasks(userId);
    const pendingTasks = tasks.filter(t => t.status === 'pending');
    const replanningTasks = tasks.filter(t => t.status === 'needs_replanning');
    const Memory = `
Goal: ${user.preferences.goal || 'not set'}

Routines/Schedule:
${activeRoutines.map(r => `id: ${r.id} cron: ${r.cron} defaultAnnoyance: ${r.defaultAnnoyance} name: ${r.name} timesCompleted: ${r.stats.completed} timesFailed: ${r.stats.failed}`).join('\n') || 'no active routines'}

Pending Tasks: 
${pendingTasks.map(t => `id: ${t.id} dueAt: ${t.dueAt?t.dueAt.toISOString():'none'} pingAt: ${formatDateHuman(t.pingAt)} annoyance: ${t.annoyance} postponeCount: ${t.postponeCount} name: ${t.name}`).join('\n') || 'no active tasks'}

Tasks that need AI agent to update them: 
${pendingTasks.map(t => `id: ${t.id} dueAt: ${t.dueAt?t.dueAt.toISOString():'none'} pingAt: ${formatDateHuman(t.pingAt)} annoyance: ${t.annoyance} postponeCount: ${t.postponeCount} name: ${t.name}`).join('\n') || 'no active tasks'}

Memory: ${JSON.stringify(user.memory || {}, null, 2)}
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
            openai,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: true,
            addUserToHistory: true,
            addAssistantToHistory: true,
            enableToolCalls: true,
        });

        // Cleanup old completed/failed tasks after processing (keep last 50 per user)
        const userForCleanup = await getUser(userId);
        if (userForCleanup && userForCleanup.tasks && userForCleanup.tasks.length > 50) {
            const sortedTasks = [...userForCleanup.tasks].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
            const tasksToKeep = sortedTasks.slice(0, 50);
            const removedCount = userForCleanup.tasks.length - tasksToKeep.length;

            userForCleanup.tasks = tasksToKeep;
            await setUser(userForCleanup);

            if (removedCount > 0) {
                console.log(`🧹 Cleaned up old tasks:`, {
                    userId,
                    removedCount,
                    tasksKept: tasksToKeep.length,
                    timestamp: new Date().toISOString()
                });
            }
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
        });
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
                const nextFireTime = cronInterval.next().toDate();
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
                        openai,
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
                await bot.sendMessage(msg.chat.id, `🎯 Твоя текущая цель: "${user.preferences.goal}"\n\nИспользуй /goal <новая цель> чтобы изменить`);
            } else {
                await bot.sendMessage(msg.chat.id, `🎯 У тебя пока нет установленной цели\n\nИспользуй /goal <твоя цель> чтобы установить`);
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
            openai,
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
            openai,
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
            openai,
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
            openai,
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
            await bot.sendMessage(msg.chat.id, 'Ошибка: пользователь не найден.');
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
            await bot.sendMessage(msg.chat.id, 'У тебя пока нет активных рутин.');
            return;
        }

        const routineText = activeRoutines.map(r => `- ${r.name} (${formatCronHuman(r.cron)}, Annoyance: ${r.annoyance})`).join('\n');
        await bot.sendMessage(msg.chat.id, `🔗 Активные рутины:\n\n${routineText}`, {
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error('Error showing routines:', error);
        const result = await AIService.streamAIResponse({
            userId: msg.from?.id || 0,
            userMessage: ERROR_MESSAGE_PROMPT,
            systemPrompt: SYSTEM_PROMPT,
            bot,
            openai,
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
            await bot.sendMessage(msg.chat.id, 'Ошибка: пользователь не найден.');
            return;
        }

        const tasks = user.tasks || [];
        const pendingTasks = tasks.filter(t => t.status === 'pending');

        if (pendingTasks.length === 0) {
            await bot.sendMessage(msg.chat.id, 'У тебя пока нет активных задач.');
            return;
        }

        const taskText = pendingTasks.map(t => `- ${t.name} (Next: ${formatDateHuman(t.pingAt)}, Annoyance: ${t.annoyance})`).join('\n');
        await bot.sendMessage(msg.chat.id, `📋 Активные задачи:\n\n${taskText}`, {
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error('Error showing tasks:', error);
        const result = await AIService.streamAIResponse({
            userId: msg.from?.id || 0,
            userMessage: ERROR_MESSAGE_PROMPT,
            systemPrompt: SYSTEM_PROMPT,
            bot,
            openai,
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

        const user = await getUser(userId);
        if (!user) {
            await bot.sendMessage(msg.chat.id, 'Ошибка: пользователь не найден.');
            return;
        }

        const memoryText = JSON.stringify(user.memory, null, 2);
        await bot.sendMessage(msg.chat.id, `🧠 Сохраненная информация:\n\`\`\`${memoryText}\`\`\``, {
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error('Error showing memory:', error);
        const result = await AIService.streamAIResponse({
            userId: msg.from?.id || 0,
            userMessage: ERROR_MESSAGE_PROMPT,
            systemPrompt: SYSTEM_PROMPT,
            bot,
            openai,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: false,
            addUserToHistory: false,
            addAssistantToHistory: false,
        });

        console.log(result);
    }
});

bot.onText(/\/help/, async (msg) => {
    try {
        const result = await AIService.streamAIResponse({
            userId: msg.from?.id || 0,
            userMessage: DEFAULT_HELP_PROMPT(),
            systemPrompt: SYSTEM_PROMPT,
            bot,
            openai,
            model: OPEN_AI_MODEL,
            shouldUpdateTelegram: false,
            addUserToHistory: false,
            addAssistantToHistory: true,
        });

        console.log(result);
    } catch (error) {
        console.error('Error showing help:', error);
        await bot.sendMessage(msg.chat.id, `Доступные команды:
/goal - установить цель
/cleargoal - очистить цель  
/routines - показать активные рутины
/tasks - показать задачи
/memory - показать сохраненную информацию
/help - эта справка`);
    }
});

// Handle regular messages (now with AI command processing)
bot.on('message', async (msg) => {
    try {
        const text = msg.text;
        const userId = msg.from?.id;
        if (!text || !userId || text.startsWith('/')) return;

        console.log('📨 Received user message:', {
            userId,
            messageLength: text.length,
            isCommand: text.startsWith('/'),
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
                openai,
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
        await replyToUser(userId, text);


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
            openai,
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
