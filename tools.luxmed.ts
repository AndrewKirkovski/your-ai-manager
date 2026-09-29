import { Tool } from './tool.types';
import { smartStore } from './luxmedSmartStore';
import { smartBooking } from './luxmedSmartBooking';
import { validBookingTimeRange, zonedTime } from './luxmedAvailability';
import { textify } from './telegramFormat';
import { uniqueCityName, uniqueServiceName } from './luxmedProviderIdentity';
import {
    luxmedLogin, luxmedGetCities, luxmedGetServices,
    luxmedSearchSlots, luxmedCancelVisit, luxmedCancellationReceipts, luxmedGetReserved, luxmedCapabilities,
    LuxmedTerm, LuxmedMonitoring, LuxmedApiError, luxmedGetMonitorings, luxmedQuiesceMonitoring,
} from './luxmedAdapter';
import { geocode, getDistanceMatrix, isGoogleMapsConfigured } from './googleMapsService';
import {
    getLuxmedAccountId, saveLuxmedAccount, getLuxmedPreferences, saveLuxmedPreferences,
    LuxmedPreferences, generateShortId,
    createLuxmedMonitoring, getActiveLuxmedMonitoringsByUser, deactivateLuxmedMonitoring,
    getUserAddress, saveUserAddress, getLuxmedClinicByName, saveLuxmedClinic,
} from './userStore';

async function validateServiceId(accountId: number, serviceId: number): Promise<string | null> {
    try {
        return uniqueServiceName(await luxmedGetServices(accountId), serviceId) ? null
            : `Service ID ${serviceId} is missing or ambiguous in LuxMed. Use LuxmedListServices to choose the correct ID.`;
    } catch {
        return 'Could not verify the LuxMed service. Try again when the provider dictionary is available.';
    }
}

function requireAccount(userId: number): number {
    const accountId = getLuxmedAccountId(userId);
    if (!accountId) {
        throw new Error('LuxMed account not configured. Ask the user to provide their LuxMed login and password first.');
    }
    return accountId;
}

