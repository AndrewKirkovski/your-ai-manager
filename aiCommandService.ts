import {
    getUser, setUser,
    Routine, Task,
    addUserRoutine, updateUserRoutine, removeUserRoutine,
    addUserTask, updateUserTask,
    updateUserMemory,
    generateShortId, getTask, getRoutine
} from './userStore';
import { formatDateHuman, formatCronHuman } from './dateUtils';

function cleanAIResponse(text: string): string {
    // First remove AI command tags
    let cleaned = text.replace(/<(?:set-routine|update-routine|delete-routine|set-task|update-task|task-complete|task-fail|update-memory|goal)[^>]*>.*?<\/(?:set-routine|update-routine|delete-routine|set-task|update-task|task-complete|task-fail|update-memory|goal)>/gs, '');

    // Remove self-closing tags
    cleaned = cleaned.replace(/<(?:set-routine|update-routine|delete-routine|set-task|update-task|task-complete|task-fail|update-memory)[^>]*\/>/g, '');

    return cleaned;
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

const createRoutine = async (userId: number, routine: Partial<Routine>): Promise<string> => {
    if (!routine.cron) {
        throw new Error('Cron schedule is required to create a routine');
    }
    if (!routine.name) {
        throw new Error('Routine name is required');
    }
    const newRoutine: Routine = {
        id: generateShortId(),
        defaultAnnoyance: routine.defaultAnnoyance || 'low',
        requiresAction: routine.requiresAction ?? true,
        isActive: true,
        stats: {completed: 0, failed: 0},
        createdAt: new Date(),
        ...routine,
    } as Routine;
    await addUserRoutine(userId, newRoutine);
    return `✅ Создана рутина: "${newRoutine.name}" (${formatCronHuman(newRoutine.cron)})`;
}

const updateRoutine = async (userId: number, routine: Partial<Routine>): Promise<string> => {
    if (!routine.id) {
        throw new Error('Routine ID is required to update a routine');
    }
    await updateUserRoutine(userId, routine.id, (r) => {
        Object.assign(r, {
            ...routine,
            requiresAction: routine.requiresAction ?? r.requiresAction,
        });
    });
    const updated = await getRoutine(userId, routine.id);
    return `✅ Обновлена рутина: "${updated!.name}" (${formatCronHuman(updated!.cron)})`;
}

const createTask = async (userId: number, task: Partial<Task>): Promise<string> => {
    if (!task.pingAt) {
        throw new Error('Next ping time is required to create a task');
    }
    if (!task.name) {
        throw new Error('Task name is required');
    }
    const newTask: Task = {
        id: generateShortId(),
        status: 'pending',
        ...task,
    } as Task;
    await addUserTask(userId, newTask);
    return `✅ Запланировано: "${newTask.name}" (${formatDateHuman(newTask.pingAt)})`;
}

const updateTask = async (userId: number, task: Partial<Task>): Promise<string> => {
    if (!task.id) {
        throw new Error('Task ID is required to update a task');
    }
    await updateUserTask(userId, task.id, (r) => {
        Object.assign(r, {
            postponeCount: task.dueAt ? (r.postponeCount + 1) : r.postponeCount, // Reset postpone count if no dueAt
            status: 'pending', // Reset status to pending on update
            ...task,
            requiresAction: task.requiresAction ?? r.requiresAction,

        });
    });
    const updated = await getTask(userId, task.id);
    return `✅ Обновлена тасочка: "${updated!.name}" (${formatDateHuman(updated!.pingAt)})`;
}

const updateGoal = async (userId: number, goal: string): Promise<string> => {
    const user = await getUser(userId);
    if (!user) {
        throw new Error(`User with ID ${userId} not found`);
    }
    const oldGoal = user.preferences.goal;
    user.preferences.goal = goal;
    await setUser(user);
    return `✅ Цель: "${goal}" (была: "${oldGoal}")`;
}

export class AICommandService {
    /**
     * Parse AI commands from generated text
     */
    static generateCommands(userId: number, text: string): {
        commands: Array<() => Promise<string>>,
        cleanText: string
    } {
        const commands: Array<() => Promise<string>> = [];
        let match;

        // Goal: <goal>новая цель</goal>
        const goalRegex = /<goal>([^<]+)<\/goal>/g;
        while ((match = goalRegex.exec(text)) !== null) {
            const goal = match[1].trim();
            commands.push(() => updateGoal(userId, goal));
            console.log('🤖 AI SET GOAL:', goal, new Date().toISOString());
        }

        // ---------------- NEW TAGS -------------------
        // <set-routine cron="..." annoyance="med" requiresAction="true">Name</set-routine>
        const setRoutineRegex = /<set-routine\s+([^>]*)>([^<]+)<\/set-routine>/g;
        while ((match = setRoutineRegex.exec(text)) !== null) {
            const attrs = parseAttributes(match[1]);
            const routine: Partial<Routine> = {
                ...attrs,
                requiresAction: attrs.requiresAction ? attrs.requiresAction !== 'false' : undefined,
                name: match[2]
            };
            commands.push(() => createRoutine(userId, routine));
            console.log('🤖 SET ROUTINE:', routine, attrs, new Date().toISOString());
        }

        // <update-routine id="..." cron="..." annoyance="high" requiresAction="false">New Name</update-routine>
        const updateRoutineRegex = /<update-routine\s+([^>]*)>([^<]*)<\/update-routine>/g;
        while ((match = updateRoutineRegex.exec(text)) !== null) {
            const attrs = parseAttributes(match[1]);
            const routine: Partial<Routine> = {
                ...attrs,
                requiresAction: attrs.requiresAction ? attrs.requiresAction !== 'false' : undefined,
                name: match[2]
            };
            commands.push(() => updateRoutine(userId, routine));
            console.log('🤖 UPDATE ROUTINE:', routine, attrs, new Date().toISOString());
        }

        // <delete-routine id="uuid"/>
        const deleteRoutineRegex = /<delete-routine\s+id="([^"]+)"\s*\/>/g;
        while ((match = deleteRoutineRegex.exec(text)) !== null) {
            const id = match[1];
            commands.push(async () => {
                await removeUserRoutine(userId, id)
                return `✅ Удалена рутина: ${id}`;
            });
            console.log('🤖 AI DELETE ROUTINE:', id, new Date().toISOString());
        }

        // <set-task timestamp="..." annoyance="low" requiresAction="false">Name</set-task>
        const setTaskRegex = /<set-task\s+([^>]*)>([^<]+)<\/set-task>/g;
        while ((match = setTaskRegex.exec(text)) !== null) {
            const attrs = parseAttributes(match[1]);
            const task: Partial<Task> = {
                ...attrs,
                requiresAction: attrs.requiresAction ? attrs.requiresAction !== 'false' : undefined,
                name: match[2]
            };
            commands.push(() => createTask(userId, task));
            console.log('🤖 NEW TASK:', task, attrs, new Date().toISOString());
        }

        // <update-task id="uuid" annoyance="high" requiresAction="false"/>
        const updateTaskRegex = /<update-task\s+([^>]*)>([^<]*)<\/update-task>/g;
        while ((match = updateTaskRegex.exec(text)) !== null) {
            const attrs = parseAttributes(match[1]);
            const task: Partial<Task> = {
                ...attrs,
                requiresAction: attrs.requiresAction ? attrs.requiresAction !== 'false' : undefined,
                name: match[2]
            };
            commands.push(() => updateTask(userId, task));
            console.log('🤖 UPDATE TASK:', task, attrs, new Date().toISOString());
        }

        // <task-complete id="uuid"/>
        const taskCompleteRegex = /<task-complete\s+id="([^"]+)"\s*\/>/g;
        while ((match = taskCompleteRegex.exec(text)) !== null) {
            const taskId = match[1];
            commands.push(async () => {
                const task = await getTask(userId, taskId);
                if (!task) {
                    return `❌ Задачи нету: ${taskId}`;
                }
                await updateUserTask(userId, taskId, (t) => {
                    t.status = 'completed';
                });
                if (task.routineId) {
                    await updateUserRoutine(userId, task.routineId, (r) => {
                        r.stats.completed += 1;
                    });
                }
                return `✅ Сделано: ${task.name}`;
            });
            console.log('🤖 TASK COMPLETE:', {id: match[1], timestamp: new Date().toISOString()});
        }

        // <task-fail id="uuid"/>
        const taskFailRegex = /<task-fail\s+id="([^"]+)"\s*\/>/g;
        while ((match = taskFailRegex.exec(text)) !== null) {
            const taskId = match[1];
            commands.push(async () => {
                const task = await getTask(userId, taskId);
                if (!task) {
                    return `❌ Задачи нету: ${taskId}`;
                }
                await updateUserTask(userId, taskId, (t) => {
                    t.status = 'failed';
                });
                if (task.routineId) {
                    await updateUserRoutine(userId, task.routineId, (r) => {
                        r.stats.failed += 1;
                    });
                }
                return `⚠️ Не сделано: ${task.name}`;
            });
            console.log('🤖 TASK FAIL:', {id: match[1], timestamp: new Date().toISOString()});
        }

        // <update-memory key="sleepSchedule" value="23:00-07:00"/>
        const updateMemoryRegex = /<update-memory\s+key="([^"]+)"\s+value="([^"]+)"\s*\/>/g;
        while ((match = updateMemoryRegex.exec(text)) !== null) {
            const key = match[1];
            const value = match[2];
            commands.push(async () => {
                await updateUserMemory(userId, key, value);
                return `💾 Память: ${key} обновлена`;
            });
        }

        // Extend cleanText removal for new tags (simple all-tags strip for safety)
        const cleanText = cleanAIResponse(text);

        if (commands.length > 0) {
            console.log(`🤖 Total AI commands parsed: ${commands.length}`);
        }

        return {commands, cleanText};
    }

    /**
     * Execute AI commands for a user
     */
    static async executeCommands(userId: number, commands: Array<() => Promise<string>>): Promise<string[]> {

        if (commands.length > 0) {
            console.log(`🚀 Executing ${commands.length} AI commands for user ${userId}`);
        }

        return await Promise.all(commands.map(async (cmd) => cmd()))
    }

    /**
     * Process AI response: parse commands, execute them, and return clean text
     */
    static async processAIResponse(userId: number, aiResponse: string): Promise<{
        message: string,
        commandResults: string[]
    }> {
        const {commands, cleanText} = this.generateCommands(userId, aiResponse);
        const commandResults = await this.executeCommands(userId, commands);

        return {
            message: cleanText,
            commandResults
        };
    }
} 