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
    // The new cache keeps both cities, while the legacy table keeps the
    // rollback image's (name, city_id) shape and its one seeded row.
    db.prepare('INSERT OR IGNORE INTO luxmed_clinics_by_city (name, city_id) VALUES (?, ?)').run('fixture clinic', 2);
    assert.equal((db.prepare("SELECT count(*) AS n FROM luxmed_clinics_by_city WHERE name='fixture clinic'").get() as {n: number}).n, 2);
    assert.equal((db.prepare("SELECT count(*) AS n FROM luxmed_clinics WHERE name='fixture clinic'").get() as {n: number}).n, 1);
    // Repeated startup preserves uncertain bookings and confirmed user policy.
    const {SmartBookingStore}=await import('../luxmedSmartStore.ts');
    const store=new SmartBookingStore(db);
    if(!store.policy(424242)) {
        const home=store.place(424242,'home','fixture-home',52,21);
        store.verifyLocation(424242,'home',home.revision);
        store.draft(424242,{version:1,timezone:'Europe/Warsaw',originLocationId:'home',windows:[{weekdays:[1,2,3,4,5],from:'08:00',to:'20:00'}],commitments:[],unresolved:[],softPreferences:[],maxTransitMinutes:45,maxTaxiMinutes:30,preparationConfirmed:false});
        const confirmation=store.confirmation(424242);
        assert.equal(store.confirm(424242,confirmation.token,confirmation.revision),true);
        const attempt=store.begin(424242,424242,null,1,'upgrade-fixture',{fixture:true});
        store.outcome(attempt.id,'unknown');
    }
    assert.equal(store.policy(424242)?.state,'confirmed');
    assert.equal(store.pending(424242).length,1);
    assert.equal(store.pending(424242)[0].state,'unknown');
    // Repeated image startup must keep smart intent while an old bot image sees
    // only autobook=0, including a handoff interrupted in activating state.
    if (!db.prepare("SELECT id FROM luxmed_monitorings WHERE id='rollback-fixture'").get()) {
        db.prepare(`INSERT INTO luxmed_monitorings
            (id,user_id,account_id,service_id,service_name,city_id,city_name,date_from,date_to,created_at,autobook)
            VALUES ('rollback-fixture',424242,424242,6,'fixture',1,'Warszawa','2026-10-01','2026-11-01','2026-09-28',1)`).run();
        store.enroll('rollback-fixture',424242);
        db.prepare("UPDATE luxmed_smart_monitors SET state='activating' WHERE monitoring_id='rollback-fixture'").run();
    }
    const {applyColumnMigrations}=await import('../schema.ts');
    applyColumnMigrations(db);
    assert.deepEqual(db.prepare(`SELECT m.autobook,s.desired_autobook FROM luxmed_monitorings m
        JOIN luxmed_smart_monitors s ON s.monitoring_id=m.id WHERE m.id='rollback-fixture'`).get(),
        {autobook:0,desired_autobook:1});
}
db.close();
console.log('Bot database startup and stored account/address preservation passed.');
