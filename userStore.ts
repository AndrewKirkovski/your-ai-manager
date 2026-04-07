import db from './database';
import {DateTime} from 'luxon';

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
    id: number;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
};

export type AnnoyanceLevel = 'low' | 'med' | 'high';

export type Routine = {
    id: string;
    name: string;
    cron: string;
    defaultAnnoyance: AnnoyanceLevel;
    requiresAction: boolean;
    isActive: boolean;
    stats: { completed: number; failed: number };
    createdAt: Date;
};

export type TaskStatus = 'pending' | 'completed' | 'failed' | 'needs_replanning';
export type Task = {
    id: string;
    name: string;
    routineId?: string;
    dueAt?: Date;
    requiresAction: boolean;
    status: TaskStatus;
    annoyance: AnnoyanceLevel;
    pingAt: Date;
    postponeCount: number;
    createdAt: Date;
};

export type UserData = {
    userId: number;
    chatId?: number;
    preferences: {
        goal: string;
        timezone?: string;
    };
    routines: Routine[];
    tasks: Task[];
    memory: Record<string, string>;
    messageHistory: MessageHistory[];
};

// ============== SQLite ROW TYPES ==============

interface UserRow {
    user_id: number;
    chat_id: number | null;
    goal: string;
    timezone: string | null;
}

interface RoutineRow {
    id: string;
    user_id: number;
    name: string;
    cron: string;
    default_annoyance: string;
    requires_action: number;
    is_active: number;
    is_deleted: number;
    stats_completed: number;
    stats_failed: number;
    created_at: string;
}

interface TaskRow {
    id: string;
    user_id: number;
    name: string;
    routine_id: string | null;
    due_at: string | null;
    requires_action: number;
    status: string;
    annoyance: string;
    ping_at: string;
    postpone_count: number;
    created_at: string;
}

interface MessageRow {
    id: number;
    user_id: number;
    role: string;
    content: string;
    timestamp: string;
}

interface MemoryRow {
    key: string;
    value: string;
}

interface CountRow {
    count: number;
}

interface ImageRow {
    id: number;
    user_id: number;
    file_id: string;
    caption: string | null;
    description: string | null;
    timestamp: string;
}

interface StatRow {
    id: number;
    user_id: number;
    name: string;
    value: number;
    unit: string | null;
    note: string | null;
    timestamp: string;
}

interface StatNameRow {
    name: string;
    unit: string | null;
}

interface TodayStatRow {
    name: string;
    total: number;
    count: number;
    unit: string | null;
}

// ============== ROW MAPPERS ==============

function rowToRoutine(row: RoutineRow): Routine {
    return {
        id: row.id,
        name: row.name,
        cron: row.cron,
        defaultAnnoyance: row.default_annoyance as AnnoyanceLevel,
        requiresAction: !!row.requires_action,
        isActive: !!row.is_active,
        stats: { completed: row.stats_completed, failed: row.stats_failed },
        createdAt: new Date(row.created_at),
    };
}

function rowToTask(row: TaskRow): Task {
    return {
        id: row.id,
        name: row.name,
        routineId: row.routine_id ?? undefined,
        dueAt: row.due_at ? new Date(row.due_at) : undefined,
        requiresAction: !!row.requires_action,
        status: row.status as TaskStatus,
        annoyance: row.annoyance as AnnoyanceLevel,
        pingAt: new Date(row.ping_at),
        postponeCount: row.postpone_count,
        createdAt: new Date(row.created_at),
    };
}

function rowToMessage(row: MessageRow): MessageHistory {
    return {
        id: row.id,
        role: row.role as 'user' | 'assistant',
        content: row.content,
        timestamp: new Date(row.timestamp),
    };
}

// ============== PREPARED STATEMENTS (typed via generics) ==============

