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

// sticker_cache: short_tag + used_count (added 2026-04-24)
{
    const cols = db.prepare('PRAGMA table_info(sticker_cache)').all() as { name: string }[];
    if (!cols.some(c => c.name === 'short_tag')) {
        db.exec(`ALTER TABLE sticker_cache ADD COLUMN short_tag TEXT NOT NULL DEFAULT ''`);
    }
    if (!cols.some(c => c.name === 'used_count')) {
        db.exec(`ALTER TABLE sticker_cache ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0`);
    }
}

// Synthetic system user — required for stat_entries (FK to users) when recording
// AI usage from cron/sticker-picker/Vision calls that aren't tied to a real user.
db.prepare(
    `INSERT OR IGNORE INTO users (user_id, chat_id, goal, timezone) VALUES (0, NULL, 'system', NULL)`
).run();

// --- One-shot case-normalization for existing rows ---
// userStore.normalizeMemoryKey / normalizeClinicName now lowercase on every
// write+read. Legacy rows written before that change keep their original case,
// so lowercase lookups miss them. Migrate once at startup; handle key conflicts
// (e.g. 'Foo' + 'foo' both exist) by keeping the more-recent row.
{
    type MemRow = { user_id: number; key: string; value: string; first_recorded_at: string; updated_at: string };
    const mixed = db.prepare(
        `SELECT user_id, key, value, first_recorded_at, updated_at FROM memory WHERE key != lower(key)`
    ).all() as MemRow[];
    if (mixed.length > 0) {
        console.log(`[migrate] Normalizing ${mixed.length} mixed-case memory keys to lowercase`);
        const getLower = db.prepare(`SELECT updated_at FROM memory WHERE user_id = ? AND key = ?`);
        const del = db.prepare(`DELETE FROM memory WHERE user_id = ? AND key = ?`);
        const update = db.prepare(`UPDATE memory SET key = ? WHERE user_id = ? AND key = ?`);
        const migrate = db.transaction((rows: MemRow[]) => {
            for (const r of rows) {
                const lower = r.key.toLowerCase();
                const existing = getLower.get(r.user_id, lower) as { updated_at: string } | undefined;
                if (!existing) {
                    update.run(lower, r.user_id, r.key);
                } else if (new Date(r.updated_at) > new Date(existing.updated_at)) {
                    del.run(r.user_id, lower);
                    update.run(lower, r.user_id, r.key);
                } else {
                    del.run(r.user_id, r.key);
                }
            }
        });
        migrate(mixed);
    }
}

{
    type ClinicRow = { id: number; name: string; lat: number | null; lng: number | null; geocoded_at: string | null };
    const mixedClinics = db.prepare(
        `SELECT id, name, lat, lng, geocoded_at FROM luxmed_clinics WHERE name != lower(name)`
    ).all() as ClinicRow[];
    if (mixedClinics.length > 0) {
        console.log(`[migrate] Normalizing ${mixedClinics.length} mixed-case clinic names`);
        // Conflict resolution: prefer row with geocoded coords; else the more-recent `geocoded_at`.
        const findByName = db.prepare(`SELECT id, lat, lng, geocoded_at FROM luxmed_clinics WHERE name = ?`);
        const del = db.prepare(`DELETE FROM luxmed_clinics WHERE id = ?`);
        const update = db.prepare(`UPDATE luxmed_clinics SET name = ? WHERE id = ?`);
        const migrate = db.transaction((rows: ClinicRow[]) => {
            for (const r of rows) {
                const lower = r.name.toLowerCase().trim();
                const existing = findByName.get(lower) as { id: number; lat: number | null; lng: number | null; geocoded_at: string | null } | undefined;
                if (!existing) {
                    update.run(lower, r.id);
                    continue;
                }
                const rHasCoords = r.lat != null && r.lng != null;
                const eHasCoords = existing.lat != null && existing.lng != null;
                const rNewer = (r.geocoded_at || '') > (existing.geocoded_at || '');
                const keepIncoming =
                    (rHasCoords && !eHasCoords) ||
                    (rHasCoords && eHasCoords && rNewer);
                if (keepIncoming) {
                    del.run(existing.id);
                    update.run(lower, r.id);
                } else {
                    del.run(r.id);
                }
            }
        });
        migrate(mixedClinics);
    }
}

export default db;
