import { DateTime } from 'luxon';
import { BOOKING_ZONE, busyIntervals, evaluateSlot, expandRule, usableEstimate, validBookingTimeRange, zonedTime, type BusyInterval, type FeasibleSlot, type Slot, type TravelQuery } from './luxmedAvailability';
import { smartStore, SmartBookingStore, digest, requiresPreparation, snapshotCovers, snapshotUsable, type BookingAttempt, type ReservationCoverage } from './luxmedSmartStore';
import { TravelCache, queueTravelRequest } from './luxmedTravel';
import { rankWithJev } from './luxmedJev';
import { providerStreetMatches, providerCityMatches, resolveStreetAddress } from './googleRoutes';
import { LuxmedApiError, luxmedCapabilities, luxmedGetReserved, luxmedGetDoctors, luxmedGetCities, luxmedGetServices, luxmedGetMonitorings, luxmedBookSlot, luxmedBookingAttempt, luxmedAcknowledgeBookingAttempt, luxmedLegacyBookingBarrier, luxmedAcknowledgeLegacyBooking, luxmedCancellationReceipts, luxmedAcknowledgeMovedVisit, type BookingOutcome, type BookingReservationFact, type LuxmedTerm, type LuxmedEvent } from './luxmedAdapter';
import { providerIdentityFingerprint, selectedDoctorNames, uniqueCityName, uniqueServiceName } from './luxmedProviderIdentity';
import { rowToMonitoringConfig, type LuxmedMonitoringConfig } from './userStore';

export const smartDependencies = {
    capabilities: luxmedCapabilities, reserved: luxmedGetReserved, doctors: luxmedGetDoctors, cities: luxmedGetCities, services: luxmedGetServices, monitorings: luxmedGetMonitorings,
    book: luxmedBookSlot, attempt: luxmedBookingAttempt, acknowledgeAttempt: luxmedAcknowledgeBookingAttempt,
    legacyBarrier: luxmedLegacyBookingBarrier,
    acknowledgeLegacy: luxmedAcknowledgeLegacyBooking, cancellations: luxmedCancellationReceipts,
    acknowledgeMove: luxmedAcknowledgeMovedVisit, resolve: resolveStreetAddress,
};
export function smartBookingTimezoneIssue(zone: string): string | null {
    return zone === 'Europe/Warsaw' ? null : 'Smart booking requires the bot timezone to be Europe/Warsaw because LuxMed terms use Warsaw local time.';
}
export function reservationBaselineFacts(events: LuxmedEvent[], candidateStart?: number): BookingReservationFact[] {
    const seen = new Set<number>();
    const day = candidateStart === undefined ? null : DateTime.fromMillis(candidateStart, { zone: BOOKING_ZONE }).startOf('day');
    if (day && !day.isValid) throw new Error('The booking date is invalid.');
    const from = day?.minus({ days: 1 }).toMillis();
    const to = day?.plus({ days: 2 }).toMillis();
    return events.map(event => {
        const startAt = zonedTime(event.date);
        const endAt = event.dateTo ? zonedTime(event.dateTo) : 0;
        if (!Number.isSafeInteger(event.eventId) || event.eventId <= 0 || seen.has(event.eventId)
            || !Number.isSafeInteger(startAt) || startAt <= 0)
            throw new Error('A LuxMed reservation has invalid or duplicate booking facts.');
        seen.add(event.eventId);
        return {
            reservationId: event.eventId, startAt,
            endAt: Number.isSafeInteger(endAt) && endAt > startAt ? endAt : 0,
            clinicId: Number.isSafeInteger(event.clinic?.id) && event.clinic!.id! > 0 ? event.clinic!.id! : null,
            telemedicine: event.eventType === 'Telemedicine',
            clinicAddress: event.clinic?.address?.trim() || null,
            clinicCity: event.clinic?.city?.trim() || null,
        };
    }).filter(fact => from === undefined || to === undefined || (fact.startAt >= from && fact.startAt < to))
        .sort((a, b) => a.reservationId - b.reservationId);
}
type Dependencies = typeof smartDependencies;
export function smartConfigurationIssue(): string | null {
    if (!process.env.OPENROUTER_API_KEY) return 'OPENROUTER_API_KEY is not configured.';
    if (!process.env.GOOGLE_MAPS_API_KEY) return 'GOOGLE_MAPS_API_KEY is not configured.';
    if (process.env.GOOGLE_ROUTES_CACHE_PERMITTED !== 'true') return 'Confirm Google route caching permission before enabling stored travel profiles.';
    if (process.env.GOOGLE_GEOCODING_CACHE_PERMITTED !== 'true') return 'Confirm Google geocoding storage permission before enabling saved locations.';
    return null;
}
export function slotFromTerm(term: LuxmedTerm, cityId: number): Slot {
    const t = term.term;
    const instant = (date: { dateTimeTz?: string | null; dateTimeLocal?: string | null }): number => {
        if (date.dateTimeTz) {
            if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(date.dateTimeTz)) return NaN;
            const explicit = DateTime.fromISO(date.dateTimeTz, { setZone: true });
            if (!explicit.isValid) return NaN;
            const warsaw = explicit.setZone(BOOKING_ZONE);
            // The sidecar sends LocalDateTime to LuxMed, so it cannot carry the
            // offset that distinguishes the repeated autumn hour.
            if (warsaw.getPossibleOffsets().length !== 1) return NaN;
            if (date.dateTimeLocal) {
                const local = date.dateTimeLocal;
                if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(local)) return NaN;
                const parsed = DateTime.fromISO(local, { zone: BOOKING_ZONE });
                if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS")
                    !== warsaw.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS")) return NaN;
            }
            return explicit.toMillis();
        }
        const local = date.dateTimeLocal || '';
        const parsed = DateTime.fromISO(local, { zone: BOOKING_ZONE });
        return parsed.isValid && parsed.toFormat("yyyy-MM-dd'T'HH:mm") === local.slice(0, 16)
            && parsed.getPossibleOffsets().length === 1 ? parsed.toMillis() : NaN;
    };
    const start = instant(t.dateTimeFrom);
    return {
        id: `${t.scheduleId}:${start}:${digest(term)}`, start, end: instant(t.dateTimeTo), locationId: `clinic:${cityId}:${t.clinicId}`,
        telemedicine: t.isTelemedicine, preparationRequired: requiresPreparation(term)
    };
}
export function reservationCoverage(from: number, to: number): ReservationCoverage {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('Invalid reservation date range.');
    return {
        from: DateTime.fromMillis(Math.min(from, Date.now()), { zone: BOOKING_ZONE }).startOf('day').minus({ days: 1 }).toMillis(),
        to: DateTime.fromMillis(to, { zone: BOOKING_ZONE }).startOf('day').plus({ days: 2 }).toMillis(),
    };
}
export function monitorReservationCoverage(config: LuxmedMonitoringConfig): ReservationCoverage {
    const from = zonedTime(config.dateFrom);
    const to = zonedTime(/^\d{4}-\d{2}-\d{2}$/.test(config.dateTo) ? `${config.dateTo}T23:59:59` : config.dateTo);
    return reservationCoverage(from, to);
}
export function monitorRulesFingerprint(config: LuxmedMonitoringConfig): string {
    return digest([config.userId, config.accountId, config.serviceId, config.cityId,
        config.clinicIds, config.doctorIds, config.englishOnly, config.dateFrom, config.dateTo,
        config.timeFrom, config.timeTo, config.autobook, config.rebookIfExists,
        config.maxTransitMinutes ?? null]);
}
export function matchesMonitor(term: LuxmedTerm, c: LuxmedMonitoringConfig, englishIds?: Set<number>): boolean {
    const t = term.term, s = slotFromTerm(term, c.cityId);
    if (t.isImpediment !== false || !!t.impedimentText?.trim()
        || typeof term.additionalData?.isPreparationRequired !== 'boolean'
        || !Array.isArray(term.additionalData.preparationItems)) return false;
    const time = DateTime.fromMillis(s.start, { zone: BOOKING_ZONE }).toFormat('HH:mm');
    const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(c.dateTo) ? zonedTime(`${c.dateTo}T23:59:59`) : zonedTime(c.dateTo);
    const permitsId = (ids: number[] | null, value: number): boolean => ids === null
        || Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isSafeInteger(id) && id > 0) && ids.includes(value);
    return validBookingTimeRange(c.timeFrom, c.timeTo) && t.serviceId === c.serviceId && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start
        && s.start >= zonedTime(c.dateFrom) && s.end <= dateTo && time >= c.timeFrom && time <= c.timeTo
        && permitsId(c.clinicIds, t.clinicId) && permitsId(c.doctorIds, t.doctor.id)
        && (!c.englishOnly || (t.doctor.isEnglishSpeaker !== false && !!englishIds?.has(t.doctor.id)));
}

