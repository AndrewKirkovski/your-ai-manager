import type TelegramBot from 'node-telegram-bot-api';
import type { Tool } from './tool.types';
import { smartStore, digest, preparationFacts, requiresPreparation, type SelectedClinicIdentity } from './luxmedSmartStore';
import { smartBooking, smartConfigurationIssue, matchesMonitor, monitorReservationCoverage, monitorRulesFingerprint } from './luxmedSmartBooking';
import { BOOKING_ZONE, compareFeasible, type AvailabilityPolicy, type Commitment, type Place, type TimeRule } from './luxmedAvailability';
import { escapeHtml } from './telegramFormat';
import { DateTime } from 'luxon';
import { getActiveLuxmedMonitoringsByUser, getLuxmedAccountId, type LuxmedMonitoringConfig } from './userStore';
import { luxmedSearchSlots, luxmedGetMonitorings, luxmedGetServices, luxmedGetCities, luxmedGetDoctors, luxmedEnrollSmartAccount, luxmedLegacyBookingBarrier, luxmedSmartEnrollment } from './luxmedAdapter';
import { providerIdentityFingerprint, selectedDoctorNames, uniqueCityName, uniqueServiceName } from './luxmedProviderIdentity';
import { providerCityMatches, resolveStreetAddress } from './googleRoutes';
import { availabilityTurn, requireCurrentAvailabilityTurn } from './luxmedConversation';

