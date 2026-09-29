import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { applyColumnMigrations, INDEXES_SQL, SCHEMA_SQL } from '../schema.ts';

// Exact statements from the rollback image (c45c769): its database.ts runs the
// index statement and its userStore.ts prepares the upsert at import time.
const OLD_BOT_CLINIC_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_luxmed_clinics_name_city ON luxmed_clinics(name, city_id);';
const OLD_BOT_CLINIC_UPSERT = `INSERT INTO luxmed_clinics (name, address, lat, lng, city_id, geocoded_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(name, city_id) DO UPDATE SET address = excluded.address, lat = excluded.lat, lng = excluded.lng, geocoded_at = excluded.geocoded_at`;

function freshDatabase(): Database.Database {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    applyColumnMigrations(db);
    db.exec(INDEXES_SQL);
    return db;
}

function oldBotClinicStatement(db: Database.Database, cityId = 1): void {
    db.exec(OLD_BOT_CLINIC_INDEX);
    db.prepare(OLD_BOT_CLINIC_UPSERT).run('same clinic', 'legacy address', 52, 21, cityId, '2026-09-29');
}

function legacyRows(db: Database.Database): unknown[] {
    return db.prepare("SELECT city_id,address,lat FROM luxmed_clinics WHERE name='same clinic' ORDER BY city_id").all();
}

function count(db: Database.Database, sql: string): number {
    return (db.prepare(sql).get() as { n: number }).n;
}

test('city-specific cache permits duplicate names while the old bot contract remains valid', () => {
    const db = freshDatabase();
    try {
        oldBotClinicStatement(db);
        db.prepare('INSERT INTO luxmed_clinics_by_city(name,city_id) VALUES (?,?)').run('same clinic', 1);
        assert.deepEqual(legacyRows(db), [{ city_id: 1, address: null, lat: null }]);
        db.prepare('INSERT INTO luxmed_clinics_by_city(name,city_id) VALUES (?,?)').run('same clinic', 2);
        assert.equal(count(db, "SELECT count(*) AS n FROM luxmed_clinics_by_city WHERE name='same clinic'"), 2);
        // The old image keeps one legacy row per city; the guard triggers keep
        // coordinates off names that the new cache owns.
        oldBotClinicStatement(db, 2);
        oldBotClinicStatement(db, 1);
        assert.deepEqual(legacyRows(db),
            [{ city_id: 1, address: null, lat: null }, { city_id: 2, address: null, lat: null }]);
    } finally { db.close(); }
});

test('rollback image shape with the old unique index migrates and still runs the old upsert', () => {
    const db = new Database(':memory:');
    try {
        // Build the exact c45c769 shape: non-unique name plus its unique index.
        db.exec(SCHEMA_SQL);
        db.exec('DROP TABLE luxmed_clinics');
        db.exec(`CREATE TABLE IF NOT EXISTS luxmed_clinics (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
            address TEXT, lat REAL, lng REAL, city_id INTEGER, geocoded_at TEXT)`);
        db.exec(OLD_BOT_CLINIC_INDEX);
        const oldUpsert = db.prepare(OLD_BOT_CLINIC_UPSERT);
        oldUpsert.run('same clinic', 'city one', 52, 21, 1, '2026-09-28');
        oldUpsert.run('same clinic', 'city two', 50, 19, 2, '2026-09-29');
        // Migrate the way database.ts does.
        db.exec(SCHEMA_SQL);
        applyColumnMigrations(db);
        db.exec(INDEXES_SQL);
        assert.equal((db.prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name='idx_luxmed_clinics_name_city'")
            .get() as { tbl_name: string }).tbl_name, 'luxmed_clinics');
        assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_luxmed_clinics_name'").get(), undefined);
        assert.deepEqual(db.prepare("SELECT city_id,address,lat FROM luxmed_clinics_by_city WHERE name='same clinic' ORDER BY city_id").all(),
            [{ city_id: 1, address: null, lat: null }, { city_id: 2, address: null, lat: null }]);
        // Rollback: the old image's startup statements prepare and run.
        db.exec(OLD_BOT_CLINIC_INDEX);
        const rolledBack = db.prepare(OLD_BOT_CLINIC_UPSERT);
        rolledBack.run('same clinic', 'city one', 52, 21, 1, '2026-09-30');
        rolledBack.run('same clinic', 'city two', 50, 19, 2, '2026-09-30');
        assert.deepEqual(legacyRows(db),
            [{ city_id: 1, address: null, lat: null }, { city_id: 2, address: null, lat: null }]);
        // A second new-image startup is a no-op for this shape.
        db.exec(SCHEMA_SQL);
        applyColumnMigrations(db);
        db.exec(INDEXES_SQL);
        assert.equal(count(db, "SELECT count(*) AS n FROM luxmed_clinics WHERE name='same clinic'"), 2);
    } finally { db.close(); }
});

