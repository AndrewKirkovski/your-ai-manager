export const SMART_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS luxmed_availability (
    user_id INTEGER PRIMARY KEY REFERENCES users(user_id), revision INTEGER NOT NULL,
    policy TEXT NOT NULL, state TEXT NOT NULL, hold_token TEXT,
    confirmation_token TEXT, confirmation_expires INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS luxmed_sidecar_monitor_previews (
    user_id INTEGER PRIMARY KEY REFERENCES users(user_id), monitoring_id TEXT NOT NULL,
    account_id INTEGER NOT NULL, policy_revision INTEGER NOT NULL,
    confirmation_token TEXT NOT NULL, auto_monitor_ids TEXT NOT NULL,
    monitor_fingerprint TEXT, provider_service_name TEXT, provider_identity_fingerprint TEXT,
    clinic_identity_fingerprint TEXT
);
CREATE TABLE IF NOT EXISTS luxmed_smart_monitors (
    monitoring_id TEXT PRIMARY KEY REFERENCES luxmed_monitorings(id), user_id INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft', status TEXT NOT NULL DEFAULT 'When can you book?',
    next_check INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
    desired_autobook INTEGER, confirmed_fingerprint TEXT,
    confirmed_provider_fingerprint TEXT, confirmed_clinic_fingerprint TEXT
);
CREATE TABLE IF NOT EXISTS luxmed_smart_places (
    user_id INTEGER NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL,
    address TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
    PRIMARY KEY(user_id, id)
);
CREATE TABLE IF NOT EXISTS luxmed_smart_clinic_bindings (
    user_id INTEGER NOT NULL, location_id TEXT NOT NULL, source_label TEXT NOT NULL,
    place_revision TEXT NOT NULL, verified_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, location_id)
);
CREATE TABLE IF NOT EXISTS luxmed_smart_location_bindings (
    user_id INTEGER NOT NULL, location_id TEXT NOT NULL, place_revision TEXT NOT NULL,
    verified_at INTEGER NOT NULL, PRIMARY KEY(user_id, location_id)
);
CREATE TABLE IF NOT EXISTS luxmed_travel_estimates (
    cache_key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS luxmed_reservation_snapshots (
    account_id INTEGER PRIMARY KEY, revision TEXT NOT NULL, fetched_at INTEGER NOT NULL,
    value TEXT NOT NULL, covered_from INTEGER, covered_to INTEGER
);
CREATE TABLE IF NOT EXISTS luxmed_booking_attempts (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
    monitoring_id TEXT, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
    policy_revision INTEGER NOT NULL, payload TEXT NOT NULL, reservation_id INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, acknowledged_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_luxmed_attempt_unresolved_account
    ON luxmed_booking_attempts(account_id) WHERE state IN ('pending','unknown');
CREATE UNIQUE INDEX IF NOT EXISTS idx_luxmed_attempt_unresolved_user
    ON luxmed_booking_attempts(user_id) WHERE state IN ('pending','unknown');
CREATE TABLE IF NOT EXISTS luxmed_booking_blocks (
    attempt_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, reservation_id INTEGER NOT NULL,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS luxmed_cancelled_reservations (
    account_id INTEGER NOT NULL, reservation_id INTEGER NOT NULL,
    start_at INTEGER, cancelled_at INTEGER NOT NULL,
    PRIMARY KEY(account_id, reservation_id)
);
CREATE TABLE IF NOT EXISTS luxmed_schedule_appointments (
    user_id INTEGER NOT NULL REFERENCES users(user_id), id TEXT NOT NULL,
    value TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, id)
);
CREATE TABLE IF NOT EXISTS luxmed_account_transitions (
    user_id INTEGER NOT NULL REFERENCES users(user_id), old_account_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, old_account_id)
);
CREATE TABLE IF NOT EXISTS luxmed_preparation_confirmations (
    user_id INTEGER NOT NULL REFERENCES users(user_id), policy_revision INTEGER NOT NULL,
    service_id INTEGER NOT NULL, clinic_id INTEGER NOT NULL, items_digest TEXT NOT NULL,
    items_json TEXT NOT NULL, state TEXT NOT NULL, confirmation_token TEXT,
    confirmed_at INTEGER,
    PRIMARY KEY(user_id, policy_revision, service_id, clinic_id, items_digest)
);
CREATE TABLE IF NOT EXISTS luxmed_notification_outbox (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, message TEXT NOT NULL,
    created_at INTEGER NOT NULL, delivered_at INTEGER, last_attempt_at INTEGER
);
`;
