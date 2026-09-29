/** SQLite schema — single source of truth for database.ts. */

import type Database from 'better-sqlite3';
import { SMART_SCHEMA_SQL } from './luxmedSmartSchema';

/** Apply idempotent ADD COLUMN migrations to an existing database. Safe to call
 * before CREATE INDEX statements that reference the new columns. Called by
 * database.ts on bot startup. */
export function applyColumnMigrations(db: Database.Database): void {
    // A booking stays locked in the sidecar until the bot records its outcome.
    {
        const cols = db.prepare('PRAGMA table_info(luxmed_booking_attempts)').all() as { name: string }[];
        if (cols.length && !cols.some(column => column.name === 'acknowledged_at'))
            db.exec('ALTER TABLE luxmed_booking_attempts ADD COLUMN acknowledged_at INTEGER');
    }
    const cancellationColumns = db.prepare('PRAGMA table_info(luxmed_cancelled_reservations)').all() as { name: string }[];
    if (cancellationColumns.length && !cancellationColumns.some(column => column.name === 'start_at'))
        db.exec('ALTER TABLE luxmed_cancelled_reservations ADD COLUMN start_at INTEGER');
    // Keep the old name-unique table for rollback images: their userStore
    // prepares ON CONFLICT(name) at startup. New code uses the city-scoped
    // table. Copy every city-specific row before reducing an interim
    // nonunique legacy table to one conservative row per name.
    {
        const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'luxmed_clinics'").get() as { sql: string } | undefined;
        if (table?.sql) {
            const migrate = db.transaction(() => {
                type ClinicRow = { id: number; name: string; address: string | null; lat: number | null;
                    lng: number | null; city_id: number | null; geocoded_at: string | null };
                const rows = db.prepare(`SELECT id,name,address,lat,lng,city_id,geocoded_at FROM luxmed_clinics
                    ORDER BY (lat IS NOT NULL AND lng IS NOT NULL) DESC, COALESCE(geocoded_at,'') DESC, id DESC`)
                    .all() as ClinicRow[];
                const saveCity = db.prepare(`INSERT OR IGNORE INTO luxmed_clinics_by_city
                    (name,address,lat,lng,city_id,geocoded_at) VALUES (?,?,?,?,?,?)`);
                for (const row of rows) {
                    const name = row.name.toLowerCase().trim();
                    if (name && Number.isSafeInteger(row.city_id) && row.city_id! > 0)
                        // A name-only old image may have replaced coordinates
                        // for another city without replacing its city_id.
                        // Carry the identity forward, but require fresh
                        // verification before these rows can guide travel.
                        saveCity.run(name, null, null, null, row.city_id, null);
                }
                if (!/name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(table.sql)) {
                    db.exec('ALTER TABLE luxmed_clinics RENAME TO luxmed_clinics_before_rollback');
                    db.exec(`CREATE TABLE luxmed_clinics (
                        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
                        address TEXT, lat REAL, lng REAL, city_id INTEGER, geocoded_at TEXT
                    )`);
                    const saveLegacy = db.prepare(`INSERT OR IGNORE INTO luxmed_clinics
                        (id,name,address,lat,lng,city_id,geocoded_at) VALUES (?,?,?,?,?,?,?)`);
                    for (const row of rows) {
                        const name = row.name.toLowerCase().trim();
                        if (name) saveLegacy.run(row.id, name, row.address, row.lat, row.lng, row.city_id, row.geocoded_at);
                    }
                    db.exec('DROP TABLE luxmed_clinics_before_rollback');
                }
                // The old image updates coordinates by name without changing
                // city_id. Once the new cache owns a name, never trust that
                // legacy row as a cross-city route cache during rollback.
                const cityNames = new Set((db.prepare('SELECT DISTINCT name FROM luxmed_clinics_by_city').all() as { name: string }[])
                    .map(row => row.name));
                const clearLegacy = db.prepare(`UPDATE luxmed_clinics SET address=NULL,lat=NULL,lng=NULL,geocoded_at=NULL WHERE id=?`);
                for (const row of db.prepare('SELECT id,name FROM luxmed_clinics').all() as { id: number; name: string }[]) {
                    if (cityNames.has(row.name.toLowerCase().trim())) clearLegacy.run(row.id);
                }
                // A nonunique index under the old name would hide the old
                // image's CREATE UNIQUE INDEX IF NOT EXISTS statement.
                const oldIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_luxmed_clinics_name'")
                    .get() as { sql: string | null } | undefined;
                if (oldIndex?.sql && !/^\s*CREATE\s+UNIQUE\s+INDEX\b/i.test(oldIndex.sql))
                    db.exec('DROP INDEX idx_luxmed_clinics_name');
            });
            migrate();
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
    // stat_entries: model column for AI token rows (added 2026-04-28)
    // Nullable — non-token stats and old token rows that pre-date the column
    // both legitimately have model=NULL.
    {
        const cols = db.prepare('PRAGMA table_info(stat_entries)').all() as { name: string }[];
        if (!cols.some(c => c.name === 'model')) {
            db.exec(`ALTER TABLE stat_entries ADD COLUMN model TEXT`);
        }
    }
    // users: per-user reply budget (added 2026-07-17)
    //
    //   reply_max_tokens    persistent per-user default; NULL = built-in default.
    //   token_grant_until   ISO timestamp; while now < it, replies use the
    //                       elevated token_grant_budget. This is the consent-
    //                       granted window (GrantMoreTokens tool) that covers a
    //                       whole processing chain — tool-result recursion too.
    //   token_grant_budget  the elevated max_tokens active during the window.
    //   token_consent_pending  ISO timestamp; set when the bot asked the user
    //                       for a bigger budget, consumed by the next user-facing
    //                       turn so the bot asks once, not every turn.
    //
    // pending_budget_ask is retained (an earlier auto-escalation design) but no
    // longer read or written; SQLite has no cheap DROP COLUMN, so it stays inert.
    {
        const cols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
        const add = (name: string, type: string) => {
            if (!cols.some(c => c.name === name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
        };
        add('reply_max_tokens', 'INTEGER');
        add('pending_budget_ask', 'INTEGER');
        add('token_grant_until', 'TEXT');
        add('token_grant_budget', 'INTEGER');
        add('token_consent_pending', 'TEXT');
    }
    // luxmed_monitorings: saved transit limit (added 2026-09-25)
    {
        const cols = db.prepare('PRAGMA table_info(luxmed_monitorings)').all() as { name: string }[];
        if (!cols.some(c => c.name === 'max_transit_minutes')) {
            db.exec('ALTER TABLE luxmed_monitorings ADD COLUMN max_transit_minutes INTEGER');
        }
    }
    // Rotate failed sends so one undeliverable chat cannot hide later notices.
    {
        const cols = db.prepare('PRAGMA table_info(luxmed_notification_outbox)').all() as { name: string }[];
        if (!cols.some(c => c.name === 'last_attempt_at')) {
            db.exec('ALTER TABLE luxmed_notification_outbox ADD COLUMN last_attempt_at INTEGER');
        }
    }
    // Pre-coverage snapshots cannot prove that future dates were checked.
    {
        const cols = db.prepare('PRAGMA table_info(luxmed_reservation_snapshots)').all() as { name: string }[];
        if (!cols.some(c => c.name === 'covered_from')) db.exec('ALTER TABLE luxmed_reservation_snapshots ADD COLUMN covered_from INTEGER');
        if (!cols.some(c => c.name === 'covered_to')) db.exec('ALTER TABLE luxmed_reservation_snapshots ADD COLUMN covered_to INTEGER');
    }
    // Old bot images only read luxmed_monitorings.autobook. Once a monitor is
    // smart-enrolled, keep that legacy flag off across image rollbacks.
    {
        const cols = db.prepare('PRAGMA table_info(luxmed_smart_monitors)').all() as { name: string }[];
        if (!cols.some(c => c.name === 'desired_autobook')) db.exec('ALTER TABLE luxmed_smart_monitors ADD COLUMN desired_autobook INTEGER');
        db.transaction(() => {
            db.exec(`UPDATE luxmed_smart_monitors SET desired_autobook=(
                SELECT autobook FROM luxmed_monitorings WHERE id=monitoring_id)
                WHERE desired_autobook IS NULL`);
            db.exec(`UPDATE luxmed_monitorings SET autobook=0 WHERE id IN (
                SELECT monitoring_id FROM luxmed_smart_monitors WHERE desired_autobook IS NOT NULL)`);
        })();
    }
}

export const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS users (
        user_id                INTEGER PRIMARY KEY,
        chat_id                INTEGER,
        goal                   TEXT NOT NULL DEFAULT '',
        timezone               TEXT,
        -- NULL = use the built-in default reply budget.
        reply_max_tokens       INTEGER,
        -- Retained but inert (superseded by the grant-window columns below).
        pending_budget_ask     INTEGER,
        -- Consent-granted elevated-budget window (GrantMoreTokens tool).
        token_grant_until      TEXT,
        token_grant_budget     INTEGER,
        -- Set when the bot asked for more budget; consumed by the next turn.
        token_consent_pending  TEXT
    );

    CREATE TABLE IF NOT EXISTS routines (
        id                TEXT PRIMARY KEY,
        user_id           INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        name              TEXT NOT NULL,
        cron              TEXT NOT NULL,
        default_annoyance TEXT NOT NULL DEFAULT 'low',
        requires_action   INTEGER NOT NULL DEFAULT 1,
        is_active         INTEGER NOT NULL DEFAULT 1,
        is_deleted        INTEGER NOT NULL DEFAULT 0,
        stats_completed   INTEGER NOT NULL DEFAULT 0,
        stats_failed      INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
        id              TEXT PRIMARY KEY,
        user_id         INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        routine_id      TEXT REFERENCES routines(id) ON DELETE SET NULL,
        due_at          TEXT,
        requires_action INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'pending',
        annoyance       TEXT NOT NULL DEFAULT 'low',
        ping_at         TEXT NOT NULL,
        postpone_count  INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory (
        user_id           INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        key               TEXT NOT NULL,
        value             TEXT NOT NULL,
        first_recorded_at TEXT NOT NULL DEFAULT '',
        updated_at        TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS message_history (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id   INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        role      TEXT NOT NULL,
        content   TEXT NOT NULL,
        timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS image_cache (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        file_id     TEXT NOT NULL,
        caption     TEXT,
        description TEXT,
        timestamp   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_addresses (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        label      TEXT NOT NULL,
        address    TEXT NOT NULL,
        lat        REAL NOT NULL,
        lng        REAL NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, label)
    );

    CREATE TABLE IF NOT EXISTS luxmed_clinics (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        address     TEXT,
        lat         REAL,
        lng         REAL,
        city_id     INTEGER,
        geocoded_at TEXT
    );
    CREATE TABLE IF NOT EXISTS luxmed_clinics_by_city (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        address     TEXT,
        lat         REAL,
        lng         REAL,
        city_id     INTEGER NOT NULL,
        geocoded_at TEXT,
        UNIQUE(name, city_id)
    );

    CREATE TABLE IF NOT EXISTS luxmed_accounts (
        user_id    INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL,
        username   TEXT NOT NULL,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS luxmed_preferences (
        user_id            INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
        default_city_id    INTEGER,
        default_city_name  TEXT,
        preferred_time_from TEXT,
        preferred_time_to   TEXT,
        home_lat           REAL,
        home_lng           REAL,
        max_transit_minutes INTEGER DEFAULT 30
    );

    CREATE TABLE IF NOT EXISTS luxmed_monitorings (
        id          TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        account_id  INTEGER NOT NULL,
        service_id  INTEGER NOT NULL,
        service_name TEXT NOT NULL,
        city_id     INTEGER NOT NULL,
        city_name   TEXT NOT NULL,
        clinic_ids  TEXT,
        doctor_ids  TEXT,
        english_only INTEGER NOT NULL DEFAULT 0,
        date_from   TEXT NOT NULL,
        date_to     TEXT NOT NULL,
        time_from   TEXT NOT NULL DEFAULT '07:00',
        time_to     TEXT NOT NULL DEFAULT '21:00',
        autobook    INTEGER NOT NULL DEFAULT 1,
        rebook_if_exists INTEGER NOT NULL DEFAULT 0,
        max_transit_minutes INTEGER,
        active      INTEGER NOT NULL DEFAULT 1,
        last_check  TEXT,
        created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv_cache (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sticker_cache (
        cache_key      TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,
        emojis         TEXT NOT NULL DEFAULT '[]',
        set_name       TEXT,
        description    TEXT NOT NULL,
        short_tag      TEXT NOT NULL DEFAULT '',
        file_id        TEXT,
        analyzed_at    TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        user_corrected INTEGER NOT NULL DEFAULT 0,
        used_count     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS stat_entries (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id   INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        name      TEXT NOT NULL,
        value     REAL NOT NULL,
        unit      TEXT,
        note      TEXT,
        timestamp TEXT NOT NULL,
        model     TEXT
    );
${SMART_SCHEMA_SQL}`;

export const INDEXES_SQL = `
    CREATE INDEX IF NOT EXISTS idx_routines_user ON routines(user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status_ping ON tasks(status, ping_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_routine ON tasks(routine_id);
    CREATE INDEX IF NOT EXISTS idx_messages_user_id_desc ON message_history(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_images_user ON image_cache(user_id);
    CREATE INDEX IF NOT EXISTS idx_stats_user_name_ts ON stat_entries(user_id, name, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_luxmed_monitorings_active ON luxmed_monitorings(active, user_id);
    CREATE INDEX IF NOT EXISTS idx_user_addresses_user ON user_addresses(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_luxmed_clinics_name ON luxmed_clinics(name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_luxmed_clinics_name_city ON luxmed_clinics_by_city(name, city_id);
    CREATE TRIGGER IF NOT EXISTS luxmed_legacy_clinic_city_guard_insert
    AFTER INSERT ON luxmed_clinics
    WHEN EXISTS (SELECT 1 FROM luxmed_clinics_by_city WHERE name=lower(trim(NEW.name)))
    BEGIN
        UPDATE luxmed_clinics SET address=NULL,lat=NULL,lng=NULL,geocoded_at=NULL WHERE id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS luxmed_legacy_clinic_city_guard_update
    AFTER UPDATE OF name,address,lat,lng,geocoded_at ON luxmed_clinics
    WHEN (NEW.address IS NOT NULL OR NEW.lat IS NOT NULL OR NEW.lng IS NOT NULL OR NEW.geocoded_at IS NOT NULL)
        AND EXISTS (SELECT 1 FROM luxmed_clinics_by_city WHERE name=lower(trim(NEW.name)))
    BEGIN
        UPDATE luxmed_clinics SET address=NULL,lat=NULL,lng=NULL,geocoded_at=NULL WHERE id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS luxmed_city_clinic_legacy_guard_insert
    AFTER INSERT ON luxmed_clinics_by_city
    BEGIN
        UPDATE luxmed_clinics SET address=NULL,lat=NULL,lng=NULL,geocoded_at=NULL
        WHERE lower(trim(name))=NEW.name;
    END;
    CREATE INDEX IF NOT EXISTS idx_sticker_cache_kind ON sticker_cache(kind);
    CREATE INDEX IF NOT EXISTS idx_sticker_cache_set_name ON sticker_cache(set_name);
    CREATE INDEX IF NOT EXISTS idx_sticker_cache_used_count ON sticker_cache(used_count DESC);
    CREATE INDEX IF NOT EXISTS idx_stats_name_ts ON stat_entries(name, timestamp DESC);
`;
