import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { SCHEMA_SQL, INDEXES_SQL, applyColumnMigrations } from '../schema.ts';
import { validatePolicy, evaluateSlot, busyIntervals, expandRule, zonedTime, usableEstimate, compareFeasible, type AvailabilityPolicy, type Place, type Slot, type TravelQuery, type TravelEstimate } from '../luxmedAvailability.ts';
import { TravelCache, profileQueries } from '../luxmedTravel.ts';
import { computeGoogleRoute, providerStreetMatches, providerCityMatches, resolveStreetAddress } from '../googleRoutes.ts';
import { rankWithJev } from '../luxmedJev.ts';
import { AccountQueue } from '../luxmedAccountQueue.ts';
import type { LuxmedMonitoringConfig } from '../userStore.ts';
import type { LuxmedTerm } from '../luxmedAdapter.ts';

// Dynamic imports ensure tests can never open the operator's bot.sqlite.
process.env.DB_PATH = ':memory:';
const { SmartBookingStore } = await import('../luxmedSmartStore.ts');
const { SmartBookingCoordinator, smartDependencies, slotFromTerm, matchesMonitor } = await import('../luxmedSmartBooking.ts');
const { saveUserAddress, saveLuxmedAccount } = await import('../userStore.ts');
const { LuxmedBookSlot } = await import('../tools.luxmed.ts');
const globalDb = (await import('../database.ts')).default;
const now = zonedTime('2026-10-05T07:00:00');
const at = (value: string) => zonedTime(`2026-10-06T${value}:00`);
const home: Place = { id: 'home', revision: 'home-v1', address: 'Home', lat: 52, lng: 21 };
const clinic: Place = { id: 'clinic:1:2', revision: 'clinic-v1', address: 'Testowa 2, Warszawa', lat: 52.1, lng: 21.1 };
const school: Place = { id: 'school', revision: 'school-v1', address: 'School', lat: 52.2, lng: 21.2 };
const places = new Map([home, clinic, school].map(p => [p.id, p]));
const policy: AvailabilityPolicy = { version: 1, timezone: 'Europe/Warsaw', originLocationId: 'home', windows: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], from: '08:00', to: '20:00' }], commitments: [], unresolved: [], softPreferences: [], maxTransitMinutes: 45, maxTaxiMinutes: 30, preparationConfirmed: false };
const slot = (time = '12:00', end = '12:30'): Slot => ({ id: time, start: at(time), end: at(end), locationId: clinic.id, telemedicine: false, preparationRequired: false });
function estimate(q: TravelQuery, seconds = 25 * 60, cached = false, fetchedAt = now): TravelEstimate {
    const departure = q.kind === 'arrive' ? q.at - seconds * 1000 : q.at;
    return { query: q, status: 'ok', departure, arrival: departure + seconds * 1000, durationSeconds: seconds, distanceMeters: 6000, fetchedAt, cached };
}
function memoryStore() {
    const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); db.exec(SCHEMA_SQL); applyColumnMigrations(db); db.exec(INDEXES_SQL);
    db.prepare('INSERT INTO users(user_id) VALUES (1)').run();
    return new SmartBookingStore(db);
}

test('policy validation rejects unresolved shape, missing limits and invented time zones', () => {
    assert.equal(validatePolicy(policy).timezone, 'Europe/Warsaw');
    assert.throws(() => validatePolicy({ ...policy, maxTaxiMinutes: undefined }));
    assert.throws(() => validatePolicy({ ...policy, timezone: 'UTC' }));
    assert.throws(() => validatePolicy({ ...policy, windows: [{ date: '2026-02-30', from: '08:00', to: '11:00' }] }));
});
test('a one-off commitment cannot disappear behind recurrence bounds or exceptions', () => {
    const friday = { id: 'trip', name: 'Away', date: '2026-10-09', from: '08:00', to: '20:00', locationId: 'home' };
    assert.throws(() => validatePolicy({ ...policy, commitments: [{ ...friday, validFrom: '2026-10-10' }] }), /one-off date/);
    assert.throws(() => validatePolicy({ ...policy, commitments: [{ ...friday, validTo: '2026-10-08' }] }), /one-off date/);
    assert.throws(() => validatePolicy({ ...policy, commitments: [{ ...friday, exceptDates: ['2026-10-09'] }] }), /one-off date/);
    assert.equal(validatePolicy({ ...policy, commitments: [friday] }).commitments.length, 1);
});
test('Tuesday recurrence keeps 11:00 through DST and excludes a one-off exception', () => {
    const times = expandRule({ weekdays: [2], from: '09:00', to: '11:00', exceptDates: ['2026-10-27'] }, zonedTime('2026-10-19'), zonedTime('2026-11-05'));
    assert.deepEqual(times.map(t => DateTime.fromMillis(t.end, { zone: 'Europe/Warsaw' }).toFormat('yyyy-MM-dd HH:mm')), ['2026-10-20 11:00', '2026-11-03 11:00']);
    assert.notEqual(DateTime.fromMillis(times[0].end, { zone: 'Europe/Warsaw' }).offset, DateTime.fromMillis(times[1].end, { zone: 'Europe/Warsaw' }).offset);
});
test('ambiguous DST busy times block the day rather than freeing it', () => {
    const p = { ...policy, commitments: [{ id: 'dst', name: 'Travel', date: '2026-10-25', from: '02:15', to: '03:15', locationId: 'home' }] };
    const busy = busyIntervals(p, zonedTime('2026-10-25'), zonedTime('2026-10-26'));
    assert.equal(busy.length, 1);
    assert.equal(DateTime.fromMillis(busy[0].start, { zone: 'Europe/Warsaw' }).hour, 0);
    assert.equal(busy[0].end - busy[0].start, 25 * 3600000);
});
test('a call ending at 11 cannot book at 11 or 11:30; 11:40 includes travel and check-in', async () => {
    const busy = [{ id: 'call', start: at('09:00'), end: at('11:00'), locationId: 'home' }];
    const route = async (q: TravelQuery) => estimate(q);
    assert.equal(await evaluateSlot(slot('11:00', '11:20'), policy, places, busy, route, now), null);
    assert.equal(await evaluateSlot(slot('11:30', '12:00'), policy, places, busy, route, now), null);
    assert.ok(await evaluateSlot(slot('11:40', '12:00'), policy, places, busy, route, now));
});
test('overlapping commitments at different places leave the journey origin unknown', async () => {
    const busy = [
        { id: 'call', start: at('09:00'), end: at('11:00'), locationId: 'home' },
        { id: 'lesson', start: at('10:00'), end: at('11:00'), locationId: 'school' },
    ];
    assert.equal(await evaluateSlot(slot('11:40', '12:10'), policy, places, busy, async q => estimate(q), now), null);
});
test('a commitment away from home cannot establish the next day journey endpoints', async () => {
    const route = async (q: TravelQuery) => estimate(q, 25 * 60);
    const previousDay = [{ id: 'lesson', start: zonedTime('2026-10-05T18:00'), end: zonedTime('2026-10-05T19:00'), locationId: 'school' }];
    const nextDay = [{ id: 'lesson', start: zonedTime('2026-10-07T09:00'), end: zonedTime('2026-10-07T10:00'), locationId: 'school' }];
    assert.equal(await evaluateSlot(slot(), policy, places, previousDay, route, now), null);
    assert.equal(await evaluateSlot(slot(), policy, places, nextDay, route, now), null);
    const sameDay = [{ id: 'lesson', start: at('09:00'), end: at('11:00'), locationId: 'school' }];
    assert.ok(await evaluateSlot(slot(), policy, places, sameDay, route, now));
});
test('Friday away blocks only that Friday and unresolved schedule questions block booking', async () => {
    const friday = { ...policy, commitments: [{ id: 'trip', name: 'Away', date: '2026-10-09', from: '00:00', to: '23:59' }] };
    const candidate = { ...slot(), start: zonedTime('2026-10-09T12:00'), end: zonedTime('2026-10-09T12:30') };
    assert.equal(await evaluateSlot(candidate, friday, places, busyIntervals(friday, candidate.start - 86400000, candidate.end + 86400000), async q => estimate(q), now), null);
    assert.ok(await evaluateSlot(slot(), friday, places, [], async q => estimate(q), now));
    assert.equal(await evaluateSlot(slot(), { ...policy, unresolved: ['Which Friday?'] }, places, [], async q => estimate(q), now), null);
});
test('return travel uses the next commitment location and rejects insufficient time', async () => {
    const busy = [{ id: 'class', start: at('13:00'), end: at('14:00'), locationId: 'school' }];
    const queried: TravelQuery[] = [];
    const route = async (q: TravelQuery) => { queried.push(q); return estimate(q, 30 * 60); };
    assert.equal(await evaluateSlot(slot(), policy, places, busy, route, now), null);
    assert.ok(queried.some(q => q.from.id === clinic.id && q.to.id === 'school'));
});
test('public inbound and taxi outbound work; pickup time is included', async () => {
    const busy = [{ id: 'class', start: at('13:05'), end: at('14:00'), locationId: 'school' }];
    const route = async (q: TravelQuery) => estimate(q, q.from.id === clinic.id ? (q.mode === 'transit' ? 40 : 15) * 60 : 25 * 60);
    const result = await evaluateSlot(slot(), policy, places, busy, route, now);
    assert.equal(result?.taxiLegs, 1);
    assert.equal(result?.returnAt, at('13:00'));
});
test('a hung transit route cannot hide a verified taxi within the candidate deadline', async () => {
    const began = performance.now();
    const result = await evaluateSlot(slot(), policy, places, [], q =>
        q.mode === 'transit' ? new Promise<TravelEstimate>(() => { }) : Promise.resolve(estimate(q, 15 * 60)), now);
    assert.equal(result?.taxiLegs, 2);
    assert.ok(performance.now() - began < 1700);
});
test('unknown location, preparation and duration never pass; telemedicine still occupies time', async () => {
    const route = async (q: TravelQuery) => estimate(q);
    assert.equal(await evaluateSlot({ ...slot(), end: NaN }, policy, places, [], route, now), null);
    assert.equal(await evaluateSlot({ ...slot(), preparationRequired: true }, policy, places, [], route, now), null);
    assert.equal(await evaluateSlot(slot(), policy, new Map([['home', home]]), [], route, now), null);
    let queries = 0;
    assert.ok(await evaluateSlot({ ...slot(), telemedicine: true }, policy, places, [], async q => { queries++; return estimate(q); }, now));
    assert.equal(queries, 0);
    assert.equal(await evaluateSlot({ ...slot(), telemedicine: true }, policy, places, [{ id: 'call', start: at('11:50'), end: at('12:05'), locationId: 'home' }], route, now), null);
});
test('profiles cover 36 directed samples with separate weekday, Saturday and Sunday times', () => {
    const profiles = profileQueries(home, clinic, now);
    assert.equal(profiles.length, 36);
    assert.deepEqual([...new Set(profiles.map(q => DateTime.fromMillis(q.at, { zone: 'Europe/Warsaw' }).weekday))].sort(), [2, 6, 7]);
    assert.equal(new Set(profiles.map(q => JSON.stringify(q))).size, 36);
});
test('route eligibility checks date, age, address revision, mode and profile status', () => {
    const q: TravelQuery = { from: home, to: clinic, mode: 'transit', kind: 'depart', at: at('12:00') };
    const e = estimate(q);
    assert.ok(usableEstimate(e, q, now));
    assert.equal(usableEstimate({ ...e, fetchedAt: now - 25 * 3600000 }, q, now), false);
    assert.equal(usableEstimate({ ...e, query: { ...q, profile: true } }, q, now), false);
    assert.equal(usableEstimate(e, { ...q, from: { ...home, revision: 'changed' } }, now), false);
    assert.equal(usableEstimate(e, { ...q, at: q.at + 86400000 }, now), false);
    assert.equal(usableEstimate(e, { ...q, mode: 'taxi' }, now), false);
    assert.equal(usableEstimate({ ...e, fetchedAt: q.at - 20 * 60000 }, q, q.at - 5 * 60000), false);
});
test('lazy cache returns old estimate immediately and coalesces live refresh', async () => {
    const store = memoryStore(); let clock = now, calls = 0; let resolve: ((e: TravelEstimate) => void) | undefined;
    const q: TravelQuery = { from: home, to: clinic, mode: 'transit', kind: 'depart', at: at('12:00') };
    const cache = new TravelCache('1', store.db, true, async (query) => { calls++; if (calls === 1) return estimate(query, 1500, false, clock); return new Promise(r => { resolve = r; }); }, () => clock);
    await cache.lookup(q); clock += 6 * 60000;
    const start = performance.now(); const old = await cache.lookup(q);
    assert.ok(performance.now() - start < 100); assert.equal(old?.cached, true);
    await cache.lookup(q); assert.equal(calls, 2);
    resolve!(estimate(q, 1800, false, clock)); await new Promise(r => setTimeout(r, 0));
    assert.equal(cache.previous(q)?.durationSeconds, 1800);
    store.db.close();
});
test('no caching permission means no persistent Google estimates', async () => {
    const store = memoryStore(); const q: TravelQuery = { from: home, to: clinic, mode: 'taxi', kind: 'depart', at: at('12:00') };
    const cache = new TravelCache('1', store.db, false, async q => estimate(q), () => now);
    await cache.lookup(q); await cache.lookup(q);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM luxmed_travel_estimates').get().n, 0);
    store.db.close();
});
test('Google transit parser includes initial/final walks and actual service departure', async () => {
    const q: TravelQuery = { from: home, to: clinic, mode: 'transit', kind: 'depart', at: at('11:00') };
    const e = await computeGoogleRoute(q, { apiKey: 'fixture', now: () => now, fetch: async () => new Response(JSON.stringify({ routes: [{ duration: '2100s', distanceMeters: 4000, legs: [{ steps: [{ travelMode: 'WALK', staticDuration: '300s' }, { travelMode: 'TRANSIT', transitDetails: { stopDetails: { departureTime: new Date(at('11:10')).toISOString(), arrivalTime: new Date(at('11:30')).toISOString() } } }, { travelMode: 'WALK', staticDuration: '300s' }] }] }] })) });
    assert.equal(e.departure, at('11:05')); assert.equal(e.arrival, at('11:35')); assert.equal(e.durationSeconds, 2100);
});
test('Google driving request includes departure time and traffic model', async () => {
    let body: any;
    const q: TravelQuery = { from: home, to: clinic, mode: 'taxi', kind: 'depart', at: at('11:00') };
    const e = await computeGoogleRoute(q, { apiKey: 'fixture', now: () => now, fetch: async (_url, init) => { body = JSON.parse(init!.body as string); return new Response(JSON.stringify({ routes: [{ duration: '900s', distanceMeters: 4000 }] })); } });
    assert.equal(body.travelMode, 'DRIVE'); assert.equal(body.routingPreference, 'TRAFFIC_AWARE_OPTIMAL'); assert.ok(body.departureTime); assert.equal(e.durationSeconds, 900);
});
test('arrival-by taxi only returns a departure verified by a Google traffic response', async () => {
    const departures: number[] = [];
    const q: TravelQuery = { from: home, to: clinic, mode: 'taxi', kind: 'arrive', at: at('11:30') };
    const e = await computeGoogleRoute(q, { apiKey: 'fixture', now: () => at('10:00'), fetch: async (_url, init) => {
        departures.push(Date.parse(JSON.parse(init!.body as string).departureTime));
        return new Response(JSON.stringify({ routes: [{ duration: '1500s', distanceMeters: 4000 }] }));
    } });
    assert.deepEqual(departures, [at('11:15'), at('11:05')]);
    assert.equal(e.status, 'ok');
    assert.equal(e.departure, departures.at(-1));
    assert.equal(e.arrival, at('11:30'));
});
test('arrival-by taxi probes a later departure when the first verified drive arrives early', async () => {
    const departures: number[] = [];
    const q: TravelQuery = { from: home, to: clinic, mode: 'taxi', kind: 'arrive', at: at('11:30') };
    const e = await computeGoogleRoute(q, { apiKey: 'fixture', now: () => at('10:00'), fetch: async (_url, init) => {
        departures.push(Date.parse(JSON.parse(init!.body as string).departureTime));
        return new Response(JSON.stringify({ routes: [{ duration: '600s', distanceMeters: 2000 }] }));
    } });
    assert.deepEqual(departures, [at('11:15'), at('11:20')]);
    assert.equal(e.departure, at('11:20'));
    assert.equal(e.arrival, at('11:30'));
});
test('arrival-by taxi retains a verified early drive when a later probe has no route', async () => {
    let requests = 0;
    const q: TravelQuery = { from: home, to: clinic, mode: 'taxi', kind: 'arrive', at: at('11:30') };
    const e = await computeGoogleRoute(q, { apiKey: 'fixture', now: () => at('10:00'), fetch: async () => {
        requests++;
        return new Response(JSON.stringify(requests === 1
            ? { routes: [{ duration: '600s', distanceMeters: 2000 }] } : { routes: [] }));
    } });
    assert.equal(requests, 2);
    assert.equal(e.status, 'ok');
    assert.equal(e.departure, at('11:15'));
    assert.equal(e.arrival, at('11:25'));
});
test('arrival-by taxi remains unknown if all queried departures miss the deadline', async () => {
    const departures: number[] = [];
    const durations = [25, 35, 45];
    const q: TravelQuery = { from: home, to: clinic, mode: 'taxi', kind: 'arrive', at: at('11:30') };
    const e = await computeGoogleRoute(q, { apiKey: 'fixture', now: () => at('10:00'), fetch: async (_url, init) => {
        departures.push(Date.parse(JSON.parse(init!.body as string).departureTime));
        return new Response(JSON.stringify({ routes: [{ duration: `${durations[departures.length - 1] * 60}s`, distanceMeters: 4000 }] }));
    } });
    assert.deepEqual(departures, [at('11:15'), at('11:05'), at('10:55')]);
    assert.equal(e.status, 'unknown');
});
test('ambiguous geocoding never selects its first result', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'fixture';
    assert.equal(await resolveStreetAddress('Ambiguous', async () => new Response(JSON.stringify({ status: 'OK', results: [{}, {}] }))), null);
    delete process.env.GOOGLE_MAPS_API_KEY;
});
test('an unverified default origin cannot be confirmed, even if coordinates were saved elsewhere', () => {
    const store = memoryStore();
    const place = store.place(1, home.id, 'Model supplied home', 52, 21);
    store.draft(1, policy);
    assert.throws(() => store.confirmation(1), /Verify the street address/);
    store.verifyLocation(1, home.id, place.revision);
    assert.ok(store.confirmation(1).token);
    store.place(1, home.id, 'Changed home', 53, 21);
    assert.throws(() => store.confirmation(1), /Verify the street address/);
    store.db.close();
});
test('SaveAddress rejects model-provided coordinates even alongside plausible address text', async () => {
    const { SaveAddress } = await import('../tools.address.ts');
    const result = await SaveAddress.execute({ userId: 1, label: 'home', address: 'Warszawa', lat: 50, lng: 19 });
    assert.equal(result.success, false);
    globalDb.prepare('INSERT OR IGNORE INTO users(user_id) VALUES (101)').run();
    assert.equal((await SaveAddress.execute({ userId: 101, label: 'home', lat: 52, lng: 21 })).success, true);
    const store = new SmartBookingStore(globalDb);
    store.draft(101, { ...policy, originLocationId: 'address:home' });
    assert.throws(() => store.confirmation(101), /Verify the street address/);
});
test('policy confirmation is revision-bound; new messages invalidate old confirmation buttons', () => {
    const store = memoryStore(); for (const p of places.values()) {
        const saved = store.place(1, p.id, p.address, p.lat, p.lng);
        if (!p.id.startsWith('clinic:')) store.verifyLocation(1, p.id, saved.revision);
    }
    store.draft(1, policy); const a = store.confirmation(1); const first = store.hold(1)!;
    assert.equal(store.confirm(1, a.token, a.revision), false);
    const second = store.hold(1)!; assert.equal(store.release(1, first), false); assert.equal(store.release(1, second), true);
    const b = store.confirmation(1); store.draft(1, { ...policy, softPreferences: ['Afternoon'] }); assert.equal(store.confirm(1, b.token, b.revision), false);
    store.db.close();
});
test('reminder rescheduling cannot modify an explicitly linked commitment', () => {
    const store = memoryStore(); store.db.prepare("INSERT INTO tasks(id,user_id,name,ping_at,status,created_at) VALUES ('call',1,'Call','2026-10-06T09:00:00','pending','2026-10-01')").run();
    const p = { ...policy, commitments: [{ id: 'call', name: 'Call', date: '2026-10-06', from: '10:00', to: '11:00', locationId: 'home', source: { type: 'task' as const, id: 'call' } }] };
    store.draft(1, p); store.db.prepare("UPDATE tasks SET ping_at='2026-10-06T11:30:00' WHERE id='call'").run();
    assert.equal(store.policy(1)!.policy.commitments[0].to, '11:00'); store.db.close();
});

