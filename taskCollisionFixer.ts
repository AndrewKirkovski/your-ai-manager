import type TelegramBot from 'node-telegram-bot-api';
import { CronExpressionParser } from 'cron-parser';
import type { AIProvider } from './aiProvider';
import type { Routine } from './userStore';
import { getAllUsers, getAllTasks } from './userStore';
import { AIService } from './aiService';
import { getSystemPrompt, COLLISION_FIX_PROMPT } from './constants';
import { getCurrentTime, formatDateHuman } from './dateUtils';
import { stripSystemTags } from './telegramFormat';

// Mirrors index.ts — single bot-wide timezone.
const BOT_TZ = process.env.TZ || 'Europe/Warsaw';

// Two events closer than this are a collision; the AI is told to spread them
// to >= 10 minutes apart (comfortably above this threshold, so a fixed
// cluster doesn't re-trigger on the next run).
const CLUSTER_GAP_MS = 5 * 60_000;
// Routines firing more often than this within the look-ahead window are
// intentional nag-loops (e.g. */15) — their self-collisions are by design,
// so predicting them would report unfixable clusters every run.
const MAX_FIRES_PER_ROUTINE = 30;
// Anti-flap: don't re-attempt an identical cluster more often than this.
const RETRY_MS = 6 * 3600_000;
const LOOKAHEAD_HOURS = 24;
// Don't touch anything the minute tick is about to fire — this buffer (not
// the per-user queue) is what prevents the fixer racing the tick's status
// marks, which run outside the queue.
const WINDOW_START_BUFFER_MIN = 5;

export type ScheduleEvent = {
    kind: 'task' | 'routine';
    id: string;
    name: string;
    at: Date;
    annoyance: string;
    dueAt?: Date;
    routineId?: string;
};

/** Predicted fire times for active routines inside [windowStart, windowEnd].
 * Each fire is a future "task will spawn here" fixed point the AI must route
 * ad-hoc task pings around. */
export function predictRoutineFires(routines: Routine[], windowStart: Date, windowEnd: Date): ScheduleEvent[] {
    const events: ScheduleEvent[] = [];
    for (const r of routines) {
        if (!r.isActive) continue;
        try {
            const it = CronExpressionParser.parse(r.cron, { tz: BOT_TZ, currentDate: windowStart });
            const fires: Date[] = [];
            while (fires.length <= MAX_FIRES_PER_ROUTINE) {
                const next = it.next().toDate();
                if (next > windowEnd) break;
                fires.push(next);
            }
            if (fires.length > MAX_FIRES_PER_ROUTINE) continue; // high-frequency nag routine — skip
            for (const at of fires) {
                events.push({ kind: 'routine', id: r.id, name: r.name, at, annoyance: r.defaultAnnoyance });
            }
        } catch {
            console.warn('🧭 [collision-fix] bad cron, skipping routine:', { routineId: r.id, cron: r.cron });
        }
    }
    return events;
}

/** Two cluster shapes are by-design and NOT actionable:
 * - one task + its own parent routine's fire (trigger-time prompt handles it:
 *   "new task from same routine started → MarkTaskFailed");
 * - fires of a SINGLE routine with no tasks (e.g. cron "0,3 12 * * *" — an
 *   intentional double-reminder schedule; "fixing" it would silently rewrite
 *   the user's cron, and declining would re-spend an AI call every run since
 *   sliding fire times produce fresh signatures). */
function isActionable(cluster: ScheduleEvent[]): boolean {
    const tasks = cluster.filter(e => e.kind === 'task');
    const routines = cluster.filter(e => e.kind === 'routine');
    if (tasks.length === 1 && routines.length === 1 && tasks[0].routineId === routines[0].id) return false;
    if (tasks.length === 0 && new Set(routines.map(r => r.id)).size === 1) return false;
    return tasks.length > 0 || routines.length >= 2;
}

/** Chain-cluster events by time: a gap <= gapMs joins the current cluster.
 * Returns only actionable clusters of 2+ events. */
export function clusterEvents(events: ScheduleEvent[], gapMs = CLUSTER_GAP_MS): ScheduleEvent[][] {
    const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
    const clusters: ScheduleEvent[][] = [];
    let cur: ScheduleEvent[] = [];
    for (const ev of sorted) {
        if (cur.length && ev.at.getTime() - cur[cur.length - 1].at.getTime() <= gapMs) {
            cur.push(ev);
        } else {
            if (cur.length >= 2) clusters.push(cur);
            cur = [ev];
        }
    }
    if (cur.length >= 2) clusters.push(cur);
    return clusters.filter(isActionable);
}

/** Stable identity of a cluster: sorted kind:id@minute. If the AI (or the
 * user) moves any member, the signature changes and the cluster is retried
 * naturally; an identical signature within RETRY_MS is skipped. */
export function clusterSignature(cluster: ScheduleEvent[]): string {
    return cluster
        .map(e => `${e.kind}:${e.id}@${Math.floor(e.at.getTime() / 60_000)}`)
        .sort()
        .join('|');
}