test('earlier name-unique table and reused index name migrate to the rollback shape', () => {
    const db = new Database(':memory:');
    try {
        db.exec(SCHEMA_SQL);
        db.exec('DROP TABLE luxmed_clinics');
        db.exec(`CREATE TABLE luxmed_clinics (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, address TEXT,
            lat REAL, lng REAL, city_id INTEGER, geocoded_at TEXT)`);
        db.exec('CREATE UNIQUE INDEX idx_luxmed_clinics_name ON luxmed_clinics(name)');
        // An earlier build of the new image put the legacy index name on the city table.
        db.exec('CREATE UNIQUE INDEX idx_luxmed_clinics_name_city ON luxmed_clinics_by_city(name, city_id)');
        db.exec(`CREATE TRIGGER luxmed_city_clinic_legacy_guard_insert AFTER INSERT ON luxmed_clinics_by_city
            BEGIN UPDATE luxmed_clinics SET address=NULL,lat=NULL,lng=NULL,geocoded_at=NULL WHERE lower(trim(name))=NEW.name; END`);
        db.prepare('INSERT INTO luxmed_clinics(name,address,lat,lng,city_id,geocoded_at) VALUES (?,?,?,?,?,?)')
            .run('Same Clinic', 'one', 52, 21, 1, '2026-09-28');
        db.prepare('INSERT INTO luxmed_clinics(name,address,lat,lng,city_id,geocoded_at) VALUES (?,?,?,?,?,?)')
            .run('same clinic ', 'two', 50, 19, 1, '2026-09-29');
        db.prepare('INSERT INTO luxmed_clinics(name,city_id) VALUES (?,?)').run('unknown city', null);
        applyColumnMigrations(db);
        db.exec(INDEXES_SQL);
        const table = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='luxmed_clinics'").get() as { sql: string }).sql;
        assert.doesNotMatch(table, /UNIQUE/i);
        assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_luxmed_clinics_name'").get(), undefined);
        assert.equal((db.prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name='idx_luxmed_clinics_name_city'")
            .get() as { tbl_name: string }).tbl_name, 'luxmed_clinics');
        // Duplicate (name, city) rows collapse to one; the geocoded newer row wins.
        assert.deepEqual(db.prepare("SELECT id,city_id FROM luxmed_clinics WHERE name='same clinic'").all(), [{ id: 2, city_id: 1 }]);
        assert.deepEqual(legacyRows(db), [{ city_id: 1, address: null, lat: null }]);
        assert.equal(count(db, "SELECT count(*) AS n FROM luxmed_clinics_by_city WHERE name='unknown city'"), 0);
        assert.equal(count(db, "SELECT count(*) AS n FROM luxmed_clinics WHERE name='unknown city'"), 1);
        // The recreated city-table trigger still points at luxmed_clinics.
        db.prepare('INSERT INTO luxmed_clinics_by_city(name,city_id) VALUES (?,?)').run('same clinic', 2);
        oldBotClinicStatement(db, 2);
        assert.deepEqual(legacyRows(db),
            [{ city_id: 1, address: null, lat: null }, { city_id: 2, address: null, lat: null }]);
        db.prepare("UPDATE luxmed_clinics_by_city SET lat=51 WHERE name='same clinic' AND city_id=2").run();
        applyColumnMigrations(db);
        assert.equal((db.prepare("SELECT lat FROM luxmed_clinics_by_city WHERE name='same clinic' AND city_id=2").get() as { lat: number }).lat, 51);
    } finally { db.close(); }
});

test('old image upserts cannot import a wrong-city route on return to the new image', () => {
    const db = new Database(':memory:');
    try {
        db.exec(SCHEMA_SQL);
        db.exec(OLD_BOT_CLINIC_INDEX);
        const oldUpsert = db.prepare(OLD_BOT_CLINIC_UPSERT);
        oldUpsert.run('same clinic', 'city one', 52, 21, 1, '2026-09-28');
        oldUpsert.run('same clinic', 'city two', 50, 19, 2, '2026-09-29');
        assert.deepEqual(legacyRows(db),
            [{ city_id: 1, address: 'city one', lat: 52 }, { city_id: 2, address: 'city two', lat: 50 }]);
        applyColumnMigrations(db);
        db.exec(INDEXES_SQL);
        assert.deepEqual(db.prepare("SELECT city_id,address,lat FROM luxmed_clinics_by_city WHERE name='same clinic' ORDER BY city_id").all(),
            [{ city_id: 1, address: null, lat: null }, { city_id: 2, address: null, lat: null }]);
        assert.deepEqual(legacyRows(db),
            [{ city_id: 1, address: null, lat: null }, { city_id: 2, address: null, lat: null }]);
    } finally { db.close(); }
});

test('new clinic cache lookups never reuse another city for the same name', async () => {
    const previousPath = process.env.DB_PATH;
    process.env.DB_PATH = ':memory:';
    try {
        const { saveLuxmedClinic, getLuxmedClinicByName } = await import('../userStore.ts');
        const { default: db } = await import('../database.ts');
        saveLuxmedClinic('Same Clinic', 'one', 52, 21, 1);
        saveLuxmedClinic('Same Clinic', 'two', 50, 19, 2);
        assert.equal(getLuxmedClinicByName('same clinic', 1)?.lat, 52);
        assert.equal(getLuxmedClinicByName('same clinic', 2)?.lat, 50);
        assert.equal(getLuxmedClinicByName('same clinic'), null);
        assert.equal(count(db, "SELECT count(*) AS n FROM luxmed_clinics WHERE name='same clinic'"), 0);
        db.close();
    } finally {
        if (previousPath === undefined) delete process.env.DB_PATH;
        else process.env.DB_PATH = previousPath;
    }
});
