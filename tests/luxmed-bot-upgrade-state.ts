import assert from 'node:assert/strict';
import db from '../database.ts';
// Initializing the real store prepares every production statement.
import '../userStore.ts';

if (process.env.SEED_LEGACY === 'true') {
    db.exec(`
        INSERT INTO users (user_id, goal) VALUES (424242, 'fixture');
        INSERT INTO luxmed_accounts (user_id, account_id, username, created_at)
            VALUES (424242, 424242, 'fixture-user', '2026-07-21T00:00:00Z');
        INSERT INTO user_addresses (user_id, label, address, lat, lng, created_at)
            VALUES (424242, 'home', 'fixture-home', 52, 21, '2026-07-21T00:00:00Z');
        INSERT INTO luxmed_clinics (name, city_id) VALUES ('fixture clinic', 1);
    `);
} else {
    assert.deepEqual(db.prepare('SELECT account_id, username FROM luxmed_accounts WHERE user_id=424242').get(),
        { account_id: 424242, username: 'fixture-user' });
    assert.deepEqual(db.prepare('SELECT address, lat, lng FROM user_addresses WHERE user_id=424242').get(),
        { address: 'fixture-home', lat: 52, lng: 21 });
    // The migrated cache must allow the same clinic name in another city.
    db.prepare('INSERT OR IGNORE INTO luxmed_clinics (name, city_id) VALUES (?, ?)').run('fixture clinic', 2);
    assert.equal((db.prepare("SELECT count(*) AS n FROM luxmed_clinics WHERE name='fixture clinic'").get() as {n: number}).n, 2);
}
db.close();
console.log('Bot database startup and stored account/address preservation passed.');
