import Database from 'better-sqlite3';
import {SCHEMA_SQL, INDEXES_SQL} from './schema';

const DB_PATH = process.env.DB_PATH || 'bot.sqlite';
// If the path ends with .json (legacy), switch to .sqlite
const sqlitePath = DB_PATH.endsWith('.json')
    ? DB_PATH.replace(/\.json$/, '.sqlite')
    : DB_PATH;

const db = new Database(sqlitePath);

// Performance and safety pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(SCHEMA_SQL);
db.exec(INDEXES_SQL);

// --- Idempotent column migrations for existing DBs ---
// memory: first_recorded_at / updated_at (backfill existing rows to ~30 days ago)
{
    const cols = db.prepare('PRAGMA table_info(memory)').all() as { name: string }[];
    const hasFirst = cols.some(c => c.name === 'first_recorded_at');
    const hasUpdated = cols.some(c => c.name === 'updated_at');
    if (!hasFirst) db.exec(`ALTER TABLE memory ADD COLUMN first_recorded_at TEXT NOT NULL DEFAULT ''`);
    if (!hasUpdated) db.exec(`ALTER TABLE memory ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
    if (!hasFirst || !hasUpdated) {
        const backfill = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        db.prepare(`UPDATE memory SET first_recorded_at = ? WHERE first_recorded_at = ''`).run(backfill);
        db.prepare(`UPDATE memory SET updated_at = ? WHERE updated_at = ''`).run(backfill);
    }
}

export default db;