function formatClusters(clusters: ScheduleEvent[][]): string {
    return clusters
        .map((cluster, i) => {
            const lines = cluster.map(e => {
                const kindLabel = e.kind === 'routine' ? 'predicted routine fire' : 'task';
                const extra = e.kind === 'routine'
                    ? `routine_id: ${e.id}`
                    : `task_id: ${e.id}${e.routineId ? `, from routine ${e.routineId}` : ''}${e.dueAt ? `, dueAt: ${e.dueAt.toISOString()}` : ', no dueAt'}`;
                // Names are textified at write, but strip <system> at read too
                // (legacy rows / defense-in-depth, same as getCurrentInfo).
                return `  - [${kindLabel}] "${stripSystemTags(e.name)}" at ${e.at.toISOString()} (${formatDateHuman(e.at)}) — ${extra}, annoyance: ${e.annoyance}`;
            });
            return `Cluster ${i + 1}:\n${lines.join('\n')}`;
        })
        .join('\n\n');
}

// userId → cluster signature → last attempt (ms). In-memory on purpose: a
// restart merely retries each cluster once, and the fix is idempotent.
const attempted = new Map<number, Map<string, number>>();

export interface CollisionFixerDeps {
    bot: TelegramBot;
    provider: AIProvider;
    model: string;
    /** index.ts enqueuePerUser — serializes the silent AI call with live chat. */
    enqueue: (userId: number, work: () => Promise<void>) => Promise<void>;
    /** index.ts getCurrentInfo — same memory block the chat prompts use. */
    getCurrentInfo: (userId: number) => Promise<string>;
}

/** Look-ahead reminder-collision fixer. For each user: pending task pings in
 * the next 24h + predicted routine fires → clusters of events within 5 min →
 * one SILENT AI call (tools enabled, nothing sent to Telegram) that spreads
 * them apart via UpdateTask/UpdateRoutine. */
export async function runCollisionFixer(deps: CollisionFixerDeps): Promise<void> {
    const now = getCurrentTime();
    const windowStart = now.plus({ minutes: WINDOW_START_BUFFER_MIN }).toJSDate();
    const windowEnd = now.plus({ hours: LOOKAHEAD_HOURS }).toJSDate();
    const users = await getAllUsers();

    for (const user of users) {
        if (!user.chatId) continue;
        try {
            const taskEvents: ScheduleEvent[] = (user.tasks ?? [])
                .filter(t => t.status === 'pending' && t.pingAt >= windowStart && t.pingAt <= windowEnd)
                .map(t => ({
                    kind: 'task' as const,
                    id: t.id,
                    name: t.name,
                    at: t.pingAt,
                    annoyance: t.annoyance,
                    dueAt: t.dueAt,
                    routineId: t.routineId,
                }));
            const routineEvents = predictRoutineFires(user.routines ?? [], windowStart, windowEnd);

            const userAttempts = attempted.get(user.userId) ?? new Map<string, number>();
            const nowMs = Date.now();
            for (const [sig, ts] of userAttempts) {
                if (nowMs - ts > RETRY_MS) userAttempts.delete(sig);
            }

            const clusters = clusterEvents([...taskEvents, ...routineEvents])
                .filter(c => !userAttempts.has(clusterSignature(c)));
            if (clusters.length === 0) continue;

            for (const c of clusters) userAttempts.set(clusterSignature(c), nowMs);
            attempted.set(user.userId, userAttempts);

            console.log('🧭 [collision-fix] clusters found:', {
                userId: user.userId,
                clusters: clusters.map(c => c.map(e => `${e.kind}:${e.id}@${e.at.toISOString()}`)),
            });

            // Awaited: bounds the cycle to one silent AI call at a time and
            // serializes with any in-flight chat reply for this user.
            await deps.enqueue(user.userId, async () => {
                // Re-validate against fresh DB state: the queue may have delayed
                // us behind a long chat reply, during which cluster tasks can
                // fire (minute tick marks them completed/needs_replanning) or be
                // moved/completed by the user's own tool calls. Prompting the AI
                // with stale members would make its UpdateTask reset an already-
                // handled task back to 'pending' — a resurrected duplicate ping.
                const freshTasks = await getAllTasks(user.userId);
                const freshClusters = clusters
                    .map(c => c.filter(e => {
                        if (e.kind === 'routine') return true;
                        const t = freshTasks.find(ft => ft.id === e.id);
                        return !!t && t.status === 'pending'
                            && Math.abs(t.pingAt.getTime() - e.at.getTime()) < 60_000;
                    }))
                    .filter(c => c.length >= 2 && isActionable(c));
                if (freshClusters.length === 0) {
                    console.log('🧭 [collision-fix] clusters went stale in queue, skipping:', { userId: user.userId });
                    return;
                }

                const memory = await deps.getCurrentInfo(user.userId);
                const result = await AIService.streamAIResponse({
                    userId: user.userId,
                    userMessage: COLLISION_FIX_PROMPT(memory, formatClusters(freshClusters)),
                    systemPromptCachePrefix: getSystemPrompt(),
                    systemPrompt: '', // memory inlined into the prompt
                    bot: deps.bot,
                    provider: deps.provider,
                    model: deps.model,
                    // Above the 1500 default: a many-cluster run needs room for
                    // several tool calls (+ adaptive-thinking models spend from
                    // the same budget); truncation mid-tool-call wastes the run.
                    maxTokens: 4000,
                    shouldUpdateTelegram: false,
                    addUserToHistory: false,
                    addAssistantToHistory: false,
                    enableToolCalls: true,
                    purpose: 'collision-fix',
                });
                console.log('🧭 [collision-fix] result:', {
                    userId: user.userId,
                    summary: result.message.slice(0, 300),
                });
            });
        } catch (error) {
            console.error('🧭 [collision-fix] user failed:', {
                userId: user.userId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}
