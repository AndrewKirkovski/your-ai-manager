/**
 * LuxMed appointment monitoring loop.
 * Runs every 10 minutes, searches for slots matching active monitorings,
 * applies client-side filters (clinic list, doctor list, english-speaking),
 * and auto-books or notifies the user.
 */

import TelegramBot from 'node-telegram-bot-api';
import {
    luxmedSearchSlots, luxmedBookSlot, luxmedGetDoctors,
    luxmedGetCities, LuxmedApiError, LuxmedTerm,
} from './luxmedAdapter';
import {
    getActiveLuxmedMonitorings, updateLuxmedMonitoringLastCheck,
    deactivateLuxmedMonitoring, LuxmedMonitoringConfig, getUserAddress,
    getLuxmedClinicByName, saveLuxmedClinic, getLuxmedPreferences,
} from './userStore';
import { geocode, getDistanceMatrix, isGoogleMapsConfigured } from './googleMapsService';
import { safeSend, escapeHtml } from './telegramFormat';

let botInstance: TelegramBot | null = null;

export function initLuxmedMonitor(bot: TelegramBot): void {
    botInstance = bot;
}

// Cache english-speaking doctor IDs per city+service (refreshed each cycle)
const englishDoctorCache = new Map<string, Set<number>>();

// Track monitorings that already notified about auto-book failure (avoid spam every 10 min)
const autobookFailureNotified = new Set<string>();

async function getEnglishDoctorIds(accountId: number, cityId: number, serviceId: number): Promise<Set<number> | null> {
    const key = `${accountId}:${cityId}:${serviceId}`;
    if (englishDoctorCache.has(key)) return englishDoctorCache.get(key)!;

    try {
        const doctors = await luxmedGetDoctors(accountId, cityId, serviceId);
        const englishIds = new Set(doctors.filter(d => d.isEnglishSpeaker).map(d => d.id));
        englishDoctorCache.set(key, englishIds);
        return englishIds;
    } catch {
        return null;
    }
}

function filterTerms(terms: LuxmedTerm[], config: LuxmedMonitoringConfig, englishDoctorIds: Set<number> | null): LuxmedTerm[] {
    // A failed dictionary lookup must never turn an English-only monitor into
    // an unrestricted monitor that can auto-book any doctor.
    if (config.englishOnly && englishDoctorIds === null) return [];
    return terms.filter(t => {
        const term = t.term;

        // Filter by allowed clinics
        if (config.clinicIds && config.clinicIds.length > 0) {
            if (!config.clinicIds.includes(term.clinicGroupId) && !config.clinicIds.includes(term.clinicId)) {
                return false;
            }
        }

        // Filter by allowed doctors
        if (config.doctorIds && config.doctorIds.length > 0) {
            if (!config.doctorIds.includes(term.doctor.id)) {
                return false;
            }
        }

        // Filter by english-speaking
        if (config.englishOnly) {
            if (englishDoctorIds && !englishDoctorIds.has(term.doctor.id)) {
                return false;
            }
        }

        return true;
    });
}

async function filterTermsByTransit(terms: LuxmedTerm[], config: LuxmedMonitoringConfig): Promise<LuxmedTerm[]> {
    const maxMinutes = config.maxTransitMinutes;
    if (maxMinutes == null || terms.length === 0) return terms;
    if (!Number.isFinite(maxMinutes) || maxMinutes < 0) {
        console.warn(`[LuxMed Monitor] ${config.id}: invalid transit limit; skipping this cycle`);
        return [];
    }
    const telemedicineTerms = terms.filter(term => term.term.isTelemedicine);
    if (!isGoogleMapsConfigured()) {
        console.warn(`[LuxMed Monitor] ${config.id}: transit filter cannot run because Google Maps is not configured`);
        return telemedicineTerms;
    }
    const prefs = getLuxmedPreferences(config.userId);
    const home = getUserAddress(config.userId, 'home') || (
        prefs.homeLat != null && prefs.homeLng != null
            ? { label: 'home', address: 'Saved LuxMed home coordinates', lat: prefs.homeLat, lng: prefs.homeLng }
            : null
    );
    if (!home) {
        console.warn(`[LuxMed Monitor] ${config.id}: transit filter cannot run because home address is missing`);
        return telemedicineTerms;
    }

    const clinicNames = [...new Set(terms.filter(t => !t.term.isTelemedicine).map(t => t.term.clinic || 'Unknown clinic'))];
    const coords: { clinic: string; lat: number; lng: number }[] = [];
    let cityName = config.cityName || prefs.defaultCityName || 'Warszawa';
    if (!cityName || cityName === 'Unknown') {
        try {
            const cities = await luxmedGetCities(config.accountId);
            cityName = cities.find(city => city.id === config.cityId)?.name || 'Warszawa';
        } catch {
            cityName = 'Warszawa';
        }
    }
    for (const clinic of clinicNames) {
        const cached = getLuxmedClinicByName(clinic, config.cityId);
        if (cached) {
            coords.push({ clinic, lat: cached.lat, lng: cached.lng });
            continue;
        }
        const place = await geocode(`${clinic}, ${cityName}`);
        if (place) {
            coords.push({ clinic, lat: place.lat, lng: place.lng });
            saveLuxmedClinic(clinic, place.formattedAddress, place.lat, place.lng, config.cityId);
        }
    }
    if (coords.length === 0) {
        console.warn(`[LuxMed Monitor] ${config.id}: transit filter could not resolve any physical clinic`);
        return telemedicineTerms;
    }

    const allowed = new Set<string>();
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
        const groupCoords = coords.filter(c => clinics.has(c.clinic));
        const arrivalTime = arrivalKey === 'unknown' ? undefined : new Date(Number(arrivalKey));
        const distances = await getDistanceMatrix(
            { lat: home.lat, lng: home.lng },
            groupCoords.map(c => ({ lat: c.lat, lng: c.lng })),
            'transit',
            arrivalTime ? { arrivalTime } : undefined,
        );
        for (const distance of distances) {
            const clinic = groupCoords[distance.destinationIndex];
            if (clinic && distance.status === 'OK' && distance.durationSeconds <= maxMinutes * 60) {
                allowed.add(`${arrivalKey}:${clinic.clinic}`);
            }
        }
    }
    return terms.filter(term => {
        if (term.term.isTelemedicine) return true;
        const rawDate = term.term.dateTimeFrom.dateTimeLocal || term.term.dateTimeFrom.dateTimeTz;
        const parsedDate = rawDate ? new Date(rawDate) : null;
        const arrivalKey = parsedDate && !Number.isNaN(parsedDate.getTime()) ? String(parsedDate.getTime()) : 'unknown';
        return allowed.has(`${arrivalKey}:${term.term.clinic || 'Unknown clinic'}`);
    });
}

