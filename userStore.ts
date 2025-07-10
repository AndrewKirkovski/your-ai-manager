import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

export type ReminderSchedule = {
    id: string;
    humanText: string; // "every Monday at 9am", "daily at 2pm"
    cronExpression?: string; // "0 9 * * 1" for every Monday at 9am
    nextFireTime?: Date; // calculated next execution time
    isActive: boolean;
    reminderText: string; // what to remind about
    createdAt: Date;
};

export type MessageHistory = {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
};

export type UserData = {
    userId: number;
    chatId?: number; // store user's chat ID for direct messaging
    preferences: {
        goal: string;
        timezone?: string; // user's timezone, default to UTC
    };
    reminders: ReminderSchedule[];
    messageHistory: MessageHistory[];
};

export type DBData = {
    users: UserData[];
};

const adapter = new JSONFile<DBData>('db.json');
const db = new Low(adapter, { users: [] });
await db.read();

export async function getUser(userId: number): Promise<UserData | undefined> {
    const user = db.data?.users.find(u => u.userId === userId);
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
    return db.data?.users || [];
}

export async function getUserReminders(userId: number): Promise<ReminderSchedule[]> {
    const user = await getUser(userId);
    return user?.reminders || [];
}

export async function addUserReminder(userId: number, reminder: ReminderSchedule): Promise<void> {
    const user = await getUser(userId);
    if (user) {
        user.reminders.push(reminder);
        await setUser(user);
    }
}

export async function removeUserReminder(userId: number, reminderId: string): Promise<void> {
    const user = await getUser(userId);
    if (user) {
        user.reminders = user.reminders.filter(r => r.id !== reminderId);
        await setUser(user);
    }
}

export async function updateReminderNextFireTime(userId: number, reminderId: string, nextFireTime: Date): Promise<void> {
    const user = await getUser(userId);
    if (user) {
        const reminder = user.reminders.find(r => r.id === reminderId);
        if (reminder) {
            reminder.nextFireTime = nextFireTime;
            await setUser(user);
        }
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

export async function cleanupExpiredReminders(userId: number): Promise<string[]> {
    const user = await getUser(userId);
    if (!user) return [];
    
    const removedReminders: string[] = [];
    const activeReminders: ReminderSchedule[] = [];
    
    for (const reminder of user.reminders) {
        // Check if reminder is one-time and has already fired
        if (!reminder.cronExpression && reminder.nextFireTime && reminder.nextFireTime <= new Date()) {
            // One-time reminder that has fired - mark for removal
            removedReminders.push(reminder.reminderText);
        } else if (reminder.isActive) {
            // Keep active reminders
            activeReminders.push(reminder);
        }
    }
    
    if (removedReminders.length > 0) {
        user.reminders = activeReminders;
        await setUser(user);
    }
    
    return removedReminders;
}