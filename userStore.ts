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

    // LuxMed Accounts
    getLuxmedAccount: db.prepare<[number], { user_id: number; account_id: number; username: string; created_at: string }>('SELECT * FROM luxmed_accounts WHERE user_id = ?'),
    upsertLuxmedAccount: db.prepare('INSERT INTO luxmed_accounts (user_id, account_id, username, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET account_id = excluded.account_id, username = excluded.username'),

    // LuxMed Preferences
    getLuxmedPrefs: db.prepare<[number], { user_id: number; default_city_id: number | null; default_city_name: string | null; preferred_time_from: string | null; preferred_time_to: string | null; home_lat: number | null; home_lng: number | null; max_transit_minutes: number | null }>('SELECT * FROM luxmed_preferences WHERE user_id = ?'),
    upsertLuxmedPrefs: db.prepare(`
        INSERT INTO luxmed_preferences (user_id, default_city_id, default_city_name, preferred_time_from, preferred_time_to, home_lat, home_lng, max_transit_minutes)
        VALUES (@user_id, @default_city_id, @default_city_name, @preferred_time_from, @preferred_time_to, @home_lat, @home_lng, @max_transit_minutes)
        ON CONFLICT(user_id) DO UPDATE SET
            default_city_id = COALESCE(@default_city_id, default_city_id),
            default_city_name = COALESCE(@default_city_name, default_city_name),
            preferred_time_from = COALESCE(@preferred_time_from, preferred_time_from),
            preferred_time_to = COALESCE(@preferred_time_to, preferred_time_to),
            home_lat = COALESCE(@home_lat, home_lat),
            home_lng = COALESCE(@home_lng, home_lng),
            max_transit_minutes = COALESCE(@max_transit_minutes, max_transit_minutes)
    `),

    // LuxMed Monitorings
    insertLuxmedMonitoring: db.prepare(`
        INSERT INTO luxmed_monitorings (id, user_id, account_id, service_id, service_name, city_id, city_name, clinic_ids, doctor_ids, english_only, date_from, date_to, time_from, time_to, autobook, rebook_if_exists, active, created_at)
        VALUES (@id, @user_id, @account_id, @service_id, @service_name, @city_id, @city_name, @clinic_ids, @doctor_ids, @english_only, @date_from, @date_to, @time_from, @time_to, @autobook, @rebook_if_exists, 1, @created_at)
    `),
    getActiveLuxmedMonitorings: db.prepare<[], { id: string; user_id: number; account_id: number; service_id: number; service_name: string; city_id: number; city_name: string; clinic_ids: string | null; doctor_ids: string | null; english_only: number; date_from: string; date_to: string; time_from: string; time_to: string; autobook: number; rebook_if_exists: number; last_check: string | null; created_at: string }>('SELECT * FROM luxmed_monitorings WHERE active = 1'),
    getActiveLuxmedMonitoringsByUser: db.prepare<[number], { id: string; user_id: number; account_id: number; service_id: number; service_name: string; city_id: number; city_name: string; clinic_ids: string | null; doctor_ids: string | null; english_only: number; date_from: string; date_to: string; time_from: string; time_to: string; autobook: number; rebook_if_exists: number; last_check: string | null; created_at: string }>('SELECT * FROM luxmed_monitorings WHERE active = 1 AND user_id = ?'),
    deactivateLuxmedMonitoring: db.prepare('UPDATE luxmed_monitorings SET active = 0 WHERE id = ? AND user_id = ?'),
    updateLuxmedMonitoringLastCheck: db.prepare('UPDATE luxmed_monitorings SET last_check = ? WHERE id = ?'),

    // User Addresses
    upsertAddress: db.prepare(`INSERT INTO user_addresses (user_id, label, address, lat, lng, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, label) DO UPDATE SET address = excluded.address, lat = excluded.lat, lng = excluded.lng, created_at = excluded.created_at`),
    getAddressByLabel: db.prepare<[number, string], { id: number; user_id: number; label: string; address: string; lat: number; lng: number }>('SELECT * FROM user_addresses WHERE user_id = ? AND label = ?'),
    getAddressesByUser: db.prepare<[number], { id: number; label: string; address: string; lat: number; lng: number }>('SELECT id, label, address, lat, lng FROM user_addresses WHERE user_id = ?'),
    deleteAddress: db.prepare('DELETE FROM user_addresses WHERE user_id = ? AND label = ?'),

    // LuxMed Clinics
    upsertClinic: db.prepare(`INSERT INTO luxmed_clinics (name, address, lat, lng, city_id, geocoded_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET address = excluded.address, lat = excluded.lat, lng = excluded.lng, geocoded_at = excluded.geocoded_at`),
    getClinic: db.prepare<[number], { id: number; name: string; address: string | null; lat: number | null; lng: number | null }>('SELECT * FROM luxmed_clinics WHERE id = ?'),
    getClinicsByCity: db.prepare<[number], { id: number; name: string; address: string | null; lat: number | null; lng: number | null }>('SELECT * FROM luxmed_clinics WHERE city_id = ?'),
    getClinicByName: db.prepare<[string], { id: number; name: string; address: string | null; lat: number | null; lng: number | null }>('SELECT * FROM luxmed_clinics WHERE name = ?'),
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

