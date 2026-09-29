import type TelegramBot from 'node-telegram-bot-api';
import type { Tool } from './tool.types';
import { smartStore, preparationFacts, requiresPreparation } from './luxmedSmartStore';
import { smartBooking, smartConfigurationIssue, matchesMonitor, monitorReservationCoverage } from './luxmedSmartBooking';
import { BOOKING_ZONE, compareFeasible, type TimeRule } from './luxmedAvailability';
import { DateTime } from 'luxon';
import { getActiveLuxmedMonitoringsByUser, getLuxmedAccountId, type LuxmedMonitoringConfig } from './userStore';
import { luxmedSearchSlots, luxmedGetMonitorings, luxmedEnrollSmartAccount, luxmedLegacyBookingBarrier, luxmedSmartEnrollment } from './luxmedAdapter';
import { resolveStreetAddress } from './googleRoutes';
import { availabilityTurn, requireCurrentAvailabilityTurn } from './luxmedConversation';

let telegram: TelegramBot | null = null;
const weekdays = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function requireCurrentConversation(userId: number): void {
    requireCurrentAvailabilityTurn(userId);
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
    const saved = smartStore.policy(userId); if (!saved) return 'When can you book? Tell me your free times, commitments and where you will be.';
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
export function monitorFilterSummary(monitor: Pick<LuxmedMonitoringConfig, 'clinicIds' | 'doctorIds' | 'englishOnly'>): string {
    const ids = (value: number[] | null) => value === null ? 'any' : value.length ? value.join(', ') : 'invalid empty filter';
    return `Clinic IDs: ${ids(monitor.clinicIds)}.\nDoctor IDs: ${ids(monitor.doctorIds)}.\nEnglish-speaking doctors only: ${monitor.englishOnly ? 'yes' : 'no'}.`;
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
                if (query.message?.chat.type !== 'private' || query.message.chat.id !== userId) throw new Error('Confirm in your private chat.');
                const monitor = getActiveLuxmedMonitoringsByUser(userId).find(m => m.id === monitorId);
                if (!monitor) throw new Error('Monitoring is no longer active.');
                const issue = await smartBooking.readiness(true); if (issue) throw new Error(issue);
                // Validate ownership, revision and token before any sidecar mutation.
                const row = smartStore.db.prepare('SELECT revision,confirmation_token,confirmation_expires FROM luxmed_availability WHERE user_id=?').get(userId) as any;
                if (!row || row.revision !== Number(revisionText) || row.confirmation_token !== token || row.confirmation_expires < Date.now()) throw new Error('This confirmation expired. Request a new preview.');
                const expectedAutoMonitorIds = smartStore.sidecarMonitorPreview(userId, monitor.id, monitor.accountId,
                    { token, revision: Number(revisionText) });
                if (!expectedAutoMonitorIds) throw new Error('The sidecar monitor list was not confirmed. Request a new preview.');
                const accepted = smartStore.db.transaction(() => {
                    const otherLegacy = otherLegacyBotAutoMonitors(monitor.accountId, monitor.id);
                    if (otherLegacy.length) throw new Error(`Stop other existing automatic bot monitors on this LuxMed account first: ${otherLegacy.map(m => m.id).join(', ')}.`);
                    if (!smartStore.confirm(userId, token, Number(revisionText))) return false;
                    smartStore.enroll(monitor.id, userId);
                    // Hold every smart monitor for this user throughout sidecar handoff.
                    smartStore.db.prepare("UPDATE luxmed_availability SET state='activating' WHERE user_id=? AND revision=?")
                        .run(userId, Number(revisionText));
                    smartStore.db.prepare("UPDATE luxmed_smart_monitors SET state='activating',status='Stopping sidecar automatic monitors' WHERE monitoring_id=? AND user_id=?").run(monitorId, userId);
                    return true;
                })();
                if (!accepted) throw new Error('Availability changed. Request a new preview.');
                activatingMonitorId = monitorId;
                await luxmedEnrollSmartAccount(monitor.accountId, expectedAutoMonitorIds);
                if ((await luxmedGetMonitorings(monitor.accountId)).some(m => m.active && m.autobook)) {
                    throw new Error('A sidecar automatic monitor is still active. Smart booking remains paused.');
                }
                await smartBooking.refreshReservations(monitor.accountId, monitorReservationCoverage(monitor), true);
                const current = smartStore.policy(userId);
                if (!current || current.state !== 'activating' || current.holdToken || current.revision !== Number(revisionText)
                    || smartStore.accountTransition(userId)
                    || (smartStore.db.prepare('SELECT account_id FROM luxmed_accounts WHERE user_id=?').get(userId) as { account_id: number } | undefined)?.account_id !== monitor.accountId
                    || !getActiveLuxmedMonitoringsByUser(userId).some(m => m.id === monitor.id && m.accountId === monitor.accountId))
                    throw new Error('Availability or monitoring changed during activation. Smart booking remains paused.');
                const activated = smartStore.db.transaction(() => {
                    const changed = smartStore.db.prepare("UPDATE luxmed_availability SET state='confirmed' WHERE user_id=? AND revision=? AND state='activating' AND hold_token IS NULL")
                        .run(userId, Number(revisionText)).changes;
                    if (!changed) return false;
                    const monitorChanged = smartStore.db.prepare("UPDATE luxmed_smart_monitors SET state='active',status='Monitoring with confirmed availability',next_check=0 WHERE monitoring_id=? AND user_id=? AND state='activating'")
                        .run(monitorId, userId).changes;
                    if (monitorChanged !== 1) throw new Error('Monitoring changed during activation.');
                    return true;
                })();
                if (!activated) throw new Error('Availability changed during activation. Smart booking remains paused.');
                await bot.answerCallbackQuery(query.id, { text: 'Availability confirmed. Smart monitoring is active.' });
                await bot.sendMessage(userId, `Smart monitoring is active for ${monitor.serviceName}. I will book a suitable appointment automatically${monitor.autobook ? '' : ' only when you request it; this monitor sends notifications'}.`);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Confirmation failed';
                if (activatingMonitorId) {
                    smartStore.status(activatingMonitorId, `Activation paused: ${message}`);
                    smartStore.notify(`activation:${activatingMonitorId}:${Date.now()}`, query.from.id,
                        `LuxMed smart monitoring stayed paused: ${message} Request a new availability preview to retry activation.`);
                }
                await bot.answerCallbackQuery(query.id, { text: message.slice(0, 190), show_alert: true }).catch(() => { });
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
        smartBooking.warmKnownLocations(userId);
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
        smartBooking.warmKnownLocations(userId);
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
        const otherLegacy = otherLegacyBotAutoMonitors(monitor.accountId, monitor.id);
        if (otherLegacy.length) return { success: false,
            message: `Stop other existing automatic bot monitors on this LuxMed account before activating smart booking: ${otherLegacy.map(m => `${m.id} (${m.service_name})`).join(', ')}. They continue their current behaviour until stopped.` };
        const issue = await smartBooking.readiness(); if (issue) return { success: false, message: issue, summary: availabilitySummary(userId) };
        const legacy = (await luxmedGetMonitorings(monitor.accountId)).filter(m => m.active && m.autobook);
        const terms = await luxmedSearchSlots(monitor.accountId, monitor);
        const preview = await smartBooking.inspect(monitor, terms, true);
        requireCurrentConversation(userId);
        if (smartStore.policy(userId)?.revision !== preview.revision) throw new Error('Availability changed while preparing the preview. Please review it again.');
        const confirmation = smartStore.confirmation(userId);
        smartStore.stageSidecarMonitorPreview(userId, monitor.id, monitor.accountId, confirmation,
            legacy.map(m => m.recordId));
        const english = await smartBooking.english(monitor);
        const relevantTerms = terms.filter(term => matchesMonitor(term, monitor, english));
        const clinicText = [...new Map(relevantTerms.filter(term => !term.term.isTelemedicine)
            .map(term => [term.term.clinicId, term.term])).values()].map(term => {
            const id = `clinic:${monitor.cityId}:${term.clinicId}`;
            const place = smartStore.places(userId).get(id);
            const verified = !!place && smartStore.clinicVerified(userId, id, term.clinic || '', place.revision);
            return `Clinic ${term.clinicId}, ${term.clinic || 'unknown name'}: ${verified ? place!.address : 'street address not verified; these slots are excluded'}`;
        }).join('\n');
        const incompletePreparation = relevantTerms.filter(term => requiresPreparation(term) && !preparationFacts(term)).length;
        const preparations = smartStore.stagePreparation(userId, confirmation.token, confirmation.revision, relevantTerms);
        const preparationText = preparations.map(fact => `Preparation for service ${fact.serviceId} at clinic ${fact.clinicId}:\n${fact.items.map(item => `${item.header ? `${item.header}: ` : ''}${item.text}`).join('\n')}`).join('\n');
        const examples = [...preview.candidates].sort(compareFeasible).slice(0, 3).map(c => {
            const time = DateTime.fromMillis(c.slot.start, { zone: BOOKING_ZONE }).toFormat('ccc dd LLL HH:mm');
            const leave = DateTime.fromMillis(c.leaveAt, { zone: BOOKING_ZONE }).toFormat('HH:mm');
            return `${time}: leave by ${leave}, ${Math.ceil(c.travelSeconds / 60)} minutes travelling, ${c.taxiLegs} taxi legs.`;
        });
         const text = `${availabilitySummary(userId)}\n\nMonitor: ${monitor.serviceName}, ${monitor.dateFrom} to ${monitor.dateTo}, ${monitor.timeFrom} to ${monitor.timeTo}. ${monitor.autobook ? 'Automatic booking' : 'Notifications only'}. Replace an existing appointment: ${monitor.rebookIfExists ? 'yes' : 'no'}.\n${monitorFilterSummary(monitor)}\nSidecar automatic monitors that will be stopped: ${legacy.map(m => `#${m.recordId} ${m.serviceName}`).join(', ') || 'none'}.\n${clinicText ? `Clinics and verified street addresses:\n${clinicText}\n` : ''}${preparationText ? `Confirm these exact preparation instructions:\n${preparationText}\n` : ''}${incompletePreparation ? `${incompletePreparation} slot(s) have incomplete preparation details and cannot be booked automatically.\n` : ''}Preview: ${preview.candidates.length} currently verified suitable slots.\n${examples.join('\n')}\nConfirm these rules to activate this monitor.`;
        const chunks:string[] = []; let chunk = '';
        for (const line of text.split('\n')) {
            if (chunk.length + line.length > 3500) { chunks.push(chunk); chunk = ''; }
            chunk += `${line}\n`;
        }
        if (chunk) chunks.push(chunk);
        for (const part of chunks) await telegram.sendMessage(userId, part);
        requireCurrentConversation(userId);
        await telegram.sendMessage(userId, 'Confirm the availability and booking rules above.', { reply_markup: { inline_keyboard: [[{ text: 'Confirm availability', callback_data: `luxconfirm:${monitor.id}:${confirmation.revision}:${confirmation.token}` }]] } });
        return { success: true, message: 'Preview and confirmation button sent. Await the user clicking Confirm.' };
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
