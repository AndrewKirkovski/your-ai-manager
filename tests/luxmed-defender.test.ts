import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SCHEMA_SQL, INDEXES_SQL, applyColumnMigrations } from '../schema.ts';
import { zonedTime, type AvailabilityPolicy } from '../luxmedAvailability.ts';
import type { LuxmedTerm } from '../luxmedAdapter.ts';

process.env.DB_PATH = ':memory:';
const { SmartBookingStore, smartStore, requiresPreparation, preparationFacts, snapshotCovers, snapshotUsable } = await import('../luxmedSmartStore.ts');
const { saveLuxmedAccount, createLuxmedMonitoring, getActiveLuxmedMonitoringsByUser } = await import('../userStore.ts');
const { settleLuxmedAccountTransitions } = await import('../tools.luxmed.ts');
const globalDb = (await import('../database.ts')).default;

const policy: AvailabilityPolicy = {
    version: 1, timezone: 'Europe/Warsaw', originLocationId: 'address:home',
    windows: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], from: '08:00', to: '20:00' }],
    commitments: [], unresolved: [], softPreferences: [], maxTransitMinutes: 45,
    maxTaxiMinutes: 30, preparationConfirmed: false,
};

function storeFor(userId: number): SmartBookingStore {
    const db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    db.exec(SCHEMA_SQL); applyColumnMigrations(db); db.exec(INDEXES_SQL);
    db.prepare('INSERT INTO users(user_id) VALUES (?)').run(userId);
    return new SmartBookingStore(db);
}
function verifiedHome(store: SmartBookingStore, userId: number): void {
    const place = store.place(userId, 'address:home', 'Home', 52, 21);
    store.verifyLocation(userId, place.id, place.revision);
}

test('a null Telegram receipt remains queued and failed sends do not starve later notices', async () => {
    const store = storeFor(1);
    for (let n = 0; n < 21; n++) store.notify(`notice:${n}`, 1, `notice ${n}`);
    await store.deliver(async () => null);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM luxmed_notification_outbox WHERE delivered_at IS NOT NULL').get() as { n: number }).n, 0);
    let newestSent = false;
    await store.deliver(async (_userId, message) => {
        if (message === 'notice 20') newestSent = true;
        return { message_id: 1 };
    });
    assert.equal(newestSent, true);
    assert.equal((store.db.prepare("SELECT delivered_at FROM luxmed_notification_outbox WHERE id='notice:20'").get() as { delivered_at: number | null }).delivered_at !== null, true);
    store.db.prepare("UPDATE luxmed_notification_outbox SET last_attempt_at=0 WHERE id='notice:0'").run();
    let retried = false;
    await store.deliver(async (_userId, message) => {
        if (message === 'notice 0') retried = true;
        return { message_id: 2 };
    });
    assert.equal(retried, true);
    store.db.close();
});

test('an old outbox gains the retry rotation column on upgrade', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.exec('DROP TABLE luxmed_notification_outbox');
    db.exec('CREATE TABLE luxmed_notification_outbox (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER)');
    applyColumnMigrations(db);
    const columns = db.prepare('PRAGMA table_info(luxmed_notification_outbox)').all() as { name: string }[];
    assert.ok(columns.some(column => column.name === 'last_attempt_at'));
    db.close();
});

test('switching LuxMed accounts stops old monitors in the same transaction', () => {
    globalDb.prepare('INSERT INTO users(user_id) VALUES (42)').run();
    saveLuxmedAccount(42, 100, 'first');
    createLuxmedMonitoring({
        id: 'old-account-monitor', userId: 42, accountId: 100, serviceId: 6,
        serviceName: 'Visit', cityId: 1, cityName: 'Warszawa', clinicIds: null,
        doctorIds: null, englishOnly: false, dateFrom: '2026-10-01', dateTo: '2026-11-01',
        timeFrom: '08:00', timeTo: '20:00', autobook: true, rebookIfExists: false,
    });
    smartStore.enroll('old-account-monitor', 42);
    globalDb.prepare("UPDATE luxmed_smart_monitors SET state='active' WHERE monitoring_id='old-account-monitor'").run();
    saveLuxmedAccount(42, 200, 'second');
    assert.equal(getActiveLuxmedMonitoringsByUser(42).length, 0);
    assert.equal(smartStore.enrollment('old-account-monitor')?.state, 'paused');
    assert.match(smartStore.enrollment('old-account-monitor')?.status || '', /account changed/i);
    assert.equal(smartStore.accountTransition(42), true);
});

