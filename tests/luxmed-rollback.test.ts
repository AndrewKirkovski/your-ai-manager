import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { applyColumnMigrations, INDEXES_SQL, SCHEMA_SQL } from '../schema.ts';

function freshDatabase(): Database.Database {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    applyColumnMigrations(db);
    db.exec(INDEXES_SQL);
    return db;
}

function oldBotClinicStatement(db: Database.Database): void {
    // The old image prepares this statement while importing userStore.ts.
    db.prepare(`INSERT INTO luxmed_clinics (name,address,lat,lng,city_id,geocoded_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET address=excluded.address`).run(
        'same clinic', 'legacy address', 52, 21, 1, '2026-09-29');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_luxmed_clinics_name ON luxmed_clinics(name)');
}

test('city-specific cache permits duplicate names while the old bot contract remains valid', () => {
    const db = freshDatabase();
    try {
        oldBotClinicStatement(db);
        db.prepare('INSERT INTO luxmed_clinics_by_city(name,city_id) VALUES (?,?)').run('same clinic', 1);
        assert.equal((db.prepare("SELECT lat FROM luxmed_clinics WHERE name='same clinic'").get() as { lat: number | null }).lat, null);
        db.prepare('INSERT INTO luxmed_clinics_by_city(name,city_id) VALUES (?,?)').run('same clinic', 2);
        assert.equal((db.prepare("SELECT count(*) AS n FROM luxmed_clinics_by_city WHERE name='same clinic'").get() as { n: number }).n, 2);
        assert.equal((db.prepare("SELECT count(*) AS n FROM luxmed_clinics WHERE name='same clinic'").get() as { n: number }).n, 1);
        assert.equal((db.prepare("SELECT lat FROM luxmed_clinics WHERE name='same clinic'").get() as { lat: number | null }).lat, null);
        oldBotClinicStatement(db);
        assert.equal((db.prepare("SELECT lat FROM luxmed_clinics WHERE name='same clinic'").get() as { lat: number | null }).lat, null);
    } finally { db.close(); }
});

test('interim duplicate-name cache migrates both cities without making old startup ambiguous', () => {
    const db = new Database(':memory:');
    try {
        db.exec(SCHEMA_SQL);
        db.exec('DROP TABLE luxmed_clinics');
        db.exec(`CREATE TABLE luxmed_clinics (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT,
            lat REAL, lng REAL, city_id INTEGER, geocoded_at TEXT)`);
        db.prepare('INSERT INTO luxmed_clinics(name,address,lat,lng,city_id,geocoded_at) VALUES (?,?,?,?,?,?)')
            .run('Same Clinic', 'one', 52, 21, 1, '2026-09-28');
        db.prepare('INSERT INTO luxmed_clinics(name,address,lat,lng,city_id,geocoded_at) VALUES (?,?,?,?,?,?)')
            .run('Same Clinic', 'two', 50, 19, 2, '2026-09-29');
        db.prepare('INSERT INTO luxmed_clinics(name,city_id) VALUES (?,?)').run('unknown city', null);
        applyColumnMigrations(db);
        db.exec(INDEXES_SQL);
        oldBotClinicStatement(db);
        assert.deepEqual(db.prepare("SELECT city_id,address,lat FROM luxmed_clinics_by_city WHERE name='same clinic' ORDER BY city_id").all(),
            [{ city_id: 1, address: null, lat: null }, { city_id: 2, address: null, lat: null }]);
        assert.equal((db.prepare("SELECT count(*) AS n FROM luxmed_clinics WHERE name='same clinic'").get() as { n: number }).n, 1);
        assert.equal((db.prepare("SELECT lat FROM luxmed_clinics WHERE name='same clinic'").get() as { lat: number | null }).lat, null);
        assert.equal((db.prepare("SELECT count(*) AS n FROM luxmed_clinics_by_city WHERE name='unknown city'").get() as { n: number }).n, 0);
        db.prepare("UPDATE luxmed_clinics_by_city SET lat=51 WHERE name='same clinic' AND city_id=2").run();
        applyColumnMigrations(db);
        assert.equal((db.prepare("SELECT lat FROM luxmed_clinics_by_city WHERE name='same clinic' AND city_id=2").get() as { lat: number }).lat, 51);
    } finally { db.close(); }
});

test('old name-only upsert cannot import a wrong-city route on return to the new image', () => {
    const db = new Database(':memory:');
    try {
        db.exec(SCHEMA_SQL);
        const oldUpsert = db.prepare(`INSERT INTO luxmed_clinics(name,address,lat,lng,city_id,geocoded_at)
            VALUES (?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET
            address=excluded.address,lat=excluded.lat,lng=excluded.lng,geocoded_at=excluded.geocoded_at`);
        oldUpsert.run('same clinic', 'city one', 52, 21, 1, '2026-09-28');
        oldUpsert.run('same clinic', 'city two', 50, 19, 2, '2026-09-29');
        assert.deepEqual(db.prepare("SELECT city_id,address,lat FROM luxmed_clinics WHERE name='same clinic'").get(),
            { city_id: 1, address: 'city two', lat: 50 });
        applyColumnMigrations(db);
        db.exec(INDEXES_SQL);
        assert.deepEqual(db.prepare("SELECT city_id,address,lat FROM luxmed_clinics_by_city WHERE name='same clinic'").get(),
            { city_id: 1, address: null, lat: null });
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
        assert.equal((db.prepare("SELECT count(*) AS n FROM luxmed_clinics WHERE name='same clinic'").get() as { n: number }).n, 0);
        db.close();
    } finally {
        if (previousPath === undefined) delete process.env.DB_PATH;
        else process.env.DB_PATH = previousPath;
    }
});
