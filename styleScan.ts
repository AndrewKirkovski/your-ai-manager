import {
    getAllUsers,
    getUserMemoryRecord,
    updateUserMemory,
    countUserMessagesSince,
    getUserMessagesSince,
} from './userStore';
import {STYLE_SCAN_PROMPT} from './constants';
import {ROUTE_EFFORT} from './aiProvider';
import type {AIProvider} from './aiProvider';
import {stripSystemTags} from './telegramFormat';

const STYLE_KEY = 'communication_style';
const ADHD_KEY = 'adhd_reactions';
const MAX_MESSAGES_PER_SCAN = 100;
const EPOCH = '1970-01-01T00:00:00.000Z';

/** A scan of too little text replaced good notes with a description of one photo.
 * Below these the scan waits, and the sample keeps growing. */
const MIN_SAMPLE_ROWS = 20;
const MIN_SAMPLE_CHARS = 1500;
const NO_CHANGE_REPLY = '<no_change/>';
const MIN_KEPT_LENGTH_RATIO = 0.5;

/** The words the user actually wrote in a stored row, without synthetic prompts
 * and without media descriptions, which describe the image and not the user. */
export function userWordsInRow(content: string): string {
    const withoutMedia = stripSystemTags(content)
        .replace(/\[User sent a [\s\S]*?\[End of [^\]]*\]/g, '')
        .replace(/\[Custom emojis in this message:[\s\S]*?\n\]/g, '');
    const marker = withoutMedia.search(/\[User (?:sent a|shared)/);
    return (marker >= 0 ? withoutMedia.slice(0, marker) : withoutMedia).replace(/\s+/g, ' ').trim();
}

/** A note that shrinks a lot lost what it knew, so the old one stays. */
function isAcceptableNote(next: string | null, prior: string | undefined): next is string {
    return !!next && (!prior || next.length >= prior.length * MIN_KEPT_LENGTH_RATIO);
}

function extractTag(text: string, tag: string): string | null {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
    const m = text.match(re);
    return m ? m[1].trim() : null;
}

/**
 * Daily user-style evaluation.
 * For each user, if there are user messages newer than the older of the two
 * memory entries (or either is missing), run an AI evaluation and update both
 * memory keys.
 */
export async function runStyleScan(provider: AIProvider, model: string): Promise<number> {
    let scanned = 0;
    const users = await getAllUsers();
    console.log(`🎭 Style scan started for ${users.length} user(s)`);

    for (const user of users) {
        try {
            const styleMem = await getUserMemoryRecord(user.userId, STYLE_KEY);
            const adhdMem = await getUserMemoryRecord(user.userId, ADHD_KEY);

            // Reference time = older of the two updates. If either is missing, treat as epoch.
            const styleTs = styleMem?.updatedAt?.toISOString() ?? EPOCH;
            const adhdTs = adhdMem?.updatedAt?.toISOString() ?? EPOCH;
            const referenceIso = styleTs < adhdTs ? styleTs : adhdTs;

            const newCount = await countUserMessagesSince(user.userId, referenceIso);
            if (newCount === 0) continue;

            const messages = await getUserMessagesSince(user.userId, referenceIso, MAX_MESSAGES_PER_SCAN);
            const sample = messages.map(m => userWordsInRow(m.content)).filter(Boolean);
            if (sample.length < MIN_SAMPLE_ROWS || sample.join('').length < MIN_SAMPLE_CHARS) continue;

            const messagesText = sample.map(text => `- ${text}`).join('\n');

            const prompt = STYLE_SCAN_PROMPT(
                messagesText,
                styleMem?.value ?? null,
                adhdMem?.value ?? null,
            );

            // Thinking counts toward maxTokens and can't be turned off on current models.
            const response = await provider.completeChat({
                model,
                maxTokens: 6000,
                effort: ROUTE_EFFORT['style-scan'],
                messages: [{role: 'user', content: prompt}],
            });

            // Re-saving moves updated_at, so these messages aren't scanned again.
            if (response.includes(NO_CHANGE_REPLY) && styleMem && adhdMem) {
                await updateUserMemory(user.userId, STYLE_KEY, styleMem.value);
                await updateUserMemory(user.userId, ADHD_KEY, adhdMem.value);
                console.log(`🎭 User ${user.userId}: style scan found nothing new (${sample.length} sampled)`);
                continue;
            }

            const newStyle = extractTag(response, 'communication_style');
            const newAdhd = extractTag(response, 'adhd_reactions');
            const styleOk = isAcceptableNote(newStyle, styleMem?.value);
            const adhdOk = isAcceptableNote(newAdhd, adhdMem?.value);

            if (styleOk) {
                await updateUserMemory(user.userId, STYLE_KEY, newStyle);
            }
            if (adhdOk) {
                await updateUserMemory(user.userId, ADHD_KEY, newAdhd);
            }

            if (styleOk || adhdOk) {
                scanned++;
                console.log(`🎭 User ${user.userId}: style scan updated (${newCount} new msgs, ${sample.length} sampled)`);
            } else if (newStyle || newAdhd) {
                console.warn(`🎭 User ${user.userId}: scan output much shorter than the prior notes, keeping them`);
            } else {
                console.warn(`🎭 User ${user.userId}: scan returned no parseable tags`);
            }
        } catch (error) {
            console.error(`🎭 Style scan error for user ${user.userId}:`, error instanceof Error ? error.message : error);
        }
    }

    console.log(`🎭 Style scan finished: ${scanned} user(s) updated`);
    return scanned;
}
