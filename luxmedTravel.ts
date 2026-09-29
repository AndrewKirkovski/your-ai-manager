import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BOOKING_ZONE, usableEstimate, type Place, type TravelEstimate, type TravelQuery } from './luxmedAvailability';
import { computeGoogleRoute } from './googleRoutes';

type Job = { priority: number; key?: string; run: () => Promise<unknown>; resolve: (value: any) => void; reject: (error: unknown) => void };
const jobs: Job[] = [];
let running = 0;
function pump(): void {
    while (running < 2 && jobs.length) {
        jobs.sort((a, b) => b.priority - a.priority);
        // Keep a slot free while warming broad profiles so exact candidate
        // checks can start without waiting for two background requests.
        if (running >= 1 && jobs[0].priority <= 0) break;
        const job = jobs.shift()!;
        running++;
        void job.run().then(job.resolve, job.reject).finally(() => { running--; pump(); });
    }
}
function queue<T>(run: () => Promise<T>, priority: number, key?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => { jobs.push({ priority, key, run, resolve, reject }); pump(); });
}
export const queueTravelRequest = queue;

export function profileQueries(from: Place, to: Place, now = Date.now()): TravelQuery[] {
    const today = DateTime.fromMillis(now, { zone: BOOKING_ZONE }).startOf('day');
    const result: TravelQuery[] = [];
    for (const weekday of [2, 6, 7]) {
        let day = today.plus({ days: (weekday - today.weekday + 7) % 7 });
        if (day.toMillis() <= today.toMillis()) day = day.plus({ days: 7 });
        for (const [hour, minute] of [[8, 0], [13, 0], [17, 30]]) for (const mode of ['transit', 'taxi'] as const) for (const [origin, destination] of [[from, to], [to, from]]) {
            result.push({ from: origin, to: destination, mode, kind: 'depart', at: day.set({ hour, minute }).toMillis(), profile: true });
        }
    }
    return result;
}

export class TravelCache {
    private values = new Map<string, TravelEstimate>();
    private inFlight = new Map<string, Promise<TravelEstimate | null>>();
    private lastRequest = new Map<string, number>();
    private backgroundFailed = new Set<string>();
    readonly metrics = { hits: 0, misses: 0, refreshes: 0, failures: 0 };
    constructor(private owner: string, private db: Database.Database, private permitted = process.env.GOOGLE_ROUTES_CACHE_PERMITTED === 'true', private fetchRoute = computeGoogleRoute, private now = Date.now) { }
    key(q: TravelQuery): string {
        return createHash('sha256').update(JSON.stringify([this.owner, q.from.id, q.from.revision, q.to.id, q.to.revision, q.mode, q.kind, q.profile || false, Math.floor(q.at / 60000)])).digest('hex');
    }
    previous(q: TravelQuery): TravelEstimate | null {
        if (!this.permitted) return null;
        const key = this.key(q);
        let value = this.values.get(key);
        if (!value) {
            const row = this.db.prepare('SELECT value FROM luxmed_travel_estimates WHERE cache_key=? AND fetched_at>?').get(key, this.now() - 7 * 86400000) as { value: string } | undefined;
            if (row) { try { value = JSON.parse(row.value); } catch { return null; } }
            if (value) this.values.set(key, value);
        }
        return value ? { ...value, cached: true } : null;
    }
    refresh(q: TravelQuery, priority = 1): Promise<TravelEstimate | null> {
        const key = this.key(q);
        const pending = this.inFlight.get(key);
        if (pending) {
            const queued = jobs.find(job => job.key === key);
            if (queued) { queued.priority = Math.max(queued.priority, priority); pump(); }
            return pending;
        }
        if (this.now() - (this.lastRequest.get(key) ?? -Infinity) < 5 * 60000) {
            // One candidate may retry a failed preparation request. Repeated
            // foreground failures still observe the five-minute cooldown.
            if (priority <= 0 || !this.backgroundFailed.delete(key)) return Promise.resolve(this.previous(q));
        } else this.backgroundFailed.delete(key);
        const request = queue(async () => {
            try {
                this.metrics.refreshes++;
                // Count every provider attempt, including unknown responses and
                // thrown requests, from when the queued job actually starts.
                this.lastRequest.set(key, this.now());
                const e = await this.fetchRoute(q);
                if (e.status === 'unknown' && priority <= 0) this.backgroundFailed.add(key);
                else this.backgroundFailed.delete(key);
                if (this.permitted) {
                    this.values.set(key, e);
                    this.db.prepare('INSERT OR REPLACE INTO luxmed_travel_estimates(cache_key,value,fetched_at) VALUES (?,?,?)').run(key, JSON.stringify(e), e.fetchedAt);
                    if (this.values.size > 5000) this.values.delete(this.values.keys().next().value!);
                    this.db.prepare('DELETE FROM luxmed_travel_estimates WHERE fetched_at<?').run(this.now() - 7 * 86400000);
                }
                return e;
            } catch {
                this.metrics.failures++;
                if (priority <= 0) this.backgroundFailed.add(key);
                else this.backgroundFailed.delete(key);
                console.warn('[LuxMed travel] Route refresh failed; route remains unverified', { mode: q.mode });
                return null;
            }
        }, priority, key).finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, request);
        return request;
    }
    async lookup(q: TravelQuery): Promise<TravelEstimate | null> {
        const previous = this.previous(q);
        const refresh = this.refresh(q, 10);
        if (previous && usableEstimate(previous, q, this.now())) { this.metrics.hits++; return previous; }
        this.metrics.misses++;
        const deadline = Date.now() + 2000;
        const wait = async (request: Promise<TravelEstimate | null>): Promise<TravelEstimate | null> => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return null;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try { return await Promise.race([request, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining); })]); }
            finally { if (timer) clearTimeout(timer); }
        };
        const first = await wait(refresh);
        if (first && usableEstimate(first, q, this.now())) return first;
        // If a candidate joined failed preparation, use its one permitted
        // priority retry now when the foreground deadline still has room.
        if (this.backgroundFailed.has(this.key(q)) && Date.now() < deadline) return wait(this.refresh(q, 10));
        return first;
    }
    prepared(q: TravelQuery): TravelEstimate | null {
        const previous = this.previous(q);
        // Warm candidates may be ranked now; refresh them behind exact-route
        // misses so a broad scan cannot consume the foreground deadline.
        void this.refresh(q, 0);
        if (previous && usableEstimate(previous, q, this.now())) { this.metrics.hits++; return previous; }
        return null;
    }
    warm(from: Place, to: Place, additional: TravelQuery[] = []): void {
        if (!this.permitted) return;
        for (const query of [...profileQueries(from, to, this.now()), ...additional]) {
            const previous = this.previous(query);
            if (!previous || this.now() - previous.fetchedAt >= 86400000) void this.refresh(query, 0);
        }
    }
}
