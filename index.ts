import dotenv from 'dotenv';
dotenv.config();

import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import cron from 'node-cron';
import { 
    SYSTEM_PROMPT,
    GREETING_PROMPT,
    GOAL_ACCEPTED_PROMPT,
    GOAL_UPDATE_PROMPT,
    GOAL_ANALYSIS_PROMPT,
    MORNING_PROMPT,
    LUNCH_CHECKIN_PROMPT,
    EVENING_SUMMARY_PROMPT,
    ERROR_MESSAGE_PROMPT,
    REMINDER_SET_PROMPT,
    REMINDER_FAILED_PROMPT,
    REMINDER_FIRE_PROMPT,
    REMINDER_LIST_PROMPT,
    AI_CHAT_PROMPT
} from './constants';
import {getUser, setUser, getAllUsers, addUserReminder, getUserReminders, updateReminderNextFireTime, addMessageToHistory, getUserMessageHistory, cleanupExpiredReminders} from "./userStore";
import { ReminderService } from './reminderService';
import { AICommandService } from './aiCommandService';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPEN_AI_ENDPOINT = process.env.OPEN_AI_ENDPOINT;
const CHAT_ID = process.env.CHAT_ID;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    ...(OPEN_AI_ENDPOINT && { baseURL: OPEN_AI_ENDPOINT }),
});

async function generateMessage(prompt: string): Promise<string> {
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: prompt }
            ]
        });

        return response.choices[0].message?.content?.trim() || 'Ошибка генерации сообщения';
    } catch (error) {
        console.error('Error generating message:', error);
        return 'Извини, проблемы с генерацией сообщения 🐺';
    }
}

