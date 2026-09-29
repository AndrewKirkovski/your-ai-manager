import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { usableEstimate, type Place, type TravelEstimate, type TravelQuery } from '../luxmedAvailability.ts';
import { queueTravelRequest, TravelCache } from '../luxmedTravel.ts';

const home: Place = { id: 'home', revision: '1', address: 'Home', lat: 52.2, lng: 21.0 };
const clinic: Place = { id: 'clinic', revision: '1', address: 'Clinic', lat: 52.3, lng: 21.1 };
const departure = Date.parse('2026-10-06T12:00:00+02:00');
const query: TravelQuery = { from: home, to: clinic, mode: 'transit', kind: 'depart', at: departure };

function database(): Database.Database {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE luxmed_travel_estimates(cache_key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at INTEGER NOT NULL)');
    return db;
}

function route(status: TravelEstimate['status'], fetchedAt: number): TravelEstimate {
    return { query, status, departure, arrival: departure + 25 * 60000,
        durationSeconds: 25 * 60, distanceMeters: 6000, fetchedAt, cached: false };
}

test('a thrown provider request has a five-minute cooldown', async () => {
    const db = database();
    try {
        let now = departure - 3600000;
        let calls = 0;
        const cache = new TravelCache('user', db, true, async () => {
            calls++;
            throw new Error('Google unavailable');
        }, () => now);

        assert.equal(await cache.lookup(query), null);
        assert.equal(await cache.lookup(query), null);
        now += 5 * 60000 - 1;
        assert.equal(await cache.lookup(query), null);
        assert.equal(calls, 1);
        now++;
        assert.equal(await cache.lookup(query), null);
        assert.equal(calls, 2);
        assert.equal(cache.metrics.failures, 2);
    } finally { db.close(); }
});

test('an unknown provider result is cooled down and remains unusable for booking', async () => {
    const db = database();
    try {
        let now = departure - 3600000;
        let calls = 0;
        const cache = new TravelCache('user', db, true, async () => {
            calls++;
            return route('unknown', now);
        }, () => now);

        assert.equal((await cache.lookup(query))?.status, 'unknown');
        const repeated = await cache.lookup(query);
        assert.equal(repeated?.status, 'unknown');
        assert.equal(usableEstimate(repeated!, query, now), false);
        now += 5 * 60000 - 1;
        assert.equal((await cache.lookup(query))?.status, 'unknown');
        assert.equal(calls, 1);
        now++;
        assert.equal((await cache.lookup(query))?.status, 'unknown');
        assert.equal(calls, 2);
    } finally { db.close(); }
});

test('a candidate promotes its queued refresh ahead of background preparation', async () => {
    const db = database();
    let releaseBlocker: (() => void) | undefined;
    const blocker = queueTravelRequest(() => new Promise<void>(resolve => { releaseBlocker = resolve; }), 0);
    try {
        let calls = 0;
        const now = departure - 3600000;
        const cache = new TravelCache('user', db, true, async () => {
            calls++;
            return route('ok', now);
        }, () => now);
        const background = cache.refresh(query, 0);
        const candidate = await cache.lookup(query);
        assert.equal(candidate?.status, 'ok');
        assert.equal(calls, 1);
        assert.equal(await background, candidate);
    } finally {
        releaseBlocker?.();
        await blocker;
        db.close();
    }
});

test('a candidate gets one priority retry after an unknown background route', async () => {
    const db = database();
    try {
        let now = departure - 3600000;
        let calls = 0;
        const cache = new TravelCache('user', db, true, async () => {
            calls++;
            return route(calls === 1 ? 'unknown' : 'ok', now);
        }, () => now);

        assert.equal((await cache.refresh(query, 0))?.status, 'unknown');
        assert.equal((await cache.lookup(query))?.status, 'ok');
        assert.equal(calls, 2);
        assert.equal((await cache.lookup(query))?.status, 'ok');
        assert.equal(calls, 2);
    } finally { db.close(); }
});

test('a candidate joining a failed background request retries within its deadline', async () => {
    const db = database();
    try {
        const now = departure - 3600000;
        let calls = 0;
        let resolveFirst: ((value: TravelEstimate) => void) | undefined;
        const cache = new TravelCache('user', db, true, async () => {
            calls++;
            return calls === 1 ? new Promise<TravelEstimate>(resolve => { resolveFirst = resolve; }) : route('ok', now);
        }, () => now);
        const background = cache.refresh(query, 0);
        const joined = cache.lookup(query);
        resolveFirst?.(route('unknown', now));
        assert.equal((await background)?.status, 'unknown');
        assert.equal((await joined)?.status, 'ok');
        assert.equal(calls, 2);
        assert.equal((await cache.lookup(query))?.status, 'ok');
        assert.equal(calls, 2);
    } finally { db.close(); }
});
