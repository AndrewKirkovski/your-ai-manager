import { DateTime } from 'luxon';

export const BOOKING_ZONE = process.env.TZ || 'Europe/Warsaw';
export type TravelMode = 'transit' | 'taxi';
export interface TimeRule {
    date?: string;
    weekdays?: number[];
    from: string;
    to: string;
    validFrom?: string;
    validTo?: string;
    exceptDates?: string[];
}
export interface Commitment extends TimeRule {
    id: string;
    name: string;
    locationId?: string;
    source?: { type: 'task' | 'routine'; id: string };
}
export interface AvailabilityPolicy {
    version: 1;
    timezone: string;
    originLocationId: string;
    windows: TimeRule[];
    commitments: Commitment[];
    unresolved: string[];
    softPreferences: string[];
    maxTransitMinutes: number;
    maxTaxiMinutes: number;
    preparationConfirmed: boolean;
}
export interface Place {
    id: string;
    revision: string;
    address: string;
    lat: number;
    lng: number;
}
export interface BusyInterval {
    id: string;
    start: number;
    end: number;
    locationId?: string;
    transitionMinutes?: number;
}
export interface Slot {
    id: string;
    start: number;
    end: number;
    locationId?: string;
    telemedicine: boolean;
    preparationRequired: boolean;
    preparationConfirmed?: boolean;
}
export interface TravelQuery {
    from: Place;
    to: Place;
    mode: TravelMode;
    at: number;
    kind: 'depart' | 'arrive';
    profile?: boolean;
}
export interface TravelEstimate {
    query: TravelQuery;
    status: 'ok' | 'no_route' | 'unknown';
    departure: number;
    arrival: number;
    durationSeconds: number;
    distanceMeters: number;
    fetchedAt: number;
    cached: boolean;
}
export interface FeasibleSlot {
    slot: Slot;
    day: string;
    taxiLegs: number;
    travelSeconds: number;
    leaveAt: number;
    returnAt: number;
    legs: TravelEstimate[];
}
export type RouteLookup = (query: TravelQuery) => Promise<TravelEstimate | null>;
export const BUFFERS = { transition: 5 * 60000, checkIn: 10 * 60000, after: 10 * 60000, pickup: 5 * 60000 };

export function validBookingTimeRange(from: unknown, to: unknown): boolean {
    return typeof from === 'string' && typeof to === 'string'
        && /^([01]\d|2[0-3]):[0-5]\d$/.test(from)
        && /^([01]\d|2[0-3]):[0-5]\d$/.test(to) && from <= to;
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}
function validDate(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value).isValid;
}
function validateRule(rule: TimeRule): void {
    assert(rule && typeof rule === 'object', 'Each availability entry must be an object.');
    assert(/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.from) && /^([01]\d|2[0-3]):[0-5]\d$/.test(rule.to), 'Times must use HH:mm.');
    assert(rule.from !== rule.to, 'Start and end must differ. Use 00:00 to 23:59 for a whole day.');
    assert(Boolean(rule.date) !== Boolean(rule.weekdays), 'Specify either a date or recurring weekdays.');
    if (rule.date) {
        assert(validDate(rule.date), 'Invalid commitment date.');
        assert(rule.validFrom === undefined && rule.validTo === undefined
            && (rule.exceptDates === undefined || Array.isArray(rule.exceptDates) && rule.exceptDates.length === 0),
        'A one-off date cannot have recurrence bounds or exceptions.');
    }
    if (rule.weekdays) assert(Array.isArray(rule.weekdays) && rule.weekdays.length > 0 && rule.weekdays.every(d => Number.isInteger(d) && d >= 1 && d <= 7), 'Weekdays must be 1 (Monday) to 7 (Sunday).');
    for (const d of [rule.validFrom, rule.validTo, ...(rule.exceptDates || [])]) if (d) assert(validDate(d), 'Invalid recurrence boundary or exception.');
    if (rule.validFrom && rule.validTo) assert(rule.validFrom <= rule.validTo, 'Recurrence dates are reversed.');
}
export function validatePolicy(input: unknown): AvailabilityPolicy {
    assert(input && typeof input === 'object', 'Availability must be an object.');
    const p = input as AvailabilityPolicy;
    assert(p.version === 1 && p.timezone === BOOKING_ZONE, `Use version 1 and timezone ${BOOKING_ZONE}.`);
    assert(typeof p.originLocationId === 'string' && p.originLocationId.length > 0, 'Confirm the default starting location.');
    assert(Array.isArray(p.windows) && p.windows.length > 0 && p.windows.length <= 100, 'Provide 1 to 100 availability windows.');
    assert(Array.isArray(p.commitments) && p.commitments.length <= 200, 'Provide at most 200 commitments.');
    p.windows.forEach(validateRule);
    const ids = new Set<string>();
    for (const c of p.commitments) {
        validateRule(c);
        assert(typeof c.id === 'string' && c.id.length > 0 && !ids.has(c.id), 'Commitment IDs must be unique.');
        ids.add(c.id);
        assert(typeof c.name === 'string' && c.name.length > 0, 'Commitments need a name.');
        if (c.source) assert(['task', 'routine'].includes(c.source.type) && typeof c.source.id === 'string', 'Invalid linked task or routine.');
    }
    for (const field of ['unresolved', 'softPreferences'] as const) assert(Array.isArray(p[field]) && p[field].length <= 50 && p[field].every(s => typeof s === 'string' && s.length <= 1000), `Invalid ${field}.`);
    for (const value of [p.maxTransitMinutes, p.maxTaxiMinutes]) assert(Number.isFinite(value) && value >= 0 && value <= 240, 'Confirm journey limits between 0 and 240 minutes. Zero disables that mode.');
    assert(typeof p.preparationConfirmed === 'boolean', 'Specify whether appointment preparation has been confirmed.');
    return structuredClone(p);
}

