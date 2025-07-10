import dotenv from 'dotenv';
dotenv.config();

import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import cron from 'node-cron';
import {
    SYSTEM_PROMPT,
    GREETING_PROMPT,
    GOAL_ACCEPTED_PROMPT,
    GOAL_SET_PROMPT,
    GOAL_CLEAR_PROMPT,
    ERROR_MESSAGE_PROMPT,
    DEFAULT_HELP_PROMPT, TASK_TRIGGERED_PROMPT
} from './constants';
import {getUser, setUser, getAllUsers, addMessageToHistory, getUserMessageHistory} from "./userStore";
import { getUserRoutines, getUserTasks, addUserTask, updateUserTask, updateUserRoutine, addUserRoutine, generateShortId } from './userStore';
import { AICommandService } from './aiCommandService';
import { CronExpressionParser } from 'cron-parser';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPEN_AI_ENDPOINT = process.env.OPEN_AI_ENDPOINT;
const CHAT_ID = process.env.CHAT_ID;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    ...(OPEN_AI_ENDPOINT && { baseURL: OPEN_AI_ENDPOINT }),
});

async function recentMessages(userId: number, limit: number = 50): Promise<{ role: 'user' | 'assistant', content: string }[]> {
    const messageHistory = await getUserMessageHistory(userId);
    const recentMessages = messageHistory.slice(-limit);

    return recentMessages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content
    }));
}
async function generateMessage(
    prompt: string,
    systemPrompt: string = SYSTEM_PROMPT,
    messages: { role: 'user' | 'assistant', content: string }[] = []
): Promise<string> {
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { role: 'system', content: systemPrompt },
                ...messages,
                { role: 'user', content: prompt }
            ]
        });

        return response.choices[0].message?.content?.trim() || 'Ошибка генерации сообщения';
    } catch (error) {
        console.error('Error generating message:', error);
        return 'Извини, проблемы с генерацией сообщения 🐺';
    }
}

async function getCurrentInfo(userId: number): Promise<string> {
        const user = await getUser(userId);
        if (!user) throw new Error('Ошибка: пользователь не найден');

        const routines = await getUserRoutines(userId);
        const activeRoutines = routines.filter(r => r.isActive).map(r => ({
            id: r.id,
            name: r.name,
            cron: r.cron,
            annoyance: r.defaultAnnoyance
        }));

        const tasks = await getUserTasks(userId);
        const pendingTasks = tasks.filter(t => t.status === 'pending').map(t => ({
            id: t.id,
            name: t.name,
            due: t.due,
            nextPing: t.nextPing,
            annoyance: t.annoyance,
            postponeCount: t.postponeCount
        }));

        const currentTime = new Date();
        const Memory = `
            Текущее время: ${currentTime.toISOString()}
    
            Текущая цель: ${user.preferences.goal || 'не установлена'}
    
            Активные рутины: ${JSON.stringify(activeRoutines, null, 2)}
    
            Активные задачи: ${JSON.stringify(pendingTasks, null, 2)}
    
            Сохраненная информация (память): ${JSON.stringify(user.memory || {}, null, 2)}`

        return Memory;
}