let telegram: TelegramBot | null = null;
const weekdays = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const weekdaysRu = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const monthsRu = ['янв', 'фев', 'мар', 'апр', 'мая', 'июня', 'июля', 'авг', 'сент', 'окт', 'нояб', 'дек'];
const AGAIN_RU = 'попроси меня заново показать правила записи.';
/** An error whose English text goes to logs, status and the model, and whose Russian text goes to the Telegram user. */
class UserFacingError extends Error {
    constructor(message: string, readonly ru: string) { super(message); }
}
function russianError(error: unknown): string {
    if (error instanceof UserFacingError) return error.ru;
    return error instanceof Error
        ? `не получилось включить автозапись. техническая причина: ${error.message}`
        : 'не получилось включить автозапись.';
}
function sharedAccountError(): UserFacingError {
    return new UserFacingError('This LuxMed account is linked to more than one bot user. Resolve account ownership before smart booking.',
        'этот аккаунт LuxMed привязан к нескольким пользователям бота. сначала надо разобраться, чей он, потом включать автозапись.');
}
function requireCurrentConversation(userId: number): void {
    requireCurrentAvailabilityTurn(userId);
}
function ruDate(iso: string): string {
    const d = DateTime.fromISO(iso, { zone: BOOKING_ZONE });
    if (!d.isValid) return escapeHtml(iso);
    return `${d.day} ${monthsRu[d.month - 1]}${d.year === DateTime.now().setZone(BOOKING_ZONE).year ? '' : ` ${d.year}`}`;
}
function ruPlural(n: number, one: string, few: string, many: string): string {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    return m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}
function ruRuleLimits(r: TimeRule): string {
    return `${r.validFrom ? `, с ${ruDate(r.validFrom)}` : ''}${r.validTo ? `, по ${ruDate(r.validTo)}` : ''}${r.exceptDates?.length ? `, кроме ${r.exceptDates.map(ruDate).join(', ')}` : ''}`;
}
function ruRuleDays(r: TimeRule, days: number[] = r.weekdays ?? []): string {
    return r.date ? ruDate(r.date) : days.map(d => weekdaysRu[d]).join(', ') || 'каждый день';
}
function ruTimeRange(from: string, to: string): string {
    return `${escapeHtml(from)}–${escapeHtml(to)}`;
}
/** Groups windows with the same hours so the user reads "пн, вт, ср — 10:00–19:00" instead of one line per rule. */
function ruWindowLines(windows: TimeRule[]): string[] {
    const groups = new Map<string, { rule: TimeRule; days: Set<number> }>();
    for (const w of windows) {
        const key = JSON.stringify([w.date ?? null, w.from, w.to, w.validFrom ?? null, w.validTo ?? null, w.exceptDates ?? []]);
        const group = groups.get(key) ?? { rule: w, days: new Set<number>() };
        for (const day of w.weekdays ?? []) group.days.add(day);
        groups.set(key, group);
    }
    return [...groups.values()]
        .map(({ rule, days }) => ({ rule, days: [...days].sort((a, b) => a - b) }))
        .sort((a, b) => (a.rule.date ? 8 : a.days[0] ?? 8) - (b.rule.date ? 8 : b.days[0] ?? 8))
        .map(({ rule, days }) => `• ${ruRuleDays(rule, days)} — ${ruTimeRange(rule.from, rule.to)}${ruRuleLimits(rule)}`);
}
/** Everything the Russian preview shows. Text fields are raw provider or user text; the renderer escapes them. */
export interface SmartPreviewRu {
    serviceName: string; cityName: string; englishOnly: boolean;
    doctorNames: string[] | null; clinicFilterNames: string[] | null;
    dateFrom: string; dateTo: string; timeFrom: string; timeTo: string;
    policy: AvailabilityPolicy | null; places: Map<string, Place>; scheduleAppointments: Commitment[];
    clinics: { name: string; address: string | null }[];
    preparations: { clinicName: string; items: { header: string; text: string }[] }[];
    incompletePreparation: number; legacyNames: string[]; rebookIfExists: boolean; autobook: boolean;
    slotCount: number;
    examples: { start: number; leaveAt: number; travelSeconds: number; taxiLegs: number; telemedicine: boolean; clinicName: string | null }[];
}
/** Renders the preview as Telegram HTML lines. Each line opens and closes its own tags, so chunks can split between any two lines. */
export function smartPreviewLinesRu(d: SmartPreviewRu): string[] {
    const e = escapeHtml, p = d.policy;
    const filters = [`${e(d.serviceName)}, ${e(d.cityName)}`];
    if (d.englishOnly) filters.push('только англоговорящие врачи');
    if (d.doctorNames) filters.push(`только ${d.doctorNames.length === 1 ? 'врач' : 'врачи'}: ${d.doctorNames.map(e).join(', ')}`);
    if (d.clinicFilterNames) filters.push(`только ${d.clinicFilterNames.length === 1 ? 'клиника' : 'клиники'}: ${d.clinicFilterNames.map(e).join(', ')}`);
    const fullDay = d.timeFrom <= '00:00' && d.timeTo >= '23:59';
    const narrows = !fullDay && (!p || !p.windows.length
        || p.windows.some(w => w.to <= w.from || w.from < d.timeFrom || w.to > d.timeTo));
    const lines = [`<b>${e(d.serviceName)} — правила записи</b>`, '',
        `<b>что ищу:</b> ${filters.join(', ')}`,
        `<b>период:</b> с ${ruDate(d.dateFrom)} по ${ruDate(d.dateTo)}${narrows ? `, в пределах ${ruTimeRange(d.timeFrom, d.timeTo)}` : ''}`];
    if (!p) lines.push('', '<b>когда тебе удобно:</b> пока не знаю. скинь свободное время, дела и где ты будешь.');
    else {
        lines.push('', '<b>когда тебе удобно</b> (время уже с дорогой):', ...ruWindowLines(p.windows));
        const busy: [Commitment, boolean][] = [...p.commitments.map(c => [c, false] as [Commitment, boolean]),
            ...d.scheduleAppointments.map(c => [c, true] as [Commitment, boolean])];
        if (busy.length) lines.push('', '<b>занято:</b>', ...busy.map(([c, fromSchedule]) => {
            const address = d.places.get(c.locationId || '')?.address;
            return `• ${e(c.name)}${fromSchedule ? ' (запись из моего расписания)' : ''}: ${ruRuleDays(c)}, ${ruTimeRange(c.from, c.to)}${ruRuleLimits(c)}, ${address ? `где: ${e(address)}` : 'где, ещё надо уточнить'}`;
        }));
        const origin = d.places.get(p.originLocationId)?.address;
        const modes: string[] = [];
        if (p.maxTransitMinutes > 0) modes.push(`общественным транспортом не дольше ${p.maxTransitMinutes} мин на одну поездку`);
        if (p.maxTaxiMinutes > 0) modes.push(`${p.maxTransitMinutes > 0 ? 'если не успеваю, ' : ''}такси не дольше ${p.maxTaxiMinutes} мин`);
        lines.push('', `<b>дорога:</b> ${origin ? `из ${e(origin)}` : 'откуда выезжаешь, ещё надо уточнить'}; ${modes.join(', ') || 'поездки выключены'}.`,
            `<b>запас по времени:</b> 10 мин на регистрацию до приёма, 10 мин после приёма, 5 мин после других дел${p.maxTaxiMinutes > 0 ? ', 5 мин на подачу такси' : ''}. если маршрут не пересчитан заново, накидываю ещё немного на дорогу.`,
            '<b>как выбираю:</b> самый ранний подходящий день, потом вариант без такси, потом твои пожелания.');
        if (p.softPreferences.length) lines.push(`<b>пожелания:</b> ${p.softPreferences.map(e).join('; ')}`);
        if (p.unresolved.length) lines.push(`<b>надо уточнить:</b> ${p.unresolved.map(e).join('; ')}. пока не уточним, никуда не запишу.`);
    }
    if (d.clinics.length) lines.push('', '<b>клиники:</b>', ...d.clinics.map(c => c.address
        ? `• ${e(c.name)} — ${e(c.address)}`
        : `• ${e(c.name)} — адрес не нашёл, ${d.autobook ? 'туда не запишу' : 'слоты там пропускаю'}`));
    if (d.preparations.length) {
        lines.push('', '<b>подготовка</b> (текст LuxMed как есть, кнопкой ты подтверждаешь и её):');
        for (const prep of d.preparations) lines.push(`<i>${e(prep.clinicName)}:</i>`, ...prep.items.map(item =>
            `• ${item.header ? `<b>${e(item.header.replace(/\s+/g, ' '))}</b>: ` : ''}${e(item.text)}`));
    }
    if (d.incompletePreparation) lines.push('', `к ${d.incompletePreparation} ${ruPlural(d.incompletePreparation, 'слоту', 'слотам', 'слотам')} LuxMed не дал полных инструкций по подготовке, ${d.autobook ? 'на них сам не запишу' : 'про них писать не буду'}.`);
    if (d.legacyNames.length) lines.push('', `<b>старые автозаписи</b>, которые я выключу, чтобы не записать тебя дважды: ${d.legacyNames.map(e).join(', ')}`);
    if (d.rebookIfExists) lines.push('', 'если у тебя уже есть такая запись, заменю её на подходящую.');
    lines.push('', d.slotCount
        ? `<b>что есть прямо сейчас:</b> ${d.slotCount} ${ruPlural(d.slotCount, 'подходящий слот', 'подходящих слота', 'подходящих слотов')}`
        : '<b>что есть прямо сейчас:</b> подходящих слотов пока нет, буду ждать.');
    for (const x of d.examples) {
        const start = DateTime.fromMillis(x.start, { zone: BOOKING_ZONE });
        const when = `${weekdaysRu[start.weekday]}, ${start.day} ${monthsRu[start.month - 1]}, ${start.toFormat('HH:mm')}${x.clinicName ? `, ${e(x.clinicName)}` : ''}`;
        const trip = x.telemedicine ? 'онлайн, ехать никуда не надо'
            : `выйти в ${DateTime.fromMillis(x.leaveAt, { zone: BOOKING_ZONE }).toFormat('HH:mm')}, ${Math.ceil(x.travelSeconds / 60)} мин в пути${x.taxiLegs > 0 ? ', часть пути на такси' : ''}`;
        lines.push(`• ${when} — ${trip}`);
    }
    return lines;
}
export function smartConfirmPromptRu(autobook: boolean): string {
    return autobook
        ? 'жми кнопку ниже один раз — дальше я сам запишу тебя на первый подходящий слот и напишу, куда и когда. по каждому слоту спрашивать не буду.'
        : 'жми кнопку — буду писать, когда найду подходящий слот, сам записывать не буду.';
}
/** Splits HTML lines into Telegram messages. Splits only between lines; a line longer than the limit loses its tags and is cut outside entities. */
export function htmlChunks(lines: string[], limit = 3500): string[] {
    const max = limit - 1; // room for the line break
    const pieces = lines.flatMap(line => {
        if (line.length <= max) return [line];
        let rest = line.replace(/<\/?[bi]>/g, ''); const parts: string[] = [];
        while (rest.length > max) {
            let cut = max;
            const amp = rest.lastIndexOf('&', cut - 1);
            if (amp >= 0 && amp > cut - 6 && rest.indexOf(';', amp) >= cut) cut = amp;
            parts.push(rest.slice(0, cut)); rest = rest.slice(cut);
        }
        return [...parts, rest];
    });
    const chunks: string[] = []; let chunk = '';
    for (const line of pieces) {
        if (chunk && chunk.length + line.length + 1 > limit) { chunks.push(chunk); chunk = ''; }
        chunk += `${line}\n`;
    }
    if (chunk.trim()) chunks.push(chunk);
    return chunks;
}
function ruleText(r: TimeRule): string {
    return `${r.date || r.weekdays?.map(d => weekdays[d]).join(', ')} ${r.from} to ${r.to}${r.validFrom ? ` from ${r.validFrom}` : ''}${r.validTo ? ` until ${r.validTo}` : ''}${r.exceptDates?.length ? ` except ${r.exceptDates.join(', ')}` : ''}`;
}
function otherLegacyBotAutoMonitors(accountId: number, monitoringId: string): { id: string; service_name: string }[] {
    return smartStore.db.prepare(`SELECT m.id,m.service_name FROM luxmed_monitorings m
        WHERE m.account_id=? AND m.id<>? AND m.active=1 AND m.autobook=1
        AND NOT EXISTS (SELECT 1 FROM luxmed_smart_monitors s WHERE s.monitoring_id=m.id)
        ORDER BY m.created_at,m.id`).all(accountId, monitoringId) as { id: string; service_name: string }[];
}
export function availabilitySummary(userId: number): string {
    const saved = smartStore.policy(userId);
    if (!saved) return 'When can you book? Tell me your free times, commitments and where you will be.';
    const p = saved.policy, places = smartStore.places(userId);
    return [`Availability (${p.timezone}), revision ${saved.revision}:`,
    ...p.windows.map(w => `Available including travel: ${ruleText(w)}`),
    ...p.commitments.map(c => `Busy: ${c.name}, ${ruleText(c)}, at ${places.get(c.locationId || '')?.address || 'location needs clarification'}`),
    ...smartStore.scheduleAppointments(userId).map(c => `Bot schedule appointment: ${c.name}, ${ruleText(c)}, at ${places.get(c.locationId || '')?.address || 'location needs clarification'}`),
    `Default starting location: ${places.get(p.originLocationId)?.address || 'needs confirmation'}`,
    `Public transport: up to ${p.maxTransitMinutes} minutes per leg. Taxi fallback: up to ${p.maxTaxiMinutes} minutes per leg.`,
        'Buffers: 5 minutes after commitments, 10 minutes for check-in, 10 minutes after visits, 5 minutes for taxi pickup. Cached estimates include an additional travel allowance.',
        'Priority: earliest feasible day, then public transport, then your preferences. Confirmed rules are used if Jev is unavailable.',
    `Preferences: ${p.softPreferences.join('; ') || 'none'}. Required preparation is confirmed for each exact service, clinic and instruction set.`,
    ...(p.unresolved.length ? [`Please clarify: ${p.unresolved.join('; ')}`] : []),
    ].join('\n');
}
async function verifiedMonitorIdentity(monitor: LuxmedMonitoringConfig): Promise<{
    serviceName: string; cityName: string; doctorNames: Map<number, string>; fingerprint: string
}> {
    const [services, cities, doctors] = await Promise.all([
        luxmedGetServices(monitor.accountId), luxmedGetCities(monitor.accountId),
        monitor.doctorIds === null ? Promise.resolve([]) : luxmedGetDoctors(monitor.accountId, monitor.cityId, monitor.serviceId),
    ]);
    const serviceName = uniqueServiceName(services, monitor.serviceId);
    const cityName = uniqueCityName(cities, monitor.cityId);
    const doctorNames = selectedDoctorNames(doctors, monitor.doctorIds);
    if (!serviceName || !cityName || !doctorNames)
        throw new UserFacingError('LuxMed could not verify the selected service, city or doctors. Refresh the provider lists and request a new preview.',
            `LuxMed не узнал выбранную услугу, город или врачей. обнови у меня списки LuxMed, потом ${AGAIN_RU}`);
    return { serviceName, cityName, doctorNames,
        fingerprint: providerIdentityFingerprint(monitor.serviceId, serviceName, monitor.cityId, cityName, doctorNames) };
}
function verifiedSelectedClinics(monitor: LuxmedMonitoringConfig, cityName: string): {
    identities: SelectedClinicIdentity[]; fingerprint: string | null
} {
    if (monitor.clinicIds === null) return { identities: [], fingerprint: null };
    const identities = smartStore.selectedClinicIdentities(monitor.userId, monitor.cityId, monitor.clinicIds);
    if (!identities || identities.some(clinic => !providerCityMatches(cityName, clinic.address))) {
        throw new UserFacingError('A selected exact clinic ID has no provider-verified name and street address. Wait for an observed slot at that clinic, verify its address, then request a new preview. Facility group IDs are not exact clinic IDs.',
            `у выбранной клиники ещё нет проверенного названия и адреса. как только LuxMed покажет в ней хотя бы один слот, я проверю адрес, и тогда ${AGAIN_RU} ещё проверь, что выбрана сама клиника, а не группа клиник.`);
    }
    return { identities, fingerprint: digest(identities) };
}
export function availabilityContext(userId: number): string {
    const saved = smartStore.policy(userId);
    if (!saved) return '';
    return `\nLuxMed availability: ${JSON.stringify(saved)}\nSaved locations: ${JSON.stringify([...smartStore.places(userId).values()])}\nWhen a message changes availability, use LuxmedDraftAvailability and clarify missing details. Never assume a reminder or due date blocks time. Never claim a policy is active before the user clicks its confirmation button. If this message does not change scheduling, use LuxmedAvailabilityReviewed with the exact hold token above. Do not release a hold for an ambiguous scheduling message.\n`;
}