function coordinatorFixture() {
    const store = memoryStore(); for (const p of places.values()) {
        const saved = store.place(1, p.id, p.address, p.lat, p.lng);
        if (!p.id.startsWith('clinic:')) store.verifyLocation(1, p.id, saved.revision);
    }
    store.verifyClinic(1, clinic.id, 'Clinic - Testowa 2', store.places(1).get(clinic.id)!.revision);
    const future = DateTime.now().setZone('Europe/Warsaw').plus({ days: 3 }).toISODate()!;
    const from = `${future}T12:00:00`, to = `${future}T12:30:00`;
    store.draft(1, policy); const token = store.confirmation(1); assert.ok(store.confirm(1, token.token, token.revision));
    const term: LuxmedTerm = { additionalData: { isPreparationRequired: false, preparationItems: [] }, term: { clinicId: 2, clinicGroupId: 2, clinic: 'Clinic - Testowa 2', dateTimeFrom: { dateTimeLocal: from }, dateTimeTo: { dateTimeLocal: to }, doctor: { id: 3, name: 'Doctor' }, isTelemedicine: false, isAdditional: false, isImpediment: false, roomId: 4, scheduleId: 5, serviceId: 6 } };
    const config: LuxmedMonitoringConfig = { id: 'm1', userId: 1, accountId: 1, serviceId: 6, serviceName: 'Consultation', cityId: 1, cityName: 'Warszawa', clinicIds: null, doctorIds: null, englishOnly: false, dateFrom: `${future}T00:00:00`, dateTo: `${future}T23:59:59`, timeFrom: '08:00', timeTo: '20:00', autobook: true, rebookIfExists: false, lastCheck: null, createdAt: new Date().toISOString() };
    store.db.prepare("INSERT INTO luxmed_accounts(user_id,account_id,username,created_at) VALUES (1,1,'fixture','2026-10-01')").run();
    store.db.prepare("INSERT INTO luxmed_monitorings(id,user_id,account_id,service_id,service_name,city_id,city_name,date_from,date_to,created_at) VALUES ('m1',1,1,6,'Consultation',1,'Warszawa',?,?,?)")
        .run(config.dateFrom, config.dateTo, config.createdAt);
    store.enroll('m1', 1); store.db.prepare("UPDATE luxmed_smart_monitors SET state='active' WHERE monitoring_id='m1'").run();
    let books = 0;
    const api = { ...smartDependencies, capabilities: async () => ['smart-booking-v1', 'reservation-end-times-v1', 'smart-booking-attempts-v2', 'monitor-quiesce-v1', 'reservation-range-complete-v1', 'legacy-monitor-fence-v1', 'legacy-booking-barrier-v1', 'smart-booking-enrollment-fence-v2', 'smart-booking-identity-fence-v1', 'cancellation-receipts-v2'], reserved: async () => [], doctors: async () => [], cities: async () => [{ id: 1, name: 'Warszawa' }], monitorings: async () => [], cancellations: async () => [], book: async () => { books++; return { state: 'succeeded', reservationId: 77 }; }, attempt: async () => ({ state: 'succeeded' as const, reservationId: 77 }), legacyBarrier: async () => ({ state: 'clear' as const }), acknowledgeLegacy: async () => { }, resolve: async () => null };
    const coordinator = new SmartBookingCoordinator(store, api, () => null);
    const cache = { lookup: async (q: TravelQuery) => estimate(q, 1500, false, Date.now()), prepared: () => null, previous: () => null, key: (q: TravelQuery) => JSON.stringify(q), warm: () => { }, metrics: {} };
    coordinator.cache = () => cache as any;
    return { store, api, coordinator, term, config, books: () => books };
}
test('ambiguous and nonexistent local-only LuxMed slot times are excluded', () => {
    const f = coordinatorFixture();
    const spring = structuredClone(f.term);
    spring.term.dateTimeFrom = { dateTimeLocal: '2026-03-29T02:30:00' };
    spring.term.dateTimeTo = { dateTimeLocal: '2026-03-29T03:00:00' };
    assert.equal(Number.isNaN(slotFromTerm(spring, 1).start), true);
    const autumn = structuredClone(f.term);
    autumn.term.dateTimeFrom = { dateTimeLocal: '2026-10-25T02:30:00' };
    autumn.term.dateTimeTo = { dateTimeLocal: '2026-10-25T03:00:00' };
    assert.equal(Number.isNaN(slotFromTerm(autumn, 1).start), true);
    autumn.term.dateTimeFrom = { dateTimeTz: '2026-10-25T02:30:00+02:00' };
    autumn.term.dateTimeTo = { dateTimeTz: '2026-10-25T02:45:00+02:00' };
    assert.equal(Number.isNaN(slotFromTerm(autumn, 1).start), true);
    autumn.term.dateTimeFrom = { dateTimeTz: '2026-10-25T02:30:00+01:00', dateTimeLocal: '2026-10-25T02:30:00' };
    autumn.term.dateTimeTo = { dateTimeTz: '2026-10-25T02:45:00+01:00', dateTimeLocal: '2026-10-25T02:45:00' };
    assert.equal(Number.isNaN(slotFromTerm(autumn, 1).start), true);
    f.store.db.close();
});

