/**
 * Migration script: LowDB (db.json) → SQLite
 *
 * Reads existing db.json and inserts all data into SQLite.
 * Idempotent — skips if SQLite already has user data.
 *
 * Usage: npx tsx migrate-to-sqlite.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import {Low} from 'lowdb';
import {JSONFile} from 'lowdb/node';
import Database from 'better-sqlite3';
import {existsSync} from 'fs';
import {SCHEMA_SQL, INDEXES_SQL} from './schema';

// Determine paths
const jsonPath = process.env.DB_PATH?.endsWith('.json')
    ? process.env.DB_PATH
    : (process.env.DB_PATH || 'db.json').replace(/\.sqlite$/, '.json');

const sqlitePath = jsonPath.replace(/\.json$/, '.sqlite');

console.log(`📦 Migration: ${jsonPath} → ${sqlitePath}`);

// Check if JSON source exists
if (!existsSync(jsonPath)) {
    console.log('ℹ️ No db.json found — nothing to migrate. Starting fresh.');
    process.exit(0);
}

// Open SQLite and check if it already has data
const db = new Database(sqlitePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create schema (shared with database.ts)
db.exec(SCHEMA_SQL);
db.exec(INDEXES_SQL);

// Check if SQLite already has users
const existingCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as {count: number}).count;
if (existingCount > 0) {
    console.log(`✅ SQLite already has ${existingCount} user(s) — skipping migration.`);
    db.close();
    process.exit(0);
}

// Read JSON database
type DBData = { users: any[] };
const adapter = new JSONFile<DBData>(jsonPath);
const jsonDb = new Low(adapter, {users: []});
await jsonDb.read();

const users = jsonDb.data?.users || [];
if (users.length === 0) {
    console.log('ℹ️ db.json has no users — nothing to migrate.');
    db.close();
    process.exit(0);
}

console.log(`📊 Found ${users.length} user(s) to migrate`);

// Prepare statements
const insertUser = db.prepare(`INSERT INTO users (user_id, chat_id, goal, timezone) VALUES (?, ?, ?, ?)`);
const insertRoutine = db.prepare(`INSERT INTO routines (id, user_id, name, cron, default_annoyance, requires_action, is_active, stats_completed, stats_failed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insertTask = db.prepare(`INSERT INTO tasks (id, user_id, name, routine_id, due_at, requires_action, status, annoyance, ping_at, postpone_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insertMemory = db.prepare(`INSERT INTO memory (user_id, key, value) VALUES (?, ?, ?)`);
const insertMessage = db.prepare(`INSERT INTO message_history (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)`);

// Run migration in a single transaction
const migrate = db.transaction(() => {
    let totalRoutines = 0, totalTasks = 0, totalMemory = 0, totalMessages = 0;

    for (const user of users) {
        // Insert user
        insertUser.run(
            user.userId,
            user.chatId ?? null,
            user.preferences?.goal || '',
            user.preferences?.timezone ?? null
        );

        // Insert routines
        for (const r of user.routines ?? []) {
            const createdAt = typeof r.createdAt === 'string' ? r.createdAt : new Date(r.createdAt).toISOString();
            insertRoutine.run(
                r.id, user.userId, r.name, r.cron,
                r.defaultAnnoyance || 'low',
                r.requiresAction ? 1 : 0,
                r.isActive ? 1 : 0,
                r.stats?.completed ?? 0,
                r.stats?.failed ?? 0,
                createdAt
            );
            totalRoutines++;
        }

        // Collect valid routine IDs for FK validation
        const validRoutineIds = new Set((user.routines ?? []).map((r: { id: string }) => r.id));

        // Insert tasks (clear orphaned routineId references)
        for (const t of user.tasks ?? []) {
            const routineId = (t.routineId && validRoutineIds.has(t.routineId)) ? t.routineId : null;
            const dueAt = t.dueAt ? (typeof t.dueAt === 'string' ? t.dueAt : new Date(t.dueAt).toISOString()) : null;
            const pingAt = typeof t.pingAt === 'string' ? t.pingAt : new Date(t.pingAt).toISOString();
            const createdAt = typeof t.createdAt === 'string' ? t.createdAt : new Date(t.createdAt).toISOString();
            insertTask.run(
                t.id, user.userId, t.name, routineId,
                dueAt, t.requiresAction ? 1 : 0,
                t.status || 'pending', t.annoyance || 'low',
                pingAt, t.postponeCount ?? 0, createdAt
            );
            totalTasks++;
        }

        // Insert memory
        for (const [key, value] of Object.entries(user.memory ?? {})) {
            insertMemory.run(user.userId, key, String(value));
            totalMemory++;
        }

        // Insert message history
        for (const msg of user.messageHistory ?? []) {
            const ts = typeof msg.timestamp === 'string' ? msg.timestamp : new Date(msg.timestamp).toISOString();
            insertMessage.run(user.userId, msg.role, msg.content, ts);
            totalMessages++;
        }
    }

    console.log(`✅ Migrated:`);
    console.log(`   ${users.length} users`);
    console.log(`   ${totalRoutines} routines`);
    console.log(`   ${totalTasks} tasks`);
    console.log(`   ${totalMemory} memory entries`);
    console.log(`   ${totalMessages} messages`);
});

try {
    migrate();
    console.log('🎉 Migration completed successfully!');
} catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
} finally {
    db.close();
}
