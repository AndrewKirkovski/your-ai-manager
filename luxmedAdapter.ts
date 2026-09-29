/**
 * HTTP client for the luxmed-bot JVM sidecar REST API.
 * All LuxMed portal operations go through this adapter.
 */

import { createHmac } from 'node:crypto';
import { luxmedAccountQueue } from './luxmedAccountQueue';

const SIDECAR_URL = process.env.LUXMED_SIDECAR_URL || 'http://localhost:8080';
// Watchtower retains the old container environment. Both containers already
// have this encryption secret under their respective Compose variable names.
// Derive a separate REST key without transmitting the encryption secret.
const SIDECAR_SECRET = process.env.LUXMED_SIDECAR_SECRET || (
    process.env.LUXMED_SECURITY_SECRET
        ? createHmac('sha256', process.env.LUXMED_SECURITY_SECRET).update('luxmed-rest-auth-v1').digest('hex')
        : ''
);

interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: string | { code?: string; message?: string };
}

export class LuxmedApiError extends Error {
    readonly code: string;
    readonly status?: number;
    retryAfterMs?: number;

    constructor(message: string, code = 'LUXMED_API_ERROR', status?: number) {
        super(message);
        this.name = 'LuxmedApiError';
        this.code = code;
        this.status = status;
    }
}

interface LoginResult {
    userId: number;
    accountId: number;
    username: string;
}

export interface LuxmedCity {
    id: number;
    name: string;
}

export interface LuxmedService {
    id: number;
    name: string;
    children?: LuxmedService[];
}

export interface LuxmedFacility {
    id: number;
    name: string;
}

export interface LuxmedDoctor {
    id: number;
    firstName?: string | null;
    lastName?: string | null;
    academicTitle?: string | null;
    name: string;
    isEnglishSpeaker?: boolean;
    facilityGroupIds?: number[];
}

export interface LuxmedTerm {
    additionalData: {
        isPreparationRequired: boolean;
        preparationItems: { header?: string; text?: string }[];
    };
    term: {
        clinic?: string | null;
        clinicId: number;
        clinicGroupId: number;
        dateTimeFrom: { dateTimeLocal?: string; dateTimeTz?: string };
        dateTimeTo: { dateTimeLocal?: string; dateTimeTz?: string };
        doctor: LuxmedDoctor;
        isTelemedicine: boolean;
        isAdditional: boolean;
        isImpediment?: boolean;
        roomId: number;
        scheduleId: number;
        serviceId: number;
        impedimentText?: string | null;
    };
}

export interface LuxmedEvent {
    date: string;
    dateTo?: string | null;
    eventType?: string | null;
    clinic?: { address?: string; city?: string; id?: number; name?: string } | null;
    doctor?: { name?: string; lastname?: string } | null;
    eventId: number;
    status: string;
    title: string;
}

export interface BookingReservationFact {
    reservationId: number;
    startAt: number;
    endAt: number;
    clinicId: number | null;
    telemedicine: boolean;
    clinicAddress: string | null;
    clinicCity: string | null;
}

export interface LuxmedCancellationReceipt {
    accountId: number;
    reservationId: number;
    startAt: number;
    state: 'pending' | 'confirmed' | 'verified_still_reserved' | 'verified_moved';
    confirmedAt?: number | null;
    reviewedAt?: number | null;
    reviewedBy?: string | null;
    reviewReason?: string | null;
    reviewAction?: string | null;
    movedStartAt?: number | null;
    movedEndAt?: number | null;
    movedClinicId?: number | null;
    movedTelemedicine?: boolean | null;
    movedClinicAddress?: string | null;
    movedClinicCity?: string | null;
    acknowledgedAt?: number | null;
}

export interface LuxmedMonitoring {
    recordId: number;
    cityId?: number;
    serviceId?: number;
    clinicId?: number | null;
    doctorId?: number | null;
    cityName: string;
    clinicName: string;
    serviceName: string;
    doctorName: string;
    dateFrom: string;
    dateTo: string;
    timeFrom: string;
    timeTo: string;
    autobook: boolean;
    active: boolean;
}