test('a LuxMed offset must agree with the local time sent for booking', () => {
    const f = coordinatorFixture();
    const term = structuredClone(f.term);
    const local = term.term.dateTimeFrom.dateTimeLocal!;
    const actual = DateTime.fromISO(local, { zone: 'Europe/Warsaw' });
    term.term.dateTimeFrom.dateTimeTz = actual.plus({ hours: 1 }).toISO()!;
    assert.equal(Number.isNaN(slotFromTerm(term, 1).start), true);
    assert.equal(matchesMonitor(term, f.config), false);
    term.term.dateTimeFrom.dateTimeTz = actual.toISO()!;
    assert.equal(slotFromTerm(term, 1).start, actual.toMillis());
    f.store.db.close();
});

test('a fresh slot explicitly marked non-English cannot pass an English-only doctor filter', () => {
    const f = coordinatorFixture();
    f.config.englishOnly = true;
    f.term.term.doctor.isEnglishSpeaker = false;
    assert.equal(matchesMonitor(f.term, f.config, new Set([f.term.term.doctor.id])), false);
    f.term.term.doctor.isEnglishSpeaker = true;
    assert.equal(matchesMonitor(f.term, f.config, new Set([f.term.term.doctor.id])), true);
    f.store.db.close();
});
test('a clinic group ID cannot satisfy an explicit clinic ID restriction', async () => {
    const f = coordinatorFixture();
    f.config.clinicIds = [42];
    f.term.term.clinicGroupId = 42;
    assert.equal(matchesMonitor(f.term, f.config), false);
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'waiting');
    assert.equal(f.books(), 0);
    f.config.clinicIds = [f.term.term.clinicId];
    assert.equal(matchesMonitor(f.term, f.config), true);
    f.store.db.close();
});
test('concurrent decisions produce one booking and durable notification even when delivery fails', async () => {
    const f = coordinatorFixture();
    const results = await Promise.all([f.coordinator.process(f.config, [f.term]), f.coordinator.process(f.config, [f.term])]);
    assert.equal(f.books(), 1); assert.ok(results.some(r => r.state === 'booked'));
    await f.store.deliver(async () => { throw new Error('Telegram offline'); });
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM luxmed_notification_outbox WHERE delivered_at IS NULL').get().n, 1);
    assert.equal(f.store.blocks(1).length, 1); f.store.db.close();
});
test('an active legacy auto monitor leaves a terminal smart attempt and clear waiting status', async () => {
    const f = coordinatorFixture();
    f.api.book = async () => ({ state: 'failed', errorCode: 'LEGACY_AUTO_MONITOR_ACTIVE' });
    const result = await f.coordinator.process(f.config, [f.term]);
    assert.equal(result.state, 'waiting');
    assert.match(result.message, /existing LuxMed automatic monitor/);
    assert.equal(f.store.pending(1).length, 0);
    assert.equal((f.store.db.prepare("SELECT state FROM luxmed_booking_attempts LIMIT 1").get() as {state:string}).state, 'failed');
    assert.equal(f.books(), 0);
    f.store.db.close();
});
test('a legacy booking started after bot preflight is rejected by the sidecar barrier', async () => {
    const f = coordinatorFixture();
    f.api.book = async () => ({ state: 'failed', errorCode: 'LEGACY_BOOKING_BARRIER' });
    const result = await f.coordinator.process(f.config, [f.term]);
    assert.equal(result.state, 'waiting');
    assert.match(result.message, /earlier LuxMed booking must be verified/);
    assert.equal(f.store.pending(1).length, 0);
    assert.equal((f.store.db.prepare('SELECT state FROM luxmed_booking_attempts LIMIT 1').get() as { state: string }).state, 'failed');
    f.store.db.close();
});
test('a missing sidecar account enrollment leaves a terminal failed attempt', async () => {
    const f = coordinatorFixture();
    f.api.book = async () => ({ state: 'failed', errorCode: 'SMART_BOOKING_NOT_ENROLLED' });
    const result = await f.coordinator.process(f.config, [f.term]);
    assert.equal(result.state, 'waiting');
    assert.match(result.message, /not been enrolled/);
    assert.equal(f.store.pending(1).length, 0);
    assert.equal((f.store.db.prepare('SELECT state FROM luxmed_booking_attempts LIMIT 1').get() as { state: string }).state, 'failed');
    f.store.db.close();
});
test('a duplicate LuxMed login fails closed before a smart booking is sent upstream', async () => {
    const f = coordinatorFixture();
    f.api.book = async () => ({ state: 'failed', errorCode: 'SMART_BOOKING_IDENTITY_UNSAFE' });
    const result = await f.coordinator.process(f.config, [f.term]);
    assert.equal(result.state, 'waiting');
    assert.match(result.message, /login is linked to another account/);
    assert.equal(f.store.pending(1).length, 0);
    assert.equal((f.store.db.prepare('SELECT state FROM luxmed_booking_attempts LIMIT 1').get() as { state: string }).state, 'failed');
    f.store.db.close();
});
test('a pending legacy booking barrier prevents a smart submission', async () => {
    const f = coordinatorFixture();
    f.api.legacyBarrier = async () => ({ state: 'pending' });
    const result = await f.coordinator.process(f.config, [f.term]);
    assert.equal(result.state, 'waiting');
    assert.match(result.message, /earlier LuxMed booking outcome/);
    assert.equal(f.books(), 0);
    f.store.db.close();
});
test('a succeeded legacy barrier clears only after the exact reservation appears in a verified range', async () => {
    const f = coordinatorFixture();
    const start = slotFromTerm(f.term, 1).start;
    const date = f.term.term.dateTimeFrom.dateTimeLocal!;
    const dateTo = f.term.term.dateTimeTo.dateTimeLocal!;
    let barrierState: 'succeeded' | 'clear' = 'succeeded';
    let acknowledgements = 0;
    f.api.legacyBarrier = async () => barrierState === 'clear' ? { state: 'clear' } : { state: 'succeeded', reservationId: 77, start };
    f.api.acknowledgeLegacy = async () => { acknowledgements++; barrierState = 'clear'; };
    const day = DateTime.fromMillis(start, { zone: 'Europe/Warsaw' }).startOf('day');
    const coverage = { from: day.toMillis(), to: day.plus({ days: 1 }).toMillis() };
    f.store.saveSnapshot(1, [{ eventId: 77, date, dateTo, eventType: 'Telemedicine' }], coverage);
    let requestedCoverage: typeof coverage | undefined;
    f.api.reserved = async (_accountId, requested) => { requestedCoverage = requested; return []; };
    assert.match((await f.coordinator.process(f.config, [f.term])).message, /Waiting for LuxMed to confirm reservation 77/);
    assert.equal(acknowledgements, 0); assert.equal(f.books(), 0);
    assert.deepEqual(requestedCoverage, coverage);
    assert.equal(f.store.snapshot(1)?.value.some((event: any) => event.eventId === 77), true);
    f.api.reserved = async () => [{ eventId: 77, date, dateTo, eventType: 'Telemedicine' } as any];
    await f.coordinator.process(f.config, []);
    assert.equal(acknowledgements, 1);
    assert.equal(f.store.snapshot(1)?.value.some((event: any) => event.eventId === 77), true);
    assert.equal(f.books(), 0);
    f.store.db.close();
});
test('a confirmed cancellation can clear its matching legacy barrier without reviving the reservation', async () => {
    const f = coordinatorFixture();
    const start = slotFromTerm(f.term, 1).start;
    f.store.confirmCancellation(1, 77, start);
    let acknowledged = false;
    f.api.legacyBarrier = async () => acknowledged ? { state: 'clear' } : { state: 'succeeded', reservationId: 77, start };
    f.api.acknowledgeLegacy = async () => { acknowledged = true; };
    await f.coordinator.process(f.config, []);
    assert.equal(acknowledged, true);
    assert.equal(f.books(), 0);
    f.store.db.close();
});
test('background reconciliation clears a verified legacy barrier without a smart monitor or provider keys', async () => {
    const f = coordinatorFixture();
    f.store.db.prepare('UPDATE luxmed_monitorings SET active=0').run();
    f.api.capabilities = async () => ['legacy-booking-barrier-v1'];
    const start = slotFromTerm(f.term, 1).start;
    let acknowledged = false;
    f.api.legacyBarrier = async () => acknowledged ? { state: 'clear' } : { state: 'succeeded', reservationId: 77, start };
    f.api.acknowledgeLegacy = async () => { acknowledged = true; };
    f.api.reserved = async () => [{ eventId: 77, date: f.term.term.dateTimeFrom.dateTimeLocal!, dateTo: f.term.term.dateTimeTo.dateTimeLocal!, eventType: 'Telemedicine' } as any];
    await f.coordinator.reconcile();
    assert.equal(acknowledged, true);
    assert.equal(f.books(), 0);
    f.store.db.close();
});
test('draft enrollment disables the legacy autobook flag before confirmation', () => {
    const store = memoryStore();
    store.db.prepare("INSERT INTO luxmed_monitorings(id,user_id,account_id,service_id,service_name,city_id,city_name,date_from,date_to,created_at,autobook) VALUES ('draft-smart',1,1,6,'Visit',1,'Warszawa','2026-10-01','2026-11-01','2026-10-01',1)").run();
    store.enroll('draft-smart', 1);
    assert.deepEqual(store.db.prepare(`SELECT m.autobook,s.desired_autobook,s.state FROM luxmed_monitorings m
        JOIN luxmed_smart_monitors s ON s.monitoring_id=m.id WHERE m.id='draft-smart'`).get(),
        { autobook: 0, desired_autobook: 1, state: 'draft' });
    store.db.close();
});
test('unknown outcome blocks a second booking and reconciles after coordinator restart', async () => {
    const f = coordinatorFixture(); f.api.book = async () => { throw new Error('lost response'); };
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'unknown');
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'waiting');
    const restarted = new SmartBookingCoordinator(f.store, f.api, () => null); await restarted.reconcile();
    assert.equal(f.store.pending(1).length, 0); assert.equal(f.store.blocks(1).length, 1); f.store.db.close();
});
test('confirmed cancellation prevents a lost-response reconciliation from restoring the booking', async () => {
    const f = coordinatorFixture(); f.api.book = async () => { throw new Error('lost response'); };
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'unknown');
    const attempt = f.store.pending(1)[0];
    f.store.confirmCancellation(1, 77, slotFromTerm(f.term, 1).start);
    await new SmartBookingCoordinator(f.store, f.api, () => null).reconcile();
    assert.equal(f.store.attempt(attempt.id)?.state, 'cancelled');
    assert.equal(f.store.attempt(attempt.id)?.reservation_id, 77);
    assert.equal(f.store.blocks(1).length, 0);
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM luxmed_notification_outbox WHERE id=?')
        .get(`booked:${attempt.id}`) as { n: number }).n, 0);
    f.store.db.close();
});
test('a stale reservation feed cannot restore a confirmed cancellation', () => {
    const store = memoryStore();
    const coverage = { from: at('00:00'), to: at('23:59') };
    const event = { eventId: 77, date: '2026-10-06T12:00:00' };
    const attempt = store.begin(1, 1, null, 1, 'slot', { slot: slot() });
    store.succeed(attempt.id, 77, { id: 'reservation:77', start: at('12:00'), end: at('12:30') }, 'Booked');
    assert.equal(store.blocks(1).length, 1);
    store.saveSnapshot(1, [event], coverage);
    store.confirmCancellation(1, 77, at('12:00'));
    assert.equal(store.attempt(attempt.id)?.state, 'cancelled');
    assert.equal(store.blocks(1).length, 0);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM luxmed_notification_outbox WHERE id=?')
        .get(`booked:${attempt.id}`) as { n: number }).n, 0);
    assert.deepEqual(store.snapshot(1)?.value, []);
    store.saveSnapshot(1, [event], coverage);
    assert.deepEqual(store.snapshot(1)?.value, []);
    store.db.close();
});
test('a durable sidecar receipt clears a booked block after bot restart', async () => {
    const f = coordinatorFixture();
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'booked');
    const start = slotFromTerm(f.term, 1).start;
    f.api.cancellations = async () => [{ accountId: 1, reservationId: 77, startAt: start,
        state: 'confirmed' as const, confirmedAt: Date.now(), reviewedAt: Date.now(),
        reviewedBy: 'operator', reviewReason: 'Provider confirmed cancellation', reviewAction: 'confirmed_cancelled' }];
    await new SmartBookingCoordinator(f.store, f.api, () => null).reconcile();
    assert.equal(f.store.blocks(1).length, 0);
    assert.equal((f.store.db.prepare('SELECT state FROM luxmed_booking_attempts WHERE reservation_id=77').get() as { state: string }).state, 'cancelled');
    await new SmartBookingCoordinator(f.store, f.api, () => null).reconcile();
    assert.equal(f.store.blocks(1).length, 0);
    assert.equal(f.books(), 1);
    f.store.db.close();
});
test('an unverified cancellation receipt holds smart booking', async () => {
    const f = coordinatorFixture();
    f.api.cancellations = async () => [{ accountId: 1, reservationId: 77, startAt: slotFromTerm(f.term, 1).start,
        state: 'pending' as const, confirmedAt: null }];
    const result = await f.coordinator.process(f.config, [f.term]);
    assert.equal(result.state, 'waiting');
    assert.match(result.message, /cancellation outcome needs verification/i);
    assert.equal(f.books(), 0);
    f.store.db.close();
});
test('a malformed reviewed cancellation never releases occupied time', async () => {
    const f = coordinatorFixture();
    const start = slotFromTerm(f.term, 1).start;
    f.api.cancellations = async () => [{ accountId: 1, reservationId: 77, startAt: start,
        state: 'confirmed' as const, confirmedAt: Date.now(), reviewedAt: Date.now(),
        reviewedBy: 'operator', reviewReason: 'Provider confirmed cancellation', reviewAction: 'verified_still_reserved' }];
    await assert.rejects(f.coordinator.process(f.config, [f.term]), /review does not match/i);
    assert.equal(f.store.wasCancelled(1, 77, start), false);
    assert.equal(f.books(), 0);
    f.store.db.close();
});
test('a reviewed still-reserved visit restores an old cancellation tombstone and blocks its time', async () => {
    const f = coordinatorFixture();
    const start = slotFromTerm(f.term, 1).start;
    f.store.confirmCancellation(1, 77, start);
    f.api.cancellations = async () => [{ accountId: 1, reservationId: 77, startAt: start,
        state: 'verified_still_reserved' as const, reviewedAt: Date.now(), reviewedBy: 'operator',
        reviewReason: 'Visit is active in LuxMed', reviewAction: 'verified_still_reserved' }];
    f.api.reserved = async () => [{ eventId: 77, date: f.term.term.dateTimeFrom.dateTimeLocal!,
        dateTo: f.term.term.dateTimeTo.dateTimeLocal!, eventType: 'Telemedicine' } as any];
    const result = await f.coordinator.process(f.config, [f.term]);
    assert.equal(f.store.wasCancelled(1, 77, start), false);
    assert.equal(f.store.snapshot(1)?.value.some((event: any) => event.eventId === 77), true);
    assert.equal(f.books(), 0);
    assert.equal(result.state, 'waiting');
    f.store.db.close();
});
test('smart booking waits for reviewed cancellation receipts on a mixed sidecar image', async () => {
    const f = coordinatorFixture();
    f.api.capabilities = async () => ['smart-booking-v1', 'cancellation-receipts-v1'];
    const result = await f.coordinator.process(f.config, [f.term]);
    assert.match(result.message, /sidecar smart booking update/i);
    assert.equal(f.books(), 0);
    f.store.db.close();
});
test('a confirmed cancellation does not suppress a reused reservation ID at another start', () => {
    const store = memoryStore();
    const coverage = { from: at('00:00'), to: at('23:59') };
    store.confirmCancellation(1, 77, at('12:00'));
    store.saveSnapshot(1, [{ eventId: 77, date: '2026-10-06T13:00:00' }], coverage);
    assert.equal(store.snapshot(1)?.value.length, 1);
    assert.equal(store.wasCancelled(1, 77, at('13:00')), false);
    assert.throws(() => store.confirmCancellation(1, 77, at('13:00')), /conflicts with another visit/);
    store.db.close();
});
test('chat cancellation binds the sidecar request and local tombstone to the exact visit start', async () => {
    const { LuxmedCancelBooking } = await import('../tools.luxmed.ts');
    const userId = 171, accountId = 171, start = at('12:00');
    globalDb.prepare('INSERT OR IGNORE INTO users(user_id) VALUES (?)').run(userId);
    globalDb.prepare("INSERT OR REPLACE INTO luxmed_accounts(user_id,account_id,username,created_at) VALUES (?,?,?,'2026-10-01')")
        .run(userId, accountId, 'fixture-cancellation');
    const oldFetch = globalThis.fetch;
    let deleteCalled = false;
    globalThis.fetch = async (url, init) => {
        const path = String(url);
        if (path.endsWith('/capabilities'))
            return new Response(JSON.stringify({ success: true, data: ['cancellation-receipts-v2'] }));
        if (init?.method === 'DELETE') {
            assert.ok(path.endsWith(`/visits/77?expectedStartAt=${start}`));
            deleteCalled = true;
            return new Response(JSON.stringify({ success: true, data: 'Cancelled' }));
        }
        if (path.endsWith('/visits/reserved'))
            return new Response(JSON.stringify({ success: true, data: [{ eventId: 77, date: '2026-10-06T12:00:00' }] }));
        if (path.endsWith('/visits/cancellation-receipts'))
            return new Response(JSON.stringify({ success: true, data: [{ accountId, reservationId: 77, startAt: start,
                state: 'confirmed', confirmedAt: Date.now(), reviewedAt: Date.now(), reviewedBy: 'operator', reviewReason: 'Provider confirmed cancellation', reviewAction: 'confirmed_cancelled' }] }));
        throw new Error(`Unexpected simulated sidecar request: ${path}`);
    };
    try {
        const result = await LuxmedCancelBooking.execute({ userId, reservation_id: 77 }) as { success: boolean };
        assert.equal(result.success, true);
        assert.equal(deleteCalled, true);
        assert.equal(new SmartBookingStore(globalDb).wasCancelled(accountId, 77, start), true);
    } finally { globalThis.fetch = oldFetch; }
});
test('chat cancellation leaves occupied time intact without a confirmed sidecar receipt', async () => {
    const { LuxmedCancelBooking } = await import('../tools.luxmed.ts');
    const userId = 172, accountId = 172, start = at('12:00');
    globalDb.prepare('INSERT OR IGNORE INTO users(user_id) VALUES (?)').run(userId);
    globalDb.prepare("INSERT OR REPLACE INTO luxmed_accounts(user_id,account_id,username,created_at) VALUES (?,?,?,'2026-10-01')")
        .run(userId, accountId, 'fixture-pending-cancellation');
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const path = String(url);
        if (path.endsWith('/capabilities'))
            return new Response(JSON.stringify({ success: true, data: ['cancellation-receipts-v2'] }));
        if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: true, data: 'Cancelled' }));
        if (path.endsWith('/visits/reserved')) return new Response(JSON.stringify({ success: true,
            data: [{ eventId: 77, date: '2026-10-06T12:00:00' }] }));
        if (path.endsWith('/visits/cancellation-receipts')) return new Response(JSON.stringify({ success: true,
            data: [{ accountId, reservationId: 77, startAt: start, state: 'pending', confirmedAt: null }] }));
        throw new Error(`Unexpected simulated sidecar request: ${path}`);
    };
    try {
        const result = await LuxmedCancelBooking.execute({ userId, reservation_id: 77 }) as { success: boolean; message: string };
        assert.equal(result.success, false);
        assert.match(result.message, /needs operator verification/i);
        assert.equal(new SmartBookingStore(globalDb).wasCancelled(accountId, 77, start), false);
    } finally { globalThis.fetch = oldFetch; }
});
test('chat cancellation does not dispatch DELETE on an older sidecar image', async () => {
    const { LuxmedCancelBooking } = await import('../tools.luxmed.ts');
    const userId = 173, accountId = 173;
    globalDb.prepare('INSERT OR IGNORE INTO users(user_id) VALUES (?)').run(userId);
    globalDb.prepare("INSERT OR REPLACE INTO luxmed_accounts(user_id,account_id,username,created_at) VALUES (?,?,?,'2026-10-01')")
        .run(userId, accountId, 'fixture-old-sidecar');
    const oldFetch = globalThis.fetch;
    let deleteCalled = false;
    globalThis.fetch = async (_url, init) => {
        if (init?.method === 'DELETE') deleteCalled = true;
        return new Response(JSON.stringify({ success: true, data: ['cancellation-receipts-v1'] }));
    };
    try {
        const result = await LuxmedCancelBooking.execute({ userId, reservation_id: 77 }) as { success: boolean; message: string };
        assert.equal(result.success, false);
        assert.match(result.message, /sidecar review update/i);
        assert.equal(deleteCalled, false);
    } finally { globalThis.fetch = oldFetch; }
});
test('chat booking cannot use the legacy direct endpoint without confirmed availability', async () => {
    const userId = 78101;
    globalDb.prepare('INSERT INTO users(user_id) VALUES (?)').run(userId);
    saveLuxmedAccount(userId, 88101, 'manual-test');
    const result = await LuxmedBookSlot.execute({ userId, slot_index: 1 });
    assert.equal(result.success, false);
    assert.match(result.message, /Confirm your LuxMed availability and travel rules/);
});
test('missing sidecar attempt record never causes an automatic resubmission', async () => {
    const f = coordinatorFixture(); let submissions = 0;
    f.api.book = async () => { submissions++; throw new Error('lost response'); };
    f.api.attempt = async () => ({ state: 'not_found' });
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'unknown');
    await f.coordinator.reconcile();
    assert.equal(submissions, 1);
    assert.equal(f.store.pending(1).length, 1);
    f.store.db.close();
});
test('a 404 after booking dispatch remains unknown and cannot resubmit', async () => {
    const { LuxmedApiError } = await import('../luxmedAdapter.ts');
    const f = coordinatorFixture(); let submissions = 0;
    f.api.book = async () => { submissions++; throw new LuxmedApiError('Attempt endpoint unavailable', 'LUXMED_API_ERROR', 404); };
    f.api.attempt = async () => ({ state: 'not_found' });
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'unknown');
    assert.equal(f.store.pending(1).length, 1);
    await f.coordinator.reconcile();
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'waiting');
    assert.equal(submissions, 1);
    f.store.db.close();
});
test('a fresh taxi fallback is reranked behind another public-transport slot', async () => {
    const f = coordinatorFixture();
    const later = structuredClone(f.term);
    later.term.scheduleId = 6;
    later.term.dateTimeFrom.dateTimeLocal = later.term.dateTimeFrom.dateTimeLocal!.replace('T12:00:00', 'T13:00:00');
    later.term.dateTimeTo.dateTimeLocal = later.term.dateTimeTo.dateTimeLocal!.replace('T12:30:00', 'T13:30:00');
    const firstStart = slotFromTerm(f.term, f.config.cityId).start;
    const fetchedAt = Date.now();
    const cache = f.coordinator.cache(1);
    cache.lookup = async q => estimate(q, 1500, false, fetchedAt - 1000);
    cache.previous = q => q.at < firstStart + 45 * 60000
        ? { ...estimate(q, 1500, false, fetchedAt), status: q.mode === 'transit' ? 'no_route' : 'ok' }
        : null;
    const booked: string[] = [];
    f.api.book = async (_account, term) => { booked.push(term.term.dateTimeFrom.dateTimeLocal!); return { state: 'succeeded', reservationId: 77 }; };
    assert.equal((await f.coordinator.process(f.config, [f.term, later])).state, 'booked');
    assert.equal(booked.length, 1);
    assert.match(booked[0], /T13:00:00$/);
    f.store.db.close();
});
test('a new availability message during route evaluation prevents submission', async () => {
    const f = coordinatorFixture(); const original = f.coordinator.cache(1).lookup;
    f.coordinator.cache(1).lookup = async q => { f.store.hold(1); return original(q); };
    await assert.rejects(f.coordinator.process(f.config, [f.term]), /Availability changed/); assert.equal(f.books(), 0); f.store.db.close();
});
test('unsupported sidecar cannot enable smart booking', async () => {
    const f = coordinatorFixture(); f.api.capabilities = async () => [];
    const result = await f.coordinator.process(f.config, [f.term]);
    assert.equal(result.state, 'waiting');
    assert.match(result.message, /sidecar smart booking update/);
    assert.equal(f.books(), 0); f.store.db.close();
});
test('smart replacement waits until the old visit is identified before any booking work', async () => {
    const f = coordinatorFixture();
    f.config.rebookIfExists = true;
    f.api.capabilities = async () => { throw new Error('booking preflight must not run'); };
    const automatic = await f.coordinator.process(f.config, [f.term]);
    const manual = await f.coordinator.process(f.config, [f.term], true);
    assert.equal(automatic.state, 'waiting');
    assert.equal(manual.state, 'waiting');
    assert.match(automatic.message, /existing LuxMed visit can be identified/);
    assert.equal(f.books(), 0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM luxmed_booking_attempts').get().n, 0);
    f.store.db.close();
});
test('Jev uses earliest day and transport priority; timeout or malformed output falls back', async () => {
    const a = (await evaluateSlot(slot(), policy, places, [], async q => estimate(q), now))!;
    const b = { ...a, slot: { ...a.slot, id: 'later', start: a.slot.start + 3600000 }, travelSeconds: 600 };
    const expected = [a, b].sort(compareFeasible)[0].slot.id;
    const request = async () => new Response(JSON.stringify({ answers: { c0: { type: 'score', score: 1000 } } }));
    assert.equal((await rankWithJev([a, b], ['Prefer afternoon'], 1, { key: 'fixture', fetch: request }))!.candidate.slot.id, expected);
    const start = performance.now(); const timed = await rankWithJev([a, b], ['Prefer afternoon'], 1, { key: 'fixture', timeoutMs: 20, fetch: () => new Promise(() => { }) });
    assert.equal(timed?.source, 'rules'); assert.ok(performance.now() - start < 200);
    const laterDay = { ...b, day: '2026-10-07' };
    assert.equal((await rankWithJev([laterDay, a], [], 1))!.candidate.slot.id, a.slot.id);
});
test('account queue prioritises bookings and releases after synchronous guard failure', async () => {
    const queue = new AccountQueue(), order: string[] = []; let release!: () => void;
    const first = queue.run(1, 0, () => new Promise<void>(r => { release = r; })); await Promise.resolve();
    const search = queue.run(1, 0, async () => { order.push('search'); });
    const booking = queue.run(1, 10, async () => { order.push('booking'); }); release(); await Promise.all([first, search, booking]);
    assert.deepEqual(order, ['booking', 'search']);
    await assert.rejects(queue.run(1, 10, () => { throw new Error('stale'); }));
    assert.equal(await queue.run(1, 0, async () => 42), 42);
});
test('changing a saved address invalidates confirmed smart policy immediately', () => {
    globalDb.prepare('INSERT OR IGNORE INTO users(user_id) VALUES (10)').run();
    saveUserAddress(10, 'home', 'First', 52, 21);
    const store = new SmartBookingStore(globalDb);
    const first = store.place(10, 'address:home', 'First', 52, 21);
    store.verifyLocation(10, 'address:home', first.revision);
    store.draft(10, { ...policy, originLocationId: 'address:home' });
    const c = store.confirmation(10); store.confirm(10, c.token, c.revision);
    saveUserAddress(10, 'home', 'Second', 53, 21); assert.equal(store.policy(10)?.state, 'paused');
    assert.equal(store.places(10).has('address:home'), false);
    const second = store.place(10, 'address:home', 'Second', 53, 21);
    store.verifyLocation(10, 'address:home', second.revision);
});

test('fresh routes finishing after evaluation starts remain eligible', async () => {
    const future = DateTime.now().setZone('Europe/Warsaw').plus({ days: 2 }).set({ hour: 12, minute: 0, second: 0 }).toMillis();
    const candidate = { ...slot(), start: future, end: future + 1800000 };
    const result = await evaluateSlot(candidate, policy, places, [], async q => { await new Promise(r => setTimeout(r, 5)); return estimate(q, 1500, false, Date.now()); });
    assert.ok(result);
});
test('a newer live route that no longer fits prevents submission', async () => {
    const f = coordinatorFixture(); const cache = f.coordinator.cache(1);
    cache.previous = (q) => ({ ...estimate(q, 1500, false, Date.now() + 1), departure: q.at - 3 * 3600000, arrival: q.at + 2 * 3600000 });
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'waiting'); assert.equal(f.books(), 0); f.store.db.close();
});
test('a route that expires while queued cannot pass the final submit guard', async () => {
    const f = coordinatorFixture();
    f.coordinator.cache(1).lookup = async q => estimate(q, 1500, false, Date.now() - 23 * 3600000);
    let guardChecked = false;
    f.api.book = async (_account, _term, _city, _replace, _attempt, guard) => {
        const actualNow = Date.now;
        Date.now = () => actualNow() + 25 * 3600000;
        try { assert.equal(guard?.(), false); guardChecked = true; }
        finally { Date.now = actualNow; }
        return { state: 'failed', errorCode: 'BOOKING_GUARD_CHANGED' };
    };
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'waiting');
    assert.equal(guardChecked, true);
    f.store.db.close();
});
test('a newer route duration prevents queued submission even when endpoints match', async () => {
    const f = coordinatorFixture();
    const cache = f.coordinator.cache(1);
    const originalLookup = cache.lookup.bind(cache);
    let newest: TravelEstimate | null = null;
    cache.lookup = async q => originalLookup(q);
    cache.previous = () => newest;
    let guardChecked = false;
    f.api.book = async (_account, _term, _city, _replace, _attempt, guard) => {
        const pending = f.store.pending(1)[0];
        const selected = (JSON.parse(pending.payload) as { journey: FeasibleSlot }).journey.legs[0];
        newest = { ...selected, fetchedAt: selected.fetchedAt + 1, durationSeconds: selected.durationSeconds + 3600, cached: true };
        assert.equal(guard?.(), false);
        guardChecked = true;
        return { state: 'failed', errorCode: 'BOOKING_GUARD_CHANGED' };
    };
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'waiting');
    assert.equal(guardChecked, true);
    f.store.db.close();
});
test('a booking completed after its monitor was stopped reports the conflict', async () => {
    const f = coordinatorFixture();
    f.api.book = async () => {
        f.store.db.prepare('UPDATE luxmed_monitorings SET active=0 WHERE id=? AND user_id=?').run(f.config.id, f.config.userId);
        return { state: 'succeeded', reservationId: 77 };
    };
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'booked');
    const outbox = f.store.db.prepare("SELECT message FROM luxmed_notification_outbox WHERE id LIKE 'booked:%'").get() as { message: string };
    assert.match(outbox.message, /monitor.*changed while booking was submitted/i);
    assert.equal(f.store.blocks(1).length, 1);
    f.store.db.close();
});
test('Jev can rank soft preferences but cannot promote another day or a taxi', async () => {
    const a = (await evaluateSlot(slot(), policy, places, [], async q => estimate(q), now))!;
    const b = { ...a, slot: { ...a.slot, id: 'second', start: a.slot.start + 3600000 }, travelSeconds: a.travelSeconds + 60 };
    const probabilities = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 };
    const fetch = async (_url: any, init: any) => {
        const body = JSON.parse(init.body); assert.equal(body.state.candidates.length, 2);
        assert.deepEqual(body.state.preferences, ['afternoon']);
        return new Response(JSON.stringify({ answers: { c0: { type: 'score', score: 1, confidence: 1, probabilities }, c1: { type: 'score', score: 4, confidence: 1, probabilities } } }));
    };
    const ranked = await rankWithJev([a, b, { ...a, slot: { ...a.slot, id: 'taxi' }, taxiLegs: 1 }, { ...a, slot: { ...a.slot, id: 'tomorrow' }, day: '2026-10-07' }], ['Prefer afternoon'], 99, { key: 'fixture', fetch });
    assert.equal(ranked?.source, 'jev'); assert.equal(ranked?.candidate.slot.id, 'second');
});

