/**
 * HTTP client for the luxmed-bot JVM sidecar REST API.
 * All LuxMed portal operations go through this adapter.
 */

const SIDECAR_URL = process.env.LUXMED_SIDECAR_URL || 'http://localhost:8080';
const SIDECAR_SECRET = process.env.LUXMED_SIDECAR_SECRET || '';

interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: string | { code?: string; message?: string };
}

export class LuxmedApiError extends Error {
    readonly code: string;
    readonly status?: number;

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
        roomId: number;
        scheduleId: number;
        serviceId: number;
        impedimentText?: string | null;
    };
}

export interface LuxmedEvent {
    date: string;
    clinic?: { address?: string; city?: string } | null;
    doctor?: { name?: string; lastname?: string } | null;
    eventId: number;
    status: string;
    title: string;
}

export interface LuxmedMonitoring {
    recordId: number;
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

async function sidecarRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
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
        throw new LuxmedApiError(`LuxMed API error (${response.status}): non-JSON response`, 'SIDECAR_INVALID_RESPONSE', response.status);
    }

    const elapsed = Date.now() - start;
    if (!result.success) {
        const error = typeof result.error === 'string' ? result.error : result.error?.message;
        const normalizedError = (error || '').toLocaleLowerCase('pl-PL');
        const responseCode = typeof result.error === 'object' ? result.error?.code : undefined;
        const code = responseCode || (/klient.*(nieaktual|nieobsług)|client.*(outdated|unsupported)/.test(normalizedError)
            ? 'CLIENT_OUTDATED'
            : undefined);
        console.error(`[LuxMed API] ${method} ${path} FAILED (${elapsed}ms): ${error}`);
        throw new LuxmedApiError(error || `LuxMed API error (${response.status})`, code || 'LUXMED_API_ERROR', response.status);
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
    const from = parseSearchDate(params.dateFrom);
    const to = parseSearchDate(params.dateTo);
    if (!from || !to || to <= from || to - from <= SEARCH_WINDOW_MS) {
        return sidecarRequest<LuxmedTerm[]>('POST', `/api/v1/accounts/${accountId}/terms/search`, params);
    }

    const results: LuxmedTerm[] = [];
    let cursor = from;
    while (cursor < to) {
        const windowEnd = Math.min(to, cursor + SEARCH_WINDOW_MS);
        const windowParams = {
            ...params,
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

function termTimestamp(term: LuxmedTerm): number {
    return parseSearchDate(term.term.dateTimeFrom.dateTimeLocal || term.term.dateTimeFrom.dateTimeTz || '') || Number.MAX_SAFE_INTEGER;
}

export async function luxmedBookSlot(accountId: number, term: LuxmedTerm, cityId: number, rebookIfExists: boolean = false): Promise<unknown> {
    const t = term.term;
    const dateTimeFrom = t.dateTimeFrom.dateTimeLocal || t.dateTimeFrom.dateTimeTz || '';
    const dateTimeTo = t.dateTimeTo.dateTimeLocal || t.dateTimeTo.dateTimeTz || '';
    return sidecarRequest('POST', `/api/v1/accounts/${accountId}/book`, {
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
        isPreparationRequired: term.additionalData.isPreparationRequired,
        rebookIfExists,
    });
}

// === Visits ===

export async function luxmedGetReserved(accountId: number): Promise<LuxmedEvent[]> {
    return sidecarRequest<LuxmedEvent[]>('GET', `/api/v1/accounts/${accountId}/visits/reserved`);
}

export async function luxmedGetHistory(accountId: number): Promise<LuxmedEvent[]> {
    return sidecarRequest<LuxmedEvent[]>('GET', `/api/v1/accounts/${accountId}/visits/history`);
}

export async function luxmedCancelVisit(accountId: number, reservationId: number): Promise<void> {
    await sidecarRequest('DELETE', `/api/v1/accounts/${accountId}/visits/${reservationId}`);
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

// === Health ===

export async function luxmedHealthCheck(): Promise<boolean> {
    try {
        await sidecarRequest<string>('GET', '/api/v1/health');
        return true;
    } catch {
        return false;
    }
}