test('sidecar transition hold remains until a fresh list proves old monitors stopped', async () => {
    let calls = 0;
    const oldMonitor = { recordId: 9, cityName: 'Warszawa', clinicName: '', serviceName: 'Visit', doctorName: '', dateFrom: '', dateTo: '', timeFrom: '', timeTo: '', autobook: true, active: true };
    const inconclusive = await settleLuxmedAccountTransitions(42, {
        list: async () => { calls++; return [oldMonitor]; },
        quiesce: async () => { },
    });
    assert.equal(calls, 2);
    assert.equal(inconclusive.length, 1);
    assert.equal(smartStore.accountTransition(42), true);
    const failed = await settleLuxmedAccountTransitions(42, {
        list: async () => [oldMonitor],
        quiesce: async () => { throw new Error('unsupported sidecar'); },
    });
    assert.deepEqual(failed, ['account 100: SIDECAR_CLEANUP_FAILED']);
    assert.equal(smartStore.accountTransition(42), true);
    let active = true;
    const settled = await settleLuxmedAccountTransitions(42, {
        list: async () => active ? [oldMonitor] : [],
        quiesce: async () => { active = false; },
    });
    assert.deepEqual(settled, []);
    assert.equal(smartStore.accountTransition(42), false);
});

test('explicit schedule appointments occupy time independently of linked reminder pings', () => {
    const store = storeFor(2);
    verifiedHome(store, 2);
    store.db.prepare("INSERT INTO tasks(id,user_id,name,ping_at,status,created_at) VALUES ('call',2,'Call','2026-10-06T09:00:00','pending','2026-10-01')").run();
    store.draft(2, policy);
    const confirmation = store.confirmation(2);
    assert.equal(store.confirm(2, confirmation.token, confirmation.revision), true);
    const before = store.policy(2)!.revision;
    store.setScheduleAppointment(2, { id: 'call', name: 'Call', date: '2026-10-06', from: '10:00', to: '11:00', locationId: 'address:home', source: { type: 'task', id: 'call' } });
    assert.equal(store.policy(2)!.revision, before + 1);
    store.db.prepare("UPDATE tasks SET ping_at='2026-10-06T12:00:00' WHERE id='call'").run();
    const start = zonedTime('2026-10-06T00:00:00');
    const end = zonedTime('2026-10-07T00:00:00');
    assert.deepEqual(store.scheduleIntervals(2, start, end).map(i => [i.start, i.end]),
        [[zonedTime('2026-10-06T10:00:00'), zonedTime('2026-10-06T11:00:00')]]);
    assert.equal(store.policy(2)!.state, 'draft');
    assert.equal(store.deleteScheduleAppointment(2, 'call'), true);
    assert.equal(store.scheduleIntervals(2, start, end).length, 0);
    store.db.close();
});

test('schedule recurrences retain local time through daylight saving changes', () => {
    const store = storeFor(3);
    verifiedHome(store, 3);
    store.setScheduleAppointment(3, { id: 'lesson', name: 'Lesson', weekdays: [2], from: '10:00', to: '11:00', locationId: 'address:home' });
    const intervals = store.scheduleIntervals(3, zonedTime('2026-03-24T00:00:00'), zonedTime('2026-04-01T00:00:00'));
    assert.equal(intervals.length, 2);
    assert.deepEqual(intervals.map(i => new Date(i.start).toISOString()), ['2026-03-24T09:00:00.000Z', '2026-03-31T08:00:00.000Z']);
    store.db.close();
});