test('Jev asks again when the model alias may have moved to another build', async () => {
    const a = (await evaluateSlot(slot(), policy, places, [], async q => estimate(q), now))!;
    const b = { ...a, slot: { ...a.slot, id: 'second', start: a.slot.start + 3600000 } };
    let calls = 0;
    const probabilities = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 };
    const fetch = async () => {
        calls++;
        return new Response(JSON.stringify({
            model: `typesafe/jev-1.13-202609${calls === 1 ? '17' : '18'}`,
            answers: {
                c0: { type: 'score', score: calls === 1 ? 4 : 0, confidence: 1, probabilities },
                c1: { type: 'score', score: calls === 1 ? 0 : 4, confidence: 1, probabilities },
            },
        }));
    };
    const first = await rankWithJev([a, b], ['Prefer afternoon'], 100, { key: 'fixture', fetch });
    const second = await rankWithJev([a, b], ['Prefer afternoon'], 100, { key: 'fixture', fetch });
    assert.equal(first?.candidate.slot.id, a.slot.id);
    assert.equal(second?.candidate.slot.id, b.slot.id);
    assert.equal(calls, 2);
});

test('Jev receives no free-form medical or schedule prose', async () => {
    const { jevPreferenceCodes } = await import('../luxmedJev.ts');
    assert.deepEqual(jevPreferenceCodes(['Prefer afternoon', 'I have a medical diagnosis and treatment on Tuesday']), ['afternoon']);
    assert.deepEqual(jevPreferenceCodes(['Prefer a short journey']), ['short_journey']);
});
test('unknown attempts and policy survive repeated schema application', () => {
    const store = memoryStore(); store.draft(1, policy); const a = store.begin(1, 1, null, 1, 'fingerprint', { fixture: true }); store.outcome(a.id, 'unknown');
    store.db.exec(SCHEMA_SQL); applyColumnMigrations(store.db); store.db.exec(INDEXES_SQL);
    assert.equal(store.pending(1)[0].state, 'unknown'); assert.equal(store.policy(1)?.revision, 1); store.db.close();
});
test('only the current user-facing conversation can release a message hold', async () => {
    const { LuxmedAvailabilityReviewed } = await import('../tools.luxmedSmart.ts');
    const { availabilityTurn } = await import('../luxmedConversation.ts');
    const store = new SmartBookingStore(globalDb); const token = store.hold(10)!;
    assert.equal((await LuxmedAvailabilityReviewed.execute({ userId: 10, hold_token: token })).success, false);
    assert.equal((await availabilityTurn.run({ userId: 10, holdToken: token }, () => LuxmedAvailabilityReviewed.execute({ userId: 10, hold_token: token }))).success, true);
});
test('a stale conversation cannot add or remove an occupied schedule appointment', async () => {
    const { availabilityTurn } = await import('../luxmedConversation.ts');
    const { LuxmedSetScheduleAppointment, LuxmedDeleteScheduleAppointment } = await import('../tools.scheduleAppointments.ts');
    const store = new SmartBookingStore(globalDb);
    globalDb.prepare('INSERT OR IGNORE INTO users(user_id) VALUES (12)').run();
    const place = store.place(12, 'address:home', 'Testowa 1, Warszawa', 52, 21);
    store.verifyLocation(12, 'address:home', place.revision);
    store.draft(12, { ...policy, originLocationId: 'address:home' });
    const oldToken = store.hold(12)!;
    const newToken = store.hold(12)!;
    const args = { userId: 12, name: 'Call', date: '2026-10-06', from: '09:00', to: '11:00', location_id: 'address:home' };
    await assert.rejects(availabilityTurn.run({ userId: 12, holdToken: oldToken }, () => LuxmedSetScheduleAppointment.execute(args)), /newer user message/);
    assert.equal(store.scheduleAppointments(12).length, 0);
    await availabilityTurn.run({ userId: 12, holdToken: newToken }, () => LuxmedSetScheduleAppointment.execute(args));
    assert.equal(store.scheduleAppointments(12).length, 1);
    const appointmentId = store.scheduleAppointments(12)[0].id;
    await assert.rejects(availabilityTurn.run({ userId: 12, holdToken: oldToken }, () => LuxmedDeleteScheduleAppointment.execute({ userId: 12, appointment_id: appointmentId })), /newer user message/);
    assert.equal(store.scheduleAppointments(12).length, 1);
});
test('confirmation requires the owning private chat and cannot be replayed', async () => {
    const { initSmartBookingTools } = await import('../tools.luxmedSmart.ts');
    const { smartBooking } = await import('../luxmedSmartBooking.ts');
    const { createLuxmedMonitoring, deactivateLuxmedMonitoring } = await import('../userStore.ts');
    const store = new SmartBookingStore(globalDb); const saved = store.policy(10)!;
    globalDb.prepare("INSERT OR REPLACE INTO luxmed_accounts(user_id,account_id,username,created_at) VALUES (10,10,'fixture','2026-10-01')").run();
    const monitor = createLuxmedMonitoring({ id: 'confirm-test', userId: 10, accountId: 10, serviceId: 6, serviceName: 'Visit', cityId: 1, cityName: 'Warszawa', clinicIds: null, doctorIds: null, englishOnly: false, dateFrom: '2026-10-01T00:00:00', dateTo: '2026-11-01T00:00:00', timeFrom: '08:00', timeTo: '20:00', autobook: true, rebookIfExists: false });
    store.enroll(monitor.id, 10); const c = store.confirmation(10);
    store.stageSidecarMonitorPreview(10, monitor.id, monitor.accountId, c, [42]);
    let callback: (q: any) => void = () => { }; let answers = 0;
    initSmartBookingTools({ on: (_e: any, fn: any) => { callback = fn; }, answerCallbackQuery: async () => { answers++; }, sendMessage: async () => ({}) } as any);
    const oldReady = smartBooking.readiness, oldFetch = globalThis.fetch; smartBooking.readiness = async () => null;
    let deactivated = 0, enrolled = 0, legacyActive = true;
    globalThis.fetch = async (url, init) => {
        const path = String(url);
        if (path.endsWith('/quiesce')) { deactivated++; legacyActive = false; }
        if (path.endsWith('/smart-booking-enrollment') && init?.method === 'POST') {
            assert.equal(store.enrollment(monitor.id)?.state, 'activating');
            assert.equal(store.policy(10)?.state, 'activating');
            assert.deepEqual(JSON.parse(String(init.body)).expectedAutoMonitorIds, [42]);
            enrolled++;
            legacyActive = false;
            return new Response(JSON.stringify({ success: true, data: { enrolled: true, stoppedAutoMonitorIds: [42] } }));
        }
        return new Response(JSON.stringify({ success: true, data: path.endsWith('/monitorings') && legacyActive
            ? [{recordId:42,serviceId:7,cityId:2,serviceName:'Unrelated visit',cityName:'Another city',doctorId:null,dateFrom:'2027-10-01',dateTo:'2027-11-01',timeFrom:'08:00',timeTo:'20:00',autobook:true,active:true}] : [] }));
    };
    try {
        const query = { id: 'q', from: { id: 10 }, message: { chat: { id: 10, type: 'private' } }, data: `luxconfirm:${monitor.id}:${c.revision}:${c.token}` };
        callback({ ...query, from: { id: 11 } }); await new Promise(r => setTimeout(r, 10)); assert.notEqual(store.enrollment(monitor.id)?.state, 'active');
        createLuxmedMonitoring({ id: 'legacy-other-confirm-test', userId: 10, accountId: 10, serviceId: 7, serviceName: 'Other visit', cityId: 1, cityName: 'Warszawa', clinicIds: null, doctorIds: null, englishOnly: false, dateFrom: '2026-10-01T00:00:00', dateTo: '2026-11-01T00:00:00', timeFrom: '08:00', timeTo: '20:00', autobook: true, rebookIfExists: false });
        callback(query); await new Promise(r => setTimeout(r, 10));
        assert.notEqual(store.enrollment(monitor.id)?.state, 'active');
        assert.equal(enrolled, 0);
        deactivateLuxmedMonitoring('legacy-other-confirm-test', 10);
        callback(query); await new Promise(r => setTimeout(r, 10)); assert.equal(store.enrollment(monitor.id)?.state, 'active');
        assert.equal((globalDb.prepare('SELECT autobook FROM luxmed_monitorings WHERE id=?').get(monitor.id) as { autobook: number }).autobook, 0);
        assert.equal((await import('../userStore.ts')).getActiveLuxmedMonitoringsByUser(10).find(m => m.id === monitor.id)?.autobook, true);
        callback(query); await new Promise(r => setTimeout(r, 10)); assert.equal(answers, 4); assert.equal(store.policy(10)?.revision, saved.revision);
        assert.equal(deactivated, 0);
        assert.equal(enrolled, 1);
    } finally { smartBooking.readiness = oldReady; globalThis.fetch = oldFetch; }
});
test('failed sidecar enrollment leaves the confirmed monitor held before activation', async () => {
    const { initSmartBookingTools } = await import('../tools.luxmedSmart.ts');
    const { smartBooking } = await import('../luxmedSmartBooking.ts');
    const { createLuxmedMonitoring } = await import('../userStore.ts');
    const store = new SmartBookingStore(globalDb), userId = 130;
    globalDb.prepare('INSERT INTO users(user_id) VALUES (?)').run(userId);
    globalDb.prepare("INSERT INTO luxmed_accounts(user_id,account_id,username,created_at) VALUES (130,130,'fixture','2026-10-01')").run();
    const savedHome = store.place(userId, 'home', 'Testowa 1, Warszawa', 52, 21);
    store.verifyLocation(userId, 'home', savedHome.revision);
    store.draft(userId, policy);
    const monitor = createLuxmedMonitoring({ id: 'enrollment-failure', userId, accountId: 130, serviceId: 6, serviceName: 'Visit', cityId: 1, cityName: 'Warszawa', clinicIds: null, doctorIds: null, englishOnly: false, dateFrom: '2026-10-01T00:00:00', dateTo: '2026-11-01T00:00:00', timeFrom: '08:00', timeTo: '20:00', autobook: true, rebookIfExists: false });
    store.enroll(monitor.id, userId);
    const confirmation = store.confirmation(userId);
    store.stageSidecarMonitorPreview(userId, monitor.id, monitor.accountId, confirmation, []);
    let callback: (q: any) => void = () => { };
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    initSmartBookingTools({ on: (_event: any, fn: any) => { callback = fn; }, answerCallbackQuery: async () => { finish(); }, sendMessage: async () => ({}) } as any);
    const oldReady = smartBooking.readiness, oldFetch = globalThis.fetch;
    smartBooking.readiness = async () => null;
    let enrollmentPosts = 0;
    globalThis.fetch = async (url) => {
        if (String(url).endsWith('/smart-booking-enrollment')) enrollmentPosts++;
        return new Response(JSON.stringify({ success: false, error: 'Enrollment unavailable' }), { status: 503 });
    };
    try {
        callback({ id: 'enrollment-failure-query', from: { id: userId }, message: { chat: { id: userId, type: 'private' } },
            data: `luxconfirm:${monitor.id}:${confirmation.revision}:${confirmation.token}` });
        await done;
        assert.equal(enrollmentPosts, 1);
        assert.equal(store.policy(userId)?.state, 'activating');
        assert.equal(store.enrollment(monitor.id)?.state, 'activating');
        assert.match(store.enrollment(monitor.id)?.status || '', /Activation paused/);
    } finally { smartBooking.readiness = oldReady; globalThis.fetch = oldFetch; }
});
test('availability status stays readable when mixed sidecar images lack new status endpoints', async () => {
    const { LuxmedAvailabilityStatus } = await import('../tools.luxmedSmart.ts');
    const userId = 131;
    globalDb.prepare('INSERT INTO users(user_id) VALUES (?)').run(userId);
    saveLuxmedAccount(userId, 131, 'status-test');
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ success: false, error: 'Unavailable' }), { status: 404 });
    try {
        const result = await LuxmedAvailabilityStatus.execute({ userId });
        assert.equal(result.success, true);
        assert.deepEqual(result.sidecar, { enrollment: { status: 'unavailable' }, legacyBarrier: { status: 'unavailable' } });
    } finally { globalThis.fetch = oldFetch; }
});