export function zonedTime(value: string, zone = BOOKING_ZONE): number {
    const dt = DateTime.fromISO(value, { zone, setZone: true });
    return dt.isValid ? dt.toMillis() : NaN;
}

/** Expand by calendar days, not 24-hour increments, preserving Warsaw wall time. */
export function expandRule(rule: TimeRule, start: number, end: number, zone = BOOKING_ZONE, blockInvalid = false): Array<{ start: number; end: number }> {
    const result: Array<{ start: number; end: number }> = [];
    let day = DateTime.fromMillis(start, { zone }).startOf('day').minus({ days: 1 });
    const last = DateTime.fromMillis(end, { zone }).startOf('day');
    for (let n = 0; day <= last && n <= 368; n++, day = day.plus({ days: 1 })) {
        const date = day.toISODate()!;
        if (rule.date ? date !== rule.date : !rule.weekdays!.includes(day.weekday)) continue;
        if ((rule.validFrom && date < rule.validFrom) || (rule.validTo && date > rule.validTo) || rule.exceptDates?.includes(date)) continue;
        const from = DateTime.fromISO(`${date}T${rule.from}`, { zone });
        const endDay = rule.to < rule.from ? day.plus({ days: 1 }).toISODate() : date;
        const to = DateTime.fromISO(`${endDay}T${rule.to}`, { zone });
        // Reject nonexistent or ambiguous DST wall times instead of silently shifting them.
        if (!from.isValid || !to.isValid || from.toFormat('HH:mm') !== rule.from || to.toFormat('HH:mm') !== rule.to || from.getPossibleOffsets().length > 1 || to.getPossibleOffsets().length > 1) {
            if (blockInvalid) result.push({ start: day.toMillis(), end: day.plus({ days: rule.to < rule.from ? 2 : 1 }).toMillis() });
            continue;
        }
        if (to.toMillis() > start && from.toMillis() < end) result.push({ start: from.toMillis(), end: to.toMillis() });
    }
    return result;
}

export function busyIntervals(policy: AvailabilityPolicy, start: number, end: number, reservations: BusyInterval[] = []): BusyInterval[] {
    return [...reservations, ...policy.commitments.flatMap(c => expandRule(c, start, end, policy.timezone, true).map(t => ({ ...t, id: c.id, locationId: c.locationId })))]
        .sort((a, b) => a.start - b.start);
}

