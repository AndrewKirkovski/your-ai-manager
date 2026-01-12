import {Low} from 'lowdb';
import {JSONFile} from 'lowdb/node';

// Generate shorter IDs (8 characters)
function generateShortId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

export {generateShortId};

export type MessageHistory = {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
};

export type AnnoyanceLevel = 'low' | 'med' | 'high';

export type Routine = {
    id: string;
    name: string;
    cron: string;                   // cron schedule, always recurring
    defaultAnnoyance: AnnoyanceLevel;
    requiresAction: boolean;        // if false – generated tasks auto-complete
    isActive: boolean;
    stats: { completed: number; failed: number };
    createdAt: Date;
};

export type TaskStatus = 'pending' | 'completed' | 'failed' | 'needs_replanning';
export type Task = {
    id: string;
    name: string;
    // undefined => ad-hoc/non-routine task
    routineId?: string;
    // if not set, task can be postponed indefinitely
    dueAt?: Date;
    requiresAction: boolean;
    status: TaskStatus;
    annoyance: AnnoyanceLevel;
    pingAt: Date;                 // scheduler will ping when <= now
    postponeCount: number;
    createdAt: Date;
};

export type UserData = {
    userId: number;
    chatId?: number; // store user's chat ID for direct messaging
    preferences: {
        goal: string;
        timezone?: string; // user's timezone, default to UTC
    };
    // NEW collections
    routines: Routine[];
    tasks: Task[];
    // Arbitrary key/value memory for AI
    memory: Record<string, string>;
    messageHistory: MessageHistory[];
};

export type DBData = {
    users: UserData[];
};

// Use DB_PATH env var for Docker volume persistence, fallback to local db.json
const dbPath = process.env.DB_PATH || 'db.json';
const adapter = new JSONFile<DBData>(dbPath);
const db = new Low(adapter, {users: []});

// Initialize database
async function initDB() {
    await db.read();
}

// Initialize immediately 
initDB().catch(console.error);

export async function getUser(userId: number): Promise<UserData | undefined> {
    const user = db.data?.users.find(u => u.userId === userId);
    if (user) {
        // Convert string dates back to Date objects
        parseDatesInUser(user);
    }
    return user;
}

export async function setUser(user: UserData): Promise<void> {
    const index = db.data?.users.findIndex(u => u.userId === user.userId);
    if (index !== undefined && index >= 0) {
        db.data!.users[index] = user;
    } else {
        db.data!.users.push(user);
    }
    await db.write();
}

export async function getAllUsers(): Promise<UserData[]> {
    const users = db.data?.users || [];
    // Convert string dates back to Date objects for all users
    users.forEach(user => parseDatesInUser(user));
    return users;
}

// Helper function to parse dates in user data
function parseDatesInUser(user: UserData): void {
    // Parse message history dates
    if (user.messageHistory) {
        user.messageHistory.forEach(msg => {
            if (typeof msg.timestamp === 'string') {
                msg.timestamp = new Date(msg.timestamp);
            }
        });
    }

    // Parse routine dates
    if (user.routines) {
        user.routines.forEach(routine => {
            if (typeof routine.createdAt === 'string') {
                routine.createdAt = new Date(routine.createdAt);
            }
        });
    }

    // Parse task dates
    if (user.tasks) {
        user.tasks.forEach(task => {
            if (typeof task.dueAt === 'string') {
                task.dueAt = new Date(task.dueAt);
            }
            if (typeof task.pingAt === 'string') {
                task.pingAt = new Date(task.pingAt);
            }
            if (typeof task.createdAt === 'string') {
                task.createdAt = new Date(task.createdAt);
            }
        });
    }
}

export async function addMessageToHistory(userId: number, role: 'user' | 'assistant', content: string): Promise<void> {
    const user = await getUser(userId);
    if (user) {
        if (!user.messageHistory) {
            user.messageHistory = [];
        }

        user.messageHistory.push({
            role,
            content,
            timestamp: new Date()
        });

        // Keep only the last 5000 messages
        if (user.messageHistory.length > 5000) {
            user.messageHistory = user.messageHistory.slice(-5000);
        }

        await setUser(user);
    }
}

export async function getUserMessageHistory(userId: number): Promise<MessageHistory[]> {
    const user = await getUser(userId);
    return user?.messageHistory || [];
}

// NEW ROUTINE HELPERS -------------------------------------------------------
export const getAllRoutines = async (userId: number): Promise<Routine[]> => (await getUser(userId))?.routines ?? [];
export const getAllTasks = async (userId: number): Promise<Task[]> => (await getUser(userId))?.tasks ?? [];

export const getRoutine = async (userId: number, routineId: string): Promise<Routine | undefined> => (await getAllRoutines(userId)).find(r => r.id === routineId);

export const getTask = async (userId: number, taskId: string): Promise<Task | undefined> => (await getAllTasks(userId)).find(t => t.id === taskId);

export async function addUserRoutine(userId: number, routine: Routine): Promise<void> {
    const user = await getUser(userId);
    if (user) {
        user.routines.push(routine);
        await setUser(user);
    }
}

export async function updateUserRoutine(userId: number, routineId: string, updateFn: (r: Routine) => void): Promise<void> {
    const user = await getUser(userId);
    if (!user) return;

    const r = user.routines.find(rt => rt.id === routineId);
    if (r) {
        updateFn(r);
        await setUser(user);
    }
}

export async function removeUserRoutine(userId: number, routineId: string): Promise<void> {

    const user = await getUser(userId);
    if (!user) return;

    user.routines = user.routines.filter(r => r.id !== routineId);
    await setUser(user);

}

export async function addUserTask(userId: number, task: Task): Promise<void> {
    const user = await getUser(userId);
    if (!user) return;

    user.tasks.push(task);
    await setUser(user);

}

export async function updateUserTask(userId: number, taskId: string, updateFn: (t: Task) => void): Promise<void> {
    const user = await getUser(userId);
    if (!user) return;

    const t = user.tasks.find(tt => tt.id === taskId);
    if (t) {
        updateFn(t);
        await setUser(user);
    }
}

export async function removeUserTask(userId: number, taskId: string): Promise<void> {
    const user = await getUser(userId);
    if(!user) return;

    user.tasks = user.tasks.filter(t => t.id !== taskId);
    await setUser(user);
}

// MEMORY HELPERS ------------------------------------------------------------
export async function updateUserMemory(userId: number, key: string, value: string): Promise<void> {
    const user = await getUser(userId);
    if(!user) return;

    user.memory[key] = value;
    await setUser(user);
}

export async function getUserMemory(userId: number, key: string): Promise<string | undefined> {
    const user = await getUser(userId);
    return user?.memory[key];
}

export async function getAllUserMemory(userId: number): Promise<Record<string, string>> {
    const user = await getUser(userId);
    return user?.memory ?? {};
}

export async function deleteUserMemory(userId: number, key: string): Promise<boolean> {
    const user = await getUser(userId);
    if (!user || !(key in user.memory)) return false;

    delete user.memory[key];
    await setUser(user);
    return true;
}

// GOAL HELPERS --------------------------------------------------------------
export async function setUserGoal(userId: number, goal: string): Promise<void> {
    const user = await getUser(userId);
    if (!user) return;

    user.preferences.goal = goal;
    await setUser(user);
}

export async function getUserGoal(userId: number): Promise<string> {
    const user = await getUser(userId);
    return user?.preferences.goal ?? '';
}

export async function clearUserGoal(userId: number): Promise<void> {
    const user = await getUser(userId);
    if (!user) return;

    user.preferences.goal = '';
    await setUser(user);
}