test('migration disables legacy autobook for active and interrupted smart enrollments', () => {
    const store = memoryStore();
    for (const [id, state] of [['active-smart', 'active'], ['activating-smart', 'activating']] as const) {
        store.db.prepare("INSERT INTO luxmed_monitorings(id,user_id,account_id,service_id,service_name,city_id,city_name,date_from,date_to,created_at,autobook) VALUES (?,1,1,6,'Visit',1,'Warszawa','2026-10-01','2026-11-01','2026-10-01',1)").run(id);
        store.enroll(id, 1);
        store.db.prepare('UPDATE luxmed_smart_monitors SET state=? WHERE monitoring_id=?').run(state, id);
        store.db.prepare('UPDATE luxmed_smart_monitors SET desired_autobook=NULL WHERE monitoring_id=?').run(id);
        store.db.prepare('UPDATE luxmed_monitorings SET autobook=1 WHERE id=?').run(id);
    }
    applyColumnMigrations(store.db); applyColumnMigrations(store.db);
    const rows = store.db.prepare(`SELECT m.autobook,s.desired_autobook FROM luxmed_monitorings m JOIN luxmed_smart_monitors s ON s.monitoring_id=m.id ORDER BY m.id`)
        .all() as { autobook: number; desired_autobook: number }[];
    assert.deepEqual(rows, [{ autobook: 0, desired_autobook: 1 }, { autobook: 0, desired_autobook: 1 }]);
    store.db.close();
});

