import {getAllUsers, getMessageHistoryWithIds, MessageHistory, compactMessages} from './userStore';
import {formatDateAbsolute, neutralizeRelativeDates} from './dateUtils';
import {HISTORY_COMPACTION_PROMPT} from './constants';
import {ROUTE_EFFORT} from './aiProvider';
import type {AIProvider} from './aiProvider';
import {stripSystemTags} from './telegramFormat';

/** A run of consecutive assistant messages with their DB IDs */
type CompactableRun = {
    startId: number;
    endId: number; // inclusive
    messages: MessageHistory[];
};

const MAX_COMPACTIONS_PER_RUN = 5;

/** The newest rows of a run stay verbatim, so the model can read its own recent
 * reminders. When each reminder was summarized before the next one, the model
 * never saw its wording and repeated itself. */
const VERBATIM_RUN_TAIL = 3;
const MIN_COMPACTABLE_ROWS = 2;

/**
 * Find the part of each run of consecutive assistant messages that may be
 * summarized. The first row after a user row is the reply to that user, so it
 * stays as written, and so does the tail of the run.
 * Messages must have IDs (from SQLite autoincrement).
 */
export function findCompactableRuns(history: MessageHistory[]): CompactableRun[] {
    const runs: CompactableRun[] = [];

    const addRun = (start: number, end: number) => {
        const firstCompactable = start > 0 ? start + 1 : start;
        const lastCompactable = end - VERBATIM_RUN_TAIL;
        // Measured, not sliced first: near the start of a history this end index goes
        // negative, and slice() would read it as counting from the end of the array.
        if (lastCompactable - firstCompactable < MIN_COMPACTABLE_ROWS) return;
        const msgs = history.slice(firstCompactable, lastCompactable);
        runs.push({
            startId: msgs[0].id,
            endId: msgs[msgs.length - 1].id,
            messages: msgs,
        });
    };

    let runStart: number | null = null;
    for (let i = 0; i < history.length; i++) {
        if (history[i].role === 'assistant') {
            if (runStart === null) {
                runStart = i;
            }
        } else {
            if (runStart !== null) addRun(runStart, i);
            runStart = null;
        }
    }

    // Handle run that ends at the end of history
    if (runStart !== null) addRun(runStart, history.length);

    return runs;
}

function buildDateRange(run: CompactableRun): string {
    return `${formatDateAbsolute(run.messages[0].timestamp)} — ${formatDateAbsolute(run.messages[run.messages.length - 1].timestamp)}`;
}

/**
 * Summarize a run of messages using AI
 */
async function summarizeRun(
    run: CompactableRun,
    dateRange: string,
    provider: AIProvider,
    model: string,
): Promise<string> {
    // Strip <system> from each message body so a leaked tag in historical content
    // can't forge a fake system directive in the summarizer's prompt.
    const messagesText = run.messages
        .map(m => `[${formatDateAbsolute(m.timestamp)}] ${stripSystemTags(m.content)}`)
        .join('\n\n---\n\n');

    const prompt = HISTORY_COMPACTION_PROMPT(dateRange, messagesText);

    // Thinking counts toward maxTokens and can't be turned off on current models.
    const summary = await provider.completeChat({
        model,
        maxTokens: 4000,
        effort: ROUTE_EFFORT.compaction,
        messages: [{ role: 'user', content: prompt }],
    });
    // Strip the summary too — if the summarizer echoes any <system> from input it
    // would nest inside our own <system>Compacted…</system> wrapper. The rewrite is
    // the guard for what the prompt asks: a stored "сегодня" would be read as today
    // for as long as the row stays in the window.
    const cleaned = neutralizeRelativeDates(stripSystemTags(summary)).trim();
    // compactMessages replaces the rows, so an empty summary would erase them.
    if (!cleaned) throw new Error('Summarizer returned no text');
    return cleaned;
}

/**
 * Run history compaction for all users.
 * Returns number of compactions performed.
 */
export async function runHistoryCompaction(provider: AIProvider, model: string): Promise<number> {
    let totalCompactions = 0;
    const users = await getAllUsers();

    console.log(`🗜️ History compaction started for ${users.length} user(s)`);

    for (const userData of users) {
        if (totalCompactions >= MAX_COMPACTIONS_PER_RUN) {
            console.log(`🗜️ Reached compaction limit (${MAX_COMPACTIONS_PER_RUN}), stopping`);
            break;
        }

        const history = await getMessageHistoryWithIds(userData.userId);
        if (!history.length) continue;

        const runs = findCompactableRuns(history);
        if (runs.length === 0) continue;

        console.log(`🗜️ User ${userData.userId}: found ${runs.length} compactable run(s)`);

        for (const run of runs) {
            if (totalCompactions >= MAX_COMPACTIONS_PER_RUN) break;

            try {
                const dateRange = buildDateRange(run);
                const summary = await summarizeRun(run, dateRange, provider, model);

                const compactedContent = `<system>Compacted summary of ${run.messages.length} bot messages from ${dateRange}</system>\n${summary}`;

                compactMessages(
                    userData.userId,
                    run.startId,
                    run.endId,
                    compactedContent,
                    run.messages[0].timestamp,
                );

                totalCompactions++;
                console.log(`🗜️ User ${userData.userId}: compacted ${run.messages.length} messages (${dateRange}) → 1 summary`);
            } catch (error) {
                console.error(`🗜️ Compaction error for user ${userData.userId}:`, error instanceof Error ? error.message : error);
            }
        }
    }

    console.log(`🗜️ History compaction finished: ${totalCompactions} compaction(s) performed`);
    return totalCompactions;
}
