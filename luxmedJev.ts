import { DateTime } from 'luxon';
import { BOOKING_ZONE, compareFeasible, type FeasibleSlot } from './luxmedAvailability';

const MODEL = 'typesafe/jev-1.13';
const preferenceCodes = new Map<string, string>([
    ['morning', 'morning'], ['prefer morning', 'morning'], ['rano', 'morning'],
    ['afternoon', 'afternoon'], ['prefer afternoon', 'afternoon'], ['po południu', 'afternoon'],
    ['evening', 'evening'], ['prefer evening', 'evening'], ['wieczorem', 'evening'],
    ['shortest journey', 'short_journey'], ['prefer shortest journey', 'short_journey'],
    ['prefer a short journey', 'short_journey'],
    ['more time between commitments', 'more_buffer'], ['prefer more buffer', 'more_buffer'],
]);
export function jevPreferenceCodes(preferences: string[]): string[] {
    // Only these fixed categories leave the bot. Free-form schedule or medical
    // prose stays local and deterministic fallback still applies.
    return [...new Set(preferences.map(p => preferenceCodes.get(p.trim().toLocaleLowerCase())).filter((v): v is string => !!v))];
}
export async function rankWithJev(candidates: FeasibleSlot[], preferences: string[], _revision: number, options: { key?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ candidate: FeasibleSlot; source: 'jev' | 'rules' } | null> {
    const sorted = [...candidates].sort(compareFeasible);
    if (!sorted.length) return null;
    const group = sorted.filter(c => c.day === sorted[0].day && c.taxiLegs === sorted[0].taxiLegs).slice(0, 5);
    const fallback = { candidate: sorted[0], source: 'rules' as const };
    const key = options.key ?? process.env.OPENROUTER_API_KEY;
    const safePreferences = jevPreferenceCodes(preferences);
    if (!key || group.length === 1 || !safePreferences.length) return fallback;
    const facts = group.map((c, i) => ({
        id: `c${i}`, time: DateTime.fromMillis(c.slot.start, { zone: BOOKING_ZONE }).toFormat('HH:mm'),
        travelMinutes: Math.ceil(c.travelSeconds / 60), taxiLegs: c.taxiLegs,
        spareMinutes: Math.floor((c.slot.start - c.leaveAt) / 60000), telemedicine: c.slot.telemedicine
    }));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            (async () => {
                const response = await (options.fetch || fetch)('https://openrouter.ai/api/alpha/decisions', {
                    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: controller.signal,
                    body: JSON.stringify({ model: MODEL, state: { preferences: safePreferences, candidates: facts }, questions: Object.fromEntries(facts.map(c => [c.id, { type: 'score', instructions: `Rate how well candidate ${c.id} matches the user's soft preferences. All candidates already satisfy the hard rules.`, criteria: ['Poor match', 'Somewhat poor match', 'Neutral match', 'Good match', 'Best match'] }])) }),
                });
                if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
                return await response.json() as any;
            })(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Jev deadline')); }, options.timeoutMs ?? 800); }),
        ]);
        const scores = facts.map(c => {
            const a = result.answers?.[c.id];
            const probabilities = Object.values(a?.probabilities || {}) as number[];
            if (a?.type !== 'score' || !Number.isFinite(a.score) || a.score < 0 || a.score > 4 || !Number.isFinite(a.confidence) || a.confidence < 0.6 || a.confidence > 1
                || probabilities.length !== 5 || probabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1) || Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 0.02) throw new Error('Invalid Jev ranking');
            return { id: c.id, score: a.score as number };
        }).sort((a, b) => b.score - a.score);
        return { candidate: group[Number(scores[0].id.slice(1))], source: 'jev' };
    } catch { console.warn('[LuxMed Jev] Ranking unavailable; using confirmed rules'); return fallback; }
    finally { if (timer) clearTimeout(timer); }
}