test('Google fallback response cannot verify traffic feasibility', async () => {
    const q: TravelQuery = { from: home, to: clinic, mode: 'taxi', kind: 'depart', at: at('11:00') };
    const result = await computeGoogleRoute(q, {
        apiKey: 'fixture', fetch: async (_url, init) => {
            const mask = (init!.headers as Record<string, string>)['X-Goog-FieldMask'];
            assert.ok(mask.split(',').includes('fallbackInfo')); assert.ok(!mask.includes('routes.fallbackInfo'));
            return new Response(JSON.stringify({ fallbackInfo: { reason: 'SERVER_ERROR' }, routes: [{ duration: '1200s', distanceMeters: 1000 }] }));
        }
    });
    assert.equal(result.status, 'unknown');
});
test('portal removal clears a seen receipt but never an unobserved booking', () => {
    const store = memoryStore(); store.draft(1, policy);
    const a = store.begin(1, 1, null, 1, 'receipt', {});
    store.succeed(a.id, 77, { id: 'reservation:77', start: at('12:00'), end: at('12:30') }, 'Booked');
    const coverage = { from: at('00:00'), to: at('23:59') + 60000 };
    store.saveSnapshot(1, [], coverage); assert.equal(store.blocks(1).length, 1);
    store.saveSnapshot(1, [{ eventId: 77, date: new Date(at('12:00')).toISOString() }], coverage); assert.equal(store.blocks(1).length, 1);
    store.saveSnapshot(1, [], coverage); assert.equal(store.blocks(1).length, 1); store.db.close();
});
test('account Retry-After prevents queued searches from making another request', async () => {
    const { luxmedSearchSlots, LuxmedApiError } = await import('../luxmedAdapter.ts');
    const original = globalThis.fetch; let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('throttled', { status: 429, headers: { 'Retry-After': '60' } }); };
    const params = { cityId: 1, serviceId: 2, dateFrom: '2026-10-01', dateTo: '2026-10-07' };
    try {
        await assert.rejects(luxmedSearchSlots(987, params));
        await assert.rejects(luxmedSearchSlots(987, params), e => e instanceof LuxmedApiError && e.code === 'ACCOUNT_BACKOFF' && e.retryAfterMs! > 50000);
        assert.equal(calls, 1);
    } finally { globalThis.fetch = original; }
});