function preparationTerm(serviceId = 6, clinicId = 2, text = 'Do not eat for 8 hours'): LuxmedTerm {
    return { additionalData: { isPreparationRequired: true, preparationItems: [{ header: 'Fasting', text }] },
        term: { serviceId, clinicId, clinicGroupId: clinicId, clinic: 'Clinic',
            dateTimeFrom: { dateTimeLocal: '2026-10-06T12:00:00' }, dateTimeTo: { dateTimeLocal: '2026-10-06T12:30:00' },
            doctor: { id: 3, name: 'Doctor' }, isTelemedicine: false, isAdditional: false, roomId: 4, scheduleId: 5 } };
}

test('preparation approval is bound to exact clinic, service, items and policy revision', () => {
    const store = storeFor(4);
    verifiedHome(store, 4);
    store.draft(4, policy);
    const confirmation = store.confirmation(4);
    const term = preparationTerm();
    assert.equal(requiresPreparation(term), true);
    assert.equal(store.isPreparationConfirmed(4, confirmation.revision, term), false);
    assert.throws(() => store.stagePreparation(4, 'wrong-token', confirmation.revision, [term]));
    assert.deepEqual(store.stagePreparation(4, confirmation.token, confirmation.revision, [term, term]).length, 1);
    assert.equal(store.isPreparationConfirmed(4, confirmation.revision, term), false);
    assert.equal(store.confirm(4, confirmation.token, confirmation.revision), true);
    assert.equal(store.isPreparationConfirmed(4, confirmation.revision, term), true);
    assert.equal(store.isPreparationConfirmed(4, confirmation.revision, preparationTerm(7)), false);
    assert.equal(store.isPreparationConfirmed(4, confirmation.revision, preparationTerm(6, 3)), false);
    assert.equal(store.isPreparationConfirmed(4, confirmation.revision, preparationTerm(6, 2, 'Do not eat for 10 hours')), false);
    store.draft(4, { ...policy, softPreferences: ['Morning'] });
    assert.equal(store.isPreparationConfirmed(4, confirmation.revision, term), false);
    store.db.close();
});

test('missing and inconsistent preparation details cannot be approved', () => {
    const store = storeFor(5);
    verifiedHome(store, 5);
    store.draft(5, policy);
    const confirmation = store.confirmation(5);
    const empty = preparationTerm(); empty.additionalData.preparationItems = [];
    const missingText = preparationTerm(); missingText.additionalData.preparationItems = [{ header: 'Fasting' }];
    const contradictory = preparationTerm(); contradictory.additionalData.isPreparationRequired = false;
    const ordinary = preparationTerm(); ordinary.additionalData = { isPreparationRequired: false, preparationItems: [] };
    const impeded = preparationTerm(); impeded.additionalData = { isPreparationRequired: false, preparationItems: [] }; impeded.term.impedimentText = 'Ask the clinic first';
    const impededWithItems = preparationTerm(); impededWithItems.term.impedimentText = 'Ask the clinic first';
    assert.equal(preparationFacts(empty), null);
    assert.equal(preparationFacts(missingText), null);
    assert.equal(requiresPreparation(contradictory), true);
    assert.equal(requiresPreparation(ordinary), false);
    assert.equal(requiresPreparation(impeded), true);
    assert.equal(preparationFacts(impededWithItems), null);
    assert.deepEqual(store.stagePreparation(5, confirmation.token, confirmation.revision, [empty, missingText]), []);
    assert.equal(store.confirm(5, confirmation.token, confirmation.revision), true);
    assert.equal(store.isPreparationConfirmed(5, confirmation.revision, empty), false);
    assert.equal(store.isPreparationConfirmed(5, confirmation.revision, missingText), false);
    assert.equal(store.isPreparationConfirmed(5, confirmation.revision, ordinary), true);
    assert.equal(store.isPreparationConfirmed(5, confirmation.revision, impeded), false);
    store.db.close();
});