async function analyzeAndUpdateGoal(userId: number): Promise<void> {
    try {
        console.log('🎯 Starting goal analysis:', {
            userId,
            timestamp: new Date().toISOString()
        });

        const user = await getUser(userId);
        if (!user || !user.preferences.goal) return;

        const messageHistory = await getUserMessageHistory(userId);
        if (messageHistory.length < 5) {
            console.log('🎯 Skipping goal analysis - insufficient message history:', {
                userId,
                messageCount: messageHistory.length,
                timestamp: new Date().toISOString()
            });
            return; // Need some conversation history
        }

        // Get recent messages (last 20)
        const recentMessages = messageHistory.slice(-20).map(m => ({
            role: m.role,
            content: m.content
        }));

        console.log('🎯 Analyzing goal with message history:', {
            userId,
            currentGoal: user.preferences.goal,
            recentMessageCount: recentMessages.length,
            timestamp: new Date().toISOString()
        });

        const response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: GOAL_ANALYSIS_PROMPT(user.preferences.goal, recentMessages) }
            ]
        });

        const analysisResult = response.choices[0].message?.content?.trim();
        
        console.log('🎯 Goal analysis result:', {
            userId,
            analysisResult,
            timestamp: new Date().toISOString()
        });

        if (analysisResult?.startsWith('NEW_GOAL:')) {
            const newGoal = analysisResult.replace('NEW_GOAL:', '').trim();
            const oldGoal = user.preferences.goal;
            user.preferences.goal = newGoal;
            await setUser(user);
            
            console.log('🎯 Goal automatically updated:', {
                userId,
                oldGoal,
                newGoal,
                timestamp: new Date().toISOString()
            });
            
            // Notify user about goal update
            if (user.chatId) {
                const aiResponse = await generateMessage(GOAL_UPDATE_PROMPT(newGoal));
                const { message: updateMessage } = await AICommandService.processAIResponse(userId, aiResponse);
                await bot.sendMessage(user.chatId, `🎯 Обновил твою цель: ${updateMessage}`);
            }
        } else {
            console.log('🎯 Goal analysis completed - no update needed:', {
                userId,
                currentGoal: user.preferences.goal,
                timestamp: new Date().toISOString()
            });
        }
    } catch (error) {
        console.error('❌ Error analyzing goal:', {
            userId,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        });
    }
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

        const reminders = await getUserReminders(userId);
        const activeReminders = reminders.filter(r => r.isActive).map(r => ({
            id: r.id,
            schedule: r.humanText,
            text: r.reminderText
        }));

        const messageHistory = await getUserMessageHistory(userId);
        const recentMessages = messageHistory.slice(-10); // Last 10 messages for context

        const currentTime = new Date();
        const prompt = AI_CHAT_PROMPT(user.preferences.goal, activeReminders, recentMessages, currentTime);
        const fullPrompt = `${prompt}\n\nСообщение пользователя: "${userMessage}"`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: fullPrompt }
            ]
        });

        const aiResponse = response.choices[0].message?.content?.trim() || 'Ошибка генерации ответа';
        
        console.log('🤖 AI Response generated:', {
            userId,
            responseLength: aiResponse.length,
            containsCommands: aiResponse.includes('<set-reminder') || aiResponse.includes('<goal>') || aiResponse.includes('<update-reminder') || aiResponse.includes('<delete-reminder'),
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
        
        // Cleanup expired reminders after processing
        const removedReminders = await cleanupExpiredReminders(userId);
        if (removedReminders.length > 0) {
            console.log(`🧹 Cleaned up expired reminders:`, {
                userId,
                removedCount: removedReminders.length,
                removedReminders: removedReminders,
                timestamp: new Date().toISOString()
            });
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

// Check reminders every minute
cron.schedule('* * * * *', async () => {
    const now = new Date();
    const users = await getAllUsers();
    
    console.log('⏰ Checking reminders for all users:', {
        userCount: users.length,
        timestamp: now.toISOString()
    });
    
    for (const user of users) {
        if (!user.chatId) continue;
        
        for (const reminder of user.reminders) {
            if (ReminderService.shouldFireReminder(reminder, now)) {
                try {
                    console.log('🔔 Firing reminder:', {
                        userId: user.userId,
                        reminderId: reminder.id,
                        reminderText: reminder.reminderText,
                        cronExpression: reminder.cronExpression,
                        nextFireTime: reminder.nextFireTime,
                        timestamp: now.toISOString()
                    });

                    const aiResponse = await generateMessage(REMINDER_FIRE_PROMPT(reminder.reminderText));
                    
                    // Process AI response to remove any command tags and get clean message
                    const { message: cleanMessage } = await AICommandService.processAIResponse(user.userId, aiResponse);
                    
                    // Send clean message to user
                    await bot.sendMessage(user.chatId, cleanMessage);
                    
                    // Add reminder message to user's message history
                    await addMessageToHistory(user.userId, 'assistant', cleanMessage);
                    
                    console.log('📝 Reminder message added to history:', {
                        userId: user.userId,
                        reminderId: reminder.id,
                        messageLength: cleanMessage.length,
                        timestamp: now.toISOString()
                    });
                    
                    // Update next fire time for recurring reminders
                    const nextFireTime = ReminderService.updateNextFireTime(reminder);
                    if (nextFireTime) {
                        await updateReminderNextFireTime(user.userId, reminder.id, nextFireTime);
                        console.log('🔄 Updated recurring reminder next fire time:', {
                            userId: user.userId,
                            reminderId: reminder.id,
                            nextFireTime: nextFireTime.toISOString(),
                            timestamp: now.toISOString()
                        });
                    } else {
                        // One-time reminder fired, will be cleaned up next time
                        reminder.isActive = false;
                        console.log('⏹️ One-time reminder fired and deactivated:', {
                            userId: user.userId,
                            reminderId: reminder.id,
                            reminderText: reminder.reminderText,
                            timestamp: now.toISOString()
                        });
                    }
                } catch (error) {
                    console.error('❌ Error sending reminder:', {
                        userId: user.userId,
                        reminderId: reminder.id,
                        error: error instanceof Error ? error.message : String(error),
                        timestamp: now.toISOString()
                    });
                }
            }
        }
        
        // Cleanup expired reminders for this user
        await cleanupExpiredReminders(user.userId);
    }
});

// Analyze goals every 6 hours
cron.schedule('0 */6 * * *', async () => {
    console.log('🎯 Starting periodic goal analysis for all users:', {
        timestamp: new Date().toISOString()
    });

    const users = await getAllUsers();
    let analyzedCount = 0;
    
    for (const user of users) {
        if (user.preferences.goal) {
            await analyzeAndUpdateGoal(user.userId);
            analyzedCount++;
            // Add small delay between users to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    console.log('🎯 Periodic goal analysis completed:', {
        totalUsers: users.length,
        analyzedUsers: analyzedCount,
        timestamp: new Date().toISOString()
    });
});

// Legacy cron jobs (keeping for users with CHAT_ID set)
cron.schedule('0 10 * * *', async () => {
    if (CHAT_ID) {
        const aiResponse = await generateMessage(MORNING_PROMPT);
        const { message: cleanMessage } = await AICommandService.processAIResponse(parseInt(CHAT_ID), aiResponse);
        await bot.sendMessage(CHAT_ID, cleanMessage);
        
        // Add to message history if CHAT_ID is a valid user ID
        const chatIdAsNumber = parseInt(CHAT_ID);
        if (!isNaN(chatIdAsNumber)) {
            await addMessageToHistory(chatIdAsNumber, 'assistant', cleanMessage);
        }
    }
});

cron.schedule('0 13 * * *', async () => {
    if (CHAT_ID) {
        const aiResponse = await generateMessage(LUNCH_CHECKIN_PROMPT);
        const { message: cleanMessage } = await AICommandService.processAIResponse(parseInt(CHAT_ID), aiResponse);
        await bot.sendMessage(CHAT_ID, cleanMessage);
        
        // Add to message history if CHAT_ID is a valid user ID
        const chatIdAsNumber = parseInt(CHAT_ID);
        if (!isNaN(chatIdAsNumber)) {
            await addMessageToHistory(chatIdAsNumber, 'assistant', cleanMessage);
        }
    }
});

cron.schedule('0 17 * * *', async () => {
    if (CHAT_ID) {
        const aiResponse = await generateMessage(EVENING_SUMMARY_PROMPT);
        const { message: cleanMessage } = await AICommandService.processAIResponse(parseInt(CHAT_ID), aiResponse);
        await bot.sendMessage(CHAT_ID, cleanMessage);
        
        // Add to message history if CHAT_ID is a valid user ID
        const chatIdAsNumber = parseInt(CHAT_ID);
        if (!isNaN(chatIdAsNumber)) {
            await addMessageToHistory(chatIdAsNumber, 'assistant', cleanMessage);
        }
    }
});

// Handle commands
bot.onText(/\/remind (.+)/, async (msg, match) => {
    try {
        const userId = msg.from?.id;
        if (!userId || !match) return;

        const input = match[1];
        const parts = input.split(' - ');
        
        if (parts.length !== 2) {
            await bot.sendMessage(msg.chat.id, 'Формат: /remind <расписание> - <что напомнить>\nПример: /remind daily at 9am - выпить воды');
            return;
        }

        const [schedule, reminderText] = parts.map(s => s.trim());
        const reminder = ReminderService.parseReminderText(schedule, reminderText);
        
        if (!reminder) {
            const aiResponse = await generateMessage(REMINDER_FAILED_PROMPT(schedule));
            const { message: failMessage } = await AICommandService.processAIResponse(userId, aiResponse);
            await bot.sendMessage(msg.chat.id, failMessage);
            return;
        }

        // Ensure user exists and has chatId
        let user = await getUser(userId);
        if (!user) {
            user = {
                userId,
                chatId: msg.chat.id,
                preferences: { goal: '' },
                reminders: [],
                messageHistory: []
            };
            await setUser(user);
        } else if (!user.chatId) {
            user.chatId = msg.chat.id;
            if (!user.messageHistory) {
                user.messageHistory = [];
            }
            await setUser(user);
        }

        await addUserReminder(userId, reminder);
        const aiResponse = await generateMessage(REMINDER_SET_PROMPT(schedule, reminderText));
        const { message: successMessage } = await AICommandService.processAIResponse(userId, aiResponse);
        await bot.sendMessage(msg.chat.id, successMessage);

    } catch (error) {
        console.error('Error setting reminder:', error);
        const aiResponse = await generateMessage(ERROR_MESSAGE_PROMPT);
        const { message: errorMessage } = await AICommandService.processAIResponse(msg.from?.id || 0, aiResponse);
        await bot.sendMessage(msg.chat.id, errorMessage);
    }
});

bot.onText(/\/reminders/, async (msg) => {
    try {
        const userId = msg.from?.id;
        if (!userId) return;

        const reminders = await getUserReminders(userId);
        const activeReminders = reminders.filter(r => r.isActive);

        if (activeReminders.length === 0) {
            await bot.sendMessage(msg.chat.id, 'У тебя пока нет активных напоминаний 🐺\nИспользуй /remind чтобы создать или просто общайся со мной - я сам могу создавать напоминания!');
            return;
        }

        const reminderList = activeReminders.map(r => ({
            schedule: r.humanText,
            text: r.reminderText
        }));

        const aiResponse = await generateMessage(REMINDER_LIST_PROMPT(reminderList));
        const { message: listMessage } = await AICommandService.processAIResponse(userId, aiResponse);
        await bot.sendMessage(msg.chat.id, listMessage);

    } catch (error) {
        console.error('Error listing reminders:', error);
        const aiResponse = await generateMessage(ERROR_MESSAGE_PROMPT);
        const { message: errorMessage } = await AICommandService.processAIResponse(msg.from?.id || 0, aiResponse);
        await bot.sendMessage(msg.chat.id, errorMessage);
    }
});

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
                reminders: [],
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

        const aiResponse = await generateMessage(GOAL_UPDATE_PROMPT(newGoal));
        const { message: updateMessage } = await AICommandService.processAIResponse(userId, aiResponse);
        await bot.sendMessage(msg.chat.id, updateMessage);

    } catch (error) {
        console.error('Error updating goal:', error);
        const aiResponse = await generateMessage(ERROR_MESSAGE_PROMPT);
        const { message: errorMessage } = await AICommandService.processAIResponse(msg.from?.id || 0, aiResponse);
        await bot.sendMessage(msg.chat.id, errorMessage);
    }
});

bot.onText(/\/help/, async (msg) => {
    const helpText = `🐺 Команды бота:

/goal [новая цель] - показать или установить цель
/remind <расписание> - <текст> - создать напоминание
/reminders - показать активные напоминания
/help - эта справка

Примеры расписания:
• daily at 9am
• every Monday at 2pm  
• workdays at 10:30am
• every morning
• tomorrow at 3pm

Пример: /remind daily at 8am - выпить воды

💡 НОВОЕ: Просто общайся со мной - я сам могу создавать, изменять и удалять напоминания, а также обновлять твою цель на основе наших разговоров!`;

    await bot.sendMessage(msg.chat.id, helpText);
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
                reminders: [],
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