test('both route modes share a two-second candidate deadline', async () => {
    const started = performance.now();
    const result = await evaluateSlot(slot(), policy, places, [], () => new Promise(() => { }), now);
    assert.equal(result, null); assert.ok(performance.now() - started < 2500);
});
test('cached travel allowance is included in the reported departure', async () => {
    const result = await evaluateSlot(slot(), policy, places, [], async q => {
        const e = estimate(q, 1500, true);
        if (q.kind === 'arrive') { e.departure -= 5 * 60000; e.arrival -= 5 * 60000; }
        return e;
    }, now);
    assert.ok(result); assert.equal(result.leaveAt, at('11:20')); assert.equal(result.returnAt, at('13:10'));
});
test('a queued submission rejects a newly held policy before contacting LuxMed', async () => {
    const { LuxmedApiError } = await import('../luxmedAdapter.ts');
    const f = coordinatorFixture(); let submitted = 0;
    f.api.book = async (_account, _term, _city, _rebook, _id, guard) => {
        f.store.hold(1);
        if (guard && !guard()) throw new LuxmedApiError('Changed', 'BOOKING_GUARD_CHANGED');
        submitted++; return { state: 'succeeded', reservationId: 88 };
    };
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'waiting');
    assert.equal(submitted, 0); assert.equal(f.store.pending().length, 0); f.store.db.close();
});
test('a late travel conflict queues a warning without another booking or cancellation', async () => {
    const f = coordinatorFixture(); assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'booked');
    f.coordinator.cache(1).refresh = async q => ({ ...estimate(q, 1500, false, Date.now() + 1), status: 'no_route' });
    await f.coordinator.reconcile();
    const messages = f.store.db.prepare('SELECT message FROM luxmed_notification_outbox').all() as { message: string }[];
    assert.ok(messages.some(m => m.message.includes('has not been cancelled'))); assert.equal(f.books(), 1); f.store.db.close();
});

test('a reservation appearing during submission is reported with the successful booking', async () => {
    const f = coordinatorFixture();
    let started!: () => void, finish!: () => void;
    const inFlight = new Promise<void>(resolve => { started = resolve; });
    const reply = new Promise<void>(resolve => { finish = resolve; });
    f.api.book = async () => { started(); await reply; return { state: 'succeeded', reservationId: 77 }; };
    const booking = f.coordinator.process(f.config, [f.term]);
    await inFlight;
    const snapshot = f.store.snapshot(1)!;
    const from = f.term.term.dateTimeFrom.dateTimeLocal!, to = f.term.term.dateTimeTo.dateTimeLocal!;
    f.store.saveSnapshot(1, [{ eventId: 88, date: from, dateTo: to, eventType: 'Telemedicine' }],
        { from: snapshot.coveredFrom!, to: snapshot.coveredTo! });
    finish();
    assert.equal((await booking).state, 'booked');
    const messages = f.store.db.prepare('SELECT message FROM luxmed_notification_outbox').all() as { message: string }[];
    assert.ok(messages.some(row => row.message.includes('reservations changed while booking was submitted')));
    f.store.db.close();
});

test('a newly drafted conflicting commitment still warns about an existing booking', async () => {
    const f = coordinatorFixture();
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'booked');
    const day = f.term.term.dateTimeFrom.dateTimeLocal!.slice(0, 10);
    f.store.draft(1, { ...policy, commitments: [{ id: 'new-call', name: 'Call', date: day,
        from: '12:00', to: '12:30', locationId: 'home' }] });
    f.coordinator.cache(1).refresh = async q => estimate(q, 1500, false, Date.now());
    await f.coordinator.reconcile();
    const messages = f.store.db.prepare('SELECT message FROM luxmed_notification_outbox').all() as { message: string }[];
    assert.ok(messages.some(row => row.message.includes('another LuxMed reservation may conflict')));
    f.store.db.close();
});