test('an invalidated confirmation never commits staged preparation', () => {
    const store = storeFor(6);
    verifiedHome(store, 6);
    store.draft(6, policy);
    const first = store.confirmation(6);
    const term = preparationTerm();
    store.stagePreparation(6, first.token, first.revision, [term]);
    const hold = store.hold(6)!;
    assert.equal(store.confirm(6, first.token, first.revision), false);
    assert.equal(store.release(6, hold), true);
    const second = store.confirmation(6);
    assert.equal(store.confirm(6, second.token, second.revision), true);
    assert.equal(store.isPreparationConfirmed(6, second.revision, term), false);
    store.db.close();
});

test('old reservation snapshots have unknown coverage after migration', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.exec('DROP TABLE luxmed_reservation_snapshots');
    db.exec('CREATE TABLE luxmed_reservation_snapshots (account_id INTEGER PRIMARY KEY, revision TEXT NOT NULL, fetched_at INTEGER NOT NULL, value TEXT NOT NULL)');
    db.prepare("INSERT INTO luxmed_reservation_snapshots(account_id,revision,fetched_at,value) VALUES (1,'old',123,'[]')").run();
    applyColumnMigrations(db);
    const old = new SmartBookingStore(db).snapshot(1);
    assert.equal(old?.coveredFrom, null);
    assert.equal(old?.coveredTo, null);
    assert.equal(snapshotCovers(old!, 100, 200), false);
    db.close();
});

test('narrow reservation refresh retains observations outside its covered dates', () => {
    const store = storeFor(7);
    const dayOne = { from: zonedTime('2026-10-06T00:00:00'), to: zonedTime('2026-10-07T00:00:00') };
    const dayTwo = { from: dayOne.to, to: zonedTime('2026-10-08T00:00:00') };
    const attempt = store.begin(7, 7, null, 1, 'slot', { slot: { start: zonedTime('2026-10-06T12:00:00') } });
    store.succeed(attempt.id, 77, { id: 'reservation:77', start: zonedTime('2026-10-06T12:00:00'), end: zonedTime('2026-10-06T12:30:00') }, 'Booked');
    assert.throws(() => (store as any).saveSnapshot(7, []));
    assert.throws(() => store.saveSnapshot(7, [], { from: dayOne.to, to: dayOne.from }));
    store.saveSnapshot(7, [{ eventId: 77, date: '2026-10-06T12:00:00' }], dayOne);
    const first = store.snapshot(7)!;
    assert.equal(snapshotCovers(first, dayOne.from, dayOne.to), true);
    assert.equal(snapshotCovers(first, dayTwo.from, dayTwo.to), false);
    assert.equal(snapshotUsable(first, dayOne.from, dayOne.to, first.fetchedAt + 60000, 60000), true);
    assert.equal(snapshotUsable(first, dayOne.from, dayOne.to, first.fetchedAt + 60001, 60000), false);
    assert.equal(snapshotUsable(first, dayTwo.from, dayTwo.to, first.fetchedAt, 60000), false);
    assert.equal(snapshotUsable(first, dayOne.from, dayOne.to, first.fetchedAt - 1, 60000), false);
    store.saveSnapshot(7, [], dayTwo);
    assert.equal(store.blocks(7).length, 1);
    assert.equal(store.snapshot(7)!.value.length, 1);
    assert.equal(snapshotCovers(store.snapshot(7), dayOne.from, dayOne.to), false);
    store.saveSnapshot(7, [], dayOne);
    // A complete feed response can still be temporarily inconsistent with a
    // successful booking receipt. Missing from one refresh is not cancellation.
    assert.equal(store.blocks(7).length, 1);
    assert.equal(store.snapshot(7)!.value.length, 1);
    store.confirmCancellation(7, 77, zonedTime('2026-10-06T12:00:00'));
    assert.equal(store.blocks(7).length, 0);
    assert.equal(store.snapshot(7)!.value.length, 0);
    store.db.close();
});
