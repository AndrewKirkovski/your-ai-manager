import { Tool } from './tool.types';
import {
    luxmedLogin, luxmedGetCities, luxmedGetServices,
    luxmedSearchSlots, luxmedBookSlot, luxmedCancelVisit, luxmedGetReserved,
    LuxmedTerm,
} from './luxmedAdapter';
import {
    getLuxmedAccountId, saveLuxmedAccount, getLuxmedPreferences, saveLuxmedPreferences,
    LuxmedPreferences, generateShortId,
    createLuxmedMonitoring, getActiveLuxmedMonitoringsByUser, deactivateLuxmedMonitoring,
} from './userStore';

function requireAccount(userId: number): number {
    const accountId = getLuxmedAccountId(userId);
    if (!accountId) {
        throw new Error('LuxMed account not configured. Ask the user to provide their LuxMed login and password first.');
    }
    return accountId;
}

function formatTerm(term: LuxmedTerm, index: number): string {
    const t = term.term;
    const dt = t.dateTimeFrom.dateTimeLocal || t.dateTimeFrom.dateTimeTz || '?';
    const doctor = `${t.doctor.academicTitle} ${t.doctor.firstName} ${t.doctor.lastName}`.trim();
    const tele = t.isTelemedicine ? ' (teleconsultation)' : '';
    return `${index + 1}. ${dt} — ${doctor}, ${t.clinic}${tele}`;
}

// Store last search results per user for booking by index
const lastSearchResults = new Map<number, { terms: LuxmedTerm[]; cityId: number }>();

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
        console.log(`[LuxMed] Login attempt for user ${args.userId} (${args.username})`);
        const result = await luxmedLogin(args.username, args.password, chatId);
        saveLuxmedAccount(args.userId, result.accountId, result.username);
        console.log(`[LuxMed] Login success: userId=${result.userId}, accountId=${result.accountId}`);
        return { success: true, message: `LuxMed login successful. Account linked (${result.username}).` };
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
        },
        required: ['service_id'],
    },
    execute: async (args: { userId: number; service_id: number; city_id?: number; clinic_id?: number; doctor_id?: number; date_from?: string; date_to?: string; time_from?: string; time_to?: string }) => {
        const accountId = requireAccount(args.userId);
        const prefs = getLuxmedPreferences(args.userId);
        const cityId = args.city_id || prefs.defaultCityId;
        if (!cityId) {
            return { success: false, message: 'City not specified and no default city in preferences. Use LuxmedListCities to find the city ID, or set a default with LuxmedSetPreferences.' };
        }

        const now = new Date();
        const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
        console.log(`[LuxMed] Search: service=${args.service_id}, city=${cityId}, time=${args.time_from || '07:00'}-${args.time_to || '21:00'}`);
        const terms = await luxmedSearchSlots(accountId, {
            cityId,
            serviceId: args.service_id,
            clinicId: args.clinic_id,
            doctorId: args.doctor_id,
            dateFrom: args.date_from || now.toISOString().slice(0, 19),
            dateTo: args.date_to || twoWeeks.toISOString().slice(0, 19),
            timeFrom: args.time_from || prefs.preferredTimeFrom || '07:00',
            timeTo: args.time_to || prefs.preferredTimeTo || '21:00',
        });

        lastSearchResults.set(args.userId, { terms, cityId });
        console.log(`[LuxMed] Search returned ${terms.length} slots`);

        if (terms.length === 0) {
            return { success: true, message: 'No available slots found for the given criteria.', slots: [] };
        }

        const summary = terms.slice(0, 10).map((t, i) => formatTerm(t, i)).join('\n');
        return {
            success: true,
            message: `Found ${terms.length} available slot(s):\n${summary}${terms.length > 10 ? `\n... and ${terms.length - 10} more` : ''}`,
            totalSlots: terms.length,
            slots: terms.slice(0, 10).map(t => ({
                dateTime: t.term.dateTimeFrom.dateTimeLocal || t.term.dateTimeFrom.dateTimeTz,
                doctor: `${t.term.doctor.academicTitle} ${t.term.doctor.firstName} ${t.term.doctor.lastName}`.trim(),
                clinic: t.term.clinic,
                isTelemedicine: t.term.isTelemedicine,
            })),
        };
    },
};

