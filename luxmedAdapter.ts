/**
 * HTTP client for the luxmed-bot JVM sidecar REST API.
 * All LuxMed portal operations go through this adapter.
 */

const SIDECAR_URL = process.env.LUXMED_SIDECAR_URL || 'http://localhost:8080';

interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
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
    firstName: string;
    lastName: string;
    academicTitle: string;
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
        clinic: string;
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
        impedimentText: string;
    };
}

export interface LuxmedEvent {
    date: string;
    doctor: LuxmedDoctor;
    facilityName: string;
    status: string;
    serviceVariantName: string;
    reservationId?: number;
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
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30000),
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
            throw new Error('LuxMed service timeout — try again later');
        }
        console.error(`[LuxMed API] ${method} ${path} CONNECT FAILED after ${elapsed}ms`);
        throw new Error('LuxMed service unavailable — is the sidecar running?');
    }

    let result: ApiResponse<T>;
    try {
        result = await response.json() as ApiResponse<T>;
    } catch {
        const elapsed = Date.now() - start;
        console.error(`[LuxMed API] ${method} ${path} ${response.status} non-JSON (${elapsed}ms)`);
        throw new Error(`LuxMed API error (${response.status}): non-JSON response`);
    }

    const elapsed = Date.now() - start;
    if (!result.success) {
        console.error(`[LuxMed API] ${method} ${path} FAILED (${elapsed}ms): ${result.error}`);
        throw new Error(result.error || `LuxMed API error (${response.status})`);
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
    return sidecarRequest<LuxmedTerm[]>('POST', `/api/v1/accounts/${accountId}/terms/search`, params);
}

export async function luxmedBookSlot(accountId: number, term: LuxmedTerm, cityId: number, rebookIfExists: boolean = false): Promise<unknown> {
    const t = term.term;
    const dateTimeFrom = t.dateTimeFrom.dateTimeLocal || t.dateTimeFrom.dateTimeTz || '';
    const dateTimeTo = t.dateTimeTo.dateTimeLocal || t.dateTimeTo.dateTimeTz || '';
    return sidecarRequest('POST', `/api/v1/accounts/${accountId}/book`, {
        cityId,
        clinicId: t.clinicId,
        clinicGroupId: t.clinicGroupId,
        clinic: t.clinic,
        doctorId: t.doctor.id,
        doctorFirstName: t.doctor.firstName,
        doctorLastName: t.doctor.lastName,
        doctorAcademicTitle: t.doctor.academicTitle,
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
