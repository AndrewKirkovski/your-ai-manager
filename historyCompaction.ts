import OpenAI from 'openai';
import {getAllUsers, getUser, MessageHistory, setUser} from './userStore';
import {formatDateHuman} from './dateUtils';
import {HISTORY_COMPACTION_PROMPT} from './constants';

/** A run of consecutive assistant messages with their indices in the history array */
type CompactableRun = {
    startIndex: number;
    endIndex: number; // inclusive
    messages: MessageHistory[];
};

const MAX_COMPACTIONS_PER_RUN = 5;

/**
 * Find runs of 2+ consecutive assistant messages in history.
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
                runs.push({
                    startIndex: runStart,
                    endIndex: i - 1,
                    messages: history.slice(runStart, i),
                });
            }
            runStart = null;
        }
    }

    // Handle run that ends at the end of history
    if (runStart !== null && history.length - runStart >= 2) {
        runs.push({
            startIndex: runStart,
            endIndex: history.length - 1,
            messages: history.slice(runStart),
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

        const user = await getUser(userData.userId);
        if (!user?.messageHistory?.length) continue;

        const runs = findCompactableRuns(user.messageHistory);
        if (runs.length === 0) continue;

        console.log(`🗜️ User ${user.userId}: found ${runs.length} compactable run(s)`);

        let compactedThisUser = false;

        // Process runs from last to first so indices stay valid after splicing
        for (let i = runs.length - 1; i >= 0; i--) {
            if (totalCompactions >= MAX_COMPACTIONS_PER_RUN) break;

            const run = runs[i];
            try {
                const dateRange = buildDateRange(run);
                const summary = await summarizeRun(run, dateRange, openai, model);

                const compactedMessage: MessageHistory = {
                    role: 'assistant',
                    content: `<system>Compacted summary of ${run.messages.length} bot messages from ${dateRange}</system>\n${summary}`,
                    timestamp: run.messages[0].timestamp,
                };

                // Splice in place on the same object to keep indices valid
                user.messageHistory.splice(
                    run.startIndex,
                    run.endIndex - run.startIndex + 1,
                    compactedMessage,
                );

                compactedThisUser = true;
                totalCompactions++;
                console.log(`🗜️ User ${user.userId}: compacted ${run.messages.length} messages (${dateRange}) → 1 summary`);
            } catch (error) {
                console.error(`🗜️ Compaction error for user ${user.userId}:`, error instanceof Error ? error.message : error);
            }
        }

        // Save once after all compactions for this user
        if (compactedThisUser) {
            await setUser(user);
        }
    }

    console.log(`🗜️ History compaction finished: ${totalCompactions} compaction(s) performed`);
    return totalCompactions;
}