export function initSmartBookingTools(bot: TelegramBot): void {
    telegram = bot;
    bot.on('callback_query', query => {
        if (!query.data?.startsWith('luxconfirm:')) return;
        void (async () => {
            let activatingMonitorId: string | null = null;
            try {
                const [, monitorId, revisionText, token] = query.data!.split(':');
                const userId = query.from.id;
                if (query.message?.chat.type !== 'private' || query.message.chat.id !== userId) throw new UserFacingError('Confirm in your private chat.', 'подтверждать надо у меня в личке.');
                const monitor = getActiveLuxmedMonitoringsByUser(userId).find(m => m.id === monitorId);
                if (!monitor) throw new UserFacingError('Monitoring is no longer active.', 'этот поиск записи уже выключен.');
                if (!smartStore.soleAccountOwner(userId, monitor.accountId)) throw sharedAccountError();
                if (monitor.rebookIfExists) throw new UserFacingError('Automatic replacement is not available yet. Create a monitor without replacement and request a new preview.',
                    `заменять уже существующую запись я пока не умею. давай настроим поиск без замены, потом ${AGAIN_RU}`);
                const issue = await smartBooking.readiness(true); if (issue) throw new UserFacingError(issue, `не получилось включить автозапись: у меня что-то не готово. техническая причина: ${issue}`);
                // Validate ownership, revision and token before any sidecar mutation.
                const row = smartStore.db.prepare('SELECT revision,confirmation_token,confirmation_expires FROM luxmed_availability WHERE user_id=?').get(userId) as any;
                if (!row || row.revision !== Number(revisionText) || row.confirmation_token !== token || row.confirmation_expires < Date.now()) throw new UserFacingError('This confirmation expired. Request a new preview.', `эта кнопка устарела. ${AGAIN_RU}`);
                const staged = smartStore.sidecarMonitorPreview(userId, monitor.id, monitor.accountId,
                    { token, revision: Number(revisionText) });
                if (!staged || staged.monitorFingerprint !== monitorRulesFingerprint(monitor))
                    throw new UserFacingError('Monitor booking rules changed or were not confirmed. Request a new preview.', `правила поиска записи поменялись или не были подтверждены. ${AGAIN_RU}`);
                const providerIdentity = await verifiedMonitorIdentity(monitor);
                if (providerIdentity.fingerprint !== staged.providerIdentityFingerprint
                    || providerIdentity.serviceName !== staged.providerServiceName)
                    throw new UserFacingError('LuxMed changed the selected service, city or doctors. Request a new preview.', `LuxMed поменял выбранную услугу, город или врачей. ${AGAIN_RU}`);
                if (verifiedSelectedClinics(monitor, providerIdentity.cityName).fingerprint !== staged.clinicIdentityFingerprint)
                    throw new UserFacingError('A selected clinic changed since the preview. Request a new preview.', `выбранная клиника поменялась, пока ты смотрел правила. ${AGAIN_RU}`);
                const accepted = smartStore.db.transaction(() => {
                    const currentMonitor = getActiveLuxmedMonitoringsByUser(userId).find(m => m.id === monitor.id && m.accountId === monitor.accountId);
                    if (!currentMonitor || monitorRulesFingerprint(currentMonitor) !== staged.monitorFingerprint)
                        throw new UserFacingError('Monitor booking rules changed. Request a new preview.', `правила поиска записи поменялись. ${AGAIN_RU}`);
                    if (!smartStore.soleAccountOwner(userId, monitor.accountId))
                        throw sharedAccountError();
                    if (verifiedSelectedClinics(currentMonitor, providerIdentity.cityName).fingerprint !== staged.clinicIdentityFingerprint)
                        throw new UserFacingError('A selected clinic changed. Request a new preview.', `выбранная клиника поменялась. ${AGAIN_RU}`);
                    const otherLegacy = otherLegacyBotAutoMonitors(monitor.accountId, monitor.id);
                    if (otherLegacy.length) throw new UserFacingError(`Stop other existing automatic bot monitors on this LuxMed account first: ${otherLegacy.map(m => m.id).join(', ')}.`,
                        `на этом аккаунте LuxMed у меня уже включена другая автозапись: ${otherLegacy.map(m => m.service_name).join(', ')}. сначала её надо выключить, чтобы не записать тебя дважды.`);
                    if (!smartStore.confirm(userId, token, Number(revisionText))) return false;
                    smartStore.enroll(monitor.id, userId);
                    // Hold every smart monitor for this user throughout sidecar handoff.
                    smartStore.db.prepare("UPDATE luxmed_availability SET state='activating' WHERE user_id=? AND revision=?")
                        .run(userId, Number(revisionText));
                    smartStore.db.prepare("UPDATE luxmed_smart_monitors SET state='activating',status='Stopping sidecar automatic monitors' WHERE monitoring_id=? AND user_id=?").run(monitorId, userId);
                    return true;
                })();
                if (!accepted) throw new UserFacingError('Availability changed. Request a new preview.', `расписание поменялось. ${AGAIN_RU}`);
                activatingMonitorId = monitorId;
                await luxmedEnrollSmartAccount(monitor.accountId, staged.autoMonitorIds);
                if ((await luxmedGetMonitorings(monitor.accountId)).some(m => m.active && m.autobook)) {
                    throw new UserFacingError('A sidecar automatic monitor is still active. Smart booking remains paused.', 'старая автозапись в LuxMed всё ещё включена, поэтому новую пока не включаю.');
                }
                await smartBooking.refreshReservations(monitor.accountId, monitorReservationCoverage(monitor), true);
                const finalIdentity = await verifiedMonitorIdentity(monitor);
                if (finalIdentity.fingerprint !== staged.providerIdentityFingerprint)
                    throw new UserFacingError('LuxMed changed the selected service, city or doctors during activation. Smart booking remains paused.', 'LuxMed поменял выбранную услугу, город или врачей, пока я включал автозапись. пока не включаю.');
                if (verifiedSelectedClinics(monitor, finalIdentity.cityName).fingerprint !== staged.clinicIdentityFingerprint)
                    throw new UserFacingError('A selected clinic changed during activation. Request a new preview.', `выбранная клиника поменялась, пока я включал автозапись. ${AGAIN_RU}`);
                const current = smartStore.policy(userId);
                if (!current || current.state !== 'activating' || current.holdToken || current.revision !== Number(revisionText)
                    || smartStore.accountTransition(userId)
                    || !smartStore.soleAccountOwner(userId, monitor.accountId)
                    || (smartStore.db.prepare('SELECT account_id FROM luxmed_accounts WHERE user_id=?').get(userId) as { account_id: number } | undefined)?.account_id !== monitor.accountId
                    || !getActiveLuxmedMonitoringsByUser(userId).some(m => m.id === monitor.id && m.accountId === monitor.accountId
                        && monitorRulesFingerprint(m) === staged.monitorFingerprint))
                    throw new UserFacingError('Availability or monitoring changed during activation. Smart booking remains paused.', 'расписание или настройки поиска поменялись, пока я включал автозапись. пока не включаю.');
                const activated = smartStore.db.transaction(() => {
                    const currentMonitor = getActiveLuxmedMonitoringsByUser(userId).find(m => m.id === monitor.id && m.accountId === monitor.accountId);
                    if (!currentMonitor || monitorRulesFingerprint(currentMonitor) !== staged.monitorFingerprint)
                        throw new UserFacingError('Monitor booking rules changed during activation. Smart booking remains paused.', 'правила поиска записи поменялись, пока я включал автозапись. пока не включаю.');
                    if (!smartStore.soleAccountOwner(userId, monitor.accountId))
                        throw sharedAccountError();
                    if (verifiedSelectedClinics(currentMonitor, finalIdentity.cityName).fingerprint !== staged.clinicIdentityFingerprint)
                        throw new UserFacingError('A selected clinic changed during activation. Request a new preview.', `выбранная клиника поменялась, пока я включал автозапись. ${AGAIN_RU}`);
                    const changed = smartStore.db.prepare("UPDATE luxmed_availability SET state='confirmed' WHERE user_id=? AND revision=? AND state='activating' AND hold_token IS NULL")
                        .run(userId, Number(revisionText)).changes;
                    if (!changed) return false;
                    smartStore.db.prepare('UPDATE luxmed_monitorings SET service_name=?,city_name=? WHERE id=? AND user_id=? AND account_id=?')
                        .run(staged.providerServiceName, finalIdentity.cityName, monitorId, userId, monitor.accountId);
                    const monitorChanged = smartStore.db.prepare("UPDATE luxmed_smart_monitors SET state='active',status='Monitoring with confirmed availability',next_check=0,confirmed_fingerprint=?,confirmed_provider_fingerprint=?,confirmed_clinic_fingerprint=? WHERE monitoring_id=? AND user_id=? AND state='activating'")
                        .run(staged.monitorFingerprint, staged.providerIdentityFingerprint, staged.clinicIdentityFingerprint, monitorId, userId).changes;
                    if (monitorChanged !== 1) throw new UserFacingError('Monitoring changed during activation.', 'настройки поиска записи поменялись, пока я их включал.');
                    smartStore.notify(`activation-confirmed:${monitorId}:${Number(revisionText)}`, userId,
                        monitor.autobook
                            ? `автозапись LuxMed включена: ${staged.providerServiceName}. как только найду первый подходящий слот, запишу тебя сам, спрашивать про каждый слот не буду.`
                            : `слежу за записью LuxMed: ${staged.providerServiceName}. сам записывать не буду, просто напишу, когда найду подходящий слот.`);
                    return true;
                })();
                if (!activated) throw new UserFacingError('Availability changed during activation. Smart booking remains paused.', 'расписание поменялось, пока я включал автозапись. пока не включаю.');
                activatingMonitorId = null;
                try { smartBooking.warmKnownLocations(userId); }
                catch { console.warn('[LuxMed smart] Route preparation deferred after activation'); }
                await bot.answerCallbackQuery(query.id, { text: monitor.autobook ? 'готово, правила подтверждены. дальше ищу и записываю сам.' : 'готово, правила подтверждены. напишу, когда найду слот.' }).catch(() => { });
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Confirmation failed';
                const userMessage = russianError(error);
                if (activatingMonitorId) {
                    smartStore.status(activatingMonitorId, `Activation paused: ${message}`);
                    smartStore.notify(`activation:${activatingMonitorId}:${Date.now()}`, query.from.id,
                        `автозапись LuxMed пока не включилась. ${userMessage}${userMessage.includes(AGAIN_RU) ? '' : ` чтобы попробовать ещё раз, ${AGAIN_RU}`}`);
                }
                await bot.answerCallbackQuery(query.id, { text: userMessage.slice(0, 190), show_alert: true }).catch(() => { });
            }
        })();
    });
}