export function parseMonitorIds(value: unknown, field: string): number[] | null {
    if (value == null) return null;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a comma-separated list of positive IDs.`);
    const parts = value.split(',').map(part => part.trim());
    if (parts.some(part => !/^\d+$/.test(part) || !Number.isSafeInteger(Number(part)) || Number(part) <= 0))
        throw new Error(`${field} must be a comma-separated list of positive IDs.`);
    return [...new Set(parts.map(Number))];
}

export function parseMonitorBoolean(value: unknown, field: string, fallback: boolean): boolean {
    if (value == null) return fallback;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`${field} must be "true" or "false".`);
}

function formatTerm(term: LuxmedTerm, index: number): string {
    const t = term.term;
    const dt = t.dateTimeFrom.dateTimeLocal || t.dateTimeFrom.dateTimeTz || '?';
    const doctor = [t.doctor.academicTitle, t.doctor.firstName, t.doctor.lastName].filter(Boolean).join(' ') || 'Unknown doctor';
    const tele = t.isTelemedicine ? ' (teleconsultation)' : '';
    return `${index + 1}. ${dt} — ${doctor}, ${t.clinic || 'Unknown clinic'}${tele}`;
}

// Store last search results per user for booking by index
const lastSearchResults = new Map<number, {
    accountId: number;
    terms: LuxmedTerm[];
    cityId: number;
    expiresAt: number;
    context: string;
}>();

function searchContext(args: { cityId: number; serviceId: number; clinicId?: number; doctorId?: number; dateFrom: string; dateTo: string; timeFrom: string; timeTo: string; maxTransitMinutes?: number }): string {
    return JSON.stringify({
        cityId: args.cityId,
        serviceId: args.serviceId,
        clinicId: args.clinicId ?? null,
        doctorId: args.doctorId ?? null,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
        timeFrom: args.timeFrom,
        timeTo: args.timeTo,
        maxTransitMinutes: args.maxTransitMinutes ?? null,
    });
}

export async function settleLuxmedAccountTransitions(userId: number, sidecar: {
    list: (accountId: number) => Promise<LuxmedMonitoring[]>;
    quiesce: (accountId: number, monitorId: number) => Promise<void>;
} = { list: luxmedGetMonitorings, quiesce: luxmedQuiesceMonitoring }): Promise<string[]> {
    const failures: string[] = [];
    for (const transition of smartStore.accountTransitions(userId)) {
        try {
            const oldMonitors = await sidecar.list(transition.oldAccountId);
            for (const monitor of oldMonitors.filter(m => m.active)) {
                await sidecar.quiesce(transition.oldAccountId, monitor.recordId);
            }
            const remaining = (await sidecar.list(transition.oldAccountId)).filter(m => m.active);
            if (remaining.length) throw new Error(`${remaining.length} old monitor(s) remain active`);
            smartStore.clearAccountTransition(userId, transition.oldAccountId);
        } catch (error) {
            const status = error instanceof LuxmedApiError ? error.code
                : error instanceof Error && /old monitor\(s\) remain active/.test(error.message) ? error.message
                    : 'SIDECAR_CLEANUP_FAILED';
            smartStore.failAccountTransition(userId, transition.oldAccountId, status);
            failures.push(`account ${transition.oldAccountId}: ${status}`);
        }
    }
    return failures;
}

export const LuxmedLogin: Tool = {
    name: 'LuxmedLogin',
    description: 'Store LuxMed portal credentials. Call this when user provides their LuxMed email and password. Tests the login and saves credentials for future use.',
    parameters: {
        type: 'object',
        properties: {
            username: { type: 'string', description: 'LuxMed portal email/login' },
            password: { type: 'string', description: 'LuxMed portal password' },
        },
        required: ['username', 'password'],
    },
    execute: async (args: { userId: number; username: string; password: string }) => {
        const chatId = String(args.userId);
        const previousAccountId = getLuxmedAccountId(args.userId);
        console.log(`[LuxMed] Login attempt for user ${args.userId} (${args.username})`);
        const result = await luxmedLogin(args.username, args.password, chatId);
        saveLuxmedAccount(args.userId, result.accountId, result.username);
        lastSearchResults.delete(args.userId);
        const cleanupFailures = await settleLuxmedAccountTransitions(args.userId);
        console.log(`[LuxMed] Login success: userId=${result.userId}, accountId=${result.accountId}`);
        const switched = previousAccountId !== null && previousAccountId !== result.accountId;
        if (cleanupFailures.length) {
            return { success: false, accountLinked: true, smartBookingSafe: false,
                message: `LuxMed account linked, but old sidecar monitors could not be confirmed stopped (${cleanupFailures.join('; ')}). New smart booking is blocked. An old monitor may still book; retry LuxmedLogin after fixing the sidecar or stop those monitors manually.` };
        }
        return { success: true, message: `LuxMed login successful. Account linked (${result.username}).${switched ? ' Monitors for the previous account were stopped. Create and confirm new monitors for this account.' : ''}` };
    },
};

export const LuxmedSearchSlots: Tool = {
    name: 'LuxmedSearchSlots',
    description: 'Search available LuxMed appointments. Returns available slots filtered by service, city, time, doctor, and facility. Use city/service IDs from dictionaries, or provide names and the system will match them.',
    parameters: {
        type: 'object',
        properties: {
            service_id: { type: 'number', description: 'Service ID (from LuxmedListServices)' },
            city_id: { type: 'number', description: 'City ID (from LuxmedListCities). Omit to use default from preferences.' },
            clinic_id: { type: 'number', description: 'Facility/clinic ID to filter by. Omit for all clinics.' },
            doctor_id: { type: 'number', description: 'Doctor ID to filter by. Omit for any doctor.' },
            date_from: { type: 'string', description: 'Start date ISO (e.g. "2026-04-10T00:00:00"). Defaults to now.' },
            date_to: { type: 'string', description: 'End date ISO (e.g. "2026-04-20T00:00:00"). Defaults to 14 days from now.' },
            time_from: { type: 'string', description: 'Earliest appointment time (e.g. "10:00"). Defaults to "07:00".' },
            time_to: { type: 'string', description: 'Latest appointment time (e.g. "14:00"). Defaults to "21:00".' },
            max_transit_minutes: { type: 'number', description: 'Max transit time from home in minutes (e.g. 20). Requires home location in preferences and Google Maps API key. Filters out clinics that are too far.' },
        },
        required: ['service_id'],
    },
    execute: async (args: { userId: number; service_id: number; city_id?: number; clinic_id?: number; doctor_id?: number; date_from?: string; date_to?: string; time_from?: string; time_to?: string; max_transit_minutes?: number }) => {
        const accountId = requireAccount(args.userId);
        const prefs = getLuxmedPreferences(args.userId);
        const cityId = args.city_id || prefs.defaultCityId;
        if (!cityId) {
            return { success: false, message: 'City not specified and no default city in preferences. Use LuxmedListCities to find the city ID, or set a default with LuxmedSetPreferences.' };
        }

        const validationError = await validateServiceId(accountId, args.service_id);
        if (validationError) {
            return { success: false, message: validationError };
        }

        const now = new Date();
        const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
        const dateFrom = args.date_from || formatLocalDateTime(now);
        const dateTo = args.date_to || formatLocalDateTime(twoWeeks);
        const timeFrom = args.time_from || prefs.preferredTimeFrom || '07:00';
        const timeTo = args.time_to || prefs.preferredTimeTo || '21:00';
        const maxTransitMinutes = args.max_transit_minutes ?? prefs.maxTransitMinutes;
        if (maxTransitMinutes != null && (!Number.isFinite(maxTransitMinutes) || maxTransitMinutes < 0)) {
            return { success: false, message: 'max_transit_minutes must be a finite non-negative number.' };
        }
        console.log(`[LuxMed] Search: service=${args.service_id}, city=${cityId}, time=${args.time_from || '07:00'}-${args.time_to || '21:00'}`);
        const terms = await luxmedSearchSlots(accountId, {
            cityId,
            serviceId: args.service_id,
            clinicId: args.clinic_id,
            doctorId: args.doctor_id,
            dateFrom,
            dateTo,
            timeFrom,
            timeTo,
        });

        console.log(`[LuxMed] Search returned ${terms.length} slots`);

        // Transit time filtering
        let filteredTerms = terms;
        const transitTimes = new Map<string, number>(); // clinic address → minutes
        if (maxTransitMinutes != null && terms.length > 0) {
            if (!isGoogleMapsConfigured()) {
                return { success: false, message: 'Transit filtering requires GOOGLE_MAPS_API_KEY. Set it in .env.' };
            }
            const home = getUserAddress(args.userId, 'home') || (
                prefs.homeLat != null && prefs.homeLng != null
                    ? { label: 'home', address: 'Saved LuxMed home coordinates', lat: prefs.homeLat, lng: prefs.homeLng }
                    : null
            );
            if (!home) {
                return { success: false, message: 'Transit filtering requires home location. Use SaveAddress or LuxmedSetPreferences to save it first.' };
            }

            // Get unique clinic addresses — check persistent cache first, then geocode
            // Telemedicine appointments do not require a route to a clinic.
            // Keep them in the result even when no physical clinic can be
            // geocoded.
            const uniqueClinics = [...new Set(
                terms.filter(t => !t.term.isTelemedicine).map(t => t.term.clinic || 'Unknown clinic')
            )];
            console.log(`[LuxMed] Transit filter: resolving ${uniqueClinics.length} unique clinics`);

            const clinicCoords: { clinic: string; lat: number; lng: number }[] = [];
            const unresolvedClinics: string[] = [];
            let cityName = prefs.defaultCityName || 'Warszawa';
            if (args.city_id && args.city_id !== prefs.defaultCityId) {
                try {
                    const cities = await luxmedGetCities(accountId);
                    cityName = cities.find(city => city.id === cityId)?.name || cityName;
                } catch {
                    console.warn(`[LuxMed] Could not resolve city name for city ${cityId}; using ${cityName}`);
                }
            }
            for (const clinicName of uniqueClinics) {
                // Check luxmed_clinics cache first
                const cached = getLuxmedClinicByName(clinicName, cityId);
                if (cached) {
                    clinicCoords.push({ clinic: clinicName, lat: cached.lat, lng: cached.lng });
                    continue;
                }
                // Geocode and cache permanently
                const place = await geocode(`${clinicName}, ${cityName}`);
                if (place) {
                    clinicCoords.push({ clinic: clinicName, lat: place.lat, lng: place.lng });
                    saveLuxmedClinic(clinicName, place.formattedAddress, place.lat, place.lng, cityId);
                } else {
                    unresolvedClinics.push(clinicName);
                }
            }

            if (clinicCoords.length > 0) {
                const maxSeconds = maxTransitMinutes * 60;
                const allowedTermKeys = new Set<string>();
                const termsByArrival = new Map<string, Set<string>>();
                for (const term of terms) {
                    if (term.term.isTelemedicine) continue;
                    const clinic = term.term.clinic || 'Unknown clinic';
                    const rawDate = term.term.dateTimeFrom.dateTimeLocal || term.term.dateTimeFrom.dateTimeTz;
                    const parsedDate = rawDate ? new Date(rawDate) : null;
                    const arrivalKey = parsedDate && !Number.isNaN(parsedDate.getTime()) ? String(parsedDate.getTime()) : 'unknown';
                    const clinics = termsByArrival.get(arrivalKey) || new Set<string>();
                    clinics.add(clinic);
                    termsByArrival.set(arrivalKey, clinics);
                }
                for (const [arrivalKey, clinics] of termsByArrival) {
                    const groupClinics = clinicCoords.filter(c => clinics.has(c.clinic));
                    const arrivalTime = arrivalKey === 'unknown' ? undefined : new Date(Number(arrivalKey));
                    const distances = await getDistanceMatrix(
                        { lat: home.lat, lng: home.lng },
                        groupClinics.map(c => ({ lat: c.lat, lng: c.lng })),
                        'transit',
                        arrivalTime ? { arrivalTime } : undefined,
                    );
                    for (const d of distances) {
                        const clinic = groupClinics[d.destinationIndex];
                        if (!clinic) continue;
                        const minutes = Math.ceil(d.durationSeconds / 60);
                        transitTimes.set(clinic.clinic, Math.min(transitTimes.get(clinic.clinic) ?? Number.POSITIVE_INFINITY, minutes));
                        if (d.status === 'OK' && d.durationSeconds <= maxSeconds) {
                            allowedTermKeys.add(`${arrivalKey}:${clinic.clinic}`);
                        }
                    }
                }

                filteredTerms = terms.filter(t => {
                    if (t.term.isTelemedicine) return true;
                    const rawDate = t.term.dateTimeFrom.dateTimeLocal || t.term.dateTimeFrom.dateTimeTz;
                    const parsedDate = rawDate ? new Date(rawDate) : null;
                    const arrivalKey = parsedDate && !Number.isNaN(parsedDate.getTime()) ? String(parsedDate.getTime()) : 'unknown';
                    return allowedTermKeys.has(`${arrivalKey}:${t.term.clinic || 'Unknown clinic'}`);
                });
                console.log(`[LuxMed] Transit filter: ${filteredTerms.length}/${terms.length} within ${maxTransitMinutes} min`);
            } else if (terms.some(t => t.term.isTelemedicine)) {
                filteredTerms = terms.filter(t => t.term.isTelemedicine);
            } else {
                return { success: false, message: 'Transit filtering could not resolve any clinic addresses. Search without the transit filter or check the clinic names.' };
            }
            if (unresolvedClinics.length > 0) {
                console.warn(`[LuxMed] Transit filter skipped unresolved clinics: ${unresolvedClinics.join(', ')}`);
            }
        }

        const context = searchContext({ cityId, serviceId: args.service_id, clinicId: args.clinic_id, doctorId: args.doctor_id, dateFrom, dateTo, timeFrom, timeTo, maxTransitMinutes });
        if (getLuxmedAccountId(args.userId) !== accountId) {
            return { success: false, message: 'LuxMed account changed during search. Search again.' };
        }
        lastSearchResults.set(args.userId, { accountId, terms: filteredTerms, cityId, context, expiresAt: Date.now() + 5 * 60 * 1000 });

        if (filteredTerms.length === 0) {
            const transitNote = maxTransitMinutes != null ? ` within ${maxTransitMinutes} min transit` : '';
            return { success: true, message: `No available slots found${transitNote}.`, slots: [] };
        }

        const summary = filteredTerms.slice(0, 10).map((t, i) => {
            const base = formatTerm(t, i);
            const tt = transitTimes.get(t.term.clinic || 'Unknown clinic');
            return tt != null ? `${base} [${tt} min]` : base;
        }).join('\n');

        return {
            success: true,
            message: `Found ${filteredTerms.length} available slot(s):\n${summary}${filteredTerms.length > 10 ? `\n... and ${filteredTerms.length - 10} more` : ''}`,
            totalSlots: filteredTerms.length,
            slots: filteredTerms.slice(0, 10).map(t => ({
                dateTime: t.term.dateTimeFrom.dateTimeLocal || t.term.dateTimeFrom.dateTimeTz,
                doctor: [t.term.doctor.academicTitle, t.term.doctor.firstName, t.term.doctor.lastName].filter(Boolean).join(' ') || 'Unknown doctor',
                clinic: t.term.clinic || 'Unknown clinic',
                isTelemedicine: t.term.isTelemedicine,
                transitMinutes: transitTimes.get(t.term.clinic || 'Unknown clinic'),
            })),
        };
    },
};

function formatLocalDateTime(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export const LuxmedBookSlot: Tool = {
    name: 'LuxmedBookSlot',
    description: 'Book a specific LuxMed appointment slot after confirming availability. Use the slot index from the last search results (1-based).',
    parameters: {
        type: 'object',
        properties: {
            slot_index: { type: 'number', description: 'Slot number from the last search results (1-based, e.g. 1 for first slot)' },
            rebook_if_exists: { type: 'string', description: 'If "true", replace existing booking for the same service with this one.' },
        },
        required: ['slot_index'],
    },
    execute: async (args: { userId: number; slot_index: number; rebook_if_exists?: string }) => {
        const accountId = requireAccount(args.userId);
        const policy = smartStore.policy(args.userId);
        if (!policy || policy.state !== 'confirmed' || policy.holdToken) {
            return { success: false, message: 'Confirm your LuxMed availability and travel rules before booking a slot. Use LuxmedDraftAvailability and LuxmedPreviewAvailability first.' };
        }
        const cached = lastSearchResults.get(args.userId);
        if (cached && cached.accountId !== accountId) {
            lastSearchResults.delete(args.userId);
            return { success: false, message: 'LuxMed account changed since that search. Search again before booking.' };
        }
        if (!cached || cached.terms.length === 0) {
            return { success: false, message: 'No search results available. Use LuxmedSearchSlots first.' };
        }
        if (cached.expiresAt <= Date.now()) {
            lastSearchResults.delete(args.userId);
            return { success: false, message: 'Search results expired. Search again before booking.' };
        }
        if (!Number.isFinite(args.slot_index) || !Number.isInteger(args.slot_index)) {
            return { success: false, message: 'slot_index must be a whole number.' };
        }
        const idx = args.slot_index - 1;
        if (idx < 0 || idx >= cached.terms.length) {
            return { success: false, message: `Invalid slot index. Choose between 1 and ${cached.terms.length}.` };
        }

        const term = cached.terms[idx];
        const rebookIfExists = args.rebook_if_exists === 'true';
        const t = term.term;
        const result = await smartBooking.process({id:'manual',userId:args.userId,accountId,serviceId:t.serviceId,serviceName:'Requested appointment',cityId:cached.cityId,cityName:'',clinicIds:[t.clinicId],doctorIds:[t.doctor.id],englishOnly:false,
            dateFrom:t.dateTimeFrom.dateTimeTz||t.dateTimeFrom.dateTimeLocal||'',dateTo:t.dateTimeTo.dateTimeTz||t.dateTimeTo.dateTimeLocal||'',timeFrom:'00:00',timeTo:'23:59',autobook:true,rebookIfExists,lastCheck:null,createdAt:new Date().toISOString()},[term],true);
        return {success:result.state==='booked',...result};
    },
};

export const LuxmedCancelBooking: Tool = {
    name: 'LuxmedCancelBooking',
    description: 'Cancel an existing LuxMed appointment by reservation ID.',
    parameters: {
        type: 'object',
        properties: {
            reservation_id: { type: 'number', description: 'Reservation ID to cancel (from LuxmedMyBookings)' },
        },
        required: ['reservation_id'],
    },
    execute: async (args: { userId: number; reservation_id: number }) => {
        const accountId = requireAccount(args.userId);
        if (!Number.isInteger(args.reservation_id) || args.reservation_id <= 0) {
            return { success: false, message: 'reservation_id must be a positive whole number.' };
        }
        if (!(await luxmedCapabilities()).includes('cancellation-receipts-v3')) {
            return { success: false, message: 'Cancellation waits for the sidecar review update.' };
        }
        const bookings = await luxmedGetReserved(accountId);
        const booking = bookings.find(booking => booking.eventId === args.reservation_id);
        if (!booking) {
            return { success: false, message: `Reservation ${args.reservation_id} was not found among your upcoming appointments.` };
        }
        const expectedStartAt = zonedTime(booking.date);
        if (!Number.isSafeInteger(expectedStartAt) || expectedStartAt <= 0) return { success: false, message: 'Reservation start time could not be verified.' };
        let requestError: unknown;
        try { await luxmedCancelVisit(accountId, args.reservation_id, expectedStartAt); }
        catch (error) { requestError = error; }
        const receipts = await luxmedCancellationReceipts(accountId);
        const receipt = receipts.find(r => r.accountId === accountId && r.reservationId === args.reservation_id
            && r.startAt === expectedStartAt);
        if (!receipt && requestError) throw requestError;
        if (receipt?.state === 'pending') return { success: false, message: `Cancellation of reservation ${args.reservation_id} needs operator verification. Automatic booking is on hold.` };
        if (!receipt || receipt.state !== 'confirmed' || !Number.isSafeInteger(receipt.confirmedAt) || receipt.confirmedAt! <= 0
            || !Number.isSafeInteger(receipt.reviewedAt) || receipt.reviewedAt! <= 0
            || !receipt.reviewedBy?.trim() || !receipt.reviewReason?.trim() || receipt.reviewAction !== 'confirmed_cancelled')
            return { success: false, message: `Cancellation of reservation ${args.reservation_id} has not been confirmed.` };
        smartStore.confirmCancellation(accountId, args.reservation_id, receipt.startAt);
        return { success: true, message: `Appointment ${args.reservation_id} cancelled.` };
    },
};

export const LuxmedMyBookings: Tool = {
    name: 'LuxmedMyBookings',
    description: 'List upcoming LuxMed appointments.',
    parameters: {
        type: 'object',
        properties: {},
    },
    execute: async (args: { userId: number }) => {
        const accountId = requireAccount(args.userId);
        const events = await luxmedGetReserved(accountId);
        if (events.length === 0) {
            return { success: true, message: 'No upcoming appointments.', bookings: [] };
        }
        return {
            success: true,
            message: `${events.length} upcoming appointment(s)`,
            bookings: events.map(e => ({
                date: e.date,
                doctor: e.doctor ? [e.doctor.name, e.doctor.lastname].filter(Boolean).join(' ') || 'Unknown doctor' : 'Unknown doctor',
                facility: e.clinic ? [e.clinic.city, e.clinic.address].filter(Boolean).join(', ') || 'Unknown clinic' : 'Telemedicine',
                service: e.title,
                reservationId: e.eventId,
            })),
        };
    },
};

export const LuxmedListCities: Tool = {
    name: 'LuxmedListCities',
    description: 'List available LuxMed cities. Use the city ID in search and preference commands.',
    parameters: {
        type: 'object',
        properties: {},
    },
    execute: async (args: { userId: number }) => {
        const accountId = requireAccount(args.userId);
        const cities = await luxmedGetCities(accountId);
        return { success: true, cities };
    },
};

export const LuxmedListServices: Tool = {
    name: 'LuxmedListServices',
    description: 'List available LuxMed medical services/specializations. Use the service ID in search commands.',
    parameters: {
        type: 'object',
        properties: {},
    },
    execute: async (args: { userId: number }) => {
        const accountId = requireAccount(args.userId);
        const services = await luxmedGetServices(accountId);
        return { success: true, services };
    },
};

export const LuxmedSetPreferences: Tool = {
    name: 'LuxmedSetPreferences',
    description: 'Save default LuxMed preferences (city, preferred time range, home location). These are used as defaults when searching for appointments.',
    parameters: {
        type: 'object',
        properties: {
            default_city_id: { type: 'number', description: 'Default city ID for searches' },
            default_city_name: { type: 'string', description: 'City name (for display)' },
            preferred_time_from: { type: 'string', description: 'Preferred earliest time, e.g. "10:00"' },
            preferred_time_to: { type: 'string', description: 'Preferred latest time, e.g. "14:00"' },
            home_lat: { type: 'number', description: 'Home latitude (for transit time filtering)' },
            home_lng: { type: 'number', description: 'Home longitude (for transit time filtering)' },
            max_transit_minutes: { type: 'number', description: 'Maximum transit time in minutes (default 30)' },
        },
    },
    execute: async (args: { userId: number } & Partial<LuxmedPreferences> & { default_city_id?: number; default_city_name?: string; preferred_time_from?: string; preferred_time_to?: string; home_lat?: number; home_lng?: number; max_transit_minutes?: number }) => {
        if ((args.home_lat == null) !== (args.home_lng == null)) {
            return { success: false, message: 'Provide both home_lat and home_lng, or use SaveAddress with the full home address.' };
        }
        if (args.max_transit_minutes != null && (!Number.isFinite(args.max_transit_minutes) || args.max_transit_minutes < 0)) {
            return { success: false, message: 'max_transit_minutes must be a finite non-negative number.' };
        }
        if (args.home_lat != null && args.home_lng != null) {
            saveUserAddress(args.userId, 'home', `${args.home_lat}, ${args.home_lng}`, args.home_lat, args.home_lng);
        }
        const prefs: LuxmedPreferences = {
            defaultCityId: args.default_city_id,
            defaultCityName: textify(args.default_city_name),
            preferredTimeFrom: args.preferred_time_from,
            preferredTimeTo: args.preferred_time_to,
            homeLat: args.home_lat,
            homeLng: args.home_lng,
            maxTransitMinutes: args.max_transit_minutes,
        };
        saveLuxmedPreferences(args.userId, prefs);
        return { success: true, message: 'LuxMed preferences saved.', preferences: prefs };
    },
};

export const LuxmedMonitorSlot: Tool = {
    name: 'LuxmedMonitorSlot',
    description: 'Prepare a smart LuxMed monitor. Ask "When can you book?" and collect availability, commitments and locations using LuxmedDraftAvailability. It cannot book until the user confirms the preview. Reuse confirmed rules but confirm each new monitor.',
    parameters: {
        type: 'object',
        properties: {
            service_id: { type: 'number', description: 'Service ID to monitor' },
            service_name: { type: 'string', description: 'Service name (for display in notifications)' },
            city_id: { type: 'number', description: 'City ID. Omit to use default.' },
            city_name: { type: 'string', description: 'City name (for display)' },
            clinic_ids: { type: 'string', description: 'Comma-separated clinic IDs to filter. Omit for any clinic. E.g. "5,7,142"' },
            doctor_ids: { type: 'string', description: 'Comma-separated doctor IDs to filter. Omit for any doctor. E.g. "12218,62477"' },
            english_only: { type: 'string', description: 'Only English-speaking doctors? "true" or "false". Default "false".' },
            date_from: { type: 'string', description: 'Start of date range (ISO, e.g. "2026-04-10T00:00:00")' },
            date_to: { type: 'string', description: 'End of date range (ISO)' },
            time_from: { type: 'string', description: 'Earliest time, e.g. "10:00"' },
            time_to: { type: 'string', description: 'Latest time, e.g. "14:00"' },
            max_transit_minutes: { type: 'number', description: 'Maximum transit time from saved home in minutes. Omit to use the saved preference.' },
            autobook: { type: 'string', description: 'Auto-book first matching slot? "true" or "false". Default "true".' },
            rebook_if_exists: { type: 'string', description: 'Replace existing booking with better slot? "true" or "false". Default "false".' },
        },
        required: ['service_id', 'service_name', 'date_from', 'date_to', 'time_from', 'time_to'],
    },
    execute: async (args: { userId: number; service_id: number; service_name: string; city_id?: number; city_name?: string; clinic_ids?: string; doctor_ids?: string; english_only?: string; date_from: string; date_to: string; time_from: string; time_to: string; max_transit_minutes?: number; autobook?: string; rebook_if_exists?: string }) => {
        const accountId = requireAccount(args.userId);
        const prefs = getLuxmedPreferences(args.userId);
        const cityId = args.city_id == null ? prefs.defaultCityId : args.city_id;
        if (typeof cityId !== 'number' || !Number.isSafeInteger(cityId) || cityId <= 0) {
            return { success: false, message: 'City not specified and no default city set.' };
        }
        let serviceName: string, cityName: string;
        try {
            const [services, cities] = await Promise.all([luxmedGetServices(accountId), luxmedGetCities(accountId)]);
            serviceName = uniqueServiceName(services, args.service_id) || '';
            cityName = uniqueCityName(cities, cityId) || '';
        } catch {
            return { success: false, message: 'Could not verify the LuxMed service and city. Try again when the provider dictionary is available.' };
        }
        if (!serviceName) return { success: false, message: `Service ID ${args.service_id} is missing or ambiguous in LuxMed. Use LuxmedListServices to choose the correct ID.` };
        if (!cityName) return { success: false, message: `City ID ${cityId} is missing or ambiguous in LuxMed. Use LuxmedListCities to choose the correct ID.` };

        let clinicIds: number[] | null, doctorIds: number[] | null;
        let englishOnly: boolean, autobook: boolean, rebookIfExists: boolean;
        try {
            clinicIds = parseMonitorIds(args.clinic_ids, 'clinic_ids');
            doctorIds = parseMonitorIds(args.doctor_ids, 'doctor_ids');
            englishOnly = parseMonitorBoolean(args.english_only, 'english_only', false);
            autobook = parseMonitorBoolean(args.autobook, 'autobook', true);
            rebookIfExists = parseMonitorBoolean(args.rebook_if_exists, 'rebook_if_exists', false);
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : 'Invalid clinic or doctor IDs.' };
        }

        if (!validBookingTimeRange(args.time_from, args.time_to))
            return { success: false, message: 'time_from and time_to must be valid HH:mm values in ascending order.' };
        const parsedDateFrom = new Date(args.date_from);
        const parsedDateTo = new Date(args.date_to);
        if (Number.isNaN(parsedDateFrom.getTime()) || Number.isNaN(parsedDateTo.getTime()) || parsedDateTo < parsedDateFrom) {
            return { success: false, message: 'date_from and date_to must be valid dates, with date_to on or after date_from.' };
        }
        const maxTransitMinutes = args.max_transit_minutes ?? prefs.maxTransitMinutes;
        if (maxTransitMinutes != null && (!Number.isFinite(maxTransitMinutes) || maxTransitMinutes < 0)) {
            return { success: false, message: 'max_transit_minutes must be a finite non-negative number.' };
        }
        console.log(`[LuxMed] Creating monitoring: ${serviceName}, city=${cityId}, time=${args.time_from}-${args.time_to}, clinics=${clinicIds?.join(',') ?? 'any'}, doctors=${doctorIds?.join(',') ?? 'any'}, english=${englishOnly}, autobook=${autobook}`);
        const monitoring = smartStore.db.transaction(() => {
        const created = createLuxmedMonitoring({
            id: generateShortId(),
            userId: args.userId,
            accountId,
            serviceId: args.service_id,
            serviceName,
            cityId,
            cityName,
            clinicIds,
            doctorIds,
            englishOnly,
            dateFrom: args.date_from,
            dateTo: args.date_to,
            timeFrom: args.time_from,
            timeTo: args.time_to,
            autobook,
            rebookIfExists,
            maxTransitMinutes,
        });
        smartStore.enroll(created.id,args.userId);
        return created;
        })();

        const filters = [];
        if (clinicIds) filters.push(`clinics: ${clinicIds.length}`);
        if (doctorIds) filters.push(`doctors: ${doctorIds.length}`);
        if (args.english_only === 'true') filters.push('english-speaking only');
        const filterStr = filters.length > 0 ? ` Filters: ${filters.join(', ')}.` : '';

        return {
            success: true,
            message: `Monitoring prepared (${monitoring.id}): LuxMed service ${serviceName} (ID ${args.service_id}) in ${cityName} (ID ${cityId}), ${args.time_from}-${args.time_to}.${filterStr} When can you book? Confirm availability and locations using LuxmedDraftAvailability, then send LuxmedPreviewAvailability. Booking remains disabled until the user clicks Confirm.`,
            monitoring_id:monitoring.id,
        };
    },
};

export const LuxmedStopMonitoring: Tool = {
    name: 'LuxmedStopMonitoring',
    description: 'Stop an active LuxMed appointment monitoring.',
    parameters: {
        type: 'object',
        properties: {
            monitoring_id: { type: 'string', description: 'Monitoring ID to deactivate (from LuxmedListMonitorings)' },
        },
        required: ['monitoring_id'],
    },
    execute: async (args: { userId: number; monitoring_id: string }) => {
        if (!deactivateLuxmedMonitoring(args.monitoring_id, args.userId)) {
            return { success: false, message: `Active monitoring ${args.monitoring_id} was not found.` };
        }
        return { success: true, message: `Monitoring ${args.monitoring_id} stopped.` };
    },
};

export const LuxmedListMonitorings: Tool = {
    name: 'LuxmedListMonitorings',
    description: 'List active LuxMed appointment monitorings.',
    parameters: {
        type: 'object',
        properties: {},
    },
    execute: async (args: { userId: number }) => {
        const monitorings = getActiveLuxmedMonitoringsByUser(args.userId);
        if (monitorings.length === 0) {
            return { success: true, message: 'No active monitorings.', monitorings: [] };
        }
        return {
            success: true,
            message: `${monitorings.length} active monitoring(s)`,
            monitorings: monitorings.map(m => ({
                id: m.id,
                service: m.serviceName,
                city: m.cityName,
                clinics: m.clinicIds ? `${m.clinicIds.length} specific` : 'any',
                doctors: m.doctorIds ? `${m.doctorIds.length} specific` : 'any',
                englishOnly: m.englishOnly,
                dateRange: `${m.dateFrom} — ${m.dateTo}`,
                timeRange: `${m.timeFrom} — ${m.timeTo}`,
                autobook: m.autobook,
                lastCheck: m.lastCheck,
            })),
        };
    },
};