export function usableEstimate(e: TravelEstimate, q: TravelQuery, now: number): boolean {
    const maxAge = e.departure - now <= 2 * 3600000 ? 10 * 60000 : 24 * 3600000;
    return e.status === 'ok' && !e.query.profile && e.query.kind === q.kind && e.query.mode === q.mode
        && e.query.from.id === q.from.id && e.query.to.id === q.to.id
        && e.query.from.revision === q.from.revision && e.query.to.revision === q.to.revision
        && DateTime.fromMillis(e.query.at, { zone: BOOKING_ZONE }).toISODate() === DateTime.fromMillis(q.at, { zone: BOOKING_ZONE }).toISODate()
        && Math.abs(e.query.at - q.at) <= 15 * 60000 && now >= e.fetchedAt && now - e.fetchedAt <= maxAge
        && Number.isFinite(e.departure) && Number.isFinite(e.arrival) && e.arrival >= e.departure
        && Number.isFinite(e.durationSeconds) && e.durationSeconds >= 0;
}

export function compareFeasible(a: FeasibleSlot, b: FeasibleSlot): number {
    return a.day.localeCompare(b.day) || a.taxiLegs - b.taxiLegs || a.travelSeconds - b.travelSeconds || a.slot.start - b.slot.start || a.slot.id.localeCompare(b.slot.id);
}