test('a cold earlier candidate is checked before booking a later verified slot', async () => {
    const f = coordinatorFixture();
    const cache = f.coordinator.cache(1);
    const cold = structuredClone(f.term); cold.term.scheduleId = 9; cold.term.clinicId = 4; cold.term.dateTimeFrom.dateTimeLocal = cold.term.dateTimeFrom.dateTimeLocal!.replace('12:00', '11:00'); cold.term.dateTimeTo.dateTimeLocal = cold.term.dateTimeTo.dateTimeLocal!.replace('12:30', '11:30');
    cold.term.clinic = 'Cold - Zimna 4';
    f.store.place(1, 'clinic:1:4', 'Zimna 4, Warszawa', 52.3, 21.3);
    f.store.verifyClinic(1, 'clinic:1:4', 'Cold - Zimna 4', f.store.places(1).get('clinic:1:4')!.revision);
    let coldChecks = 0;
    cache.lookup = async q => { if (q.from.id === 'clinic:1:4' || q.to.id === 'clinic:1:4') { coldChecks++; return null; } return estimate(q, 1500, false, Date.now()); };
    const started = performance.now();
    assert.equal((await f.coordinator.process(f.config, [cold, f.term])).state, 'booked');
    assert.ok(coldChecks > 0); assert.ok(performance.now() - started < 1500); assert.equal(f.books(), 1); f.store.db.close();
});
test('many warm exact-date candidates are inspected in one cycle', async () => {
    const f = coordinatorFixture();
    const day = f.config.dateFrom.slice(0, 10);
    const terms = Array.from({ length: 20 }, (_, index) => {
        const value = structuredClone(f.term);
        const start = DateTime.fromISO(`${day}T09:00:00`, { zone: 'Europe/Warsaw' }).plus({ minutes: index * 30 });
        value.term.scheduleId = 100 + index;
        value.term.dateTimeFrom.dateTimeLocal = start.toFormat("yyyy-MM-dd'T'HH:mm:ss");
        value.term.dateTimeTo.dateTimeLocal = start.plus({ minutes: 30 }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
        return value;
    });
    const cache = f.coordinator.cache(1);
    let coldLookups = 0;
    cache.prepared = q => estimate(q, 1500, false, Date.now());
    cache.lookup = async () => { coldLookups++; return null; };
    const inspected = await f.coordinator.inspect(f.config, terms);
    assert.equal(inspected.complete, true);
    assert.equal(inspected.candidates.length, 20);
    assert.equal(coldLookups, 0);
    f.store.db.close();
});
test('a verified earlier day is not delayed by many later cold routes', async () => {
    const f = coordinatorFixture();
    const firstDay = f.config.dateFrom.slice(0, 10);
    const laterDay = DateTime.fromISO(firstDay, { zone: 'Europe/Warsaw' }).plus({ days: 1 }).toISODate()!;
    f.config.dateTo = `${laterDay}T23:59:59`;
    const later = Array.from({ length: 20 }, (_, index) => {
        const term = structuredClone(f.term);
        const start = DateTime.fromISO(`${laterDay}T09:00:00`, { zone: 'Europe/Warsaw' }).plus({ minutes: index * 30 });
        term.term.scheduleId = 100 + index;
        term.term.dateTimeFrom.dateTimeLocal = start.toFormat("yyyy-MM-dd'T'HH:mm:ss");
        term.term.dateTimeTo.dateTimeLocal = start.plus({ minutes: 30 }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
        return term;
    });
    let laterLookups = 0;
    const cache = f.coordinator.cache(1);
    cache.prepared = q => DateTime.fromMillis(q.at, { zone: 'Europe/Warsaw' }).toISODate() === firstDay
        ? estimate(q, 1500, false, Date.now()) : null;
    cache.lookup = async q => { if (DateTime.fromMillis(q.at, { zone: 'Europe/Warsaw' }).toISODate() === laterDay) laterLookups++; return null; };
    const result = await f.coordinator.inspect(f.config, [f.term, ...later]);
    assert.equal(result.complete, true);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.deferredFromDay, laterDay);
    assert.equal(laterLookups, 0);
    f.store.db.close();
});
test('a late exact route is reconsidered when a cold candidate scan resumes', async () => {
    const f = coordinatorFixture();
    const firstDay = f.config.dateFrom.slice(0, 10);
    const laterDay = DateTime.fromISO(firstDay, { zone: 'Europe/Warsaw' }).plus({ days: 1 }).toISODate()!;
    f.config.dateTo = `${laterDay}T23:59:59`;
    const terms = Array.from({ length: 5 }, (_, index) => {
        const term = structuredClone(f.term);
        const hour = 9 + index;
        term.term.scheduleId = 300 + index;
        term.term.dateTimeFrom.dateTimeLocal = `${firstDay}T${String(hour).padStart(2, '0')}:00:00`;
        term.term.dateTimeTo.dateTimeLocal = `${firstDay}T${String(hour).padStart(2, '0')}:30:00`;
        return term;
    });
    const later = structuredClone(f.term);
    later.term.scheduleId = 400;
    later.term.dateTimeFrom.dateTimeLocal = `${laterDay}T12:00:00`;
    later.term.dateTimeTo.dateTimeLocal = `${laterDay}T12:30:00`;
    let earlyRouteReady = false;
    const cache = f.coordinator.cache(1);
    cache.prepared = q => earlyRouteReady || DateTime.fromMillis(q.at, { zone: 'Europe/Warsaw' }).toISODate() === laterDay
        ? estimate(q, 1500, false, Date.now()) : null;
    cache.lookup = async () => null;
    const first = await f.coordinator.inspect(f.config, [...terms, later]);
    assert.equal(first.complete, false);
    earlyRouteReady = true;
    const second = await f.coordinator.inspect(f.config, [...terms, later]);
    assert.equal(second.complete, true);
    assert.ok(second.candidates.some(candidate => candidate.day === firstDay));
    assert.equal([...second.candidates].sort(compareFeasible)[0].day, firstDay);
    f.store.db.close();
});
test('many hard-infeasible slots do not consume cold-route scan cycles', async () => {
    const f = coordinatorFixture();
    const day = f.config.dateFrom.slice(0, 10);
    const terms = Array.from({ length: 20 }, (_, index) => {
        const value = structuredClone(f.term);
        value.term.scheduleId = 200 + index;
        value.term.dateTimeFrom.dateTimeLocal = `${day}T19:30:00`;
        value.term.dateTimeTo.dateTimeLocal = `${day}T20:00:00`;
        return value;
    });
    const cache = f.coordinator.cache(1);
    let routeCalls = 0;
    cache.prepared = () => { routeCalls++; return null; };
    cache.lookup = async () => { routeCalls++; return null; };
    const inspected = await f.coordinator.inspect(f.config, terms);
    assert.equal(inspected.complete, true);
    assert.equal(inspected.candidates.length, 0);
    assert.equal(routeCalls, 0);
    f.store.db.close();
});
test('saturated route workers check cold earlier slots without delaying a verified earlier day', async () => {
    const { queueTravelRequest } = await import('../luxmedTravel.ts');
    const f = coordinatorFixture();
    const firstDay = f.config.dateFrom.slice(0, 10);
    const nextDay = DateTime.fromISO(firstDay).plus({ days: 1 }).toISODate()!;
    f.config.dateTo = `${nextDay}T23:59:59`;
    const makeTerm = (day: string, time: string, scheduleId: number): LuxmedTerm => {
        const value = structuredClone(f.term);
        value.term.scheduleId = scheduleId;
        value.term.dateTimeFrom.dateTimeLocal = `${day}T${time}:00`;
        value.term.dateTimeTo.dateTimeLocal = `${day}T${String(Number(time.slice(0, 2))).padStart(2, '0')}:30:00`;
        return value;
    };
    const terms = [
        makeTerm(firstDay, '09:00', 9), makeTerm(firstDay, '10:00', 10),
        makeTerm(firstDay, '11:00', 11), makeTerm(firstDay, '12:00', 12),
        makeTerm(nextDay, '09:00', 13),
    ];
    const firstArrival = slotFromTerm(terms[0], f.config.cityId).start - 10 * 60000;
    let laterDayRequests = 0;
    f.coordinator.cache(1).lookup = async q => {
        if (DateTime.fromMillis(q.at, { zone: 'Europe/Warsaw' }).toISODate() === nextDay) {
            laterDayRequests++;
            return estimate(q, 1500, false, Date.now());
        }
        return queueTravelRequest(async () => {
            await new Promise(resolve => setTimeout(resolve, 1050));
            return q.kind === 'arrive' && q.at === firstArrival ? null : estimate(q, 1500, false, Date.now());
        }, 10);
    };
    assert.equal((await f.coordinator.process(f.config, terms)).state, 'booked');
    assert.equal(f.books(), 1);
    assert.equal(laterDayRequests, 0);
    const booked = f.store.db.prepare("SELECT payload FROM luxmed_booking_attempts WHERE state='succeeded'").get() as { payload: string };
    assert.equal(DateTime.fromMillis(JSON.parse(booked.payload).slot.start, { zone: 'Europe/Warsaw' }).toISODate(), firstDay);
    f.store.db.close();
});
test('an unverified clinic ID and address cannot become a booking route', async () => {
    const f = coordinatorFixture();
    f.store.db.prepare('DELETE FROM luxmed_smart_clinic_bindings WHERE user_id=1').run();
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'waiting');
    assert.equal(f.books(), 0);
    f.store.db.close();
});
test('a unique geocode must still match the clinic street and number', () => {
    assert.equal(providerStreetMatches('LX Wrocław - Fabryczna 6', 'Fabryczna 6, Wrocław, Polska'), true);
    assert.equal(providerStreetMatches('LX Wrocław - Fabryczna 6', 'Fabryczna 8, Wrocław, Polska'), false);
    assert.equal(providerStreetMatches('LX Wrocław - Fabryczna 6', 'Wołowska 6, Wrocław, Polska'), false);
    assert.equal(providerStreetMatches('Nowa Wieś 5', 'Stara Wieś 5, Warszawa'), false);
    assert.equal(providerStreetMatches('LX Wrocław', 'Fabryczna 6, Wrocław, Polska'), false);
    assert.equal(providerStreetMatches('Clinic 2', 'Clinic 2, Fabryczna 8, Wrocław'), false);
    assert.equal(providerCityMatches('Warszawa', 'Domaniewska 52, Kraków, Polska'), false);
    assert.equal(providerCityMatches('Warszawa', 'Domaniewska 52, 02-672 Warszawa, Polska'), true);
});
test('a clinic street in another city remains excluded when the monitor city name is wrong', async () => {
    const f = coordinatorFixture();
    f.config.cityName = 'Kraków';
    const place = f.store.place(1, clinic.id, 'Testowa 2, Kraków, Polska', 50, 19);
    f.store.verifyClinic(1, clinic.id, f.term.term.clinic!, place.revision);
    assert.equal((await f.coordinator.inspect(f.config, [f.term], true)).candidates.length, 0);
    assert.equal(f.books(), 0);
    f.store.db.close();
});
test('an unverified existing reservation location cannot be treated as home', async () => {
    const f = coordinatorFixture();
    const date = f.term.term.dateTimeFrom.dateTimeLocal!.slice(0, 10);
    const oldAttempt = f.store.begin(1, 1, null, 1, 'old-clinic', {});
    f.store.succeed(oldAttempt.id, 88, { id: 'reservation:88', start: zonedTime(`${date}T10:00:00`),
        end: zonedTime(`${date}T11:00:00`), locationId: clinic.id }, 'Earlier booking');
    f.store.saveSnapshot(1, [{ eventId: 88, date: `${date}T10:00:00`, dateTo: `${date}T11:00:00`,
        eventType: 'Visit', clinic: { address: 'Testowa 2', city: 'Kraków' } }],
        { from: zonedTime(`${date}T00:00:00`), to: zonedTime(`${date}T23:59:59`) });
    const reservations = await f.coordinator.intervals(1, 1, 1);
    assert.equal(reservations[0].locationId, 'unresolved-reservation:88');
    const candidate = { ...slot(), start: zonedTime(`${date}T11:40:00`), end: zonedTime(`${date}T12:10:00`) };
    const feasible = await evaluateSlot(candidate, policy, f.store.places(1), reservations, async q => estimate(q, 5 * 60, false, Date.now()));
    assert.equal(feasible, null);
    f.store.db.close();
});
test('cached inbound travel uses an earlier real connection and applies its allowance once', async () => {
    const queries:TravelQuery[] = [];
    const result = await evaluateSlot(slot('11:45', '12:15'), policy, places,
        [{id:'call',start:at('10:00'),end:at('11:00'),locationId:'home'}], async q => {
            queries.push(q); return estimate(q, 1500, true);
        }, now);
    assert.ok(result); assert.equal(result.leaveAt, at('11:05'));
    assert.ok(queries.some(q => q.kind === 'arrive' && q.at === at('11:30')));
});

test('scheduler combines duplicate searches and does not poll before the next due time', async () => {
    const {createLuxmedMonitoring, deactivateLuxmedMonitoring} = await import('../userStore.ts');
    const {smartBooking} = await import('../luxmedSmartBooking.ts');
    const {runLuxmedMonitoringCycle} = await import('../luxmedMonitor.ts');
    const store = new SmartBookingStore(globalDb);
    deactivateLuxmedMonitoring('confirm-test', 10);
    globalDb.prepare('INSERT OR IGNORE INTO users(user_id) VALUES (20)').run();
    globalDb.prepare("INSERT OR REPLACE INTO luxmed_accounts(user_id,account_id,username,created_at) VALUES (20,20,'fixture','2026-10-01')").run();
    const verifiedHome = store.place(20, home.id, home.address, home.lat, home.lng);
    store.verifyLocation(20, home.id, verifiedHome.revision); store.draft(20, policy);
    const confirmation = store.confirmation(20); store.confirm(20, confirmation.token, confirmation.revision);
    const date = DateTime.now().plus({days:2}).toISODate()!;
    for (const id of ['duplicate-a', 'duplicate-b']) {
        createLuxmedMonitoring({id,userId:20,accountId:20,serviceId:6,serviceName:'Fixture',cityId:1,cityName:'Warszawa',clinicIds:null,doctorIds:null,englishOnly:false,dateFrom:date,dateTo:date,timeFrom:'08:00',timeTo:'20:00',autobook:true,rebookIfExists:false});
        store.enroll(id, 20); globalDb.prepare("UPDATE luxmed_smart_monitors SET state='active' WHERE monitoring_id=?").run(id);
    }
    const old = {fetch:globalThis.fetch,readiness:smartBooking.readiness,legacy:smartBooking.legacyMonitorIssue,refresh:smartBooking.refreshReservations,process:smartBooking.process,reconcile:smartBooking.reconcile};
    let searches = 0, decisions = 0;
    globalThis.fetch = async () => { searches++; return new Response(JSON.stringify({success:true,data:[]})); };
    smartBooking.readiness = async () => null; smartBooking.legacyMonitorIssue = async () => null; smartBooking.refreshReservations = async () => {};
    smartBooking.reconcile = async () => {};
    smartBooking.process = async () => { decisions++; return {state:'waiting',message:'Fixture'}; };
    try {
        smartBooking.legacyMonitorIssue = async () => 'An existing LuxMed automatic monitor is still active.';
        await runLuxmedMonitoringCycle(); assert.equal(searches, 0); assert.equal(decisions, 0);
        globalDb.prepare('UPDATE luxmed_smart_monitors SET next_check=0 WHERE user_id=20').run();
        smartBooking.legacyMonitorIssue = async () => null;
        await runLuxmedMonitoringCycle(); assert.equal(searches, 1); assert.equal(decisions, 2);
        const due = store.enrollment('duplicate-a')!.next_check; assert.ok(due - Date.now() > 28000 && due - Date.now() <= 33000);
        await runLuxmedMonitoringCycle(); assert.equal(searches, 1); assert.equal(decisions, 2);
        globalDb.prepare('UPDATE luxmed_smart_monitors SET next_check=0 WHERE user_id=20').run();
        await runLuxmedMonitoringCycle(); assert.equal(searches, 1); assert.equal(decisions, 4);
    } finally {
        globalThis.fetch = old.fetch; smartBooking.readiness = old.readiness; smartBooking.legacyMonitorIssue = old.legacy; smartBooking.refreshReservations = old.refresh;
        smartBooking.process = old.process; smartBooking.reconcile = old.reconcile;
        for (const id of ['duplicate-a', 'duplicate-b']) deactivateLuxmedMonitoring(id, 20);
    }
});

test('a failed background refresh preserves the previous route and observes cooldown', async () => {
    const store = memoryStore(); let clock = now, calls = 0;
    const q:TravelQuery = {from:home,to:clinic,mode:'transit',kind:'depart',at:at('12:00')};
    const cache = new TravelCache('1', store.db, true, async query => {
        if (++calls > 1) throw new Error('Simulated Google outage');
        return estimate(query, 1500, false, clock);
    }, () => clock);
    await cache.lookup(q); clock += 6 * 60000;
    const previous = await cache.lookup(q); await cache.refresh(q);
    assert.equal(previous?.cached, true); assert.equal(cache.previous(q)?.durationSeconds, 1500);
    assert.equal(cache.metrics.failures, 1); assert.equal(calls, 2); store.db.close();
});
test('holiday travel requests retain the actual date instead of substituting a weekday profile', async () => {
    const holiday = zonedTime('2026-12-25T13:00:00');
    const q:TravelQuery = {from:home,to:clinic,mode:'transit',kind:'depart',at:holiday};
    await computeGoogleRoute(q, {apiKey:'fixture',fetch:async (_url, init) => {
        assert.equal(JSON.parse(init!.body as string).departureTime, new Date(holiday).toISOString());
        return new Response(JSON.stringify({routes:[]}));
    }});
    assert.equal(usableEstimate(estimate({...q,profile:true}), q, now), false);
});

test('an existing monitor transit limit remains binding after smart enrolment', async () => {
    const f = coordinatorFixture();
    f.store.draft(1, {...policy,maxTaxiMinutes:0});
    const c = f.store.confirmation(1); f.store.confirm(1, c.token, c.revision);
    f.config.maxTransitMinutes = 10;
    assert.equal((await f.coordinator.process(f.config, [f.term])).state, 'waiting');
    assert.equal(f.books(), 0); f.store.db.close();
});