async function generateAIResponse(userId: number, userMessage: string): Promise<string> {
    try {
        console.log('💬 Generating AI response:', {
            userId,
            userMessage: userMessage.substring(0, 100) + (userMessage.length > 100 ? '...' : ''),
            timestamp: new Date().toISOString()
        });

        const user = await getUser(userId);
        if (!user) return 'Ошибка: пользователь не найден';

        const memory = await getCurrentInfo(userId);
        const fullPrompt = ` 
            ${SYSTEM_PROMPT}       
            
            ${memory}`;

        const messages = [
            { 
              role: 'system' as const, 
              content: fullPrompt 
            },
            // Add recent message history for context
            ...(await recentMessages(userId, 50)),
            { role: 'user' as const, content: userMessage }
        ];

        const response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages
        });

        const aiResponse = response.choices[0].message?.content?.trim() || 'Ошибка генерации ответа';
        
        console.log('🤖 AI Response generated:', {
            userId,
            responseLength: aiResponse.length,
            containsCommands: aiResponse.includes('<set-routine') || aiResponse.includes('<goal>') || aiResponse.includes('<set-task') || aiResponse.includes('<update-routine') || aiResponse.includes('<delete-routine'),
            timestamp: new Date().toISOString()
        });
        
        // Process AI commands and return clean response
        const { message, commandResults } = await AICommandService.processAIResponse(userId, aiResponse);
        
        // Add both user message and AI response to history
        await addMessageToHistory(userId, 'user', userMessage);
        await addMessageToHistory(userId, 'assistant', message);
        
        console.log('📝 Messages added to history:', {
            userId,
            userMessageLength: userMessage.length,
            aiMessageLength: message.length,
            totalHistoryAfter: (await getUserMessageHistory(userId)).length,
            timestamp: new Date().toISOString()
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
        if (commandResults.length > 0) {
            return `${message}\n\n${commandResults.join('\n')}`;
        }
        
        return message;
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
    const now = new Date();
    const users = await getAllUsers();
    
    console.log('⏰ Checking routines and tasks for all users:', {
        userCount: users.length,
        timestamp: now.toISOString()
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
                const timeSinceLastFire = now.getTime() - lastFireTime.getTime();
                if (timeSinceLastFire <= 60000) { // Within 1 minute
                    console.log('🔔 Firing routine to create task:', {
                        userId: user.userId,
                        routineId: routine.id,
                        routineName: routine.name,
                        cronExpression: routine.cron,
                        lastFireTime: lastFireTime.toISOString(),
                        timestamp: now.toISOString()
                    });

                    // Create new task instance from routine
                    const newTask = {
                        id: generateShortId(),
                        name: routine.name,
                        routineId: routine.id,
                        firstTriggered: now,
                        due: now,
                        requiresAction: routine.requiresAction,
                        status: routine.requiresAction ? 'pending' : 'completed',
                        annoyance: routine.defaultAnnoyance,
                        nextPing: now,
                        postponeCount: 0,
                        createdAt: now
                    } as const;

                    await addUserTask(user.userId, newTask);
                    
                    // Update routine stats
                    await updateUserRoutine(user.userId, routine.id, (r) => {
                        // No stats update needed here, will be updated when task is completed/failed
                    });

                    console.log('✅ Created task from routine:', {
                        userId: user.userId,
                        routineId: routine.id,
                        taskId: newTask.id,
                        taskName: newTask.name,
                        timestamp: now.toISOString()
                    });
                }
            } catch (error) {
                console.error('❌ Error checking routine:', {
                    userId: user.userId,
                    routineId: routine.id,
                    error: error instanceof Error ? error.message : String(error),
                    timestamp: now.toISOString()
                });
            }
        }
        
        // 2. Check pending tasks for pinging users
        const pendingTasks = user.tasks.filter(t => t.status === 'pending');
        for (const task of pendingTasks) {
            try {
                // Check if task should ping user
                if (task.nextPing <= now) {
                    console.log('📱 Pinging user about pending task:', {
                        userId: user.userId,
                        taskId: task.id,
                        taskName: task.name,
                        due: task.due.toISOString(),
                        nextPing: task.nextPing.toISOString(),
                        annoyance: task.annoyance,
                        postponeCount: task.postponeCount,
                        timestamp: now.toISOString()
                    });

                    const memory = await getCurrentInfo(user.userId);

                    // Generate AI response asking about the task
                    const taskPrompt = TASK_TRIGGERED_PROMPT(memory, task);
                    
                    const aiResponse = await generateMessage(
                        taskPrompt,
                        SYSTEM_PROMPT,
                        await recentMessages(user.userId, 50),
                    );
                    const { message: cleanMessage } = await AICommandService.processAIResponse(user.userId, aiResponse);

                    // Send message to user
                    await bot.sendMessage(user.chatId, cleanMessage);
                    await addMessageToHistory(user.userId, 'assistant', cleanMessage);

                    console.log(aiResponse);
                }
            } catch (error) {
                console.error('❌ Error pinging task:', {
                    userId: user.userId,
                    taskId: task.id,
                    error: error instanceof Error ? error.message : String(error),
                    timestamp: now.toISOString()
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
                preferences: { goal: newGoal },
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

        const aiResponse = await generateMessage(GOAL_SET_PROMPT(newGoal));
        const { message: updateMessage } = await AICommandService.processAIResponse(userId, aiResponse);
        await bot.sendMessage(msg.chat.id, updateMessage);

    } catch (error) {
        console.error('Error updating goal:', error);
        const aiResponse = await generateMessage(ERROR_MESSAGE_PROMPT);
        const { message: errorMessage } = await AICommandService.processAIResponse(msg.from?.id || 0, aiResponse);
        await bot.sendMessage(msg.chat.id, errorMessage);
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
                preferences: { goal: '' },
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

        const aiResponse = await generateMessage(GOAL_CLEAR_PROMPT());
        const { message: clearMessage } = await AICommandService.processAIResponse(userId, aiResponse);
        await bot.sendMessage(msg.chat.id, clearMessage);

    } catch (error) {
        console.error('Error clearing goal:', error);
        const aiResponse = await generateMessage(ERROR_MESSAGE_PROMPT);
        const { message: errorMessage } = await AICommandService.processAIResponse(msg.from?.id || 0, aiResponse);
        await bot.sendMessage(msg.chat.id, errorMessage);
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

        const routineText = activeRoutines.map(r => `• ${r.name} (CRON: ${r.cron}, Annoyance: ${r.annoyance})`).join('\n');
        await bot.sendMessage(msg.chat.id, `🔗 Активные рутины:\n${routineText}`);

    } catch (error) {
        console.error('Error showing routines:', error);
        const aiResponse = await generateMessage(ERROR_MESSAGE_PROMPT);
        const { message: errorMessage } = await AICommandService.processAIResponse(msg.from?.id || 0, aiResponse);
        await bot.sendMessage(msg.chat.id, errorMessage);
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
        const pendingTasks = tasks.filter(t => t.status === 'pending').map(t => ({
            id: t.id,
            name: t.name,
            due: t.due,
            nextPing: t.nextPing,
            annoyance: t.annoyance,
            postponeCount: t.postponeCount
        }));

        if (pendingTasks.length === 0) {
            await bot.sendMessage(msg.chat.id, 'У тебя пока нет активных задач.');
            return;
        }

        const taskText = pendingTasks.map(t => `• ${t.name} (Due: ${t.due.toISOString().slice(0, 10)}, Annoyance: ${t.annoyance})`).join('\n');
        await bot.sendMessage(msg.chat.id, `📋 Активные задачи:\n${taskText}`);

    } catch (error) {
        console.error('Error showing tasks:', error);
        const aiResponse = await generateMessage(ERROR_MESSAGE_PROMPT);
        const { message: errorMessage } = await AICommandService.processAIResponse(msg.from?.id || 0, aiResponse);
        await bot.sendMessage(msg.chat.id, errorMessage);
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
        await bot.sendMessage(msg.chat.id, `🧠 Сохраненная информация:\n\`\`\`${memoryText}\`\`\``);

    } catch (error) {
        console.error('Error showing memory:', error);
        const aiResponse = await generateMessage(ERROR_MESSAGE_PROMPT);
        const { message: errorMessage } = await AICommandService.processAIResponse(msg.from?.id || 0, aiResponse);
        await bot.sendMessage(msg.chat.id, errorMessage);
    }
});

bot.onText(/\/help/, async (msg) => {
    try {
        const aiResponse = await generateMessage(DEFAULT_HELP_PROMPT());
        const { message: helpMessage } = await AICommandService.processAIResponse(msg.from?.id || 0, aiResponse);
        await bot.sendMessage(msg.chat.id, helpMessage);
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
                messageHistory: []
            };
            await setUser(newUser);
            const aiResponse = await generateMessage(GREETING_PROMPT);
            const { message: greetingMessage } = await AICommandService.processAIResponse(userId, aiResponse);
            await bot.sendMessage(msg.chat.id, greetingMessage);
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

        if (!existing.preferences.goal) {
            console.log('🎯 User setting initial goal:', {
                userId,
                goal: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
                timestamp: new Date().toISOString()
            });

            existing.preferences.goal = text;
            await setUser(existing);
            await addMessageToHistory(userId, 'user', text);
            const aiResponse = await generateMessage(GOAL_ACCEPTED_PROMPT(text));
            const { message: acceptedMessage } = await AICommandService.processAIResponse(userId, aiResponse);
            await addMessageToHistory(userId, 'assistant', acceptedMessage);
            await bot.sendMessage(msg.chat.id, acceptedMessage);
            return;
        }

        // Use AI to respond with command processing
        const aiResponse = await generateAIResponse(userId, text);
        await bot.sendMessage(msg.chat.id, aiResponse);
        
    } catch (error) {
        console.error('❌ Error handling message:', {
            userId: msg.from?.id,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        });
        const aiResponse = await generateMessage(ERROR_MESSAGE_PROMPT);
        const { message: errorMessage } = await AICommandService.processAIResponse(msg.from?.id || 0, aiResponse);
        await bot.sendMessage(msg.chat.id, errorMessage);
    }
});

// Handle bot errors
bot.on('error', (error) => {
    console.error('Bot error:', error);
});