export class SmartBookingCoordinator {
    private travel = new Map<number, TravelCache>();
    private accounts = new Set<number>();
    private users = new Set<number>();
    private snapshots = new Map<number, Promise<void>>();
    private dictionaries = new Map<string, { expires: number; ids: Set<number> }>();
    private cityNames = new Map<string, { expires: number; name: string }>();
    private legacyMonitorCache = new Map<number, { expires: number; active: boolean }>();
    private legacyResolutions = new Map<number, Promise<string | null>>();
    private legacyCapability: { expires: number; version: 0 | 1 | 2 } | null = null;
    private cancellationCapability: { expires: number; value: boolean } | null = null;
    private attemptAckCapability: { expires: number; value: boolean } | null = null;
    private legacySweepCursor = 0;
    private lastLegacySweep = new Map<number, number>();
    private warmed = new Set<string>();
    private resolving = new Map<string, Promise<void>>();
    private capability: { expires: number; value: boolean } | null = null;
    private sweepRunning = false;
    private lastTravelReview = new Map<string, number>();
    private reviewedReservationRevisions = new Map<string, string>();
    private lastBackgroundReservationAttempt = new Map<number, number>();
    private intervalIndex = new Map<string, BusyInterval[]>();
    private candidateScans = new Map<string, { key: string; next: number; cold: number[]; unresolved: number[]; candidates: FeasibleSlot[] }>();
    constructor(readonly store: SmartBookingStore = smartStore, private api: Dependencies = smartDependencies, private configured = smartConfigurationIssue) { }
    private activeAccount(userId: number, accountId: number): boolean {
        const row = this.store.db.prepare('SELECT account_id FROM luxmed_accounts WHERE user_id=?').get(userId) as { account_id: number } | undefined;
        return row?.account_id === accountId && !this.store.accountTransition(userId);
    }
    private activeMonitor(config: LuxmedMonitoringConfig): boolean {
        const row = this.store.db.prepare(`SELECT m.*,s.desired_autobook AS smart_autobook FROM luxmed_monitorings m
            LEFT JOIN luxmed_smart_monitors s ON s.monitoring_id=m.id
            WHERE m.id=? AND m.user_id=? AND m.account_id=? AND m.active=1`)
            .get(config.id, config.userId, config.accountId);
        if (!row) return false;
        let current: LuxmedMonitoringConfig;
        try { current = rowToMonitoringConfig(row); }
        catch { return false; }
        const enrollment = this.store.enrollment(config.id);
        if (current.clinicIds !== null) {
            const clinics = this.store.selectedClinicIdentities(config.userId, config.cityId, current.clinicIds);
            if (!clinics || !enrollment?.confirmed_clinic_fingerprint
                || digest(clinics) !== enrollment.confirmed_clinic_fingerprint) return false;
        }
        return enrollment?.state === 'active'
            && enrollment.confirmed_fingerprint === monitorRulesFingerprint(current)
            && monitorRulesFingerprint(current) === monitorRulesFingerprint(config);
    }
    private async providerIdentityIssue(config: LuxmedMonitoringConfig): Promise<string | null> {
        const expected = this.store.enrollment(config.id)?.confirmed_provider_fingerprint;
        if (!expected) return 'The confirmed LuxMed service, city and doctor identities are missing. Request a new preview.';
        const [services, cities, doctors] = await Promise.all([
            this.api.services(config.accountId), this.api.cities(config.accountId),
            config.doctorIds === null ? Promise.resolve([]) : this.api.doctors(config.accountId, config.cityId, config.serviceId),
        ]);
        const serviceName = uniqueServiceName(services, config.serviceId);
        const cityName = uniqueCityName(cities, config.cityId);
        const doctorNames = selectedDoctorNames(doctors, config.doctorIds);
        if (!serviceName || !cityName || !doctorNames
            || providerIdentityFingerprint(config.serviceId, serviceName, config.cityId, cityName, doctorNames) !== expected
            || serviceName !== config.serviceName || cityName !== config.cityName) {
            this.store.db.prepare("UPDATE luxmed_smart_monitors SET state='paused',status='LuxMed service, city or doctor identity changed; confirm a new preview' WHERE monitoring_id=? AND state='active' AND confirmed_provider_fingerprint=?")
                .run(config.id, expected);
            return 'LuxMed changed a selected service, city or doctor. Smart booking is paused until a new preview is confirmed.';
        }
        return null;
    }
    cache(userId: number): TravelCache {
        let cache = this.travel.get(userId);
        if (!cache) { cache = new TravelCache(String(userId), this.store.db); this.travel.set(userId, cache); }
        return cache;
    }
    async readiness(force = false): Promise<string | null> {
        const timezoneIssue = smartBookingTimezoneIssue(BOOKING_ZONE); if (timezoneIssue) return timezoneIssue;
        const config = this.configured(); if (config) return config;
        if (force || !this.capability || this.capability.expires < Date.now()) {
            const caps = await this.api.capabilities();
            this.capability = { expires: Date.now() + 60000, value: caps.includes('smart-booking-v1') && caps.includes('reservation-end-times-v1') && caps.includes('smart-booking-attempts-v3') && caps.includes('smart-booking-attempts-v4') && caps.includes('smart-booking-lockterm-review-v1') && caps.includes('monitor-quiesce-v1') && caps.includes('reservation-range-complete-v1') && caps.includes('legacy-monitor-fence-v1') && caps.includes('legacy-booking-barrier-v2') && caps.includes('smart-booking-enrollment-fence-v2') && caps.includes('smart-booking-identity-fence-v1') && caps.includes('cancellation-receipts-v3') };
            this.legacyCapability = { expires: Date.now() + 60000, version: caps.includes('legacy-booking-barrier-v2') ? 2 : caps.includes('legacy-booking-barrier-v1') ? 1 : 0 };
        }
        return this.capability.value ? null : 'Waiting for the sidecar smart booking update.';
    }
    async legacyMonitorIssue(accountId: number): Promise<string | null> {
        let cached = this.legacyMonitorCache.get(accountId);
        if (!cached || cached.expires < Date.now()) {
            cached = { expires: Date.now() + 15000,
                active: (await this.api.monitorings(accountId)).some(m => m.active && m.autobook) };
            this.legacyMonitorCache.set(accountId, cached);
        }
        return cached.active ? 'An existing LuxMed automatic monitor is still active on this account. Smart booking waits until it is enrolled or stopped.' : null;
    }
    private async syncCancellationReceipts(accountId: number): Promise<string | null> {
        const receipts = await this.api.cancellations(accountId);
        if (!Array.isArray(receipts)) throw new Error('Sidecar cancellation receipts are incomplete.');
        let pending = false;
        for (const receipt of receipts) {
            if (receipt.accountId !== accountId || !Number.isSafeInteger(receipt.reservationId) || receipt.reservationId <= 0
                || !Number.isSafeInteger(receipt.startAt) || receipt.startAt <= 0
                || !['pending', 'confirmed', 'verified_still_reserved', 'verified_moved'].includes(receipt.state)) throw new Error('Sidecar cancellation receipt is invalid.');
            if (receipt.state === 'pending') pending = true;
            else if (!Number.isSafeInteger(receipt.reviewedAt) || receipt.reviewedAt! <= 0 || !receipt.reviewedBy?.trim() || !receipt.reviewReason?.trim())
                throw new Error('Reviewed cancellation has no audit details.');
            else if (receipt.state === 'confirmed' && receipt.reviewAction === 'confirmed_cancelled'
                && Number.isSafeInteger(receipt.confirmedAt) && receipt.confirmedAt! > 0)
                this.store.confirmCancellation(accountId, receipt.reservationId, receipt.startAt);
            else if (receipt.state === 'verified_still_reserved' && receipt.reviewAction === 'verified_still_reserved') {
                this.store.restoreUncancelledVisit(accountId, receipt.reservationId, receipt.startAt);
                const coverage = reservationCoverage(receipt.startAt, receipt.startAt + 60000);
                await this.refreshReservations(accountId, coverage);
                const snapshot = this.store.snapshot(accountId);
                const exactVisit = (snapshot?.value as LuxmedEvent[] | undefined)?.some(event =>
                    event.eventId === receipt.reservationId && zonedTime(event.date) === receipt.startAt);
                if (!snapshotUsable(snapshot, coverage.from, coverage.to, Date.now(), 60000) || !exactVisit) pending = true;
            } else if (receipt.state === 'verified_moved' && receipt.reviewAction === 'verified_moved') {
                const movedStart = receipt.movedStartAt, movedEnd = receipt.movedEndAt;
                if (!Number.isSafeInteger(movedStart) || !Number.isSafeInteger(movedEnd) || movedStart! <= 0
                    || movedEnd! <= movedStart! || movedStart === receipt.startAt || typeof receipt.movedTelemedicine !== 'boolean')
                    throw new Error('Moved visit review lacks exact booking facts.');
                const coverage = reservationCoverage(movedStart!, movedEnd!);
                await this.refreshReservations(accountId, coverage, !receipt.acknowledgedAt);
                const snapshot = this.store.snapshot(accountId);
                const normalized = (value: string | null | undefined) => value?.trim().replace(/\s+/g, ' ').toLowerCase() || null;
                const exact = (snapshot?.value as LuxmedEvent[] | undefined)?.filter(event =>
                    event.eventId === receipt.reservationId && zonedTime(event.date) === movedStart) || [];
                const visit = exact.length === 1 ? exact[0] : null;
                const sameClinic = !!visit && (visit.clinic?.id ?? null) === (receipt.movedClinicId ?? null)
                    && normalized(visit.clinic?.address) === normalized(receipt.movedClinicAddress)
                    && normalized(visit.clinic?.city) === normalized(receipt.movedClinicCity);
                if (!snapshotUsable(snapshot, coverage.from, coverage.to, Date.now(), 60000) || !visit
                    || zonedTime(visit.dateTo || '') !== movedEnd || (visit.eventType === 'Telemedicine') !== receipt.movedTelemedicine
                    || !sameClinic) { pending = true; continue; }
                this.store.recordMovedReservation(accountId, receipt.reservationId, receipt.startAt,
                    movedStart!, movedEnd!, receipt.movedTelemedicine!);
                if (!receipt.acknowledgedAt) {
                    try { await this.api.acknowledgeMove(accountId, receipt.reservationId, receipt.startAt, movedStart!); }
                    catch (error) {
                        pending = true;
                        console.warn('[LuxMed smart] Moved visit acknowledgement deferred', { accountId, reservationId: receipt.reservationId, error });
                    }
                }
            } else throw new Error('Cancellation review does not match the receipt state.');
        }
        return pending ? 'An earlier LuxMed cancellation outcome needs verification. Smart booking is on hold.' : null;
    }
    private resolveLegacyBarrier(accountId: number): Promise<string | null> {
        const running = this.legacyResolutions.get(accountId);
        if (running) return running;
        const job = this.checkLegacyBarrier(accountId).finally(() => this.legacyResolutions.delete(accountId));
        this.legacyResolutions.set(accountId, job);
        return job;
    }
    private async checkLegacyBarrier(accountId: number): Promise<string | null> {
        if (!this.legacyCapability || this.legacyCapability.expires < Date.now()) {
            const capabilities = await this.api.capabilities();
            this.legacyCapability = { expires: Date.now() + 60000,
                version: capabilities.includes('legacy-booking-barrier-v2') ? 2 : capabilities.includes('legacy-booking-barrier-v1') ? 1 : 0 };
        }
        if (!this.legacyCapability.version) return 'Waiting for the sidecar legacy booking barrier update.';
        for (let checked = 0; checked < 20; checked++) {
            const barrier = await this.api.legacyBarrier(accountId);
            if (barrier.state === 'clear') return null;
            if (barrier.state !== 'succeeded' || !Number.isSafeInteger(barrier.reservationId) || barrier.reservationId! <= 0
                || !Number.isSafeInteger(barrier.start) || barrier.start! <= 0
                || (this.legacyCapability.version >= 2 && !barrier.id)) {
                return 'An earlier LuxMed booking outcome needs verification. Smart booking is on hold.';
            }
            if (this.store.wasCancelled(accountId, barrier.reservationId!, barrier.start!)) {
                await this.api.acknowledgeLegacy(accountId, barrier.reservationId!, barrier.id, barrier.start!);
                continue;
            }
            const day = DateTime.fromMillis(barrier.start!, { zone: BOOKING_ZONE }).startOf('day');
            if (!day.isValid) return 'An earlier LuxMed booking has an invalid appointment date. Smart booking is on hold.';
            const coverage = { from: day.toMillis(), to: day.plus({ days: 1 }).toMillis() };
            const observed = await this.api.reserved(accountId, coverage);
            this.store.saveSnapshot(accountId, observed, coverage);
            if (!observed.some(event => event.eventId === barrier.reservationId && zonedTime(event.date) === barrier.start)) {
                return `Waiting for LuxMed to confirm reservation ${barrier.reservationId} in a complete reservation response.`;
            }
            await this.api.acknowledgeLegacy(accountId, barrier.reservationId!, barrier.id, barrier.start!);
        }
        return 'Several earlier LuxMed bookings need verification before smart booking can continue.';
    }
    private async reconcileLegacyBarriers(): Promise<void> {
        if (!this.legacyCapability || this.legacyCapability.expires < Date.now()) {
            const capabilities = await this.api.capabilities();
            this.legacyCapability = { expires: Date.now() + 60000,
                version: capabilities.includes('legacy-booking-barrier-v2') ? 2 : capabilities.includes('legacy-booking-barrier-v1') ? 1 : 0 };
        }
        if (!this.legacyCapability.version) return;
        const accounts = this.store.db.prepare('SELECT DISTINCT account_id FROM luxmed_accounts ORDER BY account_id')
            .all() as { account_id: number }[];
        if (!accounts.length) return;
        const count = Math.min(accounts.length, 5);
        for (let i = 0; i < count; i++) {
            const accountId = accounts[(this.legacySweepCursor + i) % accounts.length].account_id;
            if (this.accounts.has(accountId) || Date.now() - (this.lastLegacySweep.get(accountId) || 0) < 60000) continue;
            this.lastLegacySweep.set(accountId, Date.now());
            try { await this.resolveLegacyBarrier(accountId); }
            catch { console.warn('[LuxMed smart] Legacy booking barrier review deferred', { accountId }); }
        }
        this.legacySweepCursor = (this.legacySweepCursor + count) % accounts.length;
    }
    warmKnownLocations(userId: number): void {
        const policy = this.store.policy(userId)?.policy; if (!policy) return;
        const places = this.store.places(userId);
        const commitments = [...policy.commitments, ...this.store.scheduleAppointments(userId)];
        const origins = new Set([policy.originLocationId, ...commitments.map(c => c.locationId).filter((id): id is string => !!id)]);
        for (const clinic of places.values()) if (clinic.id.startsWith('clinic:')) for (const id of origins) {
            const origin = places.get(id); if (origin) this.cache(userId).warm(origin, clinic);
        }
    }
    async refreshReservations(accountId: number, coverage: ReservationCoverage, force = false, maxAgeMs = 60000): Promise<void> {
        const running = this.snapshots.get(accountId);
        if (running) {
            await running;
            if (!force && snapshotUsable(this.store.snapshot(accountId), coverage.from, coverage.to, Date.now(), maxAgeMs)) return;
            return this.refreshReservations(accountId, coverage, force, maxAgeMs);
        }
        const old = this.store.snapshot(accountId);
        if (!force && snapshotUsable(old, coverage.from, coverage.to, Date.now(), maxAgeMs)) return;
        const job = this.api.reserved(accountId, coverage).then(value => { this.store.saveSnapshot(accountId, value, coverage); }).finally(() => this.snapshots.delete(accountId));
        this.snapshots.set(accountId, job); return job;
    }
    async refreshActiveReservations(configs: LuxmedMonitoringConfig[]): Promise<void> {
        const coverageByAccount = new Map<number, ReservationCoverage>();
        for (const config of configs) {
            if (this.store.enrollment(config.id)?.state !== 'active' || !this.activeAccount(config.userId, config.accountId)) continue;
            let coverage: ReservationCoverage;
            try { coverage = monitorReservationCoverage(config); }
            catch { console.warn('[LuxMed smart] Invalid monitor reservation range', { monitorId: config.id }); continue; }
            const current = coverageByAccount.get(config.accountId);
            coverageByAccount.set(config.accountId, current
                ? { from: Math.min(current.from, coverage.from), to: Math.max(current.to, coverage.to) } : coverage);
        }
        await Promise.all([...coverageByAccount].map(async ([accountId, coverage]) => {
            const now = Date.now();
            if (snapshotUsable(this.store.snapshot(accountId), coverage.from, coverage.to, now, 50000)
                || now - (this.lastBackgroundReservationAttempt.get(accountId) ?? 0) < 10000) return;
            this.lastBackgroundReservationAttempt.set(accountId, now);
            try { await this.refreshReservations(accountId, coverage, false, 50000); }
            catch { console.warn('[LuxMed smart] Background reservation refresh deferred', { accountId }); }
        }));
    }
    async english(config: LuxmedMonitoringConfig): Promise<Set<number> | undefined> {
        if (!config.englishOnly) return undefined;
        const key = `${config.accountId}:${config.cityId}:${config.serviceId}`;
        let cached = this.dictionaries.get(key);
        if (!cached || cached.expires < Date.now()) {
            const doctors = await this.api.doctors(config.accountId, config.cityId, config.serviceId);
            cached = { expires: Date.now() + 3600000, ids: new Set(doctors.filter(d => d.isEnglishSpeaker).map(d => d.id)) }; this.dictionaries.set(key, cached);
        }
        return cached.ids;
    }
    private async verifiedCity(config: LuxmedMonitoringConfig): Promise<string> {
        const key = `${config.accountId}:${config.cityId}`;
        let cached = this.cityNames.get(key);
        if (!cached || cached.expires < Date.now()) {
            const city = (await this.api.cities(config.accountId)).find(c => c.id === config.cityId);
            if (!city?.name?.trim()) throw new Error('LuxMed city ID could not be verified.');
            cached = { expires: Date.now() + 3600000, name: city.name.trim() };
            this.cityNames.set(key, cached);
        }
        return cached.name;
    }
    async intervals(userId: number, accountId: number, cityId: number): Promise<BusyInterval[]> {
        const events = (this.store.snapshot(accountId)?.value || []) as LuxmedEvent[];
        const result: BusyInterval[] = [];
        for (const e of events) {
            const start = zonedTime(e.date);
            if (!Number.isFinite(start)) throw new Error('An existing reservation has an invalid date.');
            let end = e.dateTo ? zonedTime(e.dateTo) : NaN;
            if (!Number.isFinite(end) || end <= start) {
                // An unknown duration blocks the whole day, rather than inventing a short visit.
                result.push({ id: `reservation:${e.eventId}`, start: DateTime.fromMillis(start, { zone: BOOKING_ZONE }).startOf('day').toMillis(), end: DateTime.fromMillis(start, { zone: BOOKING_ZONE }).endOf('day').toMillis() });
                continue;
            }
            const savedBlock = this.store.blocks(userId).find(b => b.id === `reservation:${e.eventId}`);
            const id = `reservation-clinic:${accountId}:${e.eventId}`;
            let locationId: string | undefined;
            if (e.eventType !== 'Telemedicine' && e.clinic?.address && e.clinic.city) {
                let place = this.store.places(userId).get(id);
                if (!place || !this.store.locationVerified(userId, id, place.revision)
                    || !providerStreetMatches(e.clinic.address, place.address)
                    || !providerCityMatches(e.clinic.city, place.address)) {
                    const resolved = await this.api.resolve(`${e.clinic.address}, ${e.clinic.city}`);
                    if (resolved && providerStreetMatches(e.clinic.address, resolved.address)
                        && providerCityMatches(e.clinic.city, resolved.address)) {
                        place = this.store.place(userId, id, resolved.address, resolved.lat, resolved.lng);
                        this.store.verifyLocation(userId, id, place.revision);
                    }
                }
                if (place && this.store.locationVerified(userId, id, place.revision)
                    && providerStreetMatches(e.clinic.address, place.address)
                    && providerCityMatches(e.clinic.city, place.address)) locationId = id;
            }
            result.push({ id: `reservation:${e.eventId}`, start: start - (e.eventType === 'Telemedicine' ? 0 : 10 * 60000), end: end + 10 * 60000, transitionMinutes: 0,
                locationId: e.eventType === 'Telemedicine' ? savedBlock?.locationId : locationId || `unresolved-reservation:${e.eventId}` });
        }
        // Keep newly booked blocks until the portal snapshot catches up.
        const ids = new Set(result.map(b => b.id));
        result.push(...this.store.blocks(userId).filter(b => !ids.has(b.id)));
        return result;
    }
    async prepareClinics(config: LuxmedMonitoringConfig, terms: LuxmedTerm[]): Promise<void> {
        const policy = this.store.policy(config.userId)?.policy; if (!policy) return;
        const cityName = await this.verifiedCity(config);
        const commitments = [...policy.commitments, ...this.store.scheduleAppointments(config.userId)];
        const unique = new Map(terms.filter(t => !t.term.isTelemedicine).map(t => [t.term.clinicId, t]));
        for (const term of unique.values()) {
            const id = `clinic:${config.cityId}:${term.term.clinicId}`;
            const sourceLabel = term.term.clinic?.trim() || '';
            let place = this.store.places(config.userId).get(id);
            if (!sourceLabel) { this.store.status(config.id, `Clinic ${term.term.clinicId} has no verified street address.`); continue; }
            if (!place || !this.store.clinicVerified(config.userId, id, sourceLabel, place.revision)
                || !providerCityMatches(cityName, place.address)) {
                const key = digest([config.userId, id, sourceLabel, place?.revision]);
                if (!this.resolving.has(key)) {
                    const job = queueTravelRequest(async () => {
                        const resolved = await this.api.resolve(`${sourceLabel}, ${cityName}`);
                        if (resolved && providerStreetMatches(sourceLabel, resolved.address)
                            && providerCityMatches(cityName, resolved.address)) {
                            const stored = this.store.place(config.userId, id, resolved.address, resolved.lat, resolved.lng);
                            this.store.verifyClinic(config.userId, id, sourceLabel, stored.revision);
                        } else this.store.status(config.id, `LuxMed clinic ${term.term.clinicId} needs a matching street and building number: ${sourceLabel}`);
                    }, 5).catch(() => { this.store.status(config.id, `Could not verify clinic ${term.term.clinicId}'s address.`); }).finally(() => this.resolving.delete(key));
                    this.resolving.set(key, job);
                }
                await this.resolving.get(key);
                place = this.store.places(config.userId).get(id);
            }
            if (!place || !this.store.clinicVerified(config.userId, id, sourceLabel, place.revision)
                || !providerCityMatches(cityName, place.address)) continue;
            const places = this.store.places(config.userId);
            for (const originId of new Set([policy.originLocationId, ...commitments.map(c => c.locationId).filter((v): v is string => !!v)])) {
                const origin = places.get(originId); if (!origin) continue;
                const warmKey = digest([config.userId, origin.id, origin.revision, place.id, place.revision, DateTime.now().toISODate()]);
                if (this.warmed.has(warmKey)) continue;
                this.warmed.add(warmKey);
                const additional: TravelQuery[] = [];
                const until = Math.min(zonedTime(config.dateTo), Date.now() + 14 * 86400000);
                for (const c of commitments.filter(c => c.locationId === originId)) for (const interval of expandRule(c, Date.now(), until)) {
                    for (const mode of ['transit', 'taxi'] as const) {
                        additional.push({ from: origin, to: place, mode, kind: 'depart', at: interval.end + 5 * 60000 });
                        additional.push({ from: place, to: origin, mode, kind: 'arrive', at: interval.start });
                    }
                }
                this.cache(config.userId).warm(origin, place, additional);
            }
        }
    }
    async inspect(config: LuxmedMonitoringConfig, terms: LuxmedTerm[], allowDraft = false): Promise<{ candidates: FeasibleSlot[]; revision: number; reservationRevision: string; complete: boolean; deferredFromDay?: string }> {
        if (!this.activeAccount(config.userId, config.accountId)) throw new Error('The LuxMed account changed or its previous monitors still need cleanup.');
        const issue = await this.readiness(); if (issue) throw new Error(issue);
        const saved = this.store.policy(config.userId);
        if (!saved || (!allowDraft && (saved.state !== 'confirmed' || saved.holdToken))) throw new Error('Availability is awaiting review or confirmation.');
        const requiredLocations = [saved.policy.originLocationId, ...saved.policy.commitments.map(c => c.locationId),
            ...this.store.scheduleAppointments(config.userId).map(c => c.locationId)];
        const currentPlaces = this.store.places(config.userId);
        if (requiredLocations.some(id => !id || !this.store.locationVerified(config.userId, id, currentPlaces.get(id)?.revision || '')))
            throw new Error('A travel location needs a verified street address. Smart booking is paused.');
        const coverage = monitorReservationCoverage(config);
        await this.refreshReservations(config.accountId, coverage);
        if (!snapshotCovers(this.store.snapshot(config.accountId), coverage.from, coverage.to)) throw new Error('Reservations do not cover the monitor date range.');
        const english = await this.english(config);
        const filtered = terms.filter(t => matchesMonitor(t, config, english));
        await this.prepareClinics(config, filtered);
        const cityName = await this.verifiedCity(config);
        const verified = filtered.filter(t => t.term.isTelemedicine || this.store.clinicVerified(config.userId,
            `clinic:${config.cityId}:${t.term.clinicId}`, t.term.clinic || '',
            this.store.places(config.userId).get(`clinic:${config.cityId}:${t.term.clinicId}`)?.revision || '')
            && providerCityMatches(cityName, this.store.places(config.userId).get(`clinic:${config.cityId}:${t.term.clinicId}`)?.address || ''));
        const reservations = await this.intervals(config.userId, config.accountId, config.cityId);
        const places = this.store.places(config.userId);
        const effectivePolicy = { ...saved.policy, commitments: [...saved.policy.commitments, ...this.store.scheduleAppointments(config.userId)],
            maxTransitMinutes: Math.min(saved.policy.maxTransitMinutes, config.maxTransitMinutes ?? Infinity) };
        const evaluate = async (term: LuxmedTerm, prepared: boolean) => {
            const slot = { ...slotFromTerm(term, config.cityId), preparationConfirmed: this.store.isPreparationConfirmed(config.userId, saved.revision, term) };
            const day = DateTime.fromMillis(slot.start, { zone: BOOKING_ZONE }).startOf('day');
            const indexKey = digest([config.userId, saved.revision, day.toISODate(), reservations]);
            let busy = this.intervalIndex.get(indexKey);
            if (!busy) {
                busy = busyIntervals(effectivePolicy, day.minus({ days: 1 }).toMillis(), day.plus({ days: 3 }).toMillis(), reservations);
                this.intervalIndex.set(indexKey, busy);
                if (this.intervalIndex.size > 1000) this.intervalIndex.delete(this.intervalIndex.keys().next().value!);
            }
            let missingRoute = false;
            const candidate = await evaluateSlot(slot, effectivePolicy, places, busy, async q => {
                const route = prepared ? this.cache(config.userId).prepared(q) : await this.cache(config.userId).lookup(q);
                if (prepared && !route) missingRoute = true;
                return route;
            });
            return { candidate, missingRoute };
        };
        // Each candidate can use both Google workers for its two legs. Starting
        // every candidate together consumes their two-second deadlines in the
        // queue before later candidates can request an exact route.
        const ordered = verified.sort((a, b) => slotFromTerm(a, config.cityId).start - slotFromTerm(b, config.cityId).start);
        const reservationRevision = this.store.snapshot(config.accountId)!.revision;
        const scanKey = digest([config.id, config.accountId, config.cityId, config.serviceId, config.clinicIds,
            config.doctorIds, config.englishOnly, config.dateFrom, config.dateTo, config.timeFrom, config.timeTo,
            config.maxTransitMinutes, saved.revision, reservationRevision,
            ordered.map(t => slotFromTerm(t, config.cityId).id)]);
        let scan = this.candidateScans.get(config.id);
        if (!scan || scan.key !== scanKey || allowDraft) {
            scan = { key: scanKey, next: 0, cold: [], unresolved: [], candidates: [] };
            // Inspect every slot against usable exact-date routes without
            // queuing Google calls. Warm candidates should not wait for a
            // later polling cycle merely because there are many slots.
            for (let index = 0; index < ordered.length; index++) {
                const checked = await evaluate(ordered[index], true);
                if (checked.candidate) scan.candidates.push(checked.candidate);
                else if (checked.missingRoute) scan.cold.push(index);
            }
        }
        // A verified earlier day does not wait for cold routes on later days.
        // Within its day, every cold slot still gets a chance to beat its
        // transport class before ranking.
        const earliestDay = () => scan!.candidates.reduce<string | null>((day, candidate) =>
            !day || candidate.day < day ? candidate.day : day, null);
        const nextColdDay = () => scan!.next < scan!.cold.length
            ? DateTime.fromMillis(slotFromTerm(ordered[scan!.cold[scan!.next]], config.cityId).start, { zone: BOOKING_ZONE }).toISODate()!
            : null;
        const mustCheckNext = () => {
            const coldDay = nextColdDay(), knownDay = earliestDay();
            return !!coldDay && (!knownDay || coldDay <= knownDay);
        };
        let checked = 0;
        while (mustCheckNext() && (allowDraft || checked < 4)) {
            const index = scan.cold[scan.next];
            const result = await evaluate(ordered[index], false);
            if (result.candidate) scan.candidates.push(result.candidate);
            else scan.unresolved.push(index);
            scan.next++;
            checked++;
        }
        // A foreground deadline can expire just before its background route
        // arrives. Revisit those slots from the prepared cache before using a
        // later day, including when this scan resumes on another polling cycle.
        const unresolved: number[] = [];
        for (const index of scan.unresolved) {
            const result = await evaluate(ordered[index], true);
            if (result.candidate) scan.candidates.push(result.candidate);
            else unresolved.push(index);
        }
        scan.unresolved = unresolved;
        if (mustCheckNext()) {
            this.candidateScans.set(config.id, scan);
            if (this.candidateScans.size > 100) this.candidateScans.delete(this.candidateScans.keys().next().value!);
            return { candidates: [], revision: saved.revision, reservationRevision, complete: false };
        }
        const deferredFromDay = nextColdDay() || undefined;
        this.candidateScans.delete(config.id);
        return { candidates: scan.candidates, revision: saved.revision, reservationRevision, complete: true, deferredFromDay };
    }
    async process(config: LuxmedMonitoringConfig, terms: LuxmedTerm[], manual = false): Promise<{ state: string; message: string }> {
        if (!this.activeAccount(config.userId, config.accountId)) return { state: 'waiting', message: 'The LuxMed account changed. Search again under the current account.' };
        if (!manual && !this.activeMonitor(config)) return { state: 'waiting', message: 'Smart monitoring is no longer active.' };
        if (config.rebookIfExists) return { state: 'waiting', message: 'Replacement booking is paused until the existing LuxMed visit can be identified and travel checked without that visit.' };
        if (this.accounts.has(config.accountId) || this.users.has(config.userId)) return { state: 'waiting', message: 'Another booking decision is in progress.' };
        this.accounts.add(config.accountId); this.users.add(config.userId);
        const started = Date.now();
        const bookingRevision = this.store.accountBookingRevision(config.accountId);
        try {
            if (this.store.pending(config.userId).length) return { state: 'waiting', message: 'Checking the outcome of a previous booking.' };
            const readiness = await this.readiness(); if (readiness) return { state: 'waiting', message: readiness };
            const cancellationIssue = await this.syncCancellationReceipts(config.accountId);
            if (cancellationIssue) return { state: 'waiting', message: cancellationIssue };
            const legacyBarrier = await this.resolveLegacyBarrier(config.accountId);
            if (legacyBarrier) return { state: 'waiting', message: legacyBarrier };
            const inspected = await this.inspect(config, terms);
            if (!inspected.complete) return { state: 'waiting', message: 'Checking earlier appointment routes before choosing a day.' };
            const saved = this.store.policy(config.userId)!;
            let remaining = inspected.candidates;
            while (remaining.length) {
                const ranked = await rankWithJev(remaining, saved.policy.softPreferences, saved.revision);
                if (!ranked) break;
                const candidate = ranked.candidate;
                const current = this.store.policy(config.userId);
                if (!current || current.revision !== inspected.revision || current.state !== 'confirmed' || current.holdToken) throw new Error('Availability changed during the decision.');
                const snapshot = this.store.snapshot(config.accountId);
                if (!snapshot || snapshot.revision !== inspected.reservationRevision
                    || !snapshotUsable(snapshot, candidate.slot.start, candidate.slot.end, Date.now(), 60000)) throw new Error('Reservations changed or need refreshing.');
                const effectivePolicy = { ...current.policy, commitments: [...current.policy.commitments, ...this.store.scheduleAppointments(config.userId)],
                    maxTransitMinutes: Math.min(current.policy.maxTransitMinutes, config.maxTransitMinutes ?? Infinity) };
                const busy = busyIntervals(effectivePolicy, candidate.slot.start - 86400000, candidate.slot.end + 86400000, await this.intervals(config.userId, config.accountId, config.cityId));
                const rechecked = await evaluateSlot(candidate.slot, effectivePolicy, this.store.places(config.userId), busy, async q => {
                    const prior = candidate.legs.find(l => digest(l.query) === digest(q));
                    const refreshed = this.cache(config.userId).previous(q);
                    if (refreshed && refreshed.fetchedAt > (prior?.fetchedAt ?? started)) return refreshed;
                    return prior || refreshed;
                });
                if (!rechecked) {
                    remaining = remaining.filter(c => c !== candidate);
                    const nextKnownDay = remaining.reduce<string | null>((day, value) =>
                        !day || value.day < day ? value.day : day, null);
                    if (inspected.deferredFromDay && (!nextKnownDay || nextKnownDay >= inspected.deferredFromDay))
                        return { state: 'waiting', message: 'Checking routes for later slots before choosing another day.' };
                    continue;
                }
                if (rechecked.day !== candidate.day || rechecked.taxiLegs !== candidate.taxiLegs
                    || rechecked.travelSeconds !== candidate.travelSeconds || rechecked.leaveAt !== candidate.leaveAt) {
                    // New route facts can change the confirmed transport order
                    // or the facts Jev used. Rank the verified candidates again.
                    remaining = remaining.map(value => value === candidate ? rechecked : value);
                    continue;
                }
                if (!manual) {
                    const providerIssue = await this.providerIdentityIssue(config)
                        .catch(() => 'LuxMed provider identities could not be verified. Smart booking is waiting.');
                    if (providerIssue) return { state: 'waiting', message: providerIssue };
                }
                // All awaits are complete. Recheck synchronously immediately before persistence/submission.
                const latest = this.store.policy(config.userId);
                if (!latest || latest.revision !== current.revision || latest.holdToken || latest.state !== 'confirmed'
                    || this.store.accountBookingRevision(config.accountId) !== bookingRevision
                    || !this.activeAccount(config.userId, config.accountId) || (!manual && !this.activeMonitor(config))) throw new Error('Availability, reservations or monitoring changed before submission.');
                const submissionPlaces = this.store.places(config.userId);
                const submissionLocations = [latest.policy.originLocationId, ...latest.policy.commitments.map(c => c.locationId),
                    ...this.store.scheduleAppointments(config.userId).map(c => c.locationId)];
                if (submissionLocations.some(id => !id || !this.store.locationVerified(config.userId, id, submissionPlaces.get(id)?.revision || '')))
                    throw new Error('A travel location changed before submission.');
                const term = terms.find(t => slotFromTerm(t, config.cityId).id === candidate.slot.id)!;
                if (!term.term.isTelemedicine && !this.store.clinicVerified(config.userId, candidate.slot.locationId!, term.term.clinic || '',
                    this.store.places(config.userId).get(candidate.slot.locationId!)?.revision || '')) throw new Error('Clinic address changed before submission.');
                if (!term.term.isTelemedicine && !providerCityMatches(this.cityNames.get(`${config.accountId}:${config.cityId}`)?.name || '',
                    this.store.places(config.userId).get(candidate.slot.locationId!)?.address || '')) throw new Error('Clinic city changed before submission.');
                if (candidate.slot.preparationRequired && !this.store.isPreparationConfirmed(config.userId, current.revision, term))
                    throw new Error('Appointment preparation changed before submission.');
                if (!config.autobook && !manual) {
                    this.store.notify(`candidate:${config.id}:${candidate.slot.id}`, config.userId, `LuxMed found a suitable appointment at ${new Date(candidate.slot.start).toISOString()}. Use the bot to book it.`);
                    return { state: 'notified', message: 'Suitable appointment notification queued.' };
                }
                const allReservations = snapshot.value as LuxmedEvent[];
                const baselineFacts = reservationBaselineFacts(allReservations, candidate.slot.start);
                const baselineIds = allReservations.map(event => event.eventId).sort((a, b) => a - b);
                const attempt = this.store.begin(config.userId, config.accountId, manual ? null : config.id, current.revision, digest(term), { term, cityId: config.cityId,
                    rebookIfExists: config.rebookIfExists, slot: candidate.slot, journey: rechecked,
                    baseline: snapshot.value, reservationRevision: snapshot.revision });
                console.log('[LuxMed smart] Submitting verified booking', {
                    monitorId: config.id, decisionMs: Date.now() - started, ranking: ranked.source,
                    routeAgeMs: rechecked.legs.map(l => Date.now() - l.fetchedAt), cachedLegs: rechecked.legs.filter(l => l.cached).length, cache: this.cache(config.userId).metrics
                });
                try {
                    const outcome = await this.api.book(config.accountId, term, config.cityId, config.rebookIfExists, attempt.id, () => {
                        const policy = this.store.policy(config.userId), snapshotNow = this.store.snapshot(config.accountId);
                        const routeChanged = rechecked.legs.some(leg => {
                            const newest = this.cache(config.userId).previous(leg.query);
                            // A newer result can change duration, transfers or the
                            // cached safety margin without changing endpoints.
                            // Re-evaluate on the next cycle instead of submitting
                            // from facts that are no longer the latest available.
                            return !usableEstimate(leg, leg.query, Date.now()) || !!newest && newest.fetchedAt > leg.fetchedAt;
                        });
                        return !!policy && policy.state === 'confirmed' && !policy.holdToken && policy.revision === current.revision && snapshotNow?.revision === snapshot.revision
                            && this.store.accountBookingRevision(config.accountId) === bookingRevision
                            && snapshotUsable(snapshotNow, candidate.slot.start, candidate.slot.end, Date.now(), 60000)
                            && rechecked.leaveAt >= Date.now() + 5 * 60000
                            && this.activeAccount(config.userId, config.accountId) && (manual || this.activeMonitor(config)) && !routeChanged
                            && submissionLocations.every(id => !!id && this.store.locationVerified(config.userId, id,
                                this.store.places(config.userId).get(id)?.revision || ''))
                            && (term.term.isTelemedicine || this.store.clinicVerified(config.userId, candidate.slot.locationId!, term.term.clinic || '',
                                this.store.places(config.userId).get(candidate.slot.locationId!)?.revision || ''))
                            && (term.term.isTelemedicine || providerCityMatches(this.cityNames.get(`${config.accountId}:${config.cityId}`)?.name || '',
                                this.store.places(config.userId).get(candidate.slot.locationId!)?.address || ''))
                            && (!candidate.slot.preparationRequired || this.store.isPreparationConfirmed(config.userId, current.revision, term));
                    }, baselineIds, baselineFacts) as BookingOutcome;
                    if (outcome.state === 'succeeded' && Number.isSafeInteger(outcome.reservationId) && outcome.reservationId! > 0) {
                        this.complete(attempt, outcome.reservationId!, !!outcome.errorCode);
                        await this.acknowledgeCompletedAttempt(attempt.id, config.accountId, outcome.reservationId!);
                        return { state: 'booked', message: `Appointment booked. Reservation ${outcome.reservationId}.` };
                    }
                    if (outcome.state === 'failed') {
                        this.store.outcome(attempt.id, 'failed');
                        if (outcome.errorCode === 'ACCOUNT_BUSY') return { state: 'waiting', message: 'Another booking outcome must be resolved for this LuxMed account.' };
                        if (outcome.errorCode === 'LEGACY_AUTO_MONITOR_ACTIVE') {
                            this.store.status(config.id, 'Waiting for existing LuxMed automatic monitors on this account to be enrolled or stopped.');
                            return { state: 'waiting', message: 'An existing LuxMed automatic monitor is still active on this account.' };
                        }
                        if (outcome.errorCode === 'LEGACY_BOOKING_BARRIER') {
                            return { state: 'waiting', message: 'An earlier LuxMed booking must be verified before another booking can be submitted.' };
                        }
                        if (outcome.errorCode === 'SMART_BOOKING_NOT_ENROLLED') {
                            return { state: 'waiting', message: 'Smart booking has not been enrolled for this LuxMed account. Confirm the availability preview again.' };
                        }
                        if (outcome.errorCode === 'SMART_BOOKING_IDENTITY_UNSAFE') {
                            return { state: 'waiting', message: 'The LuxMed login is linked to another account or changed after confirmation. Smart booking is on hold until the account identity is resolved.' };
                        }
                        if (outcome.errorCode !== 'BOOKING_REJECTED') return { state: 'waiting', message: 'LuxMed could not submit the booking. Monitoring will retry.' };
                        remaining = remaining.filter(c => c !== candidate);
                        const nextKnownDay = remaining.reduce<string | null>((day, value) =>
                            !day || value.day < day ? value.day : day, null);
                        if (inspected.deferredFromDay && (!nextKnownDay || nextKnownDay >= inspected.deferredFromDay))
                            return { state: 'waiting', message: 'Checking routes for later slots before choosing another day.' };
                        continue;
                    }
                    if (outcome.state === 'blocked' && outcome.errorCode === 'ACCOUNT_BUSY') {
                        this.store.outcome(attempt.id, 'failed');
                        return { state: 'waiting', message: 'Another booking outcome must be resolved for this LuxMed account.' };
                    }
                } catch (error) {
                    if (error instanceof LuxmedApiError && error.status === 404) {
                        this.capability = null;
                        // A response status after dispatch cannot prove the
                        // booking request was never submitted upstream.
                    }
                    if (error instanceof LuxmedApiError && ['BOOKING_GUARD_CHANGED', 'ACCOUNT_BACKOFF'].includes(error.code)) {
                        this.store.outcome(attempt.id, 'failed'); return { state: 'waiting', message: error.message };
                    }
                    // A network error does not establish that booking failed.
                }
                this.store.outcome(attempt.id, 'unknown');
                this.store.notify(`unknown:${attempt.id}`, config.userId, 'LuxMed booking outcome is uncertain. I am checking the reservation before attempting another booking.');
                return { state: 'unknown', message: 'Checking the booking outcome before retrying.' };
            }
            return { state: 'waiting', message: 'No verified slot fits the confirmed schedule and travel limits.' };
        } finally { this.accounts.delete(config.accountId); this.users.delete(config.userId); }
    }
    private complete(attempt: BookingAttempt, reservationId: number, providerWarning = false): void {
        const p = JSON.parse(attempt.payload) as { slot: Slot; journey: FeasibleSlot; reservationRevision?: string };
        const policy = this.store.policy(attempt.user_id);
        const currentSnapshot = this.store.snapshot(attempt.account_id);
        const monitorStopped = !!attempt.monitoring_id && !this.store.db.prepare(
            'SELECT 1 FROM luxmed_monitorings WHERE id=? AND user_id=? AND account_id=? AND active=1'
        ).get(attempt.monitoring_id, attempt.user_id, attempt.account_id);
        const conflict = policy?.revision !== attempt.policy_revision || !!policy?.holdToken
            || !currentSnapshot || currentSnapshot.revision !== p.reservationRevision
            || monitorStopped || !this.activeAccount(attempt.user_id, attempt.account_id);
        const time = DateTime.fromMillis(p.slot.start, { zone: BOOKING_ZONE }).toFormat('ccc dd LLL HH:mm');
        const leave = DateTime.fromMillis(p.journey.leaveAt, { zone: BOOKING_ZONE }).toFormat('HH:mm');
        this.store.succeed(attempt.id, reservationId, { id: `reservation:${reservationId}`, start: p.slot.start - (p.slot.telemedicine ? 0 : 10 * 60000), end: p.slot.end + 10 * 60000, transitionMinutes: 0, locationId: p.journey.legs[0]?.query.to.id },
            `LuxMed booked ${time}. Reservation ${reservationId}. Leave by ${leave}. ${p.journey.taxiLegs ? 'Taxi is needed for part of the journey.' : 'Public transport fits.'}${providerWarning ? ' LuxMed returned a booking warning. Review the appointment and its instructions in the LuxMed portal.' : ''}${conflict ? ' Your schedule, monitor, account or LuxMed reservations changed while booking was submitted. Please review this appointment.' : ''}`);
        void this.refreshReservations(attempt.account_id, reservationCoverage(p.slot.start, p.slot.end), true).catch(() => console.warn('[LuxMed smart] Post-booking reservation refresh deferred'));
    }
    private async acknowledgeCompletedAttempt(id: string, accountId: number, reservationId: number): Promise<void> {
        const saved = this.store.attempt(id);
        if (!saved || !['succeeded', 'cancelled'].includes(saved.state) || saved.reservation_id !== reservationId) return;
        try {
            await this.api.acknowledgeAttempt(accountId, id, reservationId);
            if (!this.store.acknowledge(id, reservationId))
                throw new Error('Local booking acknowledgement no longer matches the saved reservation.');
        } catch (error) {
            console.warn('[LuxMed smart] Booking acknowledgement deferred', { attemptId: id, error });
        }
    }
    async reconcile(): Promise<void> {
        if (this.sweepRunning) return; this.sweepRunning = true;
        try {
            try {
                if (!this.cancellationCapability || this.cancellationCapability.expires < Date.now()
                    || !this.attemptAckCapability || this.attemptAckCapability.expires < Date.now()) {
                    const capabilities = await this.api.capabilities();
                    this.cancellationCapability = { expires: Date.now() + 60000, value: capabilities.includes('cancellation-receipts-v3') };
                    this.attemptAckCapability = { expires: Date.now() + 60000, value: capabilities.includes('smart-booking-attempts-v3') };
                }
                if (this.cancellationCapability.value) {
                    const accounts = this.store.db.prepare('SELECT DISTINCT account_id FROM luxmed_accounts ORDER BY account_id')
                        .all() as { account_id: number }[];
                    for (const account of accounts) await this.syncCancellationReceipts(account.account_id);
                }
            } catch { console.warn('[LuxMed smart] Cancellation receipt review deferred'); }
            if (this.attemptAckCapability?.value) {
                for (const attempt of this.store.unacknowledged()) {
                    if (attempt.reservation_id)
                        await this.acknowledgeCompletedAttempt(attempt.id, attempt.account_id, attempt.reservation_id);
                }
            }
            for (const attempt of this.store.pending()) {
                try {
                    const outcome = await this.api.attempt(attempt.account_id, attempt.id).catch(error => {
                        if (error instanceof LuxmedApiError && error.status === 404) return { state: 'unknown' } as BookingOutcome;
                        throw error;
                    });
                    // A missing sidecar record does not prove the upstream request was never sent.
                    const settled = outcome;
                    if (settled.state === 'succeeded' && Number.isSafeInteger(settled.reservationId) && settled.reservationId! > 0) {
                        this.complete(attempt, settled.reservationId!, !!settled.errorCode);
                        await this.acknowledgeCompletedAttempt(attempt.id, attempt.account_id, settled.reservationId!);
                    }
                    else if (settled.state === 'failed') this.store.outcome(attempt.id, 'failed');
                    else {
                        const payload = JSON.parse(attempt.payload) as { slot: Slot; baseline: LuxmedEvent[] };
                        await this.refreshReservations(attempt.account_id, reservationCoverage(payload.slot.start, payload.slot.end), true);
                        this.store.outcome(attempt.id, 'unknown');
                        const known = new Set(payload.baseline.map(e => e.eventId));
                        const possible = (this.store.snapshot(attempt.account_id)?.value as LuxmedEvent[] || []).filter(e => !known.has(e.eventId) && zonedTime(e.date) === payload.slot.start);
                        this.store.notify(`verify:${attempt.id}`, attempt.user_id, `A booking outcome still needs verification. Automatic booking is on hold; no duplicate attempt will be submitted.${possible.length ? ` The portal now lists reservation(s) ${possible.map(e => e.eventId).join(', ')} at that time. Please verify the service and clinic.` : ''}`);
                    }
                } catch { console.warn('[LuxMed smart] Booking reconciliation deferred', { attemptId: attempt.id }); }
            }
            try { await this.reconcileLegacyBarriers(); }
            catch { console.warn('[LuxMed smart] Legacy booking barrier review deferred'); }
            await this.reviewBookedJourneys();
        } finally { this.sweepRunning = false; }
    }
    private async reviewBookedJourneys(): Promise<void> {
        const attempts = this.store.db.prepare("SELECT * FROM luxmed_booking_attempts WHERE state='succeeded' ORDER BY created_at DESC LIMIT 100").all() as BookingAttempt[];
        for (const attempt of attempts) {
            const payload = JSON.parse(attempt.payload) as { slot: Slot; journey: FeasibleSlot; cityId: number; reservationRevision?: string };
            if (payload.slot.start < Date.now() || Date.now() - (this.lastTravelReview.get(attempt.id) || 0) < 5 * 60000) continue;
            if (!this.store.blocks(attempt.user_id).some(b => b.id === `reservation:${attempt.reservation_id}`)) continue;
            this.lastTravelReview.set(attempt.id, Date.now());
            try {
                const policy = this.store.policy(attempt.user_id); if (!policy) continue;
                await this.refreshReservations(attempt.account_id, reservationCoverage(payload.slot.start, payload.slot.end));
                const currentSnapshot = this.store.snapshot(attempt.account_id);
                const reservationChanged = !currentSnapshot || currentSnapshot.revision
                    !== (this.reviewedReservationRevisions.get(attempt.id) ?? payload.reservationRevision);
                const refreshed = await Promise.all(payload.journey.legs.map(l => this.cache(attempt.user_id).refresh(l.query, 1)));
                const changed = policy.revision !== attempt.policy_revision || reservationChanged
                    || refreshed.some((e, i) => e && e.fetchedAt > payload.journey.legs[i].fetchedAt && (e.status !== 'ok' || e.departure !== payload.journey.legs[i].departure || e.arrival !== payload.journey.legs[i].arrival));
                if (!changed) continue;
                const existing = (await this.intervals(attempt.user_id, attempt.account_id, payload.cityId)).filter(b => b.id !== `reservation:${attempt.reservation_id}`);
                const effectivePolicy = { ...policy.policy, commitments: [...policy.policy.commitments, ...this.store.scheduleAppointments(attempt.user_id)] };
                const busy = busyIntervals(effectivePolicy, payload.slot.start - 86400000, payload.slot.end + 86400000, existing);
                const fits = await evaluateSlot(payload.slot, effectivePolicy, this.store.places(attempt.user_id), busy, async q => {
                    const i = payload.journey.legs.findIndex(l => this.cache(attempt.user_id).key(l.query) === this.cache(attempt.user_id).key(q));
                    return i >= 0 ? refreshed[i] || payload.journey.legs[i] : null;
                });
                if (!fits) this.store.notify(`travel-conflict:${attempt.id}:${policy.revision}:${currentSnapshot?.revision || 'missing'}`, attempt.user_id,
                    `Updated travel, availability or another LuxMed reservation may conflict with reservation ${attempt.reservation_id}. Please review the journey. Your appointment has not been cancelled.`);
                if (currentSnapshot) this.reviewedReservationRevisions.set(attempt.id, currentSnapshot.revision);
            } catch { console.warn('[LuxMed smart] Booked journey review deferred', { attemptId: attempt.id }); }
        }
    }
}
export const smartBooking = new SmartBookingCoordinator();
