import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import db from './database';
import { BOOKING_ZONE, expandRule, validatePolicy, zonedTime, type AvailabilityPolicy, type BusyInterval, type Commitment, type Place } from './luxmedAvailability';
import type { LuxmedTerm } from './luxmedAdapter';
import { providerStreetMatches } from './googleRoutes';

export interface SavedPolicy { userId: number; revision: number; policy: AvailabilityPolicy; state: string; holdToken: string | null; }
export interface Enrollment { monitoring_id: string; user_id: number; state: string; status: string; next_check: number; failures: number; }
export interface BookingAttempt {
    id: string; user_id: number; account_id: number; monitoring_id: string | null; fingerprint: string;
    state: string; policy_revision: number; payload: string; reservation_id: number | null; created_at: number; updated_at: number;
    acknowledged_at: number | null;
}
export interface ReservationCoverage { from: number; to: number; }
export interface ReservationSnapshot {
    revision: string; fetchedAt: number; value: unknown[];
    coveredFrom: number | null; coveredTo: number | null;
}
export function snapshotCovers(snapshot: ReservationSnapshot | null, from: number, to: number): boolean {
    return !!snapshot && Number.isSafeInteger(from) && Number.isSafeInteger(to) && from < to
        && snapshot.coveredFrom !== null && snapshot.coveredTo !== null
        && Number.isSafeInteger(snapshot.coveredFrom) && Number.isSafeInteger(snapshot.coveredTo)
        && snapshot.coveredFrom <= from && snapshot.coveredTo >= to;
}
export function snapshotUsable(snapshot: ReservationSnapshot | null, from: number, to: number, now: number, maxAgeMs: number): boolean {
    return snapshotCovers(snapshot, from, to) && !!snapshot
        && Number.isSafeInteger(now) && Number.isSafeInteger(maxAgeMs) && maxAgeMs >= 0
        && Number.isSafeInteger(snapshot.fetchedAt) && snapshot.fetchedAt <= now
        && now - snapshot.fetchedAt <= maxAgeMs;
}
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface PreparationFacts {
    serviceId: number;
    clinicId: number;
    items: { header: string; text: string }[];
    itemsDigest: string;
}

export function requiresPreparation(term: LuxmedTerm): boolean {
    const data = term?.additionalData;
    const impediment = term?.term?.impedimentText;
    return !data || typeof data.isPreparationRequired !== 'boolean' || !Array.isArray(data.preparationItems)
        || data.isPreparationRequired || data.preparationItems.length > 0
        || (typeof impediment === 'string' && impediment.trim().length > 0);
}

export function preparationFacts(term: LuxmedTerm): PreparationFacts | null {
    if (!requiresPreparation(term)) return null;
    if (typeof term?.term?.impedimentText === 'string' && term.term.impedimentText.trim()) return null;
    const items = term?.additionalData?.preparationItems;
    const serviceId = term?.term?.serviceId, clinicId = term?.term?.clinicId;
    if (!Number.isSafeInteger(serviceId) || serviceId <= 0 || !Number.isSafeInteger(clinicId) || clinicId <= 0
        || !Array.isArray(items) || items.length === 0 || items.length > 30) return null;
    const normalized: { header: string; text: string }[] = [];
    for (const item of items) {
        if (!item || typeof item !== 'object' || typeof item.text !== 'string' || !item.text.trim()
            || item.text.length > 2000 || (item.header !== undefined && (typeof item.header !== 'string' || item.header.length > 200))) return null;
        normalized.push({ header: item.header || '', text: item.text });
    }
    return { serviceId, clinicId, items: normalized, itemsDigest: digest(normalized) };
}