const accountBackoff = new Map<string,{until:number;failures:number}>();
async function sidecarRequest<T>(method: string, path: string, body?: unknown, guard?:()=>boolean): Promise<T> {
    const accountId=/\/accounts\/(\d+)\//.exec(path)?.[1];
    const run=async()=>{
        if(guard&&!guard())throw new LuxmedApiError('Availability changed before submission','BOOKING_GUARD_CHANGED');
        const backoff=accountId ? accountBackoff.get(accountId) : undefined;
        const upstream=!!accountId&&!path.includes('/booking-attempts/');
        if(upstream&&backoff&&backoff.until>Date.now()) {
            const error=new LuxmedApiError('LuxMed account is waiting before another request','ACCOUNT_BACKOFF',429);
            error.retryAfterMs=backoff.until-Date.now();throw error;
        }
        try {
            const result=await requestSidecar<T>(method,path,body);
            if(upstream)accountBackoff.delete(accountId!);
            return result;
        }catch(error) {
            if(upstream&&error instanceof LuxmedApiError) {
                const failures=(backoff?.failures||0)+1;
                const retry=error.retryAfterMs ?? (error.status===429||failures>=2 ? Math.min(600000,30000*2**Math.min(failures-1,5)) : 0);
                accountBackoff.set(accountId!,{until:Date.now()+retry,failures});
            }
            throw error;
        }
    };
    return accountId ? luxmedAccountQueue.run(Number(accountId),path.endsWith('/book')||path.endsWith('/booking-attempts')?10:path.includes('visits/reserved')?5:0,run) : run();
}
async function requestSidecar<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${SIDECAR_URL}${path}`;
    const start = Date.now();
    console.log(`[LuxMed API] ${method} ${path}`);

    const options: RequestInit = {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(SIDECAR_SECRET ? { 'X-LuxMed-Secret': SIDECAR_SECRET } : {}),
        },
        signal: AbortSignal.timeout(35000),
    };
    if (body) {
        options.body = JSON.stringify(body);
    }

    let response: Response;
    try {
        response = await fetch(url, options);
    } catch (err) {
        const elapsed = Date.now() - start;
        if (err instanceof Error && err.name === 'TimeoutError') {
            console.error(`[LuxMed API] ${method} ${path} TIMEOUT after ${elapsed}ms`);
            throw new LuxmedApiError('LuxMed service timeout — try again later', 'SIDECAR_TIMEOUT');
        }
        console.error(`[LuxMed API] ${method} ${path} CONNECT FAILED after ${elapsed}ms`);
        throw new LuxmedApiError('LuxMed service unavailable — is the sidecar running?', 'SIDECAR_UNAVAILABLE');
    }

    let result: ApiResponse<T>;
    try {
        result = await response.json() as ApiResponse<T>;
    } catch {
        const elapsed = Date.now() - start;
        console.error(`[LuxMed API] ${method} ${path} ${response.status} non-JSON (${elapsed}ms)`);
        const error=new LuxmedApiError(`LuxMed API error (${response.status}): non-JSON response`, 'SIDECAR_INVALID_RESPONSE', response.status);
        const retry=response.headers.get('Retry-After');
        if(retry)error.retryAfterMs=/^\d+$/.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now());
        throw error;
    }

    const elapsed = Date.now() - start;
    if (!response.ok || !result.success) {
        const error = typeof result.error === 'string' ? result.error : result.error?.message;
        const normalizedError = (error || '').toLocaleLowerCase('pl-PL');
        const responseCode = typeof result.error === 'object' ? result.error?.code : undefined;
        const code = responseCode || (/klient.*(nieaktual|nieobsług)|client.*(outdated|unsupported)/.test(normalizedError)
            ? 'CLIENT_OUTDATED'
            : undefined);
        console.error(`[LuxMed API] ${method} ${path} FAILED (${elapsed}ms): ${error}`);
        const apiError = new LuxmedApiError(error || `LuxMed API error (${response.status})`, code || 'LUXMED_API_ERROR', response.status);
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) apiError.retryAfterMs = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
        throw apiError;
    }

    console.log(`[LuxMed API] ${method} ${path} OK (${elapsed}ms)`);
    return result.data as T;
}

// === Authentication ===

export async function luxmedLogin(username: string, password: string, chatId: string): Promise<LoginResult> {
    return sidecarRequest<LoginResult>('POST', '/api/v1/login', { username, password, chatId });
}

// === Dictionaries ===

export async function luxmedGetCities(accountId: number): Promise<LuxmedCity[]> {
    return sidecarRequest<LuxmedCity[]>('GET', `/api/v1/accounts/${accountId}/cities`);
}

export async function luxmedGetServices(accountId: number): Promise<LuxmedService[]> {
    return sidecarRequest<LuxmedService[]>('GET', `/api/v1/accounts/${accountId}/services`);
}

export async function luxmedGetFacilities(accountId: number, cityId: number, serviceId: number): Promise<LuxmedFacility[]> {
    return sidecarRequest<LuxmedFacility[]>('GET', `/api/v1/accounts/${accountId}/facilities?cityId=${cityId}&serviceId=${serviceId}`);
}

export async function luxmedGetDoctors(accountId: number, cityId: number, serviceId: number): Promise<LuxmedDoctor[]> {
    return sidecarRequest<LuxmedDoctor[]>('GET', `/api/v1/accounts/${accountId}/doctors?cityId=${cityId}&serviceId=${serviceId}`);
}

// === Search & Book ===

export async function luxmedSearchSlots(accountId: number, params: {
    cityId: number;
    serviceId: number;
    clinicId?: number;
    doctorId?: number;
    dateFrom: string;
    dateTo: string;
    timeFrom: string;
    timeTo: string;
}): Promise<LuxmedTerm[]> {
    const normalizedParams = {
        ...params,
        dateFrom: normalizeSearchDate(params.dateFrom),
        dateTo: normalizeSearchDate(params.dateTo),
    };
    const from = parseSearchDate(normalizedParams.dateFrom);
    const to = parseSearchDate(normalizedParams.dateTo);
    if (!from || !to || to <= from || to - from <= SEARCH_WINDOW_MS) {
        return sidecarRequest<LuxmedTerm[]>('POST', `/api/v1/accounts/${accountId}/terms/search`, normalizedParams);
    }

    const results: LuxmedTerm[] = [];
    let cursor = from;
    while (cursor < to) {
        const windowEnd = Math.min(to, cursor + SEARCH_WINDOW_MS);
        const windowParams = {
            ...normalizedParams,
            dateFrom: formatSearchDate(cursor),
            dateTo: formatSearchDate(windowEnd),
        };
        const windowTerms = await sidecarRequest<LuxmedTerm[]>('POST', `/api/v1/accounts/${accountId}/terms/search`, windowParams);
        results.push(...windowTerms);
        cursor = windowEnd + 1000;
    }
    const unique = new Map<string, LuxmedTerm>();
    for (const term of results) {
        const t = term.term;
        const key = `${t.scheduleId}:${t.dateTimeFrom.dateTimeLocal || t.dateTimeFrom.dateTimeTz || ''}`;
        unique.set(key, term);
    }
    return [...unique.values()].sort((a, b) => termTimestamp(a) - termTimestamp(b));
}

const SEARCH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function parseSearchDate(value: string): number | null {
    // The sidecar accepts Warsaw wall-clock LocalDateTime values. Normalize
    // explicit offsets to that same wall clock before chunking a long search.
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
        const instant = Date.parse(value);
        if (Number.isNaN(instant)) return null;
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/Warsaw', hour12: false, hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(new Date(instant));
        const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
        return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
    if (!match) return null;
    return Date.UTC(
        Number(match[1]), Number(match[2]) - 1, Number(match[3]),
        Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0),
    );
}

function formatSearchDate(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 19);
}

function normalizeSearchDate(value: string): string {
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return value;
    const parsed = parseSearchDate(value);
    return parsed == null ? value : formatSearchDate(parsed);
}

function termTimestamp(term: LuxmedTerm): number {
    return parseSearchDate(term.term.dateTimeFrom.dateTimeLocal || term.term.dateTimeFrom.dateTimeTz || '') || Number.MAX_SAFE_INTEGER;
}

export async function luxmedBookSlot(accountId: number, term: LuxmedTerm, cityId: number, rebookIfExists: boolean = false,
    attemptId?: string, guard?:()=>boolean, baselineReservationIds?: number[], baselineReservations?: BookingReservationFact[]): Promise<unknown> {
    const t = term.term;
    const dateTimeFrom = t.dateTimeFrom.dateTimeLocal || t.dateTimeFrom.dateTimeTz || '';
    const dateTimeTo = t.dateTimeTo.dateTimeLocal || t.dateTimeTo.dateTimeTz || '';
    return sidecarRequest('POST', `/api/v1/accounts/${accountId}/${attemptId ? 'booking-attempts' : 'book'}`, {
        cityId,
        clinicId: t.clinicId,
        clinicGroupId: t.clinicGroupId,
        clinic: t.clinic || '',
        doctorId: t.doctor.id,
        doctorFirstName: t.doctor.firstName || '',
        doctorLastName: t.doctor.lastName || '',
        doctorAcademicTitle: t.doctor.academicTitle || '',
        roomId: t.roomId,
        scheduleId: t.scheduleId,
        serviceId: t.serviceId,
        dateTimeFrom,
        dateTimeTo,
        isTelemedicine: t.isTelemedicine,
        isAdditional: t.isAdditional,
        isImpediment: t.isImpediment,
        impedimentText: t.impedimentText || '',
        isPreparationRequired: term.additionalData.isPreparationRequired,
        preparationItems: term.additionalData.preparationItems,
        rebookIfExists,
        ...(attemptId ? { attemptId } : {}),
        ...(attemptId && baselineReservationIds ? { baselineReservationIds } : {}),
        ...(attemptId && baselineReservations ? { baselineReservations } : {}),
    },guard);
}

export interface BookingOutcome { state: 'pending' | 'unknown' | 'succeeded' | 'failed' | 'blocked' | 'not_found'; reservationId?: number; errorCode?: string; }
export function luxmedCapabilities(): Promise<string[]> { return sidecarRequest('GET', '/api/v1/capabilities'); }
export function luxmedBookingAttempt(accountId: number, attemptId: string): Promise<BookingOutcome> {
    return sidecarRequest('GET', `/api/v1/accounts/${accountId}/booking-attempts/${encodeURIComponent(attemptId)}`);
}
export async function luxmedAcknowledgeBookingAttempt(accountId: number, attemptId: string, reservationId: number): Promise<void> {
    await sidecarRequest('POST', `/api/v1/accounts/${accountId}/booking-attempts/${encodeURIComponent(attemptId)}/acknowledge`, { reservationId });
}
export interface LegacyBookingBarrier { id?: string; state: 'clear' | 'pending' | 'succeeded'; reservationId?: number; start?: number; }
export function luxmedLegacyBookingBarrier(accountId: number): Promise<LegacyBookingBarrier> {
    return sidecarRequest('GET', `/api/v1/accounts/${accountId}/legacy-booking-barrier`);
}
export async function luxmedAcknowledgeLegacyBooking(accountId: number, reservationId: number, id?: string, expectedStartAt?: number): Promise<void> {
    await sidecarRequest('POST', `/api/v1/accounts/${accountId}/legacy-booking-barrier/acknowledge`,
        id ? { id, reservationId, expectedStartAt } : { reservationId });
}
export function luxmedSmartEnrollment(accountId: number): Promise<{ enrolled: boolean }> {
    return sidecarRequest('GET', `/api/v1/accounts/${accountId}/smart-booking-enrollment`);
}
export async function luxmedEnrollSmartAccount(accountId: number, expectedAutoMonitorIds: number[]): Promise<void> {
    const expected = [...expectedAutoMonitorIds].sort((a, b) => a - b);
    const result = await sidecarRequest<{ enrolled: boolean; stoppedAutoMonitorIds: number[] }>('POST',
        `/api/v1/accounts/${accountId}/smart-booking-enrollment`, { expectedAutoMonitorIds: expected });
    const stopped = result?.stoppedAutoMonitorIds;
    if (result?.enrolled !== true || !Array.isArray(stopped) || stopped.length !== expected.length
        || [...stopped].sort((a, b) => a - b).some((id, index) => id !== expected[index])) {
        throw new LuxmedApiError('Sidecar did not confirm the exact automatic monitors stopped during enrollment.', 'SMART_ENROLLMENT_UNCONFIRMED');
    }
}

// === Visits ===

export async function luxmedGetReserved(accountId: number, coverage?: { from: number; to: number }): Promise<LuxmedEvent[]> {
    if (!coverage) return sidecarRequest<LuxmedEvent[]>('GET', `/api/v1/accounts/${accountId}/visits/reserved`);
    const from = encodeURIComponent(new Date(coverage.from).toISOString());
    const to = encodeURIComponent(new Date(coverage.to).toISOString());
    return sidecarRequest<LuxmedEvent[]>('GET', `/api/v1/accounts/${accountId}/visits/reserved/verified?from=${from}&to=${to}`);
}

export async function luxmedGetHistory(accountId: number): Promise<LuxmedEvent[]> {
    return sidecarRequest<LuxmedEvent[]>('GET', `/api/v1/accounts/${accountId}/visits/history`);
}

export async function luxmedCancelVisit(accountId: number, reservationId: number, expectedStartAt: number): Promise<void> {
    if (!Number.isSafeInteger(expectedStartAt) || expectedStartAt <= 0) throw new Error('Invalid expected reservation start.');
    await sidecarRequest('DELETE', `/api/v1/accounts/${accountId}/visits/${reservationId}?expectedStartAt=${expectedStartAt}`);
}

export async function luxmedCancellationReceipts(accountId: number): Promise<LuxmedCancellationReceipt[]> {
    return sidecarRequest<LuxmedCancellationReceipt[]>('GET', `/api/v1/accounts/${accountId}/visits/cancellation-receipts`);
}

export async function luxmedAcknowledgeMovedVisit(accountId: number, reservationId: number,
    expectedStartAt: number, expectedMovedStartAt: number): Promise<void> {
    await sidecarRequest('POST', `/api/v1/accounts/${accountId}/visits/cancellation-receipts/${reservationId}/acknowledge-move`,
        { expectedStartAt, expectedMovedStartAt });
}

// === Monitoring ===

export async function luxmedCreateMonitoring(accountId: number, params: {
    chatId: string;
    payerId: number;
    cityId: number;
    cityName: string;
    serviceId: number;
    serviceName: string;
    clinicId?: number;
    clinicName?: string;
    doctorId?: number;
    doctorName?: string;
    dateFrom: string;
    dateTo: string;
    timeFrom: string;
    timeTo: string;
    autobook?: boolean;
    rebookIfExists?: boolean;
    offset?: number;
}): Promise<LuxmedMonitoring> {
    return sidecarRequest<LuxmedMonitoring>('POST', `/api/v1/accounts/${accountId}/monitorings`, params);
}

export async function luxmedGetMonitorings(accountId: number): Promise<LuxmedMonitoring[]> {
    return sidecarRequest<LuxmedMonitoring[]>('GET', `/api/v1/accounts/${accountId}/monitorings`);
}

export async function luxmedDeactivateMonitoring(accountId: number, monitoringId: number): Promise<void> {
    await sidecarRequest('DELETE', `/api/v1/accounts/${accountId}/monitorings/${monitoringId}`);
}

export async function luxmedQuiesceMonitoring(accountId: number, monitoringId: number): Promise<void> {
    await sidecarRequest('POST', `/api/v1/accounts/${accountId}/monitorings/${monitoringId}/quiesce`);
}

// === Health ===

export async function luxmedHealthCheck(): Promise<boolean> {
    try {
        await sidecarRequest<string>('GET', '/api/v1/health');
        return true;
    } catch {
        return false;
    }
}
