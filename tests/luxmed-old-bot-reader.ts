import assert from 'node:assert/strict';

// Import the old image's real database and prepared statements against the
// Watchtower-preserved volume. No Telegram or provider service starts.
assert.equal(process.env.DB_PATH, '/app/data/db.sqlite');
const { default: db } = await import('../database.ts');
await import('../userStore.ts');
assert.deepEqual(db.prepare("SELECT autobook, active FROM luxmed_monitorings WHERE id='rollback-fixture' AND user_id=424242").get(),
    { autobook: 0, active: 1 });
assert.equal((db.prepare("SELECT count(*) AS n FROM luxmed_clinics WHERE name='fixture clinic'").get() as { n: number }).n, 1);
assert.equal((db.prepare("SELECT count(*) AS n FROM luxmed_clinics_by_city WHERE name='fixture clinic'").get() as { n: number }).n, 2);
db.close();
console.log('Legacy image prepares its store on migrated SQLite and keeps automatic booking disabled.');
