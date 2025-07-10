import { 
    getUser, setUser,
    Routine, Task, AnnoyanceLevel,
    addUserRoutine, updateUserRoutine, removeUserRoutine,
    addUserTask, updateUserTask, removeUserTask,
    updateUserMemory,
    generateShortId
} from './userStore';

export interface AICommand {
    type:        
        | 'goal'
        | 'set-routine' | 'update-routine' | 'delete-routine'
        | 'set-task' | 'update-task' | 'task-complete' | 'task-fail' | 'task-postpone' | 'task-update'
        | 'update-memory';
    // Existing fields
    id?: string;
    cron?: string;
    timestamp?: string;
    text?: string;
    goal?: string;
    // NEW fields for routines/tasks
    annoyance?: 'low' | 'med' | 'high';
    requiresAction?: boolean;
    nextPingMinutes?: number; // for task-update
    key?: string; // for memory update
    value?: string; // for memory update
}

// Helper to parse attribute string like: key="value" key2="value2"
function parseAttributes(attrString: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const regex = /(\w+)="([^"]*)"/g;
    let m;
    while ((m = regex.exec(attrString)) !== null) {
        attrs[m[1]] = m[2];
    }
    return attrs;
}

export class AICommandService {
    /**
     * Parse AI commands from generated text
     */
    static parseCommands(text: string): { commands: AICommand[], cleanText: string } {
        const commands: AICommand[] = [];
        let match;

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

        // ---------------- NEW TAGS -------------------
        // <set-routine cron="..." annoyance="med" requiresAction="true">Name</set-routine>
        const setRoutineRegex = /<set-routine\s+([^>]*)>([^<]+)<\/set-routine>/g;
        while ((match = setRoutineRegex.exec(text)) !== null) {
            const attrs = parseAttributes(match[1]);
            const command: AICommand = {
                type: 'set-routine',
                cron: attrs.cron,
                annoyance: (attrs.annoyance as AnnoyanceLevel) || 'low',
                requiresAction: attrs.requiresAction ? attrs.requiresAction === 'true' : true,
                text: match[2].trim()
            };
            commands.push(command);
            console.log('🤖 AI Command detected - SET ROUTINE:', { ...command, timestamp: new Date().toISOString() });
        }

        // <update-routine id="..." cron="..." annoyance="high" requiresAction="false">New Name</update-routine>
        const updateRoutineRegex = /<update-routine\s+([^>]*)>([^<]*)<\/update-routine>/g;
        while ((match = updateRoutineRegex.exec(text)) !== null) {
            const attrs = parseAttributes(match[1]);
            const command: AICommand = {
                type: 'update-routine',
                id: attrs.id,
                cron: attrs.cron,
                annoyance: attrs.annoyance as AnnoyanceLevel,
                requiresAction: attrs.requiresAction ? attrs.requiresAction === 'true' : undefined,
                text: match[2]?.trim()
            };
            commands.push(command);
            console.log('🤖 AI Command detected - UPDATE ROUTINE:', { ...command, timestamp: new Date().toISOString() });
        }

        // <delete-routine id="uuid"/>
        const deleteRoutineRegex = /<delete-routine\s+id="([^"]+)"\s*\/>/g;
        while ((match = deleteRoutineRegex.exec(text)) !== null) {
            const command: AICommand = {
                type: 'delete-routine',
                id: match[1]
            };
            commands.push(command);
            console.log('🤖 AI Command detected - DELETE ROUTINE:', { id: command.id, timestamp: new Date().toISOString() });
        }

        // <set-task timestamp="..." annoyance="low" requiresAction="false">Name</set-task>
        const setTaskRegex = /<set-task\s+([^>]*)>([^<]+)<\/set-task>/g;
        while ((match = setTaskRegex.exec(text)) !== null) {
            const attrs = parseAttributes(match[1]);
            const command: AICommand = {
                type: 'set-task',
                timestamp: attrs.timestamp,
                annoyance: attrs.annoyance as AnnoyanceLevel,
                requiresAction: attrs.requiresAction ? attrs.requiresAction === 'true' : false,
                text: match[2].trim()
            };
            commands.push(command);
            console.log('🤖 AI Command detected - SET TASK:', { ...command, timestamp: new Date().toISOString() });
        }

        // <update-task id="uuid" annoyance="high" requiresAction="false"/>
        const updateTaskRegex = /<update-task\s+([^>]*)>([^<]*)<\/update-task>/g;
        while ((match = updateTaskRegex.exec(text)) !== null) {
            const attrs = parseAttributes(match[1]);
            const command: AICommand = {
                type: 'update-task',
                id: attrs.id,
                annoyance: attrs.annoyance as AnnoyanceLevel,
                requiresAction: attrs.requiresAction ? attrs.requiresAction === 'true' : undefined,
                text: match[2]?.trim()
            };
            commands.push(command);
            console.log('🤖 AI Command detected - UPDATE TASK:', { ...command, timestamp: new Date().toISOString() });
        }

        // <task-complete id="uuid"/>
        const taskCompleteRegex = /<task-complete\s+id="([^"]+)"\s*\/>/g;
        while ((match = taskCompleteRegex.exec(text)) !== null) {
            commands.push({ type: 'task-complete', id: match[1] });
        }

        // <task-fail id="uuid"/>
        const taskFailRegex = /<task-fail\s+id="([^"]+)"\s*\/>/g;
        while ((match = taskFailRegex.exec(text)) !== null) {
            commands.push({ type: 'task-fail', id: match[1] });
        }

        // <task-postpone id="uuid" timestamp="ISO"/>
        const taskPostponeRegex = /<task-postpone\s+id="([^"]+)"\s+timestamp="([^"]+)"\s*\/>/g;
        while ((match = taskPostponeRegex.exec(text)) !== null) {
            commands.push({ type: 'task-postpone', id: match[1], timestamp: match[2] });
        }

        // <task-update id="uuid" nextPingMinutes="30" annoyance="high"/>
        const taskUpdateRegex = /<task-update\s+([^>]*)\/>/g; // self-closing variant
        while ((match = taskUpdateRegex.exec(text)) !== null) {
            const attrs = parseAttributes(match[1]);
            const command: AICommand = {
                type: 'task-update',
                id: attrs.id,
                nextPingMinutes: attrs.nextPingMinutes ? parseInt(attrs.nextPingMinutes, 10) : undefined,
                annoyance: attrs.annoyance as AnnoyanceLevel
            };
            commands.push(command);
        }

        // <update-memory key="sleepSchedule" value="23:00-07:00"/>
        const updateMemoryRegex = /<update-memory\s+key="([^"]+)"\s+value="([^"]+)"\s*\/>/g;
        while ((match = updateMemoryRegex.exec(text)) !== null) {
            commands.push({ type: 'update-memory', key: match[1], value: match[2] });
        }

        // Extend cleanText removal for new tags (simple all-tags strip for safety)
        const cleanText = text.replace(/<[^>]+>/g, '').replace(/\n\s*\n/g, '\n').trim();

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
                    case 'set-routine': {
                        if (command.cron && command.text) {
                            const routine: Routine = {
                                id: generateShortId(),
                                name: command.text,
                                cron: command.cron,
                                defaultAnnoyance: command.annoyance || 'low',
                                requiresAction: command.requiresAction ?? true,
                                isActive: true,
                                stats: { completed: 0, failed: 0 },
                                createdAt: new Date()
                            };
                            await addUserRoutine(userId, routine);
                            results.push(`✅ Создана рутина: "${routine.name}" (${routine.cron})`);
                        }
                        break;
                    }
                    case 'update-routine': {
                        if (command.id) {
                            await updateUserRoutine(userId, command.id, (r) => {
                                if (command.cron) r.cron = command.cron;
                                if (command.annoyance) r.defaultAnnoyance = command.annoyance as AnnoyanceLevel;
                                if (command.requiresAction !== undefined) r.requiresAction = command.requiresAction;
                                if (command.text) r.name = command.text;
                            });
                            results.push(`✅ Обновлена рутина: ${command.text}`);
                        }
                        break;
                    }
                    case 'delete-routine': {
                        if (command.id) {
                            await removeUserRoutine(userId, command.id);
                            results.push(`✅ Удалена рутина: ${command.text}`);
                        }
                        break;
                    }
                    case 'set-task': {
                        if (command.timestamp && command.text) {
                            const due = new Date(command.timestamp);
                            const task: Task = {
                                id: generateShortId(),
                                name: command.text,
                                routineId: undefined,
                                firstTriggered: due,
                                due,
                                requiresAction: command.requiresAction ?? false,
                                status: (command.requiresAction ?? false) ? 'pending' : 'completed',
                                annoyance: command.annoyance || 'low',
                                nextPing: due,
                                postponeCount: 0,
                                createdAt: new Date()
                            };
                            await addUserTask(userId, task);
                            results.push(`✅ Создана задача: "${task.name}" (${due.toLocaleString('ru-RU')})`);
                        }
                        break;
                    }
                    case 'update-task': {
                        if (command.id) {
                            await updateUserTask(userId, command.id, (t) => {
                                if (command.annoyance) t.annoyance = command.annoyance;
                                if (command.requiresAction !== undefined) t.requiresAction = command.requiresAction;
                                if (command.text) t.name = command.text;
                            });
                            results.push(`✅ Обновлена задача: ${command.text}`);
                        }
                        break;
                    }
                    case 'task-complete': {
                        if (command.id) {
                            await updateUserTask(userId, command.id, (t) => {
                                t.status = 'completed';
                            });
                            results.push(`✅ Задача выполнена: ${command.text}`);
                        }
                        break;
                    }
                    case 'task-fail': {
                        if (command.id) {
                            await updateUserTask(userId, command.id, (t) => {
                                t.status = 'failed';
                            });
                            results.push(`⚠️ Задача провалена: ${command.text}`);
                        }
                        break;
                    }
                    case 'task-postpone': {
                        if (command.id && command.timestamp) {
                            const newDate = new Date(command.timestamp);
                            await updateUserTask(userId, command.id, (t) => {
                                t.due = newDate;
                                t.nextPing = newDate;
                                t.postponeCount += 1;
                            });
                            results.push(`🔄 Задача перенесена: ${command.text} → ${newDate.toLocaleString('ru-RU')}`);
                        }
                        break;
                    }
                    case 'task-update': {
                        if (command.id) {
                            await updateUserTask(userId, command.id, (t) => {
                                if (command.annoyance) t.annoyance = command.annoyance;
                                if (command.nextPingMinutes !== undefined) {
                                    const next = new Date(Date.now() + command.nextPingMinutes * 60000);
                                    t.nextPing = next;
                                }
                            });
                            results.push(`✅ Обновлены параметры задачи: ${command.text}`);
                        }
                        break;
                    }
                    case 'update-memory': {
                        if (command.key && command.value) {
                            await updateUserMemory(userId, command.key, command.value);
                            results.push(`💾 Обновлена память: ${command.key}`);
                        }
                        break;
                    }
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