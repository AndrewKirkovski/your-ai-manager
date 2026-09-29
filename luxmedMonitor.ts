/**
 * LuxMed appointment monitoring loop.
 * Schedules smart searches every 30 seconds and legacy searches every 10 minutes,
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
    getLuxmedAccountId,
} from './userStore';
import { geocode, getDistanceMatrix, isGoogleMapsConfigured } from './googleMapsService';
import { safeSend, escapeHtml } from './telegramFormat';
import { smartStore } from './luxmedSmartStore';
import { smartBooking, monitorReservationCoverage } from './luxmedSmartBooking';
import { zonedTime } from './luxmedAvailability';

let botInstance: TelegramBot | null = null;

export function initLuxmedMonitor(bot: TelegramBot): void {
    botInstance = bot;
}

// Cache english-speaking doctor IDs per city+service (refreshed each cycle)
const englishDoctorCache = new Map<string, {ids:Set<number>;expires:number}>();

// Track monitorings that already notified about auto-book failure (avoid spam every 10 min)
const autobookFailureNotified = new Set<string>();
const sidecarFailureNotified = new Set<string>();

async function getEnglishDoctorIds(accountId: number, cityId: number, serviceId: number): Promise<Set<number> | null> {
    const key = `${accountId}:${cityId}:${serviceId}`;
    const cached=englishDoctorCache.get(key);
    if(cached&&cached.expires>Date.now())return cached.ids;

    try {
        const doctors = await luxmedGetDoctors(accountId, cityId, serviceId);
        const englishIds = new Set(doctors.filter(d => d.isEnglishSpeaker).map(d => d.id));
        englishDoctorCache.set(key, {ids:englishIds,expires:Date.now()+3600000});
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

async function processMonitoring(config: LuxmedMonitoringConfig, search:typeof luxmedSearchSlots = luxmedSearchSlots): Promise<void> {
    const smart=smartStore.enrollment(config.id);
    if(smart&&smart.state!=='active')return;
    if (getLuxmedAccountId(config.userId) !== config.accountId) {
        deactivateLuxmedMonitoring(config.id, config.userId);
        if (smart) smartStore.status(config.id, 'LuxMed account changed; create and confirm a new monitor');
        return;
    }
    // Check if monitoring date range is still valid
    const now = new Date();
    const dateTo = new Date(zonedTime(/^\d{4}-\d{2}-\d{2}$/.test(config.dateTo)?`${config.dateTo}T23:59:59`:config.dateTo));
    if (Number.isNaN(dateTo.getTime()) || dateTo < now) {
        deactivateLuxmedMonitoring(config.id, config.userId);
        autobookFailureNotified.delete(config.id);
        sidecarFailureNotified.delete(config.id);
        if (botInstance) {
            safeSend(botInstance, config.userId,
                `⏰ LuxMed мониторинг "${config.serviceName}" истёк (период до ${config.dateTo}). Деактивирован.`
            ).catch(err => console.error(`[LuxMed Monitor] ${config.id}: notification send failed:`, err instanceof Error ? err.message : err));
        }
        return;
    }

    try {
        // Search with broad params — filtering happens client-side
        if(smart) {
            const policy=smartStore.policy(config.userId);
            if(!policy||policy.state!=='confirmed'||policy.holdToken){smartStore.status(config.id,'Availability needs review or confirmation');return;}
            const issue=await smartBooking.readiness();if(issue){smartStore.status(config.id,issue);return;}
            if(config.autobook){const legacy=await smartBooking.legacyMonitorIssue(config.accountId);if(legacy){smartStore.status(config.id,legacy);return;}}
            await smartBooking.refreshReservations(config.accountId, monitorReservationCoverage(config));
        }
        const terms = await search(config.accountId, {
            cityId: config.cityId,
            serviceId: config.serviceId,
            dateFrom: config.dateFrom,
            dateTo: config.dateTo,
            timeFrom: config.timeFrom,
            timeTo: config.timeTo,
        });

        updateLuxmedMonitoringLastCheck(config.id);
        if(smart) {
            const result=await smartBooking.process(config,terms);
            smartStore.status(config.id,result.message);
            smartStore.db.prepare('UPDATE luxmed_smart_monitors SET failures=0 WHERE monitoring_id=?').run(config.id);
            return;
        }
        sidecarFailureNotified.delete(config.id);
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
                if (getLuxmedAccountId(config.userId) !== config.accountId) {
                    deactivateLuxmedMonitoring(config.id, config.userId);
                    return;
                }
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
        if(smart) {
            const failures=(smartStore.enrollment(config.id)?.failures||0)+1;
            const delay=err instanceof LuxmedApiError&&Number.isFinite(err.retryAfterMs)?err.retryAfterMs!:Math.min(600000,30000*2**Math.min(failures-1,5));
            smartStore.db.prepare('UPDATE luxmed_smart_monitors SET status=?,failures=?,next_check=? WHERE monitoring_id=?').run(errMsg,failures,Date.now()+delay,config.id);
        }
        console.error(`[LuxMed Monitor] ${config.id}: Error checking "${config.serviceName}": ${errMsg}`);
        // If auth error, notify user and deactivate
        const sidecarFailure = err instanceof LuxmedApiError && ['CLIENT_OUTDATED', 'SIDECAR_UNAVAILABLE', 'SIDECAR_TIMEOUT', 'SIDECAR_INVALID_RESPONSE'].includes(err.code);
        const confirmedIncompatibility = err instanceof LuxmedApiError && err.code === 'CLIENT_OUTDATED';
        const authFailure = errMsg.includes('Invalid login') || errMsg.includes('password');
        if (confirmedIncompatibility || authFailure) {
            deactivateLuxmedMonitoring(config.id, config.userId);
            autobookFailureNotified.delete(config.id);
            sidecarFailureNotified.delete(config.id);
            if (botInstance) {
                safeSend(botInstance, config.userId,
                    confirmedIncompatibility
                        ? `❌ LuxMed: Версия клиента устарела. Мониторинг "${config.serviceName}" деактивирован; обнови sidecar и запусти мониторинг заново.`
                        : `❌ LuxMed: Ошибка авторизации. Мониторинг "${config.serviceName}" деактивирован. Обнови логин/пароль.`
                ).catch(err => console.error(`[LuxMed Monitor] ${config.id}: notification send failed:`, err instanceof Error ? err.message : err));
            }
        } else if (sidecarFailure && botInstance && !sidecarFailureNotified.has(config.id)) {
            sidecarFailureNotified.add(config.id);
            safeSend(botInstance, config.userId,
                `⚠️ LuxMed: sidecar временно недоступен. Мониторинг "${config.serviceName}" останется активным и повторит попытку.`
            ).catch(notificationError => console.error(`[LuxMed Monitor] ${config.id}: notification send failed:`, notificationError instanceof Error ? notificationError.message : notificationError));
        }
    }
}

// Accounts progress independently. An account never starts an overlapping cycle.
const runningAccounts=new Set<number>();
const lastAccountMonitor=new Map<number,string>();
const recentSearches=new Map<string,{started:number;result:Promise<LuxmedTerm[]>}>();
export async function runLuxmedMonitoringCycle(): Promise<void> {
    void smartBooking.reconcile();
    if(botInstance)await smartStore.deliver((userId,message)=>safeSend(botInstance!,userId,message));
    const groups=new Map<number,LuxmedMonitoringConfig[]>();
    for(const config of getActiveLuxmedMonitorings()) {
        const smart=smartStore.enrollment(config.id);
        if(smart ? smart.state!=='active'||smart.next_check>Date.now() : config.lastCheck&&Date.now()-Date.parse(config.lastCheck)<600000)continue;
        const group=groups.get(config.accountId)||[];group.push(config);groups.set(config.accountId,group);
    }
    await Promise.all([...groups].map(async([accountId,configs])=>{
        if(runningAccounts.has(accountId))return;
        runningAccounts.add(accountId);
        const last=lastAccountMonitor.get(accountId);
        if(last){const index=configs.findIndex(c=>c.id===last);configs.push(...configs.splice(0,index+1));}
        const search:typeof luxmedSearchSlots=(id,params)=>{
            const key=JSON.stringify([id,params]);
            let pending=recentSearches.get(key);
            if(!pending||Date.now()-pending.started>=30000){
                const started=Date.now(),pollGapMs=pending?started-pending.started:null;
                const result=luxmedSearchSlots(id,params).then(terms=>{
                    console.log('[LuxMed monitor] Search timing',{accountId:id,pollGapMs,searchMs:Date.now()-started,slots:terms.length});
                    return terms;
                });
                pending={started,result};recentSearches.set(key,pending);
                if(recentSearches.size>1000)recentSearches.delete(recentSearches.keys().next().value!);
            }
            return pending.result;
        };
        try {
            for(const config of configs) {
                const started=Date.now();
                const smart=smartStore.enrollment(config.id);
                if(smart)smartStore.db.prepare('UPDATE luxmed_smart_monitors SET next_check=? WHERE monitoring_id=?').run(started+30000+Math.floor(Math.random()*3000),config.id);
                if(config.lastCheck)console.log('[LuxMed monitor] Time since previous result',{monitorId:config.id,sinceResultMs:started-Date.parse(config.lastCheck)});
                await processMonitoring(config,search);
                lastAccountMonitor.set(accountId,config.id);
            }
        }finally{runningAccounts.delete(accountId);}
    }));
}