function formatTermForNotification(t: LuxmedTerm): string {
    const term = t.term;
    const dt = term.dateTimeFrom.dateTimeLocal || term.dateTimeFrom.dateTimeTz || '?';
    const doctor = [term.doctor.academicTitle, term.doctor.firstName, term.doctor.lastName]
        .filter(Boolean)
        .join(' ') || 'Unknown doctor';
    const clinic = term.clinic || 'Unknown clinic';
    const tele = term.isTelemedicine ? ' (tele)' : '';
    // Doctor + clinic come from LuxMed API. Escape so marked/sanitize-html can't
    // interpret stray chars (e.g. `dr. Smith & Co`, academic titles with dots).
    return `${escapeHtml(dt)} — ${escapeHtml(doctor)}, ${escapeHtml(clinic)}${tele}`;
}

async function processMonitoring(config: LuxmedMonitoringConfig): Promise<void> {
    // Check if monitoring date range is still valid
    const now = new Date();
    const dateTo = new Date(config.dateTo);
    if (Number.isNaN(dateTo.getTime()) || dateTo < now) {
        deactivateLuxmedMonitoring(config.id, config.userId);
        autobookFailureNotified.delete(config.id);
        if (botInstance) {
            safeSend(botInstance, config.userId,
                `⏰ LuxMed мониторинг "${config.serviceName}" истёк (период до ${config.dateTo}). Деактивирован.`
            ).catch(err => console.error(`[LuxMed Monitor] ${config.id}: notification send failed:`, err instanceof Error ? err.message : err));
        }
        return;
    }

    try {
        // Search with broad params — filtering happens client-side
        const terms = await luxmedSearchSlots(config.accountId, {
            cityId: config.cityId,
            serviceId: config.serviceId,
            dateFrom: config.dateFrom,
            dateTo: config.dateTo,
            timeFrom: config.timeFrom,
            timeTo: config.timeTo,
        });

        updateLuxmedMonitoringLastCheck(config.id);
        console.log(`[LuxMed Monitor] ${config.id}: ${terms.length} raw slots for "${config.serviceName}"`);

        if (terms.length === 0) return;

        // Get english doctor IDs if needed
        let englishDoctorIds: Set<number> | null = new Set<number>();
        if (config.englishOnly) {
            englishDoctorIds = await getEnglishDoctorIds(config.accountId, config.cityId, config.serviceId);
            if (!englishDoctorIds) {
                console.warn(`[LuxMed Monitor] ${config.id}: English doctor lookup failed; deferring this cycle`);
            }
        }

        // Apply client-side filters
        const filtered = await filterTermsByTransit(filterTerms(terms, config, englishDoctorIds), config);
        console.log(`[LuxMed Monitor] ${config.id}: ${filtered.length}/${terms.length} after filters (clinics: ${config.clinicIds?.length ?? 'any'}, doctors: ${config.doctorIds?.length ?? 'any'}, english: ${config.englishOnly})`);
        if (filtered.length === 0) return;

        console.log(`[LuxMed Monitor] ${config.id}: Found ${filtered.length} matching slots for "${config.serviceName}"`);

        if (config.autobook) {
            // Auto-book the first matching slot
            const best = filtered[0];
            try {
                await luxmedBookSlot(config.accountId, best, config.cityId, config.rebookIfExists);
                deactivateLuxmedMonitoring(config.id, config.userId);
                autobookFailureNotified.delete(config.id);

                if (botInstance) {
                    const msg = `✅ LuxMed: Записал автоматически!\n\n${formatTermForNotification(best)}\n\nСервис: ${config.serviceName}`;
                    safeSend(botInstance, config.userId, msg).catch(err => console.error(`[LuxMed Monitor] ${config.id}: notification send failed:`, err instanceof Error ? err.message : err));
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.error(`[LuxMed Monitor] ${config.id}: Auto-book failed: ${errMsg}`);
                // Don't deactivate — try again next cycle
                // But notify user only once to avoid spam every 10 min
                if (botInstance && !autobookFailureNotified.has(config.id)) {
                    autobookFailureNotified.add(config.id);
                    const slotsText = filtered.slice(0, 5).map((t, i) => `${i + 1}. ${formatTermForNotification(t)}`).join('\n');
                    // errMsg is a raw JS error string (external source), escape to avoid breaking HTML parse.
                    const msg = `⚠️ LuxMed: Нашёл слоты для "${config.serviceName}", но автозапись не удалась (${escapeHtml(errMsg)}).\n\nДоступные слоты:\n${slotsText}\n\nЗапиши вручную через бот. Мониторинг продолжает попытки автозаписи.`;
                    safeSend(botInstance, config.userId, msg).catch(err => console.error(`[LuxMed Monitor] ${config.id}: notification send failed:`, err instanceof Error ? err.message : err));
                }
            }
        } else {
            // Just notify — deactivate ONLY after a confirmed send. If the
            // notification send fails (429 / network blip), keep monitoring active
            // so the next cycle re-notifies; deactivating first would lose BOTH the
            // slots and the monitoring on a single hiccup.
            const slotsText = filtered.slice(0, 5).map((t, i) => `${i + 1}. ${formatTermForNotification(t)}`).join('\n');
            const msg = `🔔 LuxMed: Нашёл ${filtered.length} слот(ов) для "${config.serviceName}"!\n\n${slotsText}${filtered.length > 5 ? `\n... и ещё ${filtered.length - 5}` : ''}\n\nИспользуй LuxmedSearchSlots чтобы найти и записаться.`;
            const sent = botInstance
                ? await safeSend(botInstance, config.userId, msg).catch(err => {
                    console.error(`[LuxMed Monitor] ${config.id}: slots notification send failed, keeping monitoring active:`, err instanceof Error ? err.message : err);
                    return null;
                })
                : null;
            // Deactivate on confirmed delivery, or if there's no bot to ever notify
            // (avoid a monitor that loops forever finding slots it can't report).
            if (sent || !botInstance) {
                deactivateLuxmedMonitoring(config.id, config.userId);
                autobookFailureNotified.delete(config.id);
            }
        }
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[LuxMed Monitor] ${config.id}: Error checking "${config.serviceName}": ${errMsg}`);
        // If auth error, notify user and deactivate
        const sidecarFailure = err instanceof LuxmedApiError && ['CLIENT_OUTDATED', 'SIDECAR_UNAVAILABLE', 'SIDECAR_TIMEOUT', 'SIDECAR_INVALID_RESPONSE'].includes(err.code);
        if (sidecarFailure || errMsg.includes('Invalid login') || errMsg.includes('password')) {
            deactivateLuxmedMonitoring(config.id, config.userId);
            autobookFailureNotified.delete(config.id);
            if (botInstance) {
                safeSend(botInstance, config.userId,
                    sidecarFailure
                        ? `❌ LuxMed: Сервис несовместим или недоступен. Мониторинг "${config.serviceName}" деактивирован; обнови sidecar и запусти мониторинг заново.`
                        : `❌ LuxMed: Ошибка авторизации. Мониторинг "${config.serviceName}" деактивирован. Обнови логин/пароль.`
                ).catch(err => console.error(`[LuxMed Monitor] ${config.id}: notification send failed:`, err instanceof Error ? err.message : err));
            }
        }
    }
}

// Overlap guard: N monitorings × ~32s upper bound (30s sidecar timeout + 2s
// delay) can exceed the 10-min cron interval. Skip overlapping ticks.
let cycleRunning = false;
export async function runLuxmedMonitoringCycle(): Promise<void> {
    if (cycleRunning) {
        console.warn('[LuxMed Monitor] Previous cycle still running, skipping this tick');
        return;
    }
    cycleRunning = true;
    try {
        const monitorings = getActiveLuxmedMonitorings();
        if (monitorings.length === 0) return;

        console.log(`[LuxMed Monitor] Checking ${monitorings.length} active monitoring(s)...`);

        // Clear english doctor cache each cycle (refreshes every 10 min)
        englishDoctorCache.clear();

        // Process sequentially to avoid rate limiting
        for (const config of monitorings) {
            await processMonitoring(config);
            // Small delay between checks to be gentle on the API
            if (monitorings.length > 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    } finally {
        cycleRunning = false;
    }
}
