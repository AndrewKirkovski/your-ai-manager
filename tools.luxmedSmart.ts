import type TelegramBot from 'node-telegram-bot-api';
import type { Tool } from './tool.types';
import { smartStore, digest, preparationFacts, requiresPreparation, type SelectedClinicIdentity } from './luxmedSmartStore';
import { smartBooking, smartConfigurationIssue, matchesMonitor, monitorReservationCoverage, monitorRulesFingerprint } from './luxmedSmartBooking';
import { BOOKING_ZONE, compareFeasible, type TimeRule } from './luxmedAvailability';
import { DateTime } from 'luxon';
import { getActiveLuxmedMonitoringsByUser, getLuxmedAccountId, type LuxmedMonitoringConfig } from './userStore';
import { luxmedSearchSlots, luxmedGetMonitorings, luxmedGetServices, luxmedGetCities, luxmedGetDoctors, luxmedEnrollSmartAccount, luxmedLegacyBookingBarrier, luxmedSmartEnrollment } from './luxmedAdapter';
import { providerIdentityFingerprint, selectedDoctorNames, uniqueCityName, uniqueServiceName } from './luxmedProviderIdentity';
import { providerCityMatches, resolveStreetAddress } from './googleRoutes';
import { availabilityTurn, requireCurrentAvailabilityTurn } from './luxmedConversation';