export const LuxmedDraftAvailability: Tool = {
    name: 'LuxmedDraftAvailability',
    description: 'Save a complete availability draft from the user conversation. First ask "When can you book?" Clarify recurrence, dates, locations, journey limits and preparation. This PAUSES smart booking until a real Telegram confirmation. Reuse existing rules unless the user changes them. Never invent missing details; list them in unresolved.',
    parameters: { type: 'object', properties: { policy_json: { type: 'string', description: `JSON object: {version:1,timezone:"${BOOKING_ZONE}",originLocationId:"address:home",windows:[{weekdays:[1,2,3,4,5],from:"08:00",to:"20:00"}],commitments:[{id:"polish",name:"Polish lesson",weekdays:[2],from:"09:00",to:"11:00",locationId:"school",source?:{type:"task"|"routine",id:"existing-id"}}],unresolved:[],softPreferences:[],maxTransitMinutes:45,maxTaxiMinutes:30,preparationConfirmed:false}. Each rule has either date YYYY-MM-DD or weekdays 1..7, optional validFrom/validTo/exceptDates. Overnight intervals are allowed. Examples are schema examples, not user defaults. Confirm all actual values.` } }, required: ['policy_json'] },
    execute: async ({ userId, policy_json }: { userId: number; policy_json: string }) => {
        requireCurrentConversation(userId);
        const saved = smartStore.draft(userId, JSON.parse(policy_json));
        return { success: true, state: saved.state, summary: availabilitySummary(userId), next: 'Clarify unresolved details, then call LuxmedPreviewAvailability. The user must click Confirm.' };
    },
};
export const LuxmedSaveBookingLocation: Tool = {
    name: 'LuxmedSaveBookingLocation', description: 'Resolve a user-provided street address for travel planning. Use stable IDs such as school or office. For a clinic use clinic:CITY_ID:CLINIC_ID from LuxMed. Ambiguous addresses require clarification. Changing an existing location pauses smart booking for confirmation.',
    parameters: { type: 'object', properties: { location_id: { type: 'string' }, address: { type: 'string' } }, required: ['location_id', 'address'] },
    execute: async ({ userId, location_id, address }: { userId: number; location_id: string; address: string }) => {
        requireCurrentConversation(userId);
        if (location_id.startsWith('clinic:')) return { success: false, message: 'Clinic coordinates must be verified from a LuxMed search result. An arbitrary address cannot be attached to a clinic ID.' };
        const place = await resolveStreetAddress(address);
        if (!place) return { success: false, message: 'Please provide the complete street address, building number and city. The location was ambiguous.' };
        requireCurrentConversation(userId);
        const location = smartStore.place(userId, location_id, place.address, place.lat, place.lng);
        smartStore.verifyLocation(userId, location_id, location.revision);
        return { success: true, location };
    },
};
export const LuxmedAvailabilityStatus: Tool = {
    name: 'LuxmedAvailabilityStatus', description: 'Read smart booking policy, pending questions, saved locations and monitoring status before making changes.',
    parameters: { type: 'object', properties: {} }, execute: async ({ userId }: { userId: number }) => {
        const accountId = getLuxmedAccountId(userId);
        const remote = accountId === null ? null : await Promise.allSettled([
            luxmedSmartEnrollment(accountId), luxmedLegacyBookingBarrier(accountId),
        ]);
        const sidecar = remote ? {
            enrollment: remote[0].status === 'fulfilled' ? remote[0].value : { status: 'unavailable' },
            legacyBarrier: remote[1].status === 'fulfilled' ? remote[1].value : { status: 'unavailable' },
        } : null;
        return { success: true, policy: smartStore.policy(userId), locations: [...smartStore.places(userId).values()],
            summary: availabilitySummary(userId), configuration: smartConfigurationIssue(), sidecar,
            accountTransitions: smartStore.accountTransitions(userId),
            unresolvedAttempts: smartStore.pending(userId).map(a => ({ id: a.id, accountId: a.account_id, state: a.state, createdAt: a.created_at })),
            monitors: getActiveLuxmedMonitoringsByUser(userId).map(m => ({ id: m.id, smart: smartStore.enrollment(m.id) })) };
    },
};
export const LuxmedPreviewAvailability: Tool = {
    name: 'LuxmedPreviewAvailability', description: 'Show a read-only smart booking decision preview with a real Confirm button. Existing monitoring continues until the user confirms. Call after all availability details are clarified. The user must click the button, not merely have the model call a tool.',
    parameters: { type: 'object', properties: { monitoring_id: { type: 'string' } }, required: ['monitoring_id'] },
    execute: async ({ userId, monitoring_id }: { userId: number; monitoring_id: string }) => {
        requireCurrentConversation(userId);
        if (!telegram) throw new Error('Telegram confirmation is unavailable.');
        const monitor = getActiveLuxmedMonitoringsByUser(userId).find(m => m.id === monitoring_id);
        if (!monitor) throw new Error('Monitoring not found.');
        if (!smartStore.soleAccountOwner(userId, monitor.accountId)) return { success: false,
            message: 'This LuxMed account is linked to more than one bot user. Resolve account ownership before smart booking.' };
        if (monitor.rebookIfExists) return { success: false,
            message: 'Automatic replacement is not available yet. Create a monitor without replacement before confirming smart booking.' };
        const otherLegacy = otherLegacyBotAutoMonitors(monitor.accountId, monitor.id);
        if (otherLegacy.length) return { success: false,
            message: `Stop other existing automatic bot monitors on this LuxMed account before activating smart booking: ${otherLegacy.map(m => `${m.id} (${m.service_name})`).join(', ')}. They continue their current behaviour until stopped.` };
        const issue = await smartBooking.readiness(); if (issue) return { success: false, message: issue, summary: availabilitySummary(userId) };
        const providerIdentity = await verifiedMonitorIdentity(monitor);
        const legacy = (await luxmedGetMonitorings(monitor.accountId)).filter(m => m.active && m.autobook);
        const terms = await luxmedSearchSlots(monitor.accountId, monitor);
        const preview = await smartBooking.inspect(monitor, terms, true);
        requireCurrentConversation(userId);
        if (smartStore.policy(userId)?.revision !== preview.revision) throw new Error('Availability changed while preparing the preview. Please review it again.');
        const selectedClinics = verifiedSelectedClinics(monitor, providerIdentity.cityName);
        const confirmation = smartStore.confirmation(userId);
        smartStore.stageSidecarMonitorPreview(userId, monitor.id, monitor.accountId, confirmation,
            legacy.map(m => m.recordId), monitorRulesFingerprint(monitor), providerIdentity.serviceName,
            providerIdentity.fingerprint, selectedClinics.fingerprint);
        const english = await smartBooking.english(monitor);
        const relevantTerms = terms.filter(term => matchesMonitor(term, monitor, english));
        const places = smartStore.places(userId);
        const selectedIds = new Set(selectedClinics.identities.map(clinic => clinic.clinicId));
        const clinicNames = new Map(selectedClinics.identities.map(clinic => [clinic.clinicId, clinic.sourceLabel]));
        const clinics: SmartPreviewRu['clinics'] = selectedClinics.identities.map(clinic => ({ name: clinic.sourceLabel, address: clinic.address }));
        for (const term of new Map(relevantTerms.filter(term => !term.term.isTelemedicine)
            .map(term => [term.term.clinicId, term.term])).values()) {
            if (term.clinic && !clinicNames.has(term.clinicId)) clinicNames.set(term.clinicId, term.clinic);
            const id = `clinic:${monitor.cityId}:${term.clinicId}`;
            const place = places.get(id);
            const verified = !!place && smartStore.clinicVerified(userId, id, term.clinic || '', place.revision);
            if (verified && selectedIds.has(term.clinicId)) continue; // already listed with its verified identity
            clinics.push({ name: term.clinic || `клиника №${term.clinicId}`, address: verified ? place!.address : null });
        }
        const clinicName = (clinicId: number) => clinicNames.get(clinicId) ?? `клиника №${clinicId}`;
        const incompletePreparation = relevantTerms.filter(term => requiresPreparation(term) && !preparationFacts(term)).length;
        const preparations = smartStore.stagePreparation(userId, confirmation.token, confirmation.revision, relevantTerms);
        const candidates = [...preview.candidates].sort(compareFeasible);
        const slotClinic = (locationId: string | undefined) => {
            const match = /^clinic:\d+:(\d+)$/.exec(locationId ?? '');
            return match ? clinicName(Number(match[1])) : null;
        };
        const severalClinics = new Set(candidates.map(c => c.slot.locationId)).size > 1;
        const lines = smartPreviewLinesRu({
            serviceName: providerIdentity.serviceName, cityName: providerIdentity.cityName, englishOnly: monitor.englishOnly,
            doctorNames: monitor.doctorIds === null ? null : monitor.doctorIds.map(id => providerIdentity.doctorNames.get(id) ?? `врач №${id}`),
            clinicFilterNames: monitor.clinicIds === null ? null : selectedClinics.identities.map(clinic => clinic.sourceLabel),
            dateFrom: monitor.dateFrom, dateTo: monitor.dateTo, timeFrom: monitor.timeFrom, timeTo: monitor.timeTo,
            policy: smartStore.policy(userId)?.policy ?? null, places, scheduleAppointments: smartStore.scheduleAppointments(userId),
            clinics,
            preparations: preparations.map(fact => ({ clinicName: clinicName(fact.clinicId), items: fact.items })),
            incompletePreparation,
            legacyNames: legacy.map(m => `${m.serviceName || `автозапись №${m.recordId}`}${m.clinicName ? ` (${m.clinicName})` : ''}`),
            rebookIfExists: monitor.rebookIfExists, autobook: monitor.autobook,
            slotCount: candidates.length,
            examples: candidates.slice(0, 3).map(c => ({ start: c.slot.start, leaveAt: c.leaveAt, travelSeconds: c.travelSeconds,
                taxiLegs: c.taxiLegs, telemedicine: c.slot.telemedicine, clinicName: severalClinics ? slotClinic(c.slot.locationId) : null })),
        });
        for (const part of htmlChunks(lines)) await telegram.sendMessage(userId, part, { parse_mode: 'HTML' });
        requireCurrentConversation(userId);
        await telegram.sendMessage(userId, smartConfirmPromptRu(monitor.autobook), { parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: 'подтверждаю', callback_data: `luxconfirm:${monitor.id}:${confirmation.revision}:${confirmation.token}` }]] } });
        return { success: true, message: monitor.autobook
            ? 'Preview and confirmation button sent. Await the user clicking Confirm. Confirm is a ONE-TIME confirmation of these rules, not of a slot: after it, the bot books the first suitable slot automatically without asking the user about each slot. Never tell the user they will confirm individual slots.'
            : 'Preview and confirmation button sent. Await the user clicking Confirm. Confirm is a ONE-TIME confirmation of these rules: this monitor only notifies about suitable slots and never books by itself.' };
    },
};
export const LuxmedPauseSmartBooking: Tool = {
    name: 'LuxmedPauseSmartBooking', description: 'Pause all smart booking immediately for this user.', parameters: { type: 'object', properties: {} },
    execute: async ({ userId }: { userId: number }) => { smartStore.pause(userId); return { success: true, message: 'Smart booking paused.' }; },
};
export const LuxmedAvailabilityReviewed: Tool = {
    name: 'LuxmedAvailabilityReviewed', description: 'Release the temporary incoming-message hold only after determining this message does NOT change availability, locations or travel preferences. Never use for an ambiguous schedule change. Use the exact hold token from current context.',
    parameters: { type: 'object', properties: { hold_token: { type: 'string' } }, required: ['hold_token'] },
    execute: async ({ userId, hold_token }: { userId: number; hold_token: string }) => {
        const turn = availabilityTurn.getStore();
        if (!turn || turn.userId !== userId || turn.holdToken !== hold_token || !smartStore.release(userId, hold_token)) return { success: false };
        turn.holdToken = null; // this turn released its own hold; a newer message sets a new token and still rejects it
        return { success: true };
    },
};
