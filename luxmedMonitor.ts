/**
 * LuxMed appointment monitoring loop.
 * Runs every 10 minutes, searches for slots matching active monitorings,
 * applies client-side filters (clinic list, doctor list, english-speaking),
 * and auto-books or notifies the user.
 */

import TelegramBot from 'node-telegram-bot-api';
import {
    luxmedSearchSlots, luxmedBookSlot, luxmedGetDoctors,
    LuxmedTerm,
} from './luxmedAdapter';
import {
    getActiveLuxmedMonitorings, updateLuxmedMonitoringLastCheck,
    deactivateLuxmedMonitoring, LuxmedMonitoringConfig,
} from './userStore';

let botInstance: TelegramBot | null = null;

export function initLuxmedMonitor(bot: TelegramBot): void {
    botInstance = bot;
}

// Cache english-speaking doctor IDs per city+service (refreshed each cycle)
const englishDoctorCache = new Map<string, Set<number>>();

// Track monitorings that already notified about auto-book failure (avoid spam every 10 min)
const autobookFailureNotified = new Set<string>();

async function getEnglishDoctorIds(accountId: number, cityId: number, serviceId: number): Promise<Set<number>> {
    const key = `${accountId}:${cityId}:${serviceId}`;
    if (englishDoctorCache.has(key)) return englishDoctorCache.get(key)!;

    try {
        const doctors = await luxmedGetDoctors(accountId, cityId, serviceId);
        const englishIds = new Set(doctors.filter(d => d.isEnglishSpeaker).map(d => d.id));
        englishDoctorCache.set(key, englishIds);
        return englishIds;
    } catch {
        return new Set();
    }
}

function filterTerms(terms: LuxmedTerm[], config: LuxmedMonitoringConfig, englishDoctorIds: Set<number>): LuxmedTerm[] {
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
            if (!englishDoctorIds.has(term.doctor.id)) {
                return false;
            }
        }

        return true;
    });
}

function formatTermForNotification(t: LuxmedTerm): string {
    const term = t.term;
    const dt = term.dateTimeFrom.dateTimeLocal || term.dateTimeFrom.dateTimeTz || '?';
    const doctor = `${term.doctor.academicTitle} ${term.doctor.firstName} ${term.doctor.lastName}`.trim();
    const tele = term.isTelemedicine ? ' (tele)' : '';
    return `${dt} — ${doctor}, ${term.clinic}${tele}`;
}

async function processMonitoring(config: LuxmedMonitoringConfig): Promise<void> {
    // Check if monitoring date range is still valid
    const now = new Date();
    const dateTo = new Date(config.dateTo);
    if (dateTo < now) {
        deactivateLuxmedMonitoring(config.id, config.userId);
        autobookFailureNotified.delete(config.id);
        if (botInstance) {
            botInstance.sendMessage(config.userId,
                `⏰ LuxMed мониторинг "${config.serviceName}" истёк (период до ${config.dateTo}). Деактивирован.`
            ).catch(() => {});
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
        let englishDoctorIds = new Set<number>();
        if (config.englishOnly) {
            englishDoctorIds = await getEnglishDoctorIds(config.accountId, config.cityId, config.serviceId);
        }

        // Apply client-side filters
        const filtered = filterTerms(terms, config, englishDoctorIds);
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
                    botInstance.sendMessage(config.userId, msg).catch(() => {});
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.error(`[LuxMed Monitor] ${config.id}: Auto-book failed: ${errMsg}`);
                // Don't deactivate — try again next cycle
                // But notify user only once to avoid spam every 10 min
                if (botInstance && !autobookFailureNotified.has(config.id)) {
                    autobookFailureNotified.add(config.id);
                    const slotsText = filtered.slice(0, 5).map((t, i) => `${i + 1}. ${formatTermForNotification(t)}`).join('\n');
                    const msg = `⚠️ LuxMed: Нашёл слоты для "${config.serviceName}", но автозапись не удалась (${errMsg}).\n\nДоступные слоты:\n${slotsText}\n\nЗапиши вручную через бот. Мониторинг продолжает попытки автозаписи.`;
                    botInstance.sendMessage(config.userId, msg).catch(() => {});
                }
            }
        } else {
            // Just notify
            deactivateLuxmedMonitoring(config.id, config.userId);
            autobookFailureNotified.delete(config.id);
            if (botInstance) {
                const slotsText = filtered.slice(0, 5).map((t, i) => `${i + 1}. ${formatTermForNotification(t)}`).join('\n');
                const msg = `🔔 LuxMed: Нашёл ${filtered.length} слот(ов) для "${config.serviceName}"!\n\n${slotsText}${filtered.length > 5 ? `\n... и ещё ${filtered.length - 5}` : ''}\n\nИспользуй LuxmedSearchSlots чтобы найти и записаться.`;
                botInstance.sendMessage(config.userId, msg).catch(() => {});
            }
        }
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[LuxMed Monitor] ${config.id}: Error checking "${config.serviceName}": ${errMsg}`);
        // If auth error, notify user and deactivate
        if (errMsg.includes('Invalid login') || errMsg.includes('password')) {
            deactivateLuxmedMonitoring(config.id, config.userId);
            autobookFailureNotified.delete(config.id);
            if (botInstance) {
                botInstance.sendMessage(config.userId,
                    `❌ LuxMed: Ошибка авторизации. Мониторинг "${config.serviceName}" деактивирован. Обнови логин/пароль.`
                ).catch(() => {});
            }
        }
    }
}

export async function runLuxmedMonitoringCycle(): Promise<void> {
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
}
