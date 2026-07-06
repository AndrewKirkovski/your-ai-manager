import type TelegramBot from 'node-telegram-bot-api';
import { CronExpressionParser } from 'cron-parser';
import { DateTime } from 'luxon';
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
// cluster doesn't re-trigger on the next run). Strictly BELOW the minute
// tick's STAGGER_STEP_MS (5 min) — tasks the tick just staggered are exactly
// 5 min apart and must not be re-flagged as collisions here.
const CLUSTER_GAP_MS = 4 * 60_000;
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

/** Stable identity of a cluster. Tasks are one-shot → absolute minute; routine
 * fires RECUR → time-of-day in BOT_TZ, otherwise a recurring collision the AI
 * declined to fix would mint a fresh signature every day and re-spend a silent
 * AI call forever. If the AI (or the user) moves any member, the signature
 * changes and the cluster is retried naturally; an identical signature within
 * RETRY_MS is skipped. */
export function clusterSignature(cluster: ScheduleEvent[]): string {
    return cluster
        .map(e => e.kind === 'routine'
            ? `routine:${e.id}@tod:${DateTime.fromJSDate(e.at, { zone: BOT_TZ }).hour * 60 + DateTime.fromJSDate(e.at, { zone: BOT_TZ }).minute}`
            : `task:${e.id}@${Math.floor(e.at.getTime() / 60_000)}`)
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

// userId → cluster signature → suppressed-until (ms epoch). Marked ONLY after
// a successful AI attempt — a 429/outage must not burn the backoff window.
// Task clusters retry after RETRY_MS; routine-only clusters recur daily by
// nature (their signatures are time-of-day-stable), so a declined fix is
// suppressed for a week instead of re-spending an AI call every few hours.
// In-memory on purpose: a restart merely retries each cluster once, and the
// fix is idempotent.
const attempted = new Map<number, Map<string, number>>();
const RETRY_MS_ROUTINE_ONLY = 7 * 24 * 3600_000;

function retryMsFor(cluster: ScheduleEvent[]): number {
    return cluster.every(e => e.kind === 'routine') ? RETRY_MS_ROUTINE_ONLY : RETRY_MS;
}

export interface CollisionFixerDeps {
    bot: TelegramBot;
    provider: AIProvider;
    model: string;
    /** index.ts enqueuePerUser — serializes the silent AI call with live chat. */
    enqueue: (userId: number, work: () => Promise<void>) => Promise<void>;
    /** index.ts getCurrentInfo — same memory block the chat prompts use. */
    getCurrentInfo: (userId: number) => Promise<string>;
    /** index.ts isAllowedUser — don't spend AI money on non-allowlisted rows. */
    isUserAllowed: (userId: number) => boolean;
}

// Overlap guard (mirrors routineTickRunning): a run stuck behind long chat
// replies must not overlap the next cron slot — marking is post-success, so
// an overlapping scan would see no suppression and enqueue duplicate silent
// AI calls for the same clusters.
let fixerRunning = false;

/** Look-ahead reminder-collision fixer. For each user: pending task pings in
 * the next 24h + predicted routine fires → clusters of events within
 * CLUSTER_GAP_MS of each other → one SILENT AI call (schedule tools only,
 * nothing sent to Telegram) that spreads them apart via
 * RescheduleTaskPing/UpdateRoutine. */
export async function runCollisionFixer(deps: CollisionFixerDeps): Promise<void> {
    if (fixerRunning) {
        console.warn('🧭 [collision-fix] previous run still in progress, skipping this cycle');
        return;
    }
    fixerRunning = true;
    try {
        await runCollisionFixerCycle(deps);
    } finally {
        fixerRunning = false;
    }
}

async function runCollisionFixerCycle(deps: CollisionFixerDeps): Promise<void> {
    const now = getCurrentTime();
    const windowStart = now.plus({ minutes: WINDOW_START_BUFFER_MIN }).toJSDate();
    const windowEnd = now.plus({ hours: LOOKAHEAD_HOURS }).toJSDate();
    const users = await getAllUsers();

    for (const user of users) {
        if (!user.chatId) continue;
        if (!deps.isUserAllowed(user.userId)) continue;
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
            for (const [sig, suppressedUntil] of userAttempts) {
                if (nowMs >= suppressedUntil) userAttempts.delete(sig);
            }
            attempted.set(user.userId, userAttempts);

            const clusters = clusterEvents([...taskEvents, ...routineEvents])
                .filter(c => !userAttempts.has(clusterSignature(c)));
            if (clusters.length === 0) continue;

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
                // moved/completed by the user's own tool calls. Also RE-APPLY the
                // start buffer with the CURRENT clock: the scan-time buffer is
                // consumed by queue delay, and handing the AI a task the minute
                // tick is about to fire (or firing mid-stream) reopens the
                // resurrect-and-double-ping race the buffer exists to prevent.
                const freshTasks = await getAllTasks(user.userId);
                const bufferEdge = Date.now() + WINDOW_START_BUFFER_MIN * 60_000;
                const freshPairs = clusters
                    // Suppression re-check at RUN time: a queue-delayed closure
                    // from an earlier run may have marked this signature after
                    // our scan (belt to the fixerRunning suspenders).
                    .filter(orig => !userAttempts.has(clusterSignature(orig)))
                    .map(orig => ({
                        orig,
                        fresh: orig.filter(e => {
                            if (e.at.getTime() < bufferEdge) return false;
                            if (e.kind === 'routine') return true;
                            const t = freshTasks.find(ft => ft.id === e.id);
                            return !!t && t.status === 'pending'
                                && Math.abs(t.pingAt.getTime() - e.at.getTime()) < 60_000;
                        }),
                    }))
                    .filter(p => p.fresh.length >= 2 && isActionable(p.fresh));
                if (freshPairs.length === 0) {
                    console.log('🧭 [collision-fix] clusters went stale in queue, skipping:', { userId: user.userId });
                    return;
                }

                const memory = await deps.getCurrentInfo(user.userId);
                // Throws on provider failure (silent mode rethrows) — caught by
                // the per-user catch below WITHOUT marking the clusters
                // attempted, so a 429 at :07 doesn't burn the backoff window.
                const result = await AIService.streamAIResponse({
                    userId: user.userId,
                    userMessage: COLLISION_FIX_PROMPT(memory, formatClusters(freshPairs.map(p => p.fresh))),
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
                    // Hard allowlist (enforced in aiService, not just prompted):
                    // schedule tools only, and RescheduleTaskPing instead of
                    // UpdateTask — it compare-and-sets on status==='pending' and
                    // rejects past / post-dueAt moves, so this run cannot
                    // resurrect a fired task or break a deadline even if the
                    // model ignores every prompt rule.
                    allowedTools: [
                        'RescheduleTaskPing', 'GetTaskById', 'GetTasksByIdList', 'GetTasksByStatus', 'GetTasksByRoutine',
                        'UpdateRoutine', 'ListRoutines', 'GetRoutineById',
                    ],
                    purpose: 'collision-fix',
                });

                // Mark attempted ONLY after a successful AI round trip.
                const doneMs = Date.now();
                for (const p of freshPairs) {
                    userAttempts.set(clusterSignature(p.orig), doneMs + retryMsFor(p.orig));
                }

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
