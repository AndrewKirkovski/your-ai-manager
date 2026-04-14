import {
    getAllUsers,
    getUserMemoryRecord,
    updateUserMemory,
    countUserMessagesSince,
    getUserMessagesSince,
} from './userStore';
import {STYLE_SCAN_PROMPT} from './constants';
import type {AIProvider} from './aiProvider';

const STYLE_KEY = 'communication_style';
const ADHD_KEY = 'adhd_reactions';
const MAX_MESSAGES_PER_SCAN = 100;
const EPOCH = '1970-01-01T00:00:00.000Z';

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
            if (messages.length === 0) continue;

            const messagesText = messages
                .map(m => `- ${m.content.replace(/\s+/g, ' ').trim()}`)
                .join('\n');

            const prompt = STYLE_SCAN_PROMPT(
                messagesText,
                styleMem?.value ?? null,
                adhdMem?.value ?? null,
            );

            const response = await provider.completeChat({
                model,
                maxTokens: 700,
                messages: [{role: 'user', content: prompt}],
            });

            const newStyle = extractTag(response, 'communication_style');
            const newAdhd = extractTag(response, 'adhd_reactions');

            if (newStyle) {
                await updateUserMemory(user.userId, STYLE_KEY, newStyle);
            }
            if (newAdhd) {
                await updateUserMemory(user.userId, ADHD_KEY, newAdhd);
            }

            if (newStyle || newAdhd) {
                scanned++;
                console.log(`🎭 User ${user.userId}: style scan updated (${newCount} new msgs, ${messages.length} sampled)`);
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
