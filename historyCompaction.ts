import OpenAI from 'openai';
import {getAllUsers, getMessageHistoryWithIds, MessageHistory, compactMessages} from './userStore';
import {formatDateHuman} from './dateUtils';
import {HISTORY_COMPACTION_PROMPT} from './constants';

/** A run of consecutive assistant messages with their DB IDs */
type CompactableRun = {
    startId: number;
    endId: number; // inclusive
    messages: MessageHistory[];
};

const MAX_COMPACTIONS_PER_RUN = 5;

/**
 * Find runs of 2+ consecutive assistant messages in history.
 * Messages must have IDs (from SQLite autoincrement).
 */
function findCompactableRuns(history: MessageHistory[]): CompactableRun[] {
    const runs: CompactableRun[] = [];
    let runStart: number | null = null;

    for (let i = 0; i < history.length; i++) {
        if (history[i].role === 'assistant') {
            if (runStart === null) {
                runStart = i;
            }
        } else {
            if (runStart !== null && i - runStart >= 2) {
                const msgs = history.slice(runStart, i);
                runs.push({
                    startId: msgs[0].id,
                    endId: msgs[msgs.length - 1].id,
                    messages: msgs,
                });
            }
            runStart = null;
        }
    }

    // Handle run that ends at the end of history
    if (runStart !== null && history.length - runStart >= 2) {
        const msgs = history.slice(runStart);
        runs.push({
            startId: msgs[0].id,
            endId: msgs[msgs.length - 1].id,
            messages: msgs,
        });
    }

    return runs;
}

function buildDateRange(run: CompactableRun): string {
    return `${formatDateHuman(run.messages[0].timestamp)} — ${formatDateHuman(run.messages[run.messages.length - 1].timestamp)}`;
}

/**
 * Summarize a run of messages using AI
 */
async function summarizeRun(
    run: CompactableRun,
    dateRange: string,
    openai: OpenAI,
    model: string,
): Promise<string> {
    const messagesText = run.messages
        .map(m => `[${formatDateHuman(m.timestamp)}] ${m.content}`)
        .join('\n\n---\n\n');

    const prompt = HISTORY_COMPACTION_PROMPT(dateRange, messagesText);

    const response = await openai.chat.completions.create({
        model,
        max_tokens: 800,
        messages: [
            {role: 'user', content: prompt},
        ],
    });

    return response.choices[0]?.message?.content || '[compaction failed]';
}

/**
 * Run history compaction for all users.
 * Returns number of compactions performed.
 */
export async function runHistoryCompaction(openai: OpenAI, model: string): Promise<number> {
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
                const summary = await summarizeRun(run, dateRange, openai, model);

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
