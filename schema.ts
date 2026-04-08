/** SQLite schema — single source of truth for database.ts and migrate-to-sqlite.ts */

export const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS users (
        user_id   INTEGER PRIMARY KEY,
        chat_id   INTEGER,
        goal      TEXT NOT NULL DEFAULT '',
        timezone  TEXT
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
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS stat_entries (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id   INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        name      TEXT NOT NULL,
        value     REAL NOT NULL,
        unit      TEXT,
        note      TEXT,
        timestamp TEXT NOT NULL
    );
`;

export const INDEXES_SQL = `
    CREATE INDEX IF NOT EXISTS idx_routines_user ON routines(user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status_ping ON tasks(status, ping_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_routine ON tasks(routine_id);
    CREATE INDEX IF NOT EXISTS idx_messages_user_id_desc ON message_history(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_images_user ON image_cache(user_id);
    CREATE INDEX IF NOT EXISTS idx_stats_user_name_ts ON stat_entries(user_id, name, timestamp DESC);
`;