export const LuxmedBookSlot: Tool = {
    name: 'LuxmedBookSlot',
    description: 'Book a specific LuxMed appointment slot. Use the slot index from the last search results (1-based), or provide full slot details.',
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
        const cached = lastSearchResults.get(args.userId);
        if (!cached || cached.terms.length === 0) {
            return { success: false, message: 'No search results available. Use LuxmedSearchSlots first.' };
        }
        const idx = args.slot_index - 1;
        if (idx < 0 || idx >= cached.terms.length) {
            return { success: false, message: `Invalid slot index. Choose between 1 and ${cached.terms.length}.` };
        }

        const term = cached.terms[idx];
        const rebookIfExists = args.rebook_if_exists === 'true';
        const t = term.term;
        const doctor = `${t.doctor.academicTitle} ${t.doctor.firstName} ${t.doctor.lastName}`.trim();
        const dt = t.dateTimeFrom.dateTimeLocal || t.dateTimeFrom.dateTimeTz;
        console.log(`[LuxMed] Booking slot #${args.slot_index}: ${dt}, ${doctor}, ${t.clinic} (rebook=${rebookIfExists})`);
        await luxmedBookSlot(accountId, term, cached.cityId, rebookIfExists);
        console.log(`[LuxMed] Booking successful!`);

        return {
            success: true,
            message: `Appointment booked: ${dt}, ${doctor}, ${t.clinic}`,
        };
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
        await luxmedCancelVisit(accountId, args.reservation_id);
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
                doctor: e.doctor ? `${e.doctor.academicTitle || ''} ${e.doctor.firstName} ${e.doctor.lastName}`.trim() : 'Unknown',
                facility: e.facilityName,
                service: e.serviceVariantName,
                reservationId: e.reservationId,
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
        const prefs: LuxmedPreferences = {
            defaultCityId: args.default_city_id,
            defaultCityName: args.default_city_name,
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
    description: 'Start monitoring for available appointments. Checks every 10 minutes with client-side filtering (English-speaking doctors, specific clinics/doctors). Auto-books when a matching slot appears.',
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
            autobook: { type: 'string', description: 'Auto-book first matching slot? "true" or "false". Default "true".' },
            rebook_if_exists: { type: 'string', description: 'Replace existing booking with better slot? "true" or "false". Default "false".' },
        },
        required: ['service_id', 'service_name', 'date_from', 'date_to', 'time_from', 'time_to'],
    },
    execute: async (args: { userId: number; service_id: number; service_name: string; city_id?: number; city_name?: string; clinic_ids?: string; doctor_ids?: string; english_only?: string; date_from: string; date_to: string; time_from: string; time_to: string; autobook?: string; rebook_if_exists?: string }) => {
        const accountId = requireAccount(args.userId);
        const prefs = getLuxmedPreferences(args.userId);
        const cityId = args.city_id || prefs.defaultCityId;
        if (!cityId) {
            return { success: false, message: 'City not specified and no default city set.' };
        }

        const clinicIds = args.clinic_ids ? args.clinic_ids.split(',').map(Number).filter(n => !isNaN(n)) : null;
        const doctorIds = args.doctor_ids ? args.doctor_ids.split(',').map(Number).filter(n => !isNaN(n)) : null;

        console.log(`[LuxMed] Creating monitoring: ${args.service_name}, city=${cityId}, time=${args.time_from}-${args.time_to}, clinics=${clinicIds?.join(',') ?? 'any'}, doctors=${doctorIds?.join(',') ?? 'any'}, english=${args.english_only === 'true'}, autobook=${args.autobook !== 'false'}`);
        const monitoring = createLuxmedMonitoring({
            id: generateShortId(),
            userId: args.userId,
            accountId,
            serviceId: args.service_id,
            serviceName: args.service_name,
            cityId,
            cityName: args.city_name || prefs.defaultCityName || 'Unknown',
            clinicIds,
            doctorIds,
            englishOnly: args.english_only === 'true',
            dateFrom: args.date_from,
            dateTo: args.date_to,
            timeFrom: args.time_from,
            timeTo: args.time_to,
            autobook: args.autobook !== 'false',
            rebookIfExists: args.rebook_if_exists === 'true',
        });

        const filters = [];
        if (clinicIds) filters.push(`clinics: ${clinicIds.length}`);
        if (doctorIds) filters.push(`doctors: ${doctorIds.length}`);
        if (args.english_only === 'true') filters.push('english-speaking only');
        const filterStr = filters.length > 0 ? ` Filters: ${filters.join(', ')}.` : '';

        return {
            success: true,
            message: `Monitoring started (${monitoring.id}): ${args.service_name}, ${args.time_from}-${args.time_to}, auto-book: ${args.autobook !== 'false' ? 'yes' : 'no'}.${filterStr} Checking every 10 min.`,
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
        deactivateLuxmedMonitoring(args.monitoring_id, args.userId);
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