// ============== LUXMED FUNCTIONS ==============

export function getLuxmedAccountId(userId: number): number | null {
    const row = stmts.getLuxmedAccount.get(userId);
    return row?.account_id ?? null;
}

export function saveLuxmedAccount(userId: number, accountId: number, username: string): void {
    stmts.upsertLuxmedAccount.run(userId, accountId, username, new Date().toISOString());
}

export interface LuxmedPreferences {
    defaultCityId?: number;
    defaultCityName?: string;
    preferredTimeFrom?: string;
    preferredTimeTo?: string;
    homeLat?: number;
    homeLng?: number;
    maxTransitMinutes?: number;
}

export function getLuxmedPreferences(userId: number): LuxmedPreferences {
    const row = stmts.getLuxmedPrefs.get(userId);
    if (!row) return {};
    return {
        defaultCityId: row.default_city_id ?? undefined,
        defaultCityName: row.default_city_name ?? undefined,
        preferredTimeFrom: row.preferred_time_from ?? undefined,
        preferredTimeTo: row.preferred_time_to ?? undefined,
        homeLat: row.home_lat ?? undefined,
        homeLng: row.home_lng ?? undefined,
        maxTransitMinutes: row.max_transit_minutes ?? undefined,
    };
}

export function saveLuxmedPreferences(userId: number, prefs: LuxmedPreferences): void {
    stmts.upsertLuxmedPrefs.run({
        user_id: userId,
        default_city_id: prefs.defaultCityId ?? null,
        default_city_name: prefs.defaultCityName ?? null,
        preferred_time_from: prefs.preferredTimeFrom ?? null,
        preferred_time_to: prefs.preferredTimeTo ?? null,
        home_lat: prefs.homeLat ?? null,
        home_lng: prefs.homeLng ?? null,
        max_transit_minutes: prefs.maxTransitMinutes ?? null,
    });
}

// ============== LUXMED MONITORING FUNCTIONS ==============

export interface LuxmedMonitoringConfig {
    id: string;
    userId: number;
    accountId: number;
    serviceId: number;
    serviceName: string;
    cityId: number;
    cityName: string;
    clinicIds: number[] | null;
    doctorIds: number[] | null;
    englishOnly: boolean;
    dateFrom: string;
    dateTo: string;
    timeFrom: string;
    timeTo: string;
    autobook: boolean;
    rebookIfExists: boolean;
    lastCheck: string | null;
    createdAt: string;
}

