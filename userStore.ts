import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

// Generate shorter IDs (8 characters)
function generateShortId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

export { generateShortId };

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

export type TaskStatus = 'pending' | 'completed' | 'failed';
export type Task = {
    id: string;
    name: string;
    routineId?: string;             // undefined => ad-hoc/non-routine task
    firstTriggered: Date;           // original due time, never changes
    due: Date;                      // current due time (can be postponed)
    requiresAction: boolean;
    status: TaskStatus;
    annoyance: AnnoyanceLevel;
    nextPing: Date;                 // scheduler will ping when <= now
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
    routines?: Routine[];
    tasks?: Task[];
    // Arbitrary key/value memory for AI
    memory?: Record<string, string>;
    messageHistory: MessageHistory[];
};

export type DBData = {
    users: UserData[];
};

const adapter = new JSONFile<DBData>('db.json');
const db = new Low(adapter, { users: [] });

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
            if (typeof task.firstTriggered === 'string') {
                task.firstTriggered = new Date(task.firstTriggered);
            }
            if (typeof task.due === 'string') {
                task.due = new Date(task.due);
            }
            if (typeof task.nextPing === 'string') {
                task.nextPing = new Date(task.nextPing);
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
        
        // Keep only the last 50 messages
        if (user.messageHistory.length > 50) {
            user.messageHistory = user.messageHistory.slice(-50);
        }
        
        await setUser(user);
    }
}

export async function getUserMessageHistory(userId: number): Promise<MessageHistory[]> {
    const user = await getUser(userId);
    return user?.messageHistory || [];
}

// HELPER: ensure user has arrays initialised (for legacy data)
function ensureUserCollections(user: UserData): void {
    if (!user.routines) user.routines = [];
    if (!user.tasks) user.tasks = [];
    if (!user.memory) user.memory = {};
}

// NEW ROUTINE HELPERS -------------------------------------------------------
export async function getUserRoutines(userId: number): Promise<Routine[]> {
    const user = await getUser(userId);
    if (user) {
        ensureUserCollections(user);
        return user.routines!;
    }
    return [];
}

export async function addUserRoutine(userId: number, routine: Routine): Promise<void> {
    const user = await getUser(userId);
    if (user) {
        ensureUserCollections(user);
        user.routines!.push(routine);
        await setUser(user);
    }
}

export async function updateUserRoutine(userId: number, routineId: string, updateFn: (r: Routine) => void): Promise<void> {
    const user = await getUser(userId);
    if (user) {
        ensureUserCollections(user);
        const r = user.routines!.find(rt => rt.id === routineId);
        if (r) {
            updateFn(r);
            await setUser(user);
        }
    }
}

export async function removeUserRoutine(userId: number, routineId: string): Promise<void> {
    const user = await getUser(userId);
    if (user) {
        ensureUserCollections(user);
        user.routines = user.routines!.filter(r => r.id !== routineId);
        await setUser(user);
    }
}

// NEW TASK HELPERS ----------------------------------------------------------
export async function getUserTasks(userId: number): Promise<Task[]> {
    const user = await getUser(userId);
    if (user) {
        ensureUserCollections(user);
        return user.tasks!;
    }
    return [];
}

export async function addUserTask(userId: number, task: Task): Promise<void> {
    const user = await getUser(userId);
    if (user) {
        ensureUserCollections(user);
        user.tasks!.push(task);
        await setUser(user);
    }
}

export async function updateUserTask(userId: number, taskId: string, updateFn: (t: Task) => void): Promise<void> {
    const user = await getUser(userId);
    if (user) {
        ensureUserCollections(user);
        const t = user.tasks!.find(tt => tt.id === taskId);
        if (t) {
            updateFn(t);
            await setUser(user);
        }
    }
}

export async function removeUserTask(userId: number, taskId: string): Promise<void> {
    const user = await getUser(userId);
    if (user) {
        ensureUserCollections(user);
        user.tasks = user.tasks!.filter(t => t.id !== taskId);
        await setUser(user);
    }
}

// MEMORY HELPERS ------------------------------------------------------------
export async function updateUserMemory(userId: number, key: string, value: string): Promise<void> {
    const user = await getUser(userId);
    if (user) {
        ensureUserCollections(user);
        user.memory![key] = value;
        await setUser(user);
    }
}