export async function evaluateSlot(slot: Slot, policy: AvailabilityPolicy, places: Map<string, Place>, busy: BusyInterval[], route: RouteLookup, now = Date.now()): Promise<FeasibleSlot | null> {
    const routeDeadline = Date.now() + 2000;
    if (policy.unresolved.length || !Number.isFinite(slot.start) || !Number.isFinite(slot.end) || slot.end <= slot.start || slot.start < now + BUFFERS.transition) return null;
    if (typeof slot.preparationRequired !== 'boolean' || (slot.preparationRequired && slot.preparationConfirmed !== true)) return null;
    const windows = policy.windows.flatMap(w => expandRule(w, slot.start - 86400000, slot.end + 86400000, policy.timezone));
    const window = windows.find(w => w.start <= slot.start && w.end >= slot.end + BUFFERS.after);
    if (!window || busy.some(b => b.start < slot.end + BUFFERS.after && b.end > slot.start - (slot.telemedicine ? 0 : BUFFERS.checkIn))) return null;
    const before = busy.filter(b => b.end <= slot.start).sort((a, b) => b.end - a.end)[0];
    const after = busy.filter(b => b.start >= slot.end).sort((a, b) => a.start - b.start)[0];
    const slotDay = DateTime.fromMillis(slot.start, { zone: policy.timezone }).toISODate();
    // A commitment away from the default origin does not establish where the
    // user will be on another day. The itinerary needs a confirmed location
    // transition before either cross-day leg can be used for booking.
    if (before && before.locationId !== policy.originLocationId
        && DateTime.fromMillis(before.end, { zone: policy.timezone }).toISODate() !== slotDay) return null;
    if (after && after.locationId !== policy.originLocationId
        && DateTime.fromMillis(after.start, { zone: policy.timezone }).toISODate() !== slotDay) return null;
    // Overlapping commitments at different places do not establish where the
    // user starts or finishes this journey, even if one wins the sort order.
    const ambiguous = (selected: BusyInterval | undefined) => !!selected && busy.some(other => other !== selected
        && other.start < selected.end && other.end > selected.start && other.locationId !== selected.locationId);
    if (ambiguous(before) || ambiguous(after)) return null;
    const origin = places.get(before ? before.locationId || '' : policy.originLocationId);
    const destination = places.get(after ? after.locationId || '' : policy.originLocationId);
    const clinic = slot.telemedicine ? origin : places.get(slot.locationId || '');
    if (!origin || !destination || !clinic) return null;
    const ready = Math.max(now + BUFFERS.transition, window.start, before ? before.end + (before.transitionMinutes ?? 5) * 60000 : window.start);
    const arrivalBy = slot.start - (slot.telemedicine ? 0 : BUFFERS.checkIn);
    const departAfter = slot.end + BUFFERS.after;
    const homeBy = Math.min(window.end, after?.start ?? window.end);
    if (ready > arrivalBy || departAfter > homeBy) return null;

    async function leg(from: Place, to: Place, at: number, kind: 'depart' | 'arrive', earliest: number, latest: number): Promise<TravelEstimate | null> {
        if (from.id === to.id && from.revision === to.revision) return { query: { from, to, at, kind, mode: 'transit' }, status: 'ok', departure: at, arrival: at, durationSeconds: 0, distanceMeters: 0, fetchedAt: now, cached: false };
        const forMode = async (mode: TravelMode): Promise<TravelEstimate | null> => {
            const limit = mode === 'transit' ? policy.maxTransitMinutes : policy.maxTaxiMinutes;
            if (!limit) return null;
            const pickup = mode === 'taxi' ? BUFFERS.pickup : 0;
            let query: TravelQuery = { from, to, mode, at: kind === 'depart' ? at + pickup : at, kind };
            for (let attempt = 0; attempt < 2; attempt++) {
                const remaining = routeDeadline - Date.now();
                if (remaining <= 0) return null;
                let timer: ReturnType<typeof setTimeout> | undefined;
                let e: TravelEstimate | null;
                try {
                    e = await Promise.race([route(query), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining); })]);
                } catch { return null; }
                finally { if (timer) clearTimeout(timer); }
                if (!e || !usableEstimate(e, query, Math.max(now, Date.now())) || e.durationSeconds > limit * 60) break;
                const margin = e.cached ? Math.max(5 * 60000, e.durationSeconds * 1000 * 0.2) : 0;
                if (e.departure - pickup >= earliest && e.arrival + margin <= latest) return e;
                // A cached transit connection cannot be shifted in time. Ask for an
                // actual earlier connection that leaves room for the delay allowance.
                if (attempt === 0 && kind === 'arrive' && e.cached && e.arrival + margin > latest) {
                    query = { ...query, at: latest - margin };
                } else break;
            }
            return null;
        };
        // Give a normal transit response a short head start. This avoids
        // filling both Google workers with taxi requests that are unnecessary
        // for a usable transit connection. A hung transit cannot consume the
        // whole deadline before a verified taxi is checked.
        const transit = forMode('transit');
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const first = await Promise.race([
            transit.then(result => ({ mode: 'transit' as const, result })),
            new Promise<{ mode: 'grace'; result: null }>(resolve => {
                graceTimer = setTimeout(() => resolve({ mode: 'grace', result: null }), Math.min(1200, Math.max(0, routeDeadline - Date.now())));
            }),
        ]).finally(() => { if (graceTimer) clearTimeout(graceTimer); });
        if (first.mode === 'transit') return first.result || forMode('taxi');
        const taxi = forMode('taxi');
        const next = await Promise.race([
            transit.then(result => ({ mode: 'transit' as const, result })),
            taxi.then(result => ({ mode: 'taxi' as const, result })),
        ]);
        if (next.result) return next.result;
        return next.mode === 'transit' ? taxi : transit;
    }
    const [inbound, outbound] = await Promise.all([
        leg(origin, clinic, arrivalBy, 'arrive', ready, arrivalBy),
        leg(clinic, destination, departAfter, 'depart', departAfter, homeBy),
    ]);
    if (!inbound || !outbound) return null;
    const legs = [inbound, outbound];
    return {
        slot, day: DateTime.fromMillis(slot.start, { zone: policy.timezone }).toISODate()!, taxiLegs: legs.filter(l => l.query.mode === 'taxi').length,
        travelSeconds: legs.reduce((sum, l) => sum + l.durationSeconds, 0),
        leaveAt: inbound.departure - (inbound.query.mode === 'taxi' ? BUFFERS.pickup : 0),
        returnAt: outbound.arrival + (outbound.cached ? Math.max(5 * 60000, outbound.durationSeconds * 200) : 0), legs
    };
}