const stmts = {
    // Users
    getUser: db.prepare<[number], UserRow>('SELECT * FROM users WHERE user_id = ?'),
    upsertUser: db.prepare(`
        INSERT INTO users (user_id, chat_id, goal, timezone)
        VALUES (@user_id, @chat_id, @goal, @timezone)
        ON CONFLICT(user_id) DO UPDATE SET
            chat_id = COALESCE(@chat_id, chat_id),
            goal = @goal,
            timezone = @timezone
    `),
    getAllUsers: db.prepare<[], UserRow>('SELECT * FROM users'),

    // Routines (is_deleted=0 filter on reads, soft delete on remove)
    getRoutinesByUser: db.prepare<[number], RoutineRow>('SELECT * FROM routines WHERE user_id = ? AND is_deleted = 0'),
    getRoutineById: db.prepare<[string, number], RoutineRow>('SELECT * FROM routines WHERE id = ? AND user_id = ? AND is_deleted = 0'),
    // Lookup including deleted — for FK integrity (task completion/failure updates routine stats)
    getRoutineByIdIncludeDeleted: db.prepare<[string, number], RoutineRow>('SELECT * FROM routines WHERE id = ? AND user_id = ?'),
    insertRoutine: db.prepare(`
        INSERT INTO routines (id, user_id, name, cron, default_annoyance, requires_action, is_active, stats_completed, stats_failed, created_at)
        VALUES (@id, @user_id, @name, @cron, @default_annoyance, @requires_action, @is_active, @stats_completed, @stats_failed, @created_at)
    `),
    updateRoutine: db.prepare(`
        UPDATE routines SET name=@name, cron=@cron, default_annoyance=@default_annoyance,
        requires_action=@requires_action, is_active=@is_active,
        stats_completed=@stats_completed, stats_failed=@stats_failed
        WHERE id=@id AND user_id=@user_id
    `),
    softDeleteRoutine: db.prepare('UPDATE routines SET is_deleted = 1, is_active = 0 WHERE id = ? AND user_id = ?'),

    // Tasks
    getTasksByUser: db.prepare<[number], TaskRow>('SELECT * FROM tasks WHERE user_id = ?'),
    getTaskById: db.prepare<[string, number], TaskRow>('SELECT * FROM tasks WHERE id = ? AND user_id = ?'),
    insertTask: db.prepare(`
        INSERT INTO tasks (id, user_id, name, routine_id, due_at, requires_action, status, annoyance, ping_at, postpone_count, created_at)
        VALUES (@id, @user_id, @name, @routine_id, @due_at, @requires_action, @status, @annoyance, @ping_at, @postpone_count, @created_at)
    `),
    updateTask: db.prepare(`
        UPDATE tasks SET name=@name, routine_id=@routine_id, due_at=@due_at,
        requires_action=@requires_action, status=@status, annoyance=@annoyance,
        ping_at=@ping_at, postpone_count=@postpone_count
        WHERE id=@id AND user_id=@user_id
    `),
    deleteTask: db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?'),
    cleanupOldTasks: db.prepare('DELETE FROM tasks WHERE user_id = ? AND id NOT IN (SELECT id FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)'),

    // Memory
    getMemoryByUser: db.prepare<[number], MemoryRow>('SELECT key, value FROM memory WHERE user_id = ?'),
    getMemoryByKey: db.prepare<[number, string], MemoryRow>('SELECT value FROM memory WHERE user_id = ? AND key = ?'),
    upsertMemory: db.prepare('INSERT INTO memory (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value'),
    deleteMemory: db.prepare('DELETE FROM memory WHERE user_id = ? AND key = ?'),

    // Message History
    getRecentMessages: db.prepare<[number, number], MessageRow>('SELECT * FROM message_history WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
    getAllMessages: db.prepare<[number], MessageRow>('SELECT * FROM message_history WHERE user_id = ? ORDER BY id ASC'),
    insertMessage: db.prepare('INSERT INTO message_history (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)'),
    countMessages: db.prepare<[number], CountRow>('SELECT COUNT(*) as count FROM message_history WHERE user_id = ?'),
    deleteOldMessages: db.prepare('DELETE FROM message_history WHERE user_id = ? AND id NOT IN (SELECT id FROM message_history WHERE user_id = ? ORDER BY id DESC LIMIT ?)'),
    updateMessageContent: db.prepare('UPDATE message_history SET content = ? WHERE id = ? AND user_id = ?'),
    deleteMessageRange: db.prepare('DELETE FROM message_history WHERE user_id = ? AND id BETWEEN ? AND ?'),

    // Image Cache
    insertImage: db.prepare('INSERT INTO image_cache (user_id, file_id, caption, description, timestamp) VALUES (?, ?, ?, ?, ?)'),
    getRecentImages: db.prepare<[number, number], ImageRow>('SELECT * FROM image_cache WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
    pruneImages: db.prepare('DELETE FROM image_cache WHERE user_id = ? AND id NOT IN (SELECT id FROM image_cache WHERE user_id = ? ORDER BY id DESC LIMIT ?)'),

    // Stat Entries
    insertStat: db.prepare('INSERT INTO stat_entries (user_id, name, value, unit, note, timestamp) VALUES (?, ?, ?, ?, ?, ?)'),
    getStatEntries: db.prepare<[number, string, string, string], StatRow>('SELECT * FROM stat_entries WHERE user_id = ? AND name = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC'),
    getStatNames: db.prepare<[number], StatNameRow>('SELECT DISTINCT name, unit FROM stat_entries WHERE user_id = ?'),
    getLatestStat: db.prepare<[number, string], StatRow>('SELECT * FROM stat_entries WHERE user_id = ? AND name = ? ORDER BY timestamp DESC, id DESC LIMIT 1'),
    countStatEntries: db.prepare<[number, string], CountRow>('SELECT COUNT(*) as count FROM stat_entries WHERE user_id = ? AND name = ?'),
    getTodayStats: db.prepare<[number, string], TodayStatRow>('SELECT name, SUM(value) as total, COUNT(*) as count, unit FROM stat_entries WHERE user_id = ? AND timestamp >= ? GROUP BY name'),
};

// ============== USER FUNCTIONS ==============

function assembleUser(userRow: UserRow): UserData {
    const userId = userRow.user_id;
    const routines = stmts.getRoutinesByUser.all(userId).map(rowToRoutine);
    const tasks = stmts.getTasksByUser.all(userId).map(rowToTask);

    const memoryRows = stmts.getMemoryByUser.all(userId);
    const memory: Record<string, string> = {};
    for (const row of memoryRows) {
        memory[row.key] = row.value;
    }

    const messageRows = stmts.getAllMessages.all(userId);
    const messageHistory = messageRows.map(rowToMessage);

    return {
        userId: userRow.user_id,
        chatId: userRow.chat_id ?? undefined,
        preferences: {
            goal: userRow.goal || '',
            timezone: userRow.timezone ?? undefined,
        },
        routines,
        tasks,
        memory,
        messageHistory,
    };
}

export async function getUser(userId: number): Promise<UserData | undefined> {
    const row = stmts.getUser.get(userId);
    if (!row) return undefined;
    return assembleUser(row);
}

export async function setUser(user: UserData): Promise<void> {
    stmts.upsertUser.run({
        user_id: user.userId,
        chat_id: user.chatId ?? null,
        goal: user.preferences.goal || '',
        timezone: user.preferences.timezone ?? null,
    });
}

export async function getAllUsers(): Promise<UserData[]> {
    return stmts.getAllUsers.all().map(assembleUser);
}

// ============== MESSAGE HISTORY ==============

const MAX_MESSAGES = 5000;

export async function addMessageToHistory(userId: number, role: 'user' | 'assistant', content: string): Promise<void> {
    stmts.insertMessage.run(userId, role, content, new Date().toISOString());

    // Cap enforcement
    const { count } = stmts.countMessages.get(userId)!;
    if (count > MAX_MESSAGES) {
        stmts.deleteOldMessages.run(userId, userId, MAX_MESSAGES);
    }
}

export async function getUserMessageHistory(userId: number): Promise<MessageHistory[]> {
    return stmts.getAllMessages.all(userId).map(rowToMessage);
}

export async function getRecentMessageHistory(userId: number, limit: number): Promise<MessageHistory[]> {
    // Reverse because query is ORDER BY id DESC, but we want chronological
    return stmts.getRecentMessages.all(userId, limit).map(rowToMessage).reverse();
}

// History compaction helpers
export async function getMessageHistoryWithIds(userId: number): Promise<MessageHistory[]> {
    return stmts.getAllMessages.all(userId).map(rowToMessage);
}

export function compactMessages(userId: number, startId: number, endId: number, compactedContent: string, _timestamp: Date): void {
    // Keep the first message's row (preserves ID ordering), update its content,
    // then delete the rest of the run. This avoids creating a new high-ID row
    // that would break ORDER BY id DESC queries.
    const compact = db.transaction(() => {
        stmts.updateMessageContent.run(compactedContent, startId, userId);
        if (startId < endId) {
            db.prepare('DELETE FROM message_history WHERE user_id = ? AND id > ? AND id <= ?')
                .run(userId, startId, endId);
        }
    });
    compact();
}

export function updateMessageById(userId: number, messageId: number, content: string): boolean {
    const result = stmts.updateMessageContent.run(content, messageId, userId);
    return result.changes > 0;
}

// ============== TASK CLEANUP ==============

export async function cleanupOldTasks(userId: number, keepCount: number = 50): Promise<number> {
    const result = stmts.cleanupOldTasks.run(userId, userId, keepCount);
    return result.changes;
}

// ============== ROUTINE HELPERS ==============

export const getAllRoutines = async (userId: number): Promise<Routine[]> => {
    return stmts.getRoutinesByUser.all(userId).map(rowToRoutine);
};

export const getAllTasks = async (userId: number): Promise<Task[]> => {
    return stmts.getTasksByUser.all(userId).map(rowToTask);
};

export const getRoutine = async (userId: number, routineId: string): Promise<Routine | undefined> => {
    const row = stmts.getRoutineById.get(routineId, userId);
    return row ? rowToRoutine(row) : undefined;
};

export const getTask = async (userId: number, taskId: string): Promise<Task | undefined> => {
    const row = stmts.getTaskById.get(taskId, userId);
    return row ? rowToTask(row) : undefined;
};

export async function addUserRoutine(userId: number, routine: Routine): Promise<void> {
    stmts.insertRoutine.run({
        id: routine.id,
        user_id: userId,
        name: routine.name,
        cron: routine.cron,
        default_annoyance: routine.defaultAnnoyance,
        requires_action: routine.requiresAction ? 1 : 0,
        is_active: routine.isActive ? 1 : 0,
        stats_completed: routine.stats.completed,
        stats_failed: routine.stats.failed,
        created_at: routine.createdAt.toISOString(),
    });
}

export async function updateUserRoutine(userId: number, routineId: string, updateFn: (r: Routine) => void): Promise<void> {
    // Use include-deleted lookup so task completions can still update stats on soft-deleted routines
    const row = stmts.getRoutineByIdIncludeDeleted.get(routineId, userId);
    if (!row) return;

    const routine = rowToRoutine(row);
    updateFn(routine);

    stmts.updateRoutine.run({
        id: routineId,
        user_id: userId,
        name: routine.name,
        cron: routine.cron,
        default_annoyance: routine.defaultAnnoyance,
        requires_action: routine.requiresAction ? 1 : 0,
        is_active: routine.isActive ? 1 : 0,
        stats_completed: routine.stats.completed,
        stats_failed: routine.stats.failed,
    });
}

export async function removeUserRoutine(userId: number, routineId: string): Promise<void> {
    stmts.softDeleteRoutine.run(routineId, userId);
}

export async function addUserTask(userId: number, task: Task): Promise<void> {
    stmts.insertTask.run({
        id: task.id,
        user_id: userId,
        name: task.name,
        routine_id: task.routineId ?? null,
        due_at: task.dueAt?.toISOString() ?? null,
        requires_action: task.requiresAction ? 1 : 0,
        status: task.status,
        annoyance: task.annoyance,
        ping_at: task.pingAt.toISOString(),
        postpone_count: task.postponeCount,
        created_at: task.createdAt.toISOString(),
    });
}

export async function updateUserTask(userId: number, taskId: string, updateFn: (t: Task) => void): Promise<void> {
    const row = stmts.getTaskById.get(taskId, userId);
    if (!row) return;

    const task = rowToTask(row);
    updateFn(task);

    stmts.updateTask.run({
        id: taskId,
        user_id: userId,
        name: task.name,
        routine_id: task.routineId ?? null,
        due_at: task.dueAt?.toISOString() ?? null,
        requires_action: task.requiresAction ? 1 : 0,
        status: task.status,
        annoyance: task.annoyance,
        ping_at: task.pingAt.toISOString(),
        postpone_count: task.postponeCount,
    });
}

export async function removeUserTask(userId: number, taskId: string): Promise<void> {
    stmts.deleteTask.run(taskId, userId);
}

// ============== MEMORY HELPERS ==============

export async function updateUserMemory(userId: number, key: string, value: string): Promise<void> {
    stmts.upsertMemory.run(userId, key, value);
}

export async function getUserMemory(userId: number, key: string): Promise<string | undefined> {
    const row = stmts.getMemoryByKey.get(userId, key);
    return row?.value;
}

export async function getAllUserMemory(userId: number): Promise<Record<string, string>> {
    const rows = stmts.getMemoryByUser.all(userId);
    const memory: Record<string, string> = {};
    for (const row of rows) {
        memory[row.key] = row.value;
    }
    return memory;
}

export async function deleteUserMemory(userId: number, key: string): Promise<boolean> {
    const result = stmts.deleteMemory.run(userId, key);
    return result.changes > 0;
}

// ============== GOAL HELPERS ==============

export async function setUserGoal(userId: number, goal: string): Promise<void> {
    db.prepare('UPDATE users SET goal = ? WHERE user_id = ?').run(goal, userId);
}

export async function getUserGoal(userId: number): Promise<string> {
    const row = stmts.getUser.get(userId);
    return row?.goal ?? '';
}

export async function clearUserGoal(userId: number): Promise<void> {
    db.prepare('UPDATE users SET goal = \'\' WHERE user_id = ?').run(userId);
}

// ============== IMAGE CACHE ==============

export async function addImageToCache(userId: number, fileId: string, caption: string | undefined, description: string | undefined): Promise<void> {
    stmts.insertImage.run(userId, fileId, caption ?? null, description ?? null, new Date().toISOString());
    // Prune to keep last 10
    stmts.pruneImages.run(userId, userId, 10);
}

export async function getRecentImages(userId: number, limit: number = 10): Promise<Array<{ id: number; fileId: string; caption?: string; description?: string; timestamp: Date }>> {
    const rows = stmts.getRecentImages.all(userId, limit);
    return rows.map(row => ({
        id: row.id,
        fileId: row.file_id,
        caption: row.caption ?? undefined,
        description: row.description ?? undefined,
        timestamp: new Date(row.timestamp),
    }));
}

// ============== STAT TRACKING ==============

export async function addStatEntry(userId: number, name: string, value: number, unit?: string, note?: string, timestamp?: Date): Promise<void> {
    stmts.insertStat.run(userId, name.toLowerCase(), value, unit ?? null, note ?? null, (timestamp ?? new Date()).toISOString());
}

export async function getStatEntries(userId: number, name: string, from?: Date, to?: Date): Promise<Array<{ id: number; name: string; value: number; unit?: string; note?: string; timestamp: Date }>> {
    const fromStr = (from ?? new Date('2000-01-01')).toISOString();
    const toStr = (to ?? new Date('2100-01-01')).toISOString();
    const rows = stmts.getStatEntries.all(userId, name.toLowerCase(), fromStr, toStr);
    return rows.map(row => ({
        id: row.id,
        name: row.name,
        value: row.value,
        unit: row.unit ?? undefined,
        note: row.note ?? undefined,
        timestamp: new Date(row.timestamp),
    }));
}

export async function getTrackedStatNames(userId: number): Promise<Array<{ name: string; unit?: string }>> {
    const rows = stmts.getStatNames.all(userId);
    return rows.map(row => ({
        name: row.name,
        unit: row.unit ?? undefined,
    }));
}

export async function getLatestStat(userId: number, name: string): Promise<{ value: number; unit?: string; timestamp: Date } | undefined> {
    const row = stmts.getLatestStat.get(userId, name.toLowerCase());
    if (!row) return undefined;
    return {
        value: row.value,
        unit: row.unit ?? undefined,
        timestamp: new Date(row.timestamp),
    };
}

export async function getStatCount(userId: number, name: string): Promise<number> {
    const row = stmts.countStatEntries.get(userId, name.toLowerCase());
    return row?.count ?? 0;
}

export async function getTodayStats(userId: number, timezone?: string): Promise<Array<{ name: string; total: number; count: number; unit?: string }>> {
    const todayStart = DateTime.now().setZone(timezone || 'Europe/Warsaw').startOf('day').toUTC().toISO()!;
    const rows = stmts.getTodayStats.all(userId, todayStart);
    return rows.map(row => ({
        name: row.name,
        total: row.total,
        count: row.count,
        unit: row.unit ?? undefined,
    }));
}