export class SmartBookingStore {
    private delivering = false;
    constructor(readonly db: Database.Database) { }
    policy(userId: number): SavedPolicy | null {
        const row = this.db.prepare('SELECT * FROM luxmed_availability WHERE user_id=?').get(userId) as any;
        return row ? { userId, revision: row.revision, policy: JSON.parse(row.policy), state: row.state, holdToken: row.hold_token } : null;
    }
    draft(userId: number, input: unknown): SavedPolicy {
        const policy = validatePolicy(input);
        for (const c of policy.commitments) {
            if (c.source) {
                const table = c.source.type === 'task' ? 'tasks' : 'routines';
                if (!this.db.prepare(`SELECT id FROM ${table} WHERE id=? AND user_id=?`).get(c.source.id, userId)) throw new Error(`Linked ${c.source.type} does not belong to this user.`);
            }
        }
        this.db.prepare(`INSERT INTO luxmed_availability(user_id,revision,policy,state,updated_at) VALUES (?,1,?,'draft',?)
            ON CONFLICT(user_id) DO UPDATE SET revision=revision+1, policy=excluded.policy,state='draft',confirmation_token=NULL,updated_at=excluded.updated_at`)
            .run(userId, JSON.stringify(policy), Date.now());
        this.db.prepare("UPDATE luxmed_smart_monitors SET status='Availability needs confirmation' WHERE user_id=?").run(userId);
        return this.policy(userId)!;
    }
    hold(userId: number): string | null {
        if (!this.policy(userId)) return null;
        const token = randomUUID();
        this.db.prepare('UPDATE luxmed_availability SET hold_token=?,confirmation_token=NULL WHERE user_id=?').run(token, userId);
        return token;
    }
    release(userId: number, token: string): boolean {
        return this.db.prepare('UPDATE luxmed_availability SET hold_token=NULL WHERE user_id=? AND hold_token=?').run(userId, token).changes > 0;
    }
    confirmation(userId: number): { token: string; revision: number } {
        const saved = this.policy(userId);
        if (!saved) throw new Error('When can you book? Save your availability first.');
        if (saved.policy.unresolved.length) throw new Error(`Please clarify: ${saved.policy.unresolved.join('; ')}`);
        const places = this.places(userId);
        for (const id of [saved.policy.originLocationId, ...saved.policy.commitments.map(c => c.locationId)]) {
            if (!id || !places.has(id) || !this.locationVerified(userId, id, places.get(id)!.revision))
                throw new Error('Verify the street address for the default origin and every commitment.');
        }
        const token = randomUUID().slice(0, 18);
        this.db.prepare('UPDATE luxmed_availability SET confirmation_token=?,confirmation_expires=? WHERE user_id=?')
            .run(token, Date.now() + 10 * 60000, userId);
        return { token, revision: saved.revision };
    }
    stageSidecarMonitorPreview(userId: number, monitoringId: string, accountId: number,
        confirmation: { token: string; revision: number }, autoMonitorIds: number[]): void {
        const ids = [...new Set(autoMonitorIds)].sort((a, b) => a - b);
        if (ids.length !== autoMonitorIds.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
            throw new Error('Sidecar monitor IDs are invalid. Request a new preview.');
        }
        this.db.prepare(`INSERT INTO luxmed_sidecar_monitor_previews
            (user_id,monitoring_id,account_id,policy_revision,confirmation_token,auto_monitor_ids)
            VALUES (?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
            monitoring_id=excluded.monitoring_id,account_id=excluded.account_id,
            policy_revision=excluded.policy_revision,confirmation_token=excluded.confirmation_token,
            auto_monitor_ids=excluded.auto_monitor_ids`)
            .run(userId, monitoringId, accountId, confirmation.revision, confirmation.token, JSON.stringify(ids));
    }
    sidecarMonitorPreview(userId: number, monitoringId: string, accountId: number,
        confirmation: { token: string; revision: number }): number[] | null {
        const row = this.db.prepare(`SELECT auto_monitor_ids FROM luxmed_sidecar_monitor_previews WHERE
            user_id=? AND monitoring_id=? AND account_id=? AND policy_revision=? AND confirmation_token=?`)
            .get(userId, monitoringId, accountId, confirmation.revision, confirmation.token) as { auto_monitor_ids: string } | undefined;
        return row ? JSON.parse(row.auto_monitor_ids) as number[] : null;
    }
    confirm(userId: number, token: string, revision: number): boolean {
        return this.db.transaction(() => {
            const accepted = this.db.prepare(`UPDATE luxmed_availability SET state='confirmed',hold_token=NULL,confirmation_token=NULL
                WHERE user_id=? AND revision=? AND confirmation_token=? AND confirmation_expires>?`)
                .run(userId, revision, token, Date.now()).changes === 1;
            if (!accepted) return false;
            this.db.prepare(`UPDATE luxmed_preparation_confirmations SET state='confirmed',confirmation_token=NULL,confirmed_at=?
                WHERE user_id=? AND policy_revision=? AND confirmation_token=? AND state='staged'`)
                .run(Date.now(), userId, revision, token);
            this.db.prepare("DELETE FROM luxmed_preparation_confirmations WHERE user_id=? AND state='staged'").run(userId);
            return true;
        })();
    }
    stagePreparation(userId: number, token: string, revision: number, terms: LuxmedTerm[]): PreparationFacts[] {
        if (!Array.isArray(terms)) throw new Error('Preparation preview terms are missing.');
        const facts = new Map<string, PreparationFacts>();
        for (const term of terms) {
            const fact = preparationFacts(term);
            if (fact) facts.set(`${fact.serviceId}:${fact.clinicId}:${fact.itemsDigest}`, fact);
        }
        if (facts.size > 10 || [...facts.values()].reduce((length, fact) => length + JSON.stringify(fact.items).length, 0) > 12000) {
            throw new Error('Preparation details are too long for one readable confirmation. Narrow the monitor and preview again.');
        }
        return this.db.transaction(() => {
            const row = this.db.prepare('SELECT revision,confirmation_token,confirmation_expires FROM luxmed_availability WHERE user_id=?')
                .get(userId) as { revision: number; confirmation_token: string | null; confirmation_expires: number | null } | undefined;
            if (!row || row.revision !== revision || row.confirmation_token !== token || !row.confirmation_expires
                || row.confirmation_expires <= Date.now()) throw new Error('Preparation preview confirmation expired. Request a new preview.');
            this.db.prepare("DELETE FROM luxmed_preparation_confirmations WHERE user_id=? AND state='staged'").run(userId);
            this.db.prepare('DELETE FROM luxmed_preparation_confirmations WHERE user_id=? AND policy_revision<>?').run(userId, revision);
            const insert = this.db.prepare(`INSERT OR IGNORE INTO luxmed_preparation_confirmations
                (user_id,policy_revision,service_id,clinic_id,items_digest,items_json,state,confirmation_token)
                VALUES (?,?,?,?,?,?,'staged',?)`);
            for (const fact of facts.values()) insert.run(userId, revision, fact.serviceId, fact.clinicId,
                fact.itemsDigest, JSON.stringify(fact.items), token);
            return [...facts.values()];
        })();
    }
    isPreparationConfirmed(userId: number, revision: number, term: LuxmedTerm): boolean {
        if (!requiresPreparation(term)) return true;
        const fact = preparationFacts(term);
        if (!fact) return false;
        return Boolean(this.db.prepare(`SELECT 1 FROM luxmed_preparation_confirmations c
            JOIN luxmed_availability a ON a.user_id=c.user_id AND a.revision=c.policy_revision
            WHERE c.user_id=? AND c.policy_revision=? AND c.service_id=? AND c.clinic_id=?
                AND c.items_digest=? AND c.state='confirmed' AND a.state='confirmed' AND a.hold_token IS NULL`)
            .get(userId, revision, fact.serviceId, fact.clinicId, fact.itemsDigest));
    }
    pause(userId: number): void {
        this.db.prepare("UPDATE luxmed_availability SET state='paused',revision=revision+1,confirmation_token=NULL WHERE user_id=?").run(userId);
    }
    enroll(monitorId: string, userId: number): void {
        if (!this.db.prepare('SELECT id FROM luxmed_monitorings WHERE id=? AND user_id=? AND active=1').get(monitorId, userId)) throw new Error('Active monitoring not found.');
        this.db.transaction(() => {
            this.db.prepare("INSERT OR IGNORE INTO luxmed_smart_monitors(monitoring_id,user_id) VALUES (?,?)").run(monitorId, userId);
            this.db.prepare(`UPDATE luxmed_smart_monitors SET desired_autobook=COALESCE(desired_autobook,
                (SELECT autobook FROM luxmed_monitorings WHERE id=?)) WHERE monitoring_id=? AND user_id=?`)
                .run(monitorId, monitorId, userId);
            // Old bot images see only this flag, so disable their automatic path
            // before a draft smart enrollment becomes visible.
            this.db.prepare('UPDATE luxmed_monitorings SET autobook=0 WHERE id=? AND user_id=?').run(monitorId, userId);
        })();
    }
    enrollment(monitorId: string): Enrollment | null {
        return this.db.prepare('SELECT * FROM luxmed_smart_monitors WHERE monitoring_id=?').get(monitorId) as Enrollment || null;
    }
    status(monitorId: string, status: string): void {
        this.db.prepare('UPDATE luxmed_smart_monitors SET status=? WHERE monitoring_id=?').run(status, monitorId);
    }
    place(userId: number, id: string, address: string, lat: number, lng: number): Place {
        if (!id || !address || !Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) throw new Error('Invalid location.');
        const revision = digest({ address, lat, lng });
        const old = this.places(userId).get(id);
        this.db.prepare(`INSERT INTO luxmed_smart_places(user_id,id,revision,address,lat,lng) VALUES (?,?,?,?,?,?)
            ON CONFLICT(user_id,id) DO UPDATE SET revision=excluded.revision,address=excluded.address,lat=excluded.lat,lng=excluded.lng`)
            .run(userId, id, revision, address, lat, lng);
        if (old && old.revision !== revision) {
            this.db.prepare("UPDATE luxmed_availability SET revision=revision+1,state='draft',confirmation_token=NULL WHERE user_id=?").run(userId);
        }
        return { id, revision, address, lat, lng };
    }
    places(userId: number): Map<string, Place> {
        return new Map((this.db.prepare('SELECT id,revision,address,lat,lng FROM luxmed_smart_places WHERE user_id=?').all(userId) as Place[]).map(p => [p.id, p]));
    }
    verifyLocation(userId: number, locationId: string, placeRevision: string): void {
        const place = this.places(userId).get(locationId);
        if (!place || place.revision !== placeRevision || locationId.startsWith('clinic:')) throw new Error('Location changed or is a clinic.');
        this.db.prepare(`INSERT INTO luxmed_smart_location_bindings(user_id,location_id,place_revision,verified_at)
            VALUES (?,?,?,?) ON CONFLICT(user_id,location_id) DO UPDATE SET
            place_revision=excluded.place_revision,verified_at=excluded.verified_at`)
            .run(userId, locationId, placeRevision, Date.now());
    }
    locationVerified(userId: number, locationId: string, placeRevision: string): boolean {
        if (!placeRevision || locationId.startsWith('clinic:')) return false;
        return !!this.db.prepare(`SELECT 1 FROM luxmed_smart_location_bindings
            WHERE user_id=? AND location_id=? AND place_revision=?`).get(userId, locationId, placeRevision);
    }
    verifyClinic(userId: number, locationId: string, sourceLabel: string, placeRevision: string): void {
        if (!locationId.startsWith('clinic:') || !sourceLabel.trim() || !placeRevision) throw new Error('Incomplete LuxMed clinic identity.');
        const place = this.places(userId).get(locationId);
        if (!place || place.revision !== placeRevision || !providerStreetMatches(sourceLabel, place.address))
            throw new Error('LuxMed clinic street does not match the verified address.');
        this.db.prepare(`INSERT INTO luxmed_smart_clinic_bindings(user_id,location_id,source_label,place_revision,verified_at)
            VALUES (?,?,?,?,?) ON CONFLICT(user_id,location_id) DO UPDATE SET
            source_label=excluded.source_label,place_revision=excluded.place_revision,verified_at=excluded.verified_at`)
            .run(userId, locationId, sourceLabel.trim(), placeRevision, Date.now());
    }
    clinicVerified(userId: number, locationId: string, sourceLabel: string, placeRevision: string): boolean {
        const place = this.places(userId).get(locationId);
        return !!place && place.revision === placeRevision && providerStreetMatches(sourceLabel, place.address)
            && !!this.db.prepare(`SELECT 1 FROM luxmed_smart_clinic_bindings WHERE
            user_id=? AND location_id=? AND source_label=? AND place_revision=?`)
            .get(userId, locationId, sourceLabel.trim(), placeRevision);
    }
    scheduleAppointments(userId: number): Commitment[] {
        return (this.db.prepare('SELECT value FROM luxmed_schedule_appointments WHERE user_id=? ORDER BY id').all(userId) as { value: string }[])
            .map(row => JSON.parse(row.value) as Commitment);
    }
    scheduleIntervals(userId: number, start: number, end: number): BusyInterval[] {
        return this.scheduleAppointments(userId).flatMap(appointment =>
            expandRule(appointment, start, end, BOOKING_ZONE, true)
                .map(interval => ({ ...interval, id: `schedule:${appointment.id}`, locationId: appointment.locationId })));
    }
    setScheduleAppointment(userId: number, input: Commitment): Commitment {
        const existing = this.policy(userId)?.policy;
        const policy = validatePolicy({
            version: 1, timezone: BOOKING_ZONE, originLocationId: existing?.originLocationId || 'address:home',
            windows: existing?.windows || [{ weekdays: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '23:59' }],
            commitments: [input], unresolved: [], softPreferences: [], maxTransitMinutes: 0,
            maxTaxiMinutes: 0, preparationConfirmed: false,
        });
        const appointment = policy.commitments[0];
        if (!appointment.locationId || !this.locationVerified(userId, appointment.locationId,
            this.places(userId).get(appointment.locationId)?.revision || '')) {
            throw new Error('Verify the appointment street address before saving it.');
        }
        if (appointment.source) {
            const table = appointment.source.type === 'task' ? 'tasks' : 'routines';
            const active = table === 'routines' ? ' AND is_deleted=0' : '';
            if (!this.db.prepare(`SELECT id FROM ${table} WHERE id=? AND user_id=?${active}`).get(appointment.source.id, userId)) {
                throw new Error(`Linked ${appointment.source.type} does not belong to this user.`);
            }
        }
        this.db.transaction(() => {
            this.db.prepare(`INSERT INTO luxmed_schedule_appointments(user_id,id,value,updated_at) VALUES (?,?,?,?)
                ON CONFLICT(user_id,id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
                .run(userId, appointment.id, JSON.stringify(appointment), Date.now());
            this.db.prepare("UPDATE luxmed_availability SET revision=revision+1,state='draft',confirmation_token=NULL,updated_at=? WHERE user_id=?")
                .run(Date.now(), userId);
            this.db.prepare("UPDATE luxmed_smart_monitors SET status='Schedule changed; confirm availability again' WHERE user_id=?").run(userId);
        })();
        return appointment;
    }
    deleteScheduleAppointment(userId: number, id: string): boolean {
        return this.db.transaction(() => {
            const deleted = this.db.prepare('DELETE FROM luxmed_schedule_appointments WHERE user_id=? AND id=?').run(userId, id).changes > 0;
            if (deleted) {
                this.db.prepare("UPDATE luxmed_availability SET revision=revision+1,state='draft',confirmation_token=NULL,updated_at=? WHERE user_id=?")
                    .run(Date.now(), userId);
                this.db.prepare("UPDATE luxmed_smart_monitors SET status='Schedule changed; confirm availability again' WHERE user_id=?").run(userId);
            }
            return deleted;
        })();
    }
    accountTransition(userId: number): boolean {
        return Boolean(this.db.prepare('SELECT 1 FROM luxmed_account_transitions WHERE user_id=? LIMIT 1').get(userId));
    }
    accountTransitions(userId: number): { oldAccountId: number; status: string }[] {
        return (this.db.prepare('SELECT old_account_id, status FROM luxmed_account_transitions WHERE user_id=? ORDER BY updated_at').all(userId) as { old_account_id: number; status: string }[])
            .map(row => ({ oldAccountId: row.old_account_id, status: row.status }));
    }
    failAccountTransition(userId: number, oldAccountId: number, status: string): void {
        this.db.prepare('UPDATE luxmed_account_transitions SET status=?,updated_at=? WHERE user_id=? AND old_account_id=?')
            .run(status, Date.now(), userId, oldAccountId);
    }
    clearAccountTransition(userId: number, oldAccountId: number): void {
        this.db.prepare('DELETE FROM luxmed_account_transitions WHERE user_id=? AND old_account_id=?').run(userId, oldAccountId);
    }
    snapshot(accountId: number): ReservationSnapshot | null {
        const r = this.db.prepare('SELECT * FROM luxmed_reservation_snapshots WHERE account_id=?').get(accountId) as any;
        return r ? { revision: r.revision, fetchedAt: r.fetched_at, value: JSON.parse(r.value),
            coveredFrom: r.covered_from, coveredTo: r.covered_to } : null;
    }
    saveSnapshot(accountId: number, value: unknown[], coverage: ReservationCoverage, now = Date.now()): void {
        if (!Array.isArray(value) || !coverage || !Number.isSafeInteger(coverage.from) || !Number.isSafeInteger(coverage.to)
            || coverage.from >= coverage.to) throw new Error('A reservation snapshot requires a valid covered date range.');
        this.db.transaction(() => {
            const cancelled = new Map((this.db.prepare('SELECT reservation_id,start_at FROM luxmed_cancelled_reservations WHERE account_id=?')
                .all(accountId) as { reservation_id: number; start_at: number | null }[]).map(row => [row.reservation_id, row.start_at]));
            const wasCancelled = (event: unknown) => {
                const visit = event as { eventId: number; date: string };
                const start = cancelled.get(visit.eventId);
                return Number.isSafeInteger(start) && start === zonedTime(visit.date);
            };
            const observed = value.filter(event => !wasCancelled(event));
            const currentIds = new Set(observed.map(v => (v as { eventId: number }).eventId));
            const previous = this.snapshot(accountId);
            // The feed may briefly omit a reservation even when its page is
            // complete. Only a confirmed cancellation releases occupied time.
            const retained = (previous?.value || []).filter(event =>
                !currentIds.has((event as { eventId: number }).eventId)
                && !wasCancelled(event));
            const observedValue = [...observed, ...retained];
            this.db.prepare(`INSERT OR REPLACE INTO luxmed_reservation_snapshots
                (account_id,revision,fetched_at,value,covered_from,covered_to) VALUES (?,?,?,?,?,?)`)
                .run(accountId, digest({ value: observedValue, coverage }), now, JSON.stringify(observedValue), coverage.from, coverage.to);
        })();
    }
    confirmCancellation(accountId: number, reservationId: number, startAt: number): void {
        if (!Number.isSafeInteger(startAt) || startAt <= 0) throw new Error('Cancellation needs the exact visit start.');
        this.db.transaction(() => {
            const now = Date.now();
            const prior = this.db.prepare('SELECT start_at FROM luxmed_cancelled_reservations WHERE account_id=? AND reservation_id=?')
                .get(accountId, reservationId) as { start_at: number | null } | undefined;
            if (prior?.start_at === startAt) return;
            if (prior && prior.start_at !== null && prior.start_at !== startAt)
                throw new Error('Cancellation receipt conflicts with another visit using this reservation ID.');
            this.db.prepare(`INSERT INTO luxmed_cancelled_reservations(account_id,reservation_id,start_at,cancelled_at)
                VALUES (?,?,?,?) ON CONFLICT(account_id,reservation_id) DO UPDATE SET
                start_at=excluded.start_at,cancelled_at=excluded.cancelled_at`)
                .run(accountId, reservationId, startAt, now);
            const previous = this.snapshot(accountId);
            if (previous) {
                const remaining = previous.value.filter(event => {
                    const visit = event as { eventId: number; date: string };
                    return visit.eventId !== reservationId || zonedTime(visit.date) !== startAt;
                });
                this.db.prepare('UPDATE luxmed_reservation_snapshots SET revision=?,value=? WHERE account_id=?')
                    .run(digest({ value: remaining, coverage: { from: previous.coveredFrom, to: previous.coveredTo } }), JSON.stringify(remaining), accountId);
            }
            const attempts = this.db.prepare("SELECT id,monitoring_id,user_id FROM luxmed_booking_attempts WHERE account_id=? AND reservation_id=? AND state='succeeded'")
                .all(accountId, reservationId) as { id: string; monitoring_id: string | null; user_id: number }[];
            for (const attempt of attempts) {
                const saved = this.attempt(attempt.id)!;
                const payload = JSON.parse(saved.payload) as { slot?: { start?: number } };
                if (payload.slot?.start !== startAt) continue;
                this.db.prepare('DELETE FROM luxmed_booking_blocks WHERE attempt_id=?').run(attempt.id);
                this.db.prepare("UPDATE luxmed_booking_attempts SET state='cancelled',updated_at=? WHERE id=? AND state='succeeded'").run(now, attempt.id);
                this.db.prepare('DELETE FROM luxmed_notification_outbox WHERE id=? AND delivered_at IS NULL').run(`booked:${attempt.id}`);
                if (attempt.monitoring_id) this.status(attempt.monitoring_id, 'Booked and then cancelled');
            }
        })();
    }
    restoreUncancelledVisit(accountId: number, reservationId: number, startAt: number): void {
        if (!Number.isSafeInteger(startAt) || startAt <= 0) throw new Error('Review needs the exact visit start.');
        this.db.transaction(() => {
            const prior = this.db.prepare('SELECT start_at FROM luxmed_cancelled_reservations WHERE account_id=? AND reservation_id=?')
                .get(accountId, reservationId) as { start_at: number | null } | undefined;
            if (prior && prior.start_at !== startAt) throw new Error('Review conflicts with another visit using this reservation ID.');
            if (!prior) return;
            this.db.prepare('DELETE FROM luxmed_cancelled_reservations WHERE account_id=? AND reservation_id=? AND start_at=?')
                .run(accountId, reservationId, startAt);
            // A prior cancellation may have removed this visit from the saved feed.
            // Force a new complete snapshot before any further booking decision.
            this.db.prepare('DELETE FROM luxmed_reservation_snapshots WHERE account_id=?').run(accountId);
        })();
    }
    recordMovedReservation(accountId: number, reservationId: number, oldStartAt: number,
        movedStartAt: number, movedEndAt: number, telemedicine: boolean): void {
        if (![reservationId, oldStartAt, movedStartAt, movedEndAt].every(value => Number.isSafeInteger(value) && value > 0)
            || movedStartAt === oldStartAt || movedEndAt <= movedStartAt)
            throw new Error('Moved reservation facts are invalid.');
        this.db.transaction(() => {
            const snapshot = this.snapshot(accountId);
            if (!snapshot || !snapshot.value.some(event => {
                const visit = event as { eventId: number; date: string };
                return visit.eventId === reservationId && zonedTime(visit.date) === movedStartAt;
            })) throw new Error('The moved visit is absent from the verified reservation snapshot.');
            const marker = this.db.prepare('SELECT start_at FROM luxmed_cancelled_reservations WHERE account_id=? AND reservation_id=?')
                .get(accountId, reservationId) as { start_at: number | null } | undefined;
            if (marker && marker.start_at !== oldStartAt) throw new Error('A cancellation marker conflicts with the moved visit.');
            if (marker) this.db.prepare('DELETE FROM luxmed_cancelled_reservations WHERE account_id=? AND reservation_id=? AND start_at=?')
                .run(accountId, reservationId, oldStartAt);
            const rows = this.db.prepare(`SELECT b.attempt_id,b.user_id,b.value FROM luxmed_booking_blocks b
                JOIN luxmed_booking_attempts a ON a.id=b.attempt_id
                WHERE a.account_id=? AND b.reservation_id=?`).all(accountId, reservationId) as
                { attempt_id: string; user_id: number; value: string }[];
            for (const row of rows) {
                const prior = JSON.parse(row.value) as BusyInterval;
                if (![oldStartAt, oldStartAt - 10 * 60000, movedStartAt, movedStartAt - 10 * 60000].includes(prior.start))
                    throw new Error('A saved booking block conflicts with the moved visit.');
                const next: BusyInterval = { ...prior, start: movedStartAt - (telemedicine ? 0 : 10 * 60000),
                    end: movedEndAt + 10 * 60000,
                    // A moved visit does not establish the old clinic as the
                    // patient's location, even when the new visit is remote.
                    locationId: telemedicine ? undefined : `unresolved-reservation:${reservationId}` };
                this.db.prepare('UPDATE luxmed_booking_blocks SET value=? WHERE attempt_id=? AND user_id=? AND reservation_id=?')
                    .run(JSON.stringify(next), row.attempt_id, row.user_id, reservationId);
            }
            const current = snapshot.value.filter(event => {
                const visit = event as { eventId: number; date: string };
                return visit.eventId !== reservationId || zonedTime(visit.date) !== oldStartAt;
            });
            if (current.length !== snapshot.value.length) this.db.prepare('UPDATE luxmed_reservation_snapshots SET revision=?,value=? WHERE account_id=?')
                .run(digest({ value: current, coverage: { from: snapshot.coveredFrom, to: snapshot.coveredTo } }), JSON.stringify(current), accountId);
            const users = this.db.prepare('SELECT DISTINCT user_id FROM luxmed_accounts WHERE account_id=?')
                .all(accountId) as { user_id: number }[];
            for (const user of users) this.notify(`moved:${accountId}:${reservationId}:${movedStartAt}`, user.user_id,
                `LuxMed reservation ${reservationId} was moved. Please review its new time and journey. Automatic booking waited for the updated reservation.`);
        })();
    }
    wasCancelled(accountId: number, reservationId: number, startAt: number): boolean {
        return !!this.db.prepare('SELECT 1 FROM luxmed_cancelled_reservations WHERE account_id=? AND reservation_id=? AND start_at=?')
            .get(accountId, reservationId, startAt);
    }
    pending(userId?: number): BookingAttempt[] {
        return this.db.prepare("SELECT * FROM luxmed_booking_attempts WHERE state IN ('pending','unknown')" + (userId === undefined ? '' : ' AND user_id=?'))
            .all(...(userId === undefined ? [] : [userId])) as BookingAttempt[];
    }
    accountBookingRevision(accountId: number): number {
        return (this.db.prepare("SELECT COUNT(*) AS value FROM luxmed_booking_attempts WHERE account_id=? AND state IN ('succeeded','cancelled')")
            .get(accountId) as { value: number }).value;
    }
    begin(userId: number, accountId: number, monitoringId: string | null, revision: number, fingerprint: string, payload: unknown): BookingAttempt {
        const id = randomUUID();
        const now = Date.now();
        this.db.prepare(`INSERT INTO luxmed_booking_attempts(id,user_id,account_id,monitoring_id,fingerprint,state,policy_revision,payload,created_at,updated_at)
            VALUES (?,?,?,?,?,'pending',?,?,?,?)`).run(id, userId, accountId, monitoringId, fingerprint, revision, JSON.stringify(payload), now, now);
        return this.attempt(id)!;
    }
    attempt(id: string): BookingAttempt | null { return this.db.prepare('SELECT * FROM luxmed_booking_attempts WHERE id=?').get(id) as BookingAttempt || null; }
    unacknowledged(): BookingAttempt[] {
        return this.db.prepare("SELECT * FROM luxmed_booking_attempts WHERE state IN ('succeeded','cancelled') AND reservation_id IS NOT NULL AND acknowledged_at IS NULL")
            .all() as BookingAttempt[];
    }
    acknowledge(id: string, reservationId: number): boolean {
        const changed = this.db.prepare(`UPDATE luxmed_booking_attempts SET acknowledged_at=?,updated_at=?
            WHERE id=? AND reservation_id=? AND state IN ('succeeded','cancelled') AND acknowledged_at IS NULL`)
            .run(Date.now(), Date.now(), id, reservationId);
        return changed.changes === 1 || !!this.db.prepare(`SELECT 1 FROM luxmed_booking_attempts
            WHERE id=? AND reservation_id=? AND state IN ('succeeded','cancelled') AND acknowledged_at IS NOT NULL`)
            .get(id, reservationId);
    }
    outcome(id: string, state: 'unknown' | 'failed'): void {
        this.db.prepare("UPDATE luxmed_booking_attempts SET state=?,updated_at=? WHERE id=? AND state IN ('pending','unknown')").run(state, Date.now(), id);
    }
    succeed(id: string, reservationId: number, block: BusyInterval, message: string): void {
        this.db.transaction(() => {
            const attempt = this.attempt(id);
            if (!attempt || attempt.state === 'succeeded' || attempt.state === 'cancelled') return;
            const slotStart = (JSON.parse(attempt.payload) as { slot?: { start?: number } }).slot?.start;
            const cancelled = !!this.db.prepare('SELECT 1 FROM luxmed_cancelled_reservations WHERE account_id=? AND reservation_id=? AND start_at=?')
                .get(attempt.account_id, reservationId, slotStart);
            if (cancelled) {
                this.db.prepare("UPDATE luxmed_booking_attempts SET state='cancelled',reservation_id=?,updated_at=? WHERE id=?")
                    .run(reservationId, Date.now(), id);
                if (attempt.monitoring_id) {
                    this.db.prepare('UPDATE luxmed_monitorings SET active=0 WHERE id=? AND user_id=?').run(attempt.monitoring_id, attempt.user_id);
                    this.status(attempt.monitoring_id, 'Booked and then cancelled');
                }
                this.notify(`resolved-cancelled:${id}`, attempt.user_id,
                    `LuxMed reservation ${reservationId} was booked and then cancelled. Automatic booking did not submit another attempt.`);
                return;
            }
            this.db.prepare("UPDATE luxmed_booking_attempts SET state='succeeded',reservation_id=?,updated_at=? WHERE id=?").run(reservationId, Date.now(), id);
            this.db.prepare('INSERT OR REPLACE INTO luxmed_booking_blocks(attempt_id,user_id,reservation_id,value) VALUES (?,?,?,?)').run(id, attempt.user_id, reservationId, JSON.stringify(block));
            if (attempt.monitoring_id) {
                this.db.prepare('UPDATE luxmed_monitorings SET active=0 WHERE id=? AND user_id=?').run(attempt.monitoring_id, attempt.user_id);
                this.status(attempt.monitoring_id, 'Booked');
            }
            this.notify(`booked:${id}`, attempt.user_id, message);
        })();
    }
    blocks(userId: number): BusyInterval[] {
        return (this.db.prepare('SELECT value FROM luxmed_booking_blocks WHERE user_id=?').all(userId) as { value: string }[]).map(r => JSON.parse(r.value));
    }
    notify(id: string, userId: number, message: string): void {
        this.db.prepare('INSERT OR IGNORE INTO luxmed_notification_outbox(id,user_id,message,created_at) VALUES (?,?,?,?)').run(id, userId, message, Date.now());
    }
    async deliver(send: (userId: number, message: string) => Promise<unknown>): Promise<void> {
        if (this.delivering) return;
        this.delivering = true;
        try {
            const messages = this.db.prepare(`SELECT * FROM luxmed_notification_outbox
                WHERE delivered_at IS NULL AND (last_attempt_at IS NULL OR last_attempt_at<=?)
                ORDER BY COALESCE(last_attempt_at, 0), created_at LIMIT 20`)
                .all(Date.now() - 60000) as { id: string; user_id: number; message: string }[];
            for (const m of messages) {
                try {
                    this.db.prepare('UPDATE luxmed_notification_outbox SET last_attempt_at=? WHERE id=?').run(Date.now(), m.id);
                    const receipt = await send(m.user_id, m.message);
                    if (receipt == null || receipt === false) throw new Error('Telegram did not confirm delivery.');
                    this.db.prepare('UPDATE luxmed_notification_outbox SET delivered_at=? WHERE id=?').run(Date.now(), m.id);
                } catch { console.warn('[LuxMed smart] Notification delivery deferred', { notificationId: m.id }); }
            }
        } finally { this.delivering = false; }
    }
}
export const smartStore = new SmartBookingStore(db);