let telegram: TelegramBot | null = null;
const weekdays = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const weekdaysRu = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
type SummaryLanguage = 'en' | 'ru';
/** An error whose English text goes to logs, status and the model, and whose Russian text goes to the Telegram user. */
class UserFacingError extends Error {
    constructor(message: string, readonly ru: string) { super(message); }
}
function russianError(error: unknown): string {
    if (error instanceof UserFacingError) return error.ru;
    return `не получилось: ${error instanceof Error ? error.message : 'подтверждение не прошло'}`;
}
function sharedAccountError(): UserFacingError {
    return new UserFacingError('This LuxMed account is linked to more than one bot user. Resolve account ownership before smart booking.',
        'этот аккаунт LuxMed привязан к нескольким пользователям бота. сначала надо разобраться, чей он, потом включать умную запись.');
}
function requireCurrentConversation(userId: number): void {
    requireCurrentAvailabilityTurn(userId);
}
function ruleText(r: TimeRule, lang: SummaryLanguage = 'en'): string {
    if (lang === 'ru') return `${r.date || r.weekdays?.map(d => weekdaysRu[d]).join(', ')} с ${r.from} до ${r.to}${r.validFrom ? `, начиная с ${r.validFrom}` : ''}${r.validTo ? `, по ${r.validTo}` : ''}${r.exceptDates?.length ? `, кроме ${r.exceptDates.join(', ')}` : ''}`;
    return `${r.date || r.weekdays?.map(d => weekdays[d]).join(', ')} ${r.from} to ${r.to}${r.validFrom ? ` from ${r.validFrom}` : ''}${r.validTo ? ` until ${r.validTo}` : ''}${r.exceptDates?.length ? ` except ${r.exceptDates.join(', ')}` : ''}`;
}
function otherLegacyBotAutoMonitors(accountId: number, monitoringId: string): { id: string; service_name: string }[] {
    return smartStore.db.prepare(`SELECT m.id,m.service_name FROM luxmed_monitorings m
        WHERE m.account_id=? AND m.id<>? AND m.active=1 AND m.autobook=1
        AND NOT EXISTS (SELECT 1 FROM luxmed_smart_monitors s WHERE s.monitoring_id=m.id)
        ORDER BY m.created_at,m.id`).all(accountId, monitoringId) as { id: string; service_name: string }[];
}
export function availabilitySummary(userId: number, lang: SummaryLanguage = 'en'): string {
    const saved = smartStore.policy(userId);
    if (!saved) return lang === 'ru' ? 'когда тебя можно записывать? скинь свободное время, дела и где ты будешь.' : 'When can you book? Tell me your free times, commitments and where you will be.';
    const p = saved.policy, places = smartStore.places(userId);
    if (lang === 'ru') return [`расписание (${p.timezone}), ревизия ${saved.revision}:`,
    ...p.windows.map(w => `свободен, включая дорогу: ${ruleText(w, 'ru')}`),
    ...p.commitments.map(c => `занят: ${c.name}, ${ruleText(c, 'ru')}, где: ${places.get(c.locationId || '')?.address || 'место надо уточнить'}`),
    ...smartStore.scheduleAppointments(userId).map(c => `запись из моего расписания: ${c.name}, ${ruleText(c, 'ru')}, где: ${places.get(c.locationId || '')?.address || 'место надо уточнить'}`),
    `откуда выезжаешь по умолчанию: ${places.get(p.originLocationId)?.address || 'надо подтвердить'}`,
    `общественный транспорт: до ${p.maxTransitMinutes} мин на отрезок. такси как запасной вариант: до ${p.maxTaxiMinutes} мин на отрезок.`,
        'запас: 5 мин после дел, 10 мин на регистрацию, 10 мин после визита, 5 мин на подачу такси. к закэшированным маршрутам добавляю ещё запас на дорогу.',
        'приоритет: самый ранний подходящий день, потом общественный транспорт, потом твои пожелания. если Jev недоступен, работаю по подтверждённым правилам.',
    `пожелания: ${p.softPreferences.join('; ') || 'нет'}. обязательную подготовку подтверждаешь отдельно для каждой конкретной услуги, клиники и набора инструкций.`,
    ...(p.unresolved.length ? [`надо уточнить: ${p.unresolved.join('; ')}`] : []),
    ].join('\n');
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
export function monitorFilterSummary(monitor: Pick<LuxmedMonitoringConfig, 'clinicIds' | 'doctorIds' | 'englishOnly'>,
    doctorNames: Map<number, string> = new Map(), lang: SummaryLanguage = 'en'): string {
    if (lang === 'ru') {
        const idsRu = (value: number[] | null) => value === null ? 'любые' : value.length ? value.join(', ') : 'пустой фильтр, так нельзя';
        const doctorsRu = monitor.doctorIds === null ? 'любые' : monitor.doctorIds.map(id => `${id} (${doctorNames.get(id) || 'не проверен'})`).join(', ');
        return `ID клиник: ${idsRu(monitor.clinicIds)}.\nID врачей: ${doctorsRu}.\nтолько англоговорящие врачи: ${monitor.englishOnly ? 'да' : 'нет'}.`;
    }
    const ids = (value: number[] | null) => value === null ? 'any' : value.length ? value.join(', ') : 'invalid empty filter';
    const doctors = monitor.doctorIds === null ? 'any' : monitor.doctorIds.map(id => `${id} (${doctorNames.get(id) || 'unverified'})`).join(', ');
    return `Clinic IDs: ${ids(monitor.clinicIds)}.\nDoctor IDs: ${doctors}.\nEnglish-speaking doctors only: ${monitor.englishOnly ? 'yes' : 'no'}.`;
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
            'LuxMed не подтвердил выбранную услугу, город или врачей. надо обновить списки LuxMed и попросить новое превью.');
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
            'у выбранной клиники (точный ID) нет проверенного по LuxMed названия и адреса. надо дождаться слота в этой клинике, проверить адрес и попросить новое превью. ID группы клиник это не точный ID клиники.');
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
                if (!monitor) throw new UserFacingError('Monitoring is no longer active.', 'этот мониторинг уже не активен.');
                if (!smartStore.soleAccountOwner(userId, monitor.accountId)) throw sharedAccountError();
                if (monitor.rebookIfExists) throw new UserFacingError('Automatic replacement is not available yet. Create a monitor without replacement and request a new preview.',
                    'автозамену существующей записи я пока не умею. создай мониторинг без замены и попроси новое превью.');
                const issue = await smartBooking.readiness(true); if (issue) throw new UserFacingError(issue, `умная запись пока не готова: ${issue}`);
                // Validate ownership, revision and token before any sidecar mutation.
                const row = smartStore.db.prepare('SELECT revision,confirmation_token,confirmation_expires FROM luxmed_availability WHERE user_id=?').get(userId) as any;
                if (!row || row.revision !== Number(revisionText) || row.confirmation_token !== token || row.confirmation_expires < Date.now()) throw new UserFacingError('This confirmation expired. Request a new preview.', 'это подтверждение протухло. попроси новое превью.');
                const staged = smartStore.sidecarMonitorPreview(userId, monitor.id, monitor.accountId,
                    { token, revision: Number(revisionText) });
                if (!staged || staged.monitorFingerprint !== monitorRulesFingerprint(monitor))
                    throw new UserFacingError('Monitor booking rules changed or were not confirmed. Request a new preview.', 'правила мониторинга поменялись или не были подтверждены. попроси новое превью.');
                const providerIdentity = await verifiedMonitorIdentity(monitor);
                if (providerIdentity.fingerprint !== staged.providerIdentityFingerprint
                    || providerIdentity.serviceName !== staged.providerServiceName)
                    throw new UserFacingError('LuxMed changed the selected service, city or doctors. Request a new preview.', 'LuxMed поменял выбранную услугу, город или врачей. попроси новое превью.');
                if (verifiedSelectedClinics(monitor, providerIdentity.cityName).fingerprint !== staged.clinicIdentityFingerprint)
                    throw new UserFacingError('A selected clinic changed since the preview. Request a new preview.', 'выбранная клиника поменялась после превью. попроси новое превью.');
                const accepted = smartStore.db.transaction(() => {
                    const currentMonitor = getActiveLuxmedMonitoringsByUser(userId).find(m => m.id === monitor.id && m.accountId === monitor.accountId);
                    if (!currentMonitor || monitorRulesFingerprint(currentMonitor) !== staged.monitorFingerprint)
                        throw new UserFacingError('Monitor booking rules changed. Request a new preview.', 'правила мониторинга поменялись. попроси новое превью.');
                    if (!smartStore.soleAccountOwner(userId, monitor.accountId))
                        throw sharedAccountError();
                    if (verifiedSelectedClinics(currentMonitor, providerIdentity.cityName).fingerprint !== staged.clinicIdentityFingerprint)
                        throw new UserFacingError('A selected clinic changed. Request a new preview.', 'выбранная клиника поменялась. попроси новое превью.');
                    const otherLegacy = otherLegacyBotAutoMonitors(monitor.accountId, monitor.id);
                    if (otherLegacy.length) throw new UserFacingError(`Stop other existing automatic bot monitors on this LuxMed account first: ${otherLegacy.map(m => m.id).join(', ')}.`,
                        `сначала останови другие мои автоматические мониторинги на этом аккаунте LuxMed: ${otherLegacy.map(m => m.id).join(', ')}.`);
                    if (!smartStore.confirm(userId, token, Number(revisionText))) return false;
                    smartStore.enroll(monitor.id, userId);
                    // Hold every smart monitor for this user throughout sidecar handoff.
                    smartStore.db.prepare("UPDATE luxmed_availability SET state='activating' WHERE user_id=? AND revision=?")
                        .run(userId, Number(revisionText));
                    smartStore.db.prepare("UPDATE luxmed_smart_monitors SET state='activating',status='Stopping sidecar automatic monitors' WHERE monitoring_id=? AND user_id=?").run(monitorId, userId);
                    return true;
                })();
                if (!accepted) throw new UserFacingError('Availability changed. Request a new preview.', 'расписание поменялось. попроси новое превью.');
                activatingMonitorId = monitorId;
                await luxmedEnrollSmartAccount(monitor.accountId, staged.autoMonitorIds);
                if ((await luxmedGetMonitorings(monitor.accountId)).some(m => m.active && m.autobook)) {
                    throw new UserFacingError('A sidecar automatic monitor is still active. Smart booking remains paused.', 'в сайдкаре ещё работает автоматический мониторинг. умная запись остаётся на паузе.');
                }
                await smartBooking.refreshReservations(monitor.accountId, monitorReservationCoverage(monitor), true);
                const finalIdentity = await verifiedMonitorIdentity(monitor);
                if (finalIdentity.fingerprint !== staged.providerIdentityFingerprint)
                    throw new UserFacingError('LuxMed changed the selected service, city or doctors during activation. Smart booking remains paused.', 'LuxMed поменял выбранную услугу, город или врачей, пока я включал запись. умная запись остаётся на паузе.');
                if (verifiedSelectedClinics(monitor, finalIdentity.cityName).fingerprint !== staged.clinicIdentityFingerprint)
                    throw new UserFacingError('A selected clinic changed during activation. Request a new preview.', 'выбранная клиника поменялась, пока я включал запись. попроси новое превью.');
                const current = smartStore.policy(userId);
                if (!current || current.state !== 'activating' || current.holdToken || current.revision !== Number(revisionText)
                    || smartStore.accountTransition(userId)
                    || !smartStore.soleAccountOwner(userId, monitor.accountId)
                    || (smartStore.db.prepare('SELECT account_id FROM luxmed_accounts WHERE user_id=?').get(userId) as { account_id: number } | undefined)?.account_id !== monitor.accountId
                    || !getActiveLuxmedMonitoringsByUser(userId).some(m => m.id === monitor.id && m.accountId === monitor.accountId
                        && monitorRulesFingerprint(m) === staged.monitorFingerprint))
                    throw new UserFacingError('Availability or monitoring changed during activation. Smart booking remains paused.', 'расписание или мониторинг поменялись, пока я включал запись. умная запись остаётся на паузе.');
                const activated = smartStore.db.transaction(() => {
                    const currentMonitor = getActiveLuxmedMonitoringsByUser(userId).find(m => m.id === monitor.id && m.accountId === monitor.accountId);
                    if (!currentMonitor || monitorRulesFingerprint(currentMonitor) !== staged.monitorFingerprint)
                        throw new UserFacingError('Monitor booking rules changed during activation. Smart booking remains paused.', 'правила мониторинга поменялись, пока я включал запись. умная запись остаётся на паузе.');
                    if (!smartStore.soleAccountOwner(userId, monitor.accountId))
                        throw sharedAccountError();
                    if (verifiedSelectedClinics(currentMonitor, finalIdentity.cityName).fingerprint !== staged.clinicIdentityFingerprint)
                        throw new UserFacingError('A selected clinic changed during activation. Request a new preview.', 'выбранная клиника поменялась, пока я включал запись. попроси новое превью.');
                    const changed = smartStore.db.prepare("UPDATE luxmed_availability SET state='confirmed' WHERE user_id=? AND revision=? AND state='activating' AND hold_token IS NULL")
                        .run(userId, Number(revisionText)).changes;
                    if (!changed) return false;
                    smartStore.db.prepare('UPDATE luxmed_monitorings SET service_name=?,city_name=? WHERE id=? AND user_id=? AND account_id=?')
                        .run(staged.providerServiceName, finalIdentity.cityName, monitorId, userId, monitor.accountId);
                    const monitorChanged = smartStore.db.prepare("UPDATE luxmed_smart_monitors SET state='active',status='Monitoring with confirmed availability',next_check=0,confirmed_fingerprint=?,confirmed_provider_fingerprint=?,confirmed_clinic_fingerprint=? WHERE monitoring_id=? AND user_id=? AND state='activating'")
                        .run(staged.monitorFingerprint, staged.providerIdentityFingerprint, staged.clinicIdentityFingerprint, monitorId, userId).changes;
                    if (monitorChanged !== 1) throw new UserFacingError('Monitoring changed during activation.', 'мониторинг поменялся, пока я включал запись.');
                    smartStore.notify(`activation-confirmed:${monitorId}:${Number(revisionText)}`, userId,
                        `умный мониторинг LuxMed включён: ${staged.providerServiceName} (ID услуги ${monitor.serviceId}). ${monitor.autobook
                            ? 'как только найду первый подходящий слот, запишу тебя сам, спрашивать про каждый слот не буду.'
                            : 'этот мониторинг только уведомляет: сам записывать не буду, просто напишу, когда найду подходящий слот.'}`);
                    return true;
                })();
                if (!activated) throw new UserFacingError('Availability changed during activation. Smart booking remains paused.', 'расписание поменялось, пока я включал запись. умная запись остаётся на паузе.');
                activatingMonitorId = null;
                try { smartBooking.warmKnownLocations(userId); }
                catch { console.warn('[LuxMed smart] Route preparation deferred after activation'); }
                await bot.answerCallbackQuery(query.id, { text: 'ок, правила подтверждены. умный мониторинг включён.' }).catch(() => { });
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Confirmation failed';
                const userMessage = russianError(error);
                if (activatingMonitorId) {
                    smartStore.status(activatingMonitorId, `Activation paused: ${message}`);
                    smartStore.notify(`activation:${activatingMonitorId}:${Date.now()}`, query.from.id,
                        `умный мониторинг LuxMed остался на паузе: ${userMessage} чтобы попробовать ещё раз, попроси новое превью расписания.`);
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
        const currentClinicText = [...new Map(relevantTerms.filter(term => !term.term.isTelemedicine)
            .map(term => [term.term.clinicId, term.term])).values()].map(term => {
            const id = `clinic:${monitor.cityId}:${term.clinicId}`;
            const place = smartStore.places(userId).get(id);
            const verified = !!place && smartStore.clinicVerified(userId, id, term.clinic || '', place.revision);
            return `клиника ${term.clinicId}, ${term.clinic || 'название неизвестно'}: ${verified ? place!.address : 'адрес не проверен, эти слоты пропускаю'}`;
        }).join('\n');
        const selectedClinicText = selectedClinics.identities.map(clinic =>
            `выбранная клиника ${clinic.clinicId}, ${clinic.sourceLabel}: ${clinic.address}`).join('\n');
        const clinicText = [selectedClinicText, currentClinicText].filter(Boolean).join('\n');
        const incompletePreparation = relevantTerms.filter(term => requiresPreparation(term) && !preparationFacts(term)).length;
        const preparations = smartStore.stagePreparation(userId, confirmation.token, confirmation.revision, relevantTerms);
        const preparationText = preparations.map(fact => `подготовка к услуге ${fact.serviceId} в клинике ${fact.clinicId}:\n${fact.items.map(item => `${item.header ? `${item.header}: ` : ''}${item.text}`).join('\n')}`).join('\n');
        const examples = [...preview.candidates].sort(compareFeasible).slice(0, 3).map(c => {
            const time = DateTime.fromMillis(c.slot.start, { zone: BOOKING_ZONE }).setLocale('ru').toFormat('ccc dd LLL HH:mm');
            const leave = DateTime.fromMillis(c.leaveAt, { zone: BOOKING_ZONE }).toFormat('HH:mm');
            return `${time}: выйти до ${leave}, в дороге ${Math.ceil(c.travelSeconds / 60)} мин, отрезков на такси: ${c.taxiLegs}.`;
        });
        const afterConfirm = monitor.autobook
            ? 'кнопка ниже это одно подтверждение всех правил выше, а не отдельного слота. после неё я сам записываю тебя на первый слот, который под них подходит, без вопросов по каждому слоту, и пишу, когда запишу.'
            : 'кнопка ниже это одно подтверждение всех правил выше. этот мониторинг только уведомляет: после подтверждения я пишу, когда нахожу подходящий слот, а сам не записываю.';
        const text = `${availabilitySummary(userId, 'ru')}\n\nмониторинг: услуга LuxMed ${providerIdentity.serviceName} (ID ${monitor.serviceId}), город ${providerIdentity.cityName} (ID ${monitor.cityId}), даты с ${monitor.dateFrom} по ${monitor.dateTo}, время с ${monitor.timeFrom} до ${monitor.timeTo}. ${monitor.autobook ? 'режим: автозапись' : 'режим: только уведомления'}. заменять существующую запись: ${monitor.rebookIfExists ? 'да' : 'нет'}.\n${monitorFilterSummary(monitor, providerIdentity.doctorNames, 'ru')}\nавтоматические мониторинги в сайдкаре, которые я остановлю: ${legacy.map(m => `#${m.recordId} ${m.serviceName}`).join(', ') || 'нет'}.\n${clinicText ? `клиники и проверенные адреса:\n${clinicText}\n` : ''}${preparationText ? `подтверди подготовку (текст ровно как у LuxMed):\n${preparationText}\n` : ''}${incompletePreparation ? `слотов без полной информации о подготовке: ${incompletePreparation}. их автоматически не запишу.\n` : ''}проверенных подходящих слотов прямо сейчас: ${preview.candidates.length}.\n${examples.join('\n')}\n${afterConfirm}`;
        const chunks:string[] = []; let chunk = '';
        for (const line of text.split('\n')) {
            if (chunk.length + line.length > 3500) { chunks.push(chunk); chunk = ''; }
            chunk += `${line}\n`;
        }
        if (chunk) chunks.push(chunk);
        for (const part of chunks) await telegram.sendMessage(userId, part);
        requireCurrentConversation(userId);
        const confirmPrompt = monitor.autobook
            ? 'если всё верно, жми. это разовое подтверждение правил: дальше записываю сам, по каждому слоту спрашивать не буду.'
            : 'если всё верно, жми. это разовое подтверждение правил: дальше только пишу про подходящие слоты, сам не записываю.';
        await telegram.sendMessage(userId, confirmPrompt, { reply_markup: { inline_keyboard: [[{ text: 'подтверждаю правила', callback_data: `luxconfirm:${monitor.id}:${confirmation.revision}:${confirmation.token}` }]] } });
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
        return { success: !!turn && turn.userId === userId && turn.holdToken === hold_token && smartStore.release(userId, hold_token) };
    },
};