function rowToMonitoringConfig(row: any): LuxmedMonitoringConfig {
    return {
        id: row.id,
        userId: row.user_id,
        accountId: row.account_id,
        serviceId: row.service_id,
        serviceName: row.service_name,
        cityId: row.city_id,
        cityName: row.city_name,
        clinicIds: row.clinic_ids ? JSON.parse(row.clinic_ids) : null,
        doctorIds: row.doctor_ids ? JSON.parse(row.doctor_ids) : null,
        englishOnly: row.english_only === 1,
        dateFrom: row.date_from,
        dateTo: row.date_to,
        timeFrom: row.time_from,
        timeTo: row.time_to,
        autobook: row.autobook === 1,
        rebookIfExists: row.rebook_if_exists === 1,
        lastCheck: row.last_check,
        createdAt: row.created_at,
    };
}

export function createLuxmedMonitoring(config: Omit<LuxmedMonitoringConfig, 'lastCheck' | 'createdAt'>): LuxmedMonitoringConfig {
    const now = new Date().toISOString();
    stmts.insertLuxmedMonitoring.run({
        id: config.id,
        user_id: config.userId,
        account_id: config.accountId,
        service_id: config.serviceId,
        service_name: config.serviceName,
        city_id: config.cityId,
        city_name: config.cityName,
        clinic_ids: config.clinicIds ? JSON.stringify(config.clinicIds) : null,
        doctor_ids: config.doctorIds ? JSON.stringify(config.doctorIds) : null,
        english_only: config.englishOnly ? 1 : 0,
        date_from: config.dateFrom,
        date_to: config.dateTo,
        time_from: config.timeFrom,
        time_to: config.timeTo,
        autobook: config.autobook ? 1 : 0,
        rebook_if_exists: config.rebookIfExists ? 1 : 0,
        created_at: now,
    });
    return { ...config, lastCheck: null, createdAt: now };
}

export function getActiveLuxmedMonitorings(): LuxmedMonitoringConfig[] {
    return stmts.getActiveLuxmedMonitorings.all().map(rowToMonitoringConfig);
}

export function getActiveLuxmedMonitoringsByUser(userId: number): LuxmedMonitoringConfig[] {
    return stmts.getActiveLuxmedMonitoringsByUser.all(userId).map(rowToMonitoringConfig);
}

export function deactivateLuxmedMonitoring(id: string, userId: number): void {
    stmts.deactivateLuxmedMonitoring.run(id, userId);
}

export function updateLuxmedMonitoringLastCheck(id: string): void {
    stmts.updateLuxmedMonitoringLastCheck.run(new Date().toISOString(), id);
}

// ============== USER ADDRESSES ==============

export interface UserAddress {
    label: string;
    address: string;
    lat: number;
    lng: number;
}

export function saveUserAddress(userId: number, label: string, address: string, lat: number, lng: number): void {
    stmts.upsertAddress.run(userId, label.toLowerCase().trim(), address, lat, lng, new Date().toISOString());
}

export function getUserAddress(userId: number, label: string): UserAddress | null {
    const row = stmts.getAddressByLabel.get(userId, label.toLowerCase().trim());
    return row ? { label: row.label, address: row.address, lat: row.lat, lng: row.lng } : null;
}

export function getUserAddresses(userId: number): UserAddress[] {
    return stmts.getAddressesByUser.all(userId).map(r => ({ label: r.label, address: r.address, lat: r.lat, lng: r.lng }));
}

export function deleteUserAddress(userId: number, label: string): void {
    stmts.deleteAddress.run(userId, label.toLowerCase().trim());
}

// ============== LUXMED CLINICS CACHE ==============

export function saveLuxmedClinic(name: string, address: string | null, lat: number | null, lng: number | null, cityId: number): void {
    stmts.upsertClinic.run(name, address, lat, lng, cityId, new Date().toISOString());
}

export function getLuxmedClinicByName(name: string): { id: number; name: string; lat: number; lng: number } | null {
    const row = stmts.getClinicByName.get(name);
    return row && row.lat != null && row.lng != null ? { id: row.id, name: row.name, lat: row.lat, lng: row.lng } : null;
}

export function getLuxmedClinicsByCity(cityId: number): { id: number; name: string; lat: number; lng: number }[] {
    return stmts.getClinicsByCity.all(cityId)
        .filter(r => r.lat != null && r.lng != null)
        .map(r => ({ id: r.id, name: r.name, lat: r.lat!, lng: r.lng! }));
}
