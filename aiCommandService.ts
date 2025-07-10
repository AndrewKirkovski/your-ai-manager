import { ReminderService } from './reminderService';
import { addUserReminder, removeUserReminder, getUser, setUser } from './userStore';

export interface AICommand {
    type: 'set-reminder' | 'set-onetime-reminder' | 'update-reminder' | 'delete-reminder' | 'goal';
    id?: string;
    cron?: string;
    timestamp?: string; // ISO timestamp for one-time reminders
    text?: string;
    goal?: string;
}

export class AICommandService {
    /**
     * Parse AI commands from generated text
     */
    static parseCommands(text: string): { commands: AICommand[], cleanText: string } {
        const commands: AICommand[] = [];
        
        // Set one-time reminder: <set-onetime-reminder timestamp="2025-07-09T14:25:00.000Z">текст</set-onetime-reminder>
        const setOnetimeReminderRegex = /<set-onetime-reminder\s+timestamp="([^"]+)">([^<]+)<\/set-onetime-reminder>/g;
        let match;
        while ((match = setOnetimeReminderRegex.exec(text)) !== null) {
            const command = {
                type: 'set-onetime-reminder' as const,
                timestamp: match[1],
                text: match[2].trim()
            };
            commands.push(command);
            console.log('🤖 AI Command detected - SET ONE-TIME REMINDER:', {
                timestampValue: command.timestamp,
                text: command.text,
                loggedAt: new Date().toISOString()
            });
        }
        
        // Set recurring reminder: <set-reminder cron="0 8 * * *">текст</set-reminder>
        const setReminderRegex = /<set-reminder\s+cron="([^"]+)">([^<]+)<\/set-reminder>/g;
        while ((match = setReminderRegex.exec(text)) !== null) {
            const command = {
                type: 'set-reminder' as const,
                cron: match[1],
                text: match[2].trim()
            };
            commands.push(command);
            console.log('🤖 AI Command detected - SET RECURRING REMINDER:', {
                cron: command.cron,
                text: command.text,
                timestamp: new Date().toISOString()
            });
        }

        // Update reminder: <update-reminder id="uuid" cron="0 9 * * *">новый текст</update-reminder>
        const updateReminderRegex = /<update-reminder\s+id="([^"]+)"\s+cron="([^"]+)">([^<]+)<\/update-reminder>/g;
        while ((match = updateReminderRegex.exec(text)) !== null) {
            const command = {
                type: 'update-reminder' as const,
                id: match[1],
                cron: match[2],
                text: match[3].trim()
            };
            commands.push(command);
            console.log('🤖 AI Command detected - UPDATE REMINDER:', {
                id: command.id,
                cron: command.cron,
                text: command.text,
                timestamp: new Date().toISOString()
            });
        }

        // Delete reminder: <delete-reminder id="uuid"></delete-reminder>
        const deleteReminderRegex = /<delete-reminder\s+id="([^"]+)"><\/delete-reminder>/g;
        while ((match = deleteReminderRegex.exec(text)) !== null) {
            const command = {
                type: 'delete-reminder' as const,
                id: match[1]
            };
            commands.push(command);
            console.log('🤖 AI Command detected - DELETE REMINDER:', {
                id: command.id,
                timestamp: new Date().toISOString()
            });
        }

        // Goal: <goal>новая цель</goal>
        const goalRegex = /<goal>([^<]+)<\/goal>/g;
        while ((match = goalRegex.exec(text)) !== null) {
            const command = {
                type: 'goal' as const,
                goal: match[1].trim()
            };
            commands.push(command);
            console.log('🤖 AI Command detected - SET GOAL:', {
                goal: command.goal,
                timestamp: new Date().toISOString()
            });
        }

        // Clean text by removing all command tags
        const cleanText = text
            .replace(setOnetimeReminderRegex, '')
            .replace(setReminderRegex, '')
            .replace(updateReminderRegex, '')
            .replace(deleteReminderRegex, '')
            .replace(goalRegex, '')
            .replace(/\n\s*\n/g, '\n') // Remove empty lines
            .trim();

        if (commands.length > 0) {
            console.log(`🤖 Total AI commands parsed: ${commands.length}`);
        }

        return { commands, cleanText };
    }

    /**
     * Execute AI commands for a user
     */
    static async executeCommands(userId: number, commands: AICommand[]): Promise<string[]> {
        const results: string[] = [];

        if (commands.length > 0) {
            console.log(`🚀 Executing ${commands.length} AI commands for user ${userId}`);
        }

        for (const command of commands) {
            try {
                switch (command.type) {
                    case 'set-reminder':
                        if (command.cron && command.text) {
                            const reminder = ReminderService.createReminderFromCron(command.cron, command.text);
                            if (reminder) {
                                await addUserReminder(userId, reminder);
                                const successMsg = `✅ Создано напоминание: "${command.text}" (${command.cron})`;
                                results.push(successMsg);
                                console.log('✅ SET REMINDER executed:', {
                                    userId,
                                    reminderId: reminder.id,
                                    cron: command.cron,
                                    text: command.text,
                                    nextFireTime: reminder.nextFireTime,
                                    timestamp: new Date().toISOString()
                                });
                            } else {
                                const errorMsg = `❌ Не удалось создать напоминание с cron: "${command.cron}"`;
                                results.push(errorMsg);
                                console.error('❌ SET REMINDER failed:', {
                                    userId,
                                    cron: command.cron,
                                    text: command.text,
                                    error: 'Invalid cron expression',
                                    timestamp: new Date().toISOString()
                                });
                            }
                        }
                        break;

                    case 'set-onetime-reminder':
                        if (command.timestamp && command.text) {
                            const reminder = ReminderService.createReminderFromTimestamp(command.timestamp, command.text);
                            if (reminder) {
                                await addUserReminder(userId, reminder);
                                const successMsg = `✅ Создано одноразовое напоминание: "${command.text}" (${command.timestamp})`;
                                results.push(successMsg);
                                console.log('✅ SET ONE-TIME REMINDER executed:', {
                                    userId,
                                    reminderId: reminder.id,
                                    timestampValue: command.timestamp,
                                    text: command.text,
                                    nextFireTime: reminder.nextFireTime,
                                    loggedAt: new Date().toISOString()
                                });
                            } else {
                                const errorMsg = `❌ Не удалось создать одноразовое напоминание с timestamp: "${command.timestamp}"`;
                                results.push(errorMsg);
                                console.error('❌ SET ONE-TIME REMINDER failed:', {
                                    userId,
                                    timestampValue: command.timestamp,
                                    text: command.text,
                                    error: 'Invalid timestamp',
                                    loggedAt: new Date().toISOString()
                                });
                            }
                        }
                        break;

                    case 'update-reminder':
                        if (command.id && command.cron && command.text) {
                            const user = await getUser(userId);
                            if (user) {
                                const existingReminder = user.reminders.find(r => r.id === command.id);
                                if (existingReminder) {
                                    const newReminder = ReminderService.createReminderFromCron(command.cron, command.text);
                                    if (newReminder) {
                                        // Keep the original ID and creation date
                                        newReminder.id = command.id;
                                        newReminder.createdAt = existingReminder.createdAt;
                                        
                                        // Remove old and add updated
                                        user.reminders = user.reminders.filter(r => r.id !== command.id);
                                        user.reminders.push(newReminder);
                                        await setUser(user);
                                        
                                        const successMsg = `✅ Обновлено напоминание: "${command.text}" (${command.cron})`;
                                        results.push(successMsg);
                                        console.log('✅ UPDATE REMINDER executed:', {
                                            userId,
                                            reminderId: command.id,
                                            oldText: existingReminder.reminderText,
                                            newText: command.text,
                                            oldCron: existingReminder.cronExpression,
                                            newCron: command.cron,
                                            timestamp: new Date().toISOString()
                                        });
                                    } else {
                                        const errorMsg = `❌ Не удалось обновить напоминание с cron: "${command.cron}"`;
                                        results.push(errorMsg);
                                        console.error('❌ UPDATE REMINDER failed:', {
                                            userId,
                                            reminderId: command.id,
                                            cron: command.cron,
                                            error: 'Invalid cron expression',
                                            timestamp: new Date().toISOString()
                                        });
                                    }
                                } else {
                                    const errorMsg = `❌ Напоминание с ID ${command.id} не найдено`;
                                    results.push(errorMsg);
                                    console.error('❌ UPDATE REMINDER failed:', {
                                        userId,
                                        reminderId: command.id,
                                        error: 'Reminder not found',
                                        timestamp: new Date().toISOString()
                                    });
                                }
                            }
                        }
                        break;

                    case 'delete-reminder':
                        if (command.id) {
                            const user = await getUser(userId);
                            if (user) {
                                const reminderToDelete = user.reminders.find(r => r.id === command.id);
                                if (reminderToDelete) {
                                    await removeUserReminder(userId, command.id);
                                    const successMsg = `✅ Удалено напоминание: "${reminderToDelete.reminderText}"`;
                                    results.push(successMsg);
                                    console.log('✅ DELETE REMINDER executed:', {
                                        userId,
                                        reminderId: command.id,
                                        deletedText: reminderToDelete.reminderText,
                                        timestamp: new Date().toISOString()
                                    });
                                } else {
                                    const errorMsg = `❌ Напоминание с ID ${command.id} не найдено`;
                                    results.push(errorMsg);
                                    console.error('❌ DELETE REMINDER failed:', {
                                        userId,
                                        reminderId: command.id,
                                        error: 'Reminder not found',
                                        timestamp: new Date().toISOString()
                                    });
                                }
                            }
                        }
                        break;

                    case 'goal':
                        if (command.goal) {
                            const user = await getUser(userId);
                            if (user) {
                                const oldGoal = user.preferences.goal;
                                user.preferences.goal = command.goal;
                                await setUser(user);
                                const successMsg = `✅ Цель обновлена: "${command.goal}"`;
                                results.push(successMsg);
                                console.log('✅ SET GOAL executed:', {
                                    userId,
                                    oldGoal,
                                    newGoal: command.goal,
                                    timestamp: new Date().toISOString()
                                });
                            }
                        }
                        break;
                }
            } catch (error) {
                console.error(`❌ Error executing AI command:`, {
                    userId,
                    command,
                    error: error instanceof Error ? error.message : String(error),
                    timestamp: new Date().toISOString()
                });
                results.push(`❌ Ошибка выполнения команды ${command.type}`);
            }
        }

        return results;
    }

    /**
     * Process AI response: parse commands, execute them, and return clean text
     */
    static async processAIResponse(userId: number, aiResponse: string): Promise<{ message: string, commandResults: string[] }> {
        const { commands, cleanText } = this.parseCommands(aiResponse);
        const commandResults = await this.executeCommands(userId, commands);
        
        return {
            message: cleanText,
            commandResults
        };
    }
} 