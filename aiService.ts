import TelegramBot from 'node-telegram-bot-api';
import {addMessageToHistory, getRecentMessageHistory, recordAITokens, bumpStickerUsedCount, getReplyMaxTokens, getActiveTokenGrant, setTokenConsentPending} from './userStore';
import {executeTool, getAllToolDefinitions, tools} from './tools';
import {formatDateHuman, formatNowForPrompt} from "./dateUtils";
import {safeSend, safeEdit, stripSystemTags, stripInternalMarkers, exceedsTelegramLimit, mdToTelegramHtml} from './telegramFormat';
import {DEFAULT_EFFORT, FORCED_ANSWER_EFFORT, ROUTE_EFFORT} from './aiProvider';
import type {AIProvider, AssistantBlock, ProviderMessage, ToolCallInfo, ToolDefinition} from './aiProvider';

export interface AIStreamOptions {
    userId: number;
    userMessage: string;
    systemPrompt: string;
    /**
     * Optional cacheable system-prompt prefix (passed through to provider).
     * Use for the static scaffolding so it qualifies for prompt-cache hits
     * across turns; put per-turn dynamic context in `systemPrompt`.
     */
    systemPromptCachePrefix?: string;
    bot: TelegramBot;
    provider: AIProvider;
    model: string;
    maxTokens?: number;
    /**
     * Default true. Set false for silent background runs (e.g. the collision
     * fixer): aiService itself sends nothing — no streaming message, no typing
     * indicator, no image gallery, no user-facing 🐺 error on failure — and
     * provider errors RETHROW instead of returning error text as a normal
     * result (silent callers must be able to distinguish failure). Pair with
     * `allowedTools` to restrict tools, and keep addUserToHistory /
     * addAssistantToHistory false: a silent run that throws mid-tool-chain
     * would otherwise persist a user row with no assistant row.
     */
    shouldUpdateTelegram?: boolean;
    /**
     * The turn was initiated by the BOT (a scheduled task reminder, a proactive
     * ping), not by fresh user input — so nobody is sitting there waiting for a
     * reply. The AI's real text is still streamed and sent if it produces any;
     * but a turn that ends up with NO visible output is a valid outcome here (it
     * rescheduled quietly, decided this tick needs no message, or the provider
     * failed), so the "never-silent" machinery is suppressed: no NO_OUTPUT
     * fallback ("повтори, пожалуйста" to a user who never spoke), no consent
     * ask, and no 🐺 error line on provider failure. The tick simply produces
     * nothing and retries next cycle. Default false = a real user is waiting.
     */
    proactive?: boolean;
    /**
     * When set, ONLY these tools are offered to the model AND enforced at
     * execution time (a call to anything else returns an error tool_result
     * without executing). Use for background runs that must not reach the
     * user or touch unrelated state. Undefined = full registry.
     */
    allowedTools?: string[];
    addUserToHistory?: boolean;
    addAssistantToHistory?: boolean;
    currentRecursionDepth?: number;
    enableToolCalls?: boolean;
    /**
     * Think as little as the model allows on this run. Set only by the forced-answer
     * floor in streamAIResponse, when even the maximum granted budget produced no
     * visible text on a tool-less turn. Thinking goes off where the model allows it
     * and drops to FORCED_ANSWER_EFFORT where it doesn't, so more of the allowance
     * reaches text rather than the bot asking for more forever.
     */
    disableThinking?: boolean;
    appendMessagesAfterUser?: ProviderMessage[];
    /**
     * The history and current message, built once at depth 0 and handed down the
     * recursion. A chain must not re-read history between tool calls: a row that
     * lands mid-chain would change messages the model already answered.
     */
    baseMessages?: ProviderMessage[];
    /** An earlier attempt at this turn already wrote the user row, so a re-run must not
     * count it as a new message. Set by the forced-answer floor. */
    userRowWritten?: boolean;
    /** Callback to handle images from search results (sent separately, not in history) */
    onImageResults?: (images: string[]) => Promise<void>;
    /** Recorded into stat_entries.note for the token-usage stat. Default 'reply'. */
    purpose?: string;
    /**
     * Optional AbortSignal — cancels the underlying provider stream. Used by
     * the burst-coalescer in index.ts to soft-cancel a reply that hasn't yet
     * pushed visible text into Telegram (the `hasStreamedText` gate). Aborts
     * recurse into any tool-call sub-call so the whole chain unwinds.
     */
    signal?: AbortSignal;
    /**
     * Fires once, BEFORE the first safeSend is attempted (commit-on-attempt).
     * The burst-coalescer flips a flag here so subsequent incoming user
     * messages know not to abort a stream that is about to become visible —
     * it must fire even if the send then fails, or an abort racing the send
     * roundtrip would orphan a half-delivered message.
     */
    onTextStreamed?: () => void;
    /**
     * Fires once, AFTER the first safeSend actually succeeded — i.e. the user
     * verifiably received a message. Use when the caller must know delivery
     * happened (e.g. the task-reminder path records lastReminderAt from this),
     * not merely that delivery was attempted.
     */
    onTextDelivered?: () => void;
}

export interface AIStreamResult {
    message: string;
    rawResponse: string;
    toolCalls?: ToolCallInfo[];
    /**
     * The burst-coalescer soft-cancelled this reply. Deliberate silence: the
     * next coalesced reply answers, so the consent-ask and never-silent fallback
     * must both skip it.
     */
    emptyReason?: 'aborted';
    /**
     * The turn ultimately hit the token budget with no further tool to run — a
     * genuine "couldn't finish within budget", covering both a reply truncated
     * mid-sentence and a turn that spent everything on thinking and said nothing.
     * Propagated up from the deepest generation, so a truncation inside tool-call
     * recursion is still visible at the top. Drives the consent ask.
     */
    ranOutOfTokens?: boolean;
    /**
     * Any tool executed anywhere in this turn (propagated through recursion).
     * Gates the forced-answer floor: a tool-less turn is safe to re-run, a
     * tool-using one is not (addUserTask has no dedup) and must ask instead.
     */
    usedTools?: boolean;
    /** The model declined at some depth of this turn. Propagated up like ranOutOfTokens. */
    refused?: boolean;
}

/** postponeCount goes up each time the bot itself reschedules a reminder, so it
 * says nothing about the user. Shown to the model it became the whole subject of
 * the reminders ("91 переносов"), so it stops at this boundary. */
const MODEL_HIDDEN_RESULT_FIELDS = new Set(['postponeCount']);

/** Recursively strip <system> from all string leaves in a tool-result value.
 * External data (web search snippets, LuxMed doctor/clinic names, geocoded
 * addresses) reaches the next-turn provider message via tool_result content;
 * without this, a `</system>` in any of those fields could escape our
 * <system>At…</system> wrapper in the following turn. Dates pass through
 * untouched: Object.entries on a Date is empty, so walking one serialized every
 * task date as `{}` and the model could not read a time back. */
function deepStripSystemTagsInResult(value: unknown): unknown {
    if (typeof value === 'string') return stripSystemTags(value);
    if (value instanceof Date) return value;
    if (Array.isArray(value)) return value.map(deepStripSystemTagsInResult);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            if (!MODEL_HIDDEN_RESULT_FIELDS.has(k)) out[k] = deepStripSystemTagsInResult(v);
        }
        return out;
    }
    return value;
}

/** Bookkeeping tools the model has to call that say nothing about the conversation.
 * Their calls stay out of history and out of `usedTools`, so an ordinary reply
 * reads as an ordinary reply. */
const HISTORY_HIDDEN_TOOLS = new Set(['LuxmedAvailabilityReviewed']);

/** One tool record inside a stored assistant row, as written at the tool loop. */
const STORED_TOOL_RECORD = /\n*\[Tool: ([^\]\n]+)\]\n(?:Input: (.*)\n)?(?:(?:Output|Error|Blocked): (.*)\n)?/g;
const RENDERED_TOOL_RECORD_CHARS = 200;

/** A stored assistant row split into what the bot said and the tools it ran. */
function parseStoredRow(content: string): { prose: string; records: string[] } {
    // Strips on read too: legacy rows predating the write-time strip may still
    // carry stray <system> chars from past user inputs.
    const records: string[] = [];
    const prose = stripSystemTags(content).replace(STORED_TOOL_RECORD, (_row, name: string, input?: string, output?: string) => {
        if (!HISTORY_HIDDEN_TOOLS.has(name)) {
            records.push(`${name}(${input ?? ''}) -> ${output ?? ''}`.slice(0, RENDERED_TOOL_RECORD_CHARS));
        }
        return '\n';
    }).trim();
    return { prose, records };
}

/**
 * What the model reads for a stored row. Tool records move into the `<system>`
 * wrapper, because `[Tool: X]` text in the assistant role teaches the model to
 * type tool calls as plain text, and that text would reach Telegram. Anything
 * imitating the wrapper is stripped from display and from history.
 */
export function renderHistoryRow(role: 'user' | 'assistant', content: string, when: string): string {
    if (role !== 'assistant') return `<system>At ${when}</system>\n${stripSystemTags(content)}`;
    const { prose, records } = parseStoredRow(content);
    const tools = records.length ? `. Tools run: ${records.join('; ')}` : '';
    return `<system>At ${when}${tools}</system>\n${prose}`;
}

/** The bot's own words since the user last wrote, oldest first. Empty when the user
 * wrote last. */
export function messagesSinceUserWrote(history: { role: string; content: string }[], limit = 3): string[] {
    const lastUserRow = history.map(m => m.role).lastIndexOf('user');
    return history.slice(lastUserRow + 1)
        .map(m => parseStoredRow(m.content).prose)
        .filter(Boolean)
        .slice(-limit);
}

/**
 * Base output allowance when no grant window is active and the user has set no
 * persistent budget. max_tokens covers thinking AND visible text together, so at
 * the old 1500 a high-effort thinking pass could consume the whole allowance and
 * leave nothing to say. 8000 fits ordinary chat comfortably; genuinely heavy
 * tasks that overrun it trigger the consent ask rather than a silent bump.
 */
const DEFAULT_MAX_TOKENS = 8000;

/** Elevated budget a consent grant opens, and how long its window lasts. The
 * window (not a per-message counter) is what lets one "yes" cover a whole
 * multi-step task — every request inside it, tool-result recursion included,
 * resolves to this budget. 64000 sits well inside the model's 128k output cap. */
const GRANT_BUDGET = 64000;
const GRANT_WINDOW_MINUTES = 5;

/** Delivered when a turn couldn't finish within budget, so the user is never
 * left with silence AND is given the choice to let the bot spend more. Two
 * variants: one when a partial answer was shown, one when nothing was. */
const ASK_MORE_AFTER_PARTIAL = 'Ответ не уместился в лимит 🐺 Разрешишь потратить больше токенов на пару минут — тогда допишу полностью?';
const ASK_MORE_AFTER_NOTHING = 'Не хватило лимита токенов, чтобы ответить 🐺 Разрешишь потратить больше на пару минут — тогда отвечу?';

/** Last-resort words when a turn produced nothing at all for a reason that is
 * NOT a budget overrun (a refusal, an empty completion), so the user is never
 * left staring at silence wondering whether the bot is alive. */
const NO_OUTPUT_FALLBACK = 'Задумался и потерял мысль 🐺 Повтори, пожалуйста?';

/** How many tool rounds one turn may take before the model has to answer. */
const MAX_TOOL_DEPTH = 5;

/** Added after the last tool results at the limit. With tools forbidden and no note,
 * the model can end the turn with no text at all. */
const TOOL_LIMIT_NOTE = '<system>That was the last tool round for this turn. Answer the user now, in text, with what you have, and say what is left undone.</system>';

/** Delivered when the model declined the request, so the user knows it wasn't a
 * glitch and repeating it won't help. */
const REFUSAL_LINE = 'С этим не помогу 🐺';

/** Light ack when a turn did real work via a tool (UpdateMemory, TrackStat, …)
 * but the model added no text. "Потерял мысль" would be wrong there — it DID the
 * thing — so acknowledge instead of implying the bot blanked. */
const TOOL_ONLY_ACK = 'ок 🐺';

/** Does this raw model text carry anything the USER would actually see? Runs the
 * SAME pipeline the send does (strip internal markers → mdToTelegramHtml →
 * sanitize-html), so "counts as visible" can't diverge from "actually renders
 * non-empty" — content that's non-empty after marker-stripping but renders to
 * empty HTML (stray markup) would otherwise fool the never-silent floor. */
function hasVisibleText(raw: string): boolean {
    const stripped = stripInternalMarkers(raw).trim();
    if (!stripped) return false;
    try {
        return !!mdToTelegramHtml(stripped).trim();
    } catch {
        // If the renderer throws, fall back to the marker-stripped check rather
        // than wrongly declaring the turn silent.
        return true;
    }
}

// ── Provider-failure resilience ────────────────────────────────────────────
// The goal: a user only ever sees an error for something genuinely
// unrecoverable (auth/token misconfig, or the network staying down through
// every retry). Everything transient — a 429, an Anthropic 529 overloaded, a
// 5xx, a dropped socket before we've shown anything — must SELF-HEAL by retry,
// invisibly. And when we do surface something, it's a friendly in-character
// line, never a raw stack/JSON dumped into the chat.

/** How many times the stream is (re)attempted before we give up and surface a
 * message. Each attempt already benefits from the SDK's own connect-time
 * retries (Retry-After aware), so this is the outer safety net covering
 * SDK-exhaustion and errors thrown after the SSE stream had begun. */
const MAX_STREAM_ATTEMPTS = 3;

/** User-facing lines for the terminal failure classes. Vague where the cause is
 * genuinely unknown to us — but NOT where we know it exactly. An exhausted
 * balance is fixed by one specific human action, so saying "проблема с
 * доступом" just makes the user guess at something we already know. */
const AI_ERROR_TRANSIENT = 'Связь с ИИ сейчас нестабильна 🐺 Подожди минутку и повтори, пожалуйста.';
const AI_ERROR_CREDITS = 'У меня кончились токены 🐺 Пополни баланс Anthropic — до этого я отвечать не смогу.';
const AI_ERROR_AUTH = 'У меня сейчас проблема с доступом к ИИ 🐺 Это сбой на моей стороне — уже вижу его.';
const AI_ERROR_INTERNAL = 'Что-то заглючило у меня в голове 🐺 Попробуй переспросить.';

type ProviderErrorKind = 'transient' | 'credits' | 'auth' | 'malformed' | 'unknown';

/** Short message for logging, without dragging a whole stack into one line. */
function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** An intentional cancel (burst-coalescer soft-abort, SIGTERM) — must never be
 * retried or reclassified as a provider failure. Matches by name/constructor
 * and message because the SDKs' abort errors don't set a consistent `.name`. */
function isAbortLikeError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.name === 'AbortError'
        || err.constructor?.name === 'APIUserAbortError'
        || /aborted|cancel/i.test(err.message);
}

/** Classify a provider failure so we know whether to retry it and, if it
 * survives all retries, which friendly line to show.
 *  - transient: retry it (429 / 5xx / 529 overloaded / dropped connection)
 *  - credits:   balance exhausted — no retry, and we name it outright because
 *               exactly one action fixes it (top up)
 *  - auth:      unrecoverable, tell the user it's on our side (bad/absent key,
 *               revoked access) — no retry, it won't change
 *  - malformed: we built a bad request (400/404/422) — a bug to fix, not retry
 *  - unknown:   anything unrecognised — treat conservatively (no retry) */
export function classifyProviderError(err: unknown): ProviderErrorKind {
    const anyErr = err as { status?: number; code?: string; name?: string; constructor?: { name?: string } };
    const status = typeof anyErr?.status === 'number' ? anyErr.status : undefined;
    const code = typeof anyErr?.code === 'string' ? anyErr.code : undefined;
    const ctor = anyErr?.constructor?.name ?? anyErr?.name;
    const msg = errMsg(err).toLowerCase();

    // Out of money. Checked BEFORE the generic auth branch because Anthropic
    // returns it as a 400 with an ordinary invalid_request_error — status alone
    // is indistinguishable from a malformed request, so match the message.
    // `insufficient_quota` is the OpenAI-compat shape of the same thing.
    if (/credit balance|insufficient[\s_-]?(credit|quota|funds)|billing/.test(msg)
        || code === 'insufficient_quota') {
        return 'credits';
    }

    // Auth: fixed by a human, never by retrying.
    if (status === 401 || status === 403
        || /invalid[\s_-]?api[\s_-]?key|authentication|x-api-key|permission denied/.test(msg)) {
        return 'auth';
    }

    // Transient: worth another attempt.
    if (status === 408 || status === 409 || status === 429
        || (status !== undefined && status >= 500)
        || /overloaded|rate.?limit|too many requests|service unavailable|internal server error|timeout|timed out|econnreset|etimedout|econnrefused|eai_again|enotfound|socket hang up|fetch failed|network|terminated|connection error/.test(msg)
        || ctor === 'APIConnectionError' || ctor === 'APIConnectionTimeoutError'
        || (code !== undefined && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(code))) {
        return 'transient';
    }

    // A request the model/API rejected as malformed — our bug to prevent, not
    // to retry (retrying re-sends the same bad request).
    if (status === 400 || status === 404 || status === 422) return 'malformed';

    return 'unknown';
}

/** Backoff before the next attempt: exponential + jitter, but never below a
 * provider-supplied Retry-After. Capped so a chat reply can't stall for long. */
function retryDelayMs(attempt: number, err: unknown): number {
    const backoff = Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 300);
    const headers = (err as { headers?: unknown })?.headers;
    let retryAfterSec: number | undefined;
    if (headers && typeof (headers as { get?: unknown }).get === 'function') {
        const v = (headers as { get: (k: string) => string | null }).get('retry-after');
        if (v != null) retryAfterSec = Number(v);
    } else if (headers && typeof headers === 'object') {
        const v = (headers as Record<string, unknown>)['retry-after'];
        if (v != null) retryAfterSec = Number(v);
    }
    if (retryAfterSec !== undefined && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
        return Math.max(backoff, Math.min(retryAfterSec * 1000, 15000));
    }
    return backoff;
}

/** setTimeout that rejects promptly if the burst-coalescer aborts mid-wait, so
 * a soft-cancel during backoff unwinds instead of sleeping out the full delay. */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export class AIService {
    /**
     * Unified function to handle AI streaming responses with tool calling support.
     *
     * Also guarantees the turn FINISHES, however complex the task, and never
     * ends in silence — but WITHOUT silently spending more than its budget.
     *
     * The failure this defends against: max_tokens caps thinking and visible
     * text *together*, and adaptive thinking expands to fill whatever it is
     * given — so a turn can spend its whole allowance thinking and return no
     * text and no tool calls (production incident 2026-07-17, max_tokens=1500),
     * or simply truncate a long answer. The response is consent-gated, not auto:
     *
     *   1. RE-ALLOCATE for free. Ordinary chat fits the base budget; nothing to
     *      do. (Using the same budget differently — e.g. the forced-answer floor
     *      below — is not "spending more" and needs no consent.)
     *   2. ASK to spend more. When the turn couldn't finish within budget, the
     *      bot tells the user and asks permission (setTokenConsentPending). It
     *      does NOT escalate on its own. The ask is always delivered, so this is
     *      also the never-silent guarantee for a budget overrun.
     *   3. On the user's "yes", the model calls GrantMoreTokens, which opens a
     *      time-boxed elevated-budget WINDOW. Every request inside it — including
     *      tool-result recursion — resolves to the elevated budget (see
     *      resolveReplyBudget), so a multi-step task finishes on one grant.
     *   4. FORCED-ANSWER FLOOR. If even the maximum granted budget yields no text
     *      on a tool-less turn, re-running would only ask forever — so re-run once
     *      with as little thinking as the model allows. Safe because no tool ran
     *      (nothing to duplicate). No guarantee on always-thinking models, which
     *      is why step 5 follows it.
     *   5. SPEAK ANYWAY. A non-budget empty (refusal, odd completion) still gets
     *      a fallback line, so the user is never left with silence.
     */
    static async streamAIResponse(options: AIStreamOptions): Promise<AIStreamResult> {
        const withDefaults = (opts: AIStreamOptions): AIStreamOptions => ({
            ...opts,
            // Tools are always enabled by default (unless recursion limit reached)
            enableToolCalls: (opts.currentRecursionDepth ?? 0) >= MAX_TOOL_DEPTH ? false : (opts.enableToolCalls ?? true),
        });

        const isTopLevel = (options.currentRecursionDepth ?? 0) === 0;

        // Track confirmed delivery across the whole turn, including the tool-call
        // recursion — onTextDelivered fires per level, and a tool-first reply's
        // only visible text may come from depth 1+.
        let delivered = false;
        const observed = withDefaults({
            ...options,
            // The only place the model learns today's date. Depth 0 only: recursion
            // inherits this prompt, so the time holds still through a tool chain.
            systemPrompt: isTopLevel ? `${formatNowForPrompt()}\n${options.systemPrompt}` : options.systemPrompt,
            onTextDelivered: () => {
                delivered = true;
                options.onTextDelivered?.();
            },
        });

        // One generation. The effective budget (base, persistent, or an active
        // grant window) is resolved inside — freshly, at every recursion level —
        // so a grant the model opens mid-turn covers the continuation too.
        // `let` because the forced-answer floor may replace it with its retry.
        let result = await this.streamAIResponseInternal(observed);

        // The consent ask, forced-answer floor, and never-silent fallback are the
        // turn's final word: only the top level, only for a real user, speaks
        // them. A recursion level (depth > 0) and a silent background run both
        // return their result untouched.
        const userFacing = options.shouldUpdateTelegram ?? true;
        if (!isTopLevel || !userFacing) return result;

        // Aborts are deliberate silence — the next coalesced reply answers.
        if (result.emptyReason === 'aborted') return result;

        // Proactive (bot-initiated) turns have nobody waiting: real text was
        // already streamed if there was any, and an empty turn is a valid
        // "nothing to say this tick". Suppress every synthetic floor below — the
        // consent ask, the forced-answer re-run, and the NO_OUTPUT fallback —
        // because "Задумался и потерял мысль, повтори" fired at a user who never
        // spoke is self-inflicted noise, not a safety net.
        if (options.proactive) return result;

        // "Did the user actually SEE text this turn?" — the only reliable signal
        // across recursion. `delivered` flips on any confirmed send at any depth
        // (a tool-first reply's answer streams from depth 1+, and result.message
        // holds only the depth-0 text). And it must be VISIBLE text: the delivery
        // path skips a message whose stripped/trimmed body is empty (whitespace
        // or an echoed <system>/<thinking> block), so raw result.message
        // truthiness would wrongly count that as "seen".
        const sawText = delivered || hasVisibleText(result.message);

        if (result.ranOutOfTokens) {
            // Forced-answer floor: a tool-less, text-less turn at the maximum
            // granted budget can't be helped by asking for still more — the model
            // needs more of the allowance for text. Try once to force an answer out.
            const grantActive = (await getActiveTokenGrant(options.userId)) !== null;
            if (!result.usedTools && !sawText && grantActive) {
                console.warn(`🔇→🗣 ${options.userId}: granted budget still produced no text — retrying with as little thinking as the model allows`);
                const forced = await this.streamAIResponseInternal({
                    ...observed,
                    disableThinking: true,
                    addUserToHistory: false, // the user row was written on the first attempt
                    userRowWritten: observed.addUserToHistory ?? true,
                });
                // Return the forced attempt if it delivered or produced visible
                // text (it may have gone tool-first, delivering via recursion
                // with an empty top-level message). Only if it too came up empty
                // do we fall through to the never-silent fallback with its result.
                if (delivered || hasVisibleText(forced.message)) return forced;
                result = forced;
            } else {
                // Couldn't finish within budget: ask the user for permission to
                // spend more. Reliably delivered, so it doubles as never-silent.
                // sawText picks the wording — "didn't fit, finish it?" if a
                // partial showed, "couldn't answer, may I?" if nothing did.
                await this.askForMoreTokens(options, sawText);
                return result;
            }
        }

        // Below the budget block so these also cover the forced re-run above.
        if (result.emptyReason === 'aborted') return result;
        if (result.refused) {
            await safeSend(options.bot, options.userId, REFUSAL_LINE);
            return { ...result, message: REFUSAL_LINE, rawResponse: REFUSAL_LINE };
        }

        // Never-silent floor for a non-budget empty (refusal, odd completion).
        // Gated on VISIBLE text, matching the delivery path — a whitespace- or
        // marker-only completion is nothing from the user's side even though its
        // raw message string is non-empty. The error-catch path is unaffected:
        // its 🐺 text is visible, so this correctly stays quiet after it.
        if (!delivered && !hasVisibleText(result.message)) {
            if (result.usedTools) {
                // The turn DID real work via a tool (UpdateMemory, TrackStat, …)
                // but the model added no text — e.g. "запомни, что я люблю кофе".
                // "Потерял мысль, повтори" would be wrong (it remembered); a light
                // ack is the honest floor here.
                console.warn(`🔇→🗣 ${options.userId}: tool-only turn with no text — sending ack`);
                await safeSend(options.bot, options.userId, TOOL_ONLY_ACK);
                return { ...result, message: TOOL_ONLY_ACK, rawResponse: TOOL_ONLY_ACK };
            }
            console.error(`🚨 ${options.userId}: turn delivered nothing to the user — sending fallback`);
            await safeSend(options.bot, options.userId, NO_OUTPUT_FALLBACK);
            return { ...result, message: NO_OUTPUT_FALLBACK, rawResponse: NO_OUTPUT_FALLBACK };
        }

        return result;
    }

    /**
     * The effective per-request output budget, resolved fresh on every call so a
     * grant window opened mid-turn immediately covers the tool-result recursion.
     *
     * Background callers (collision fixer, style scan) pass an explicit cap and
     * get exactly it — grants belong to user chats, not cron jobs. A user-facing
     * request takes the active grant window if one is open, otherwise the user's
     * persistent budget, otherwise the default.
     */
    private static async resolveReplyBudget(options: AIStreamOptions): Promise<number> {
        const userFacing = options.shouldUpdateTelegram ?? true;
        if (!userFacing) return options.maxTokens ?? DEFAULT_MAX_TOKENS;
        const [grant, persistent] = await Promise.all([
            getActiveTokenGrant(options.userId),
            getReplyMaxTokens(options.userId),
        ]);
        const base = options.maxTokens ?? persistent ?? DEFAULT_MAX_TOKENS;
        return grant ? Math.max(grant, base) : base;
    }

    /**
     * Tell the user the answer didn't fit and ask permission to spend more, and
     * flag the pending consent so the next turn acts on their reply (the model
     * is told, via getCurrentInfo, to call GrantMoreTokens on a "yes"). Delivered
     * unconditionally — this is what keeps a budget overrun from being silent.
     */
    private static async askForMoreTokens(options: AIStreamOptions, hadPartial: boolean): Promise<void> {
        console.warn(`🙋 ${options.userId}: couldn't finish within budget — asking permission to use more`);
        await setTokenConsentPending(options.userId)
            .catch(err => console.warn('[budget] setTokenConsentPending failed:', err instanceof Error ? err.message : err));
        await safeSend(options.bot, options.userId, hadPartial ? ASK_MORE_AFTER_PARTIAL : ASK_MORE_AFTER_NOTHING);
    }

    /**
     * Internal method to handle AI streaming responses
     */
    private static async streamAIResponseInternal(options: AIStreamOptions): Promise<AIStreamResult> {
        const {
            userId,
            userMessage,
            systemPrompt,
            systemPromptCachePrefix,
            bot,
            provider,
            model,
            shouldUpdateTelegram = true,
            addUserToHistory = true,
            addAssistantToHistory = true,
            enableToolCalls = false,
            currentRecursionDepth = 0,
            appendMessagesAfterUser,
        } = options;

        // Resolved fresh here (not passed down from the parent), so a grant
        // window opened earlier in this same turn already applies to this call.
        const maxTokens = await this.resolveReplyBudget(options);

        // Hoisted to function scope so the abort catch can salvage partial
        // billing data. Anthropic emits `message_start` with input_tokens
        // (and cache info) very early in the stream — well before the for-
        // await throws on AbortError. Recording those after abort keeps
        // internal token accounting honest about what we actually paid for.
        let usageInputTokens = 0;
        let usageOutputTokens = 0;
        let usageCacheReadTokens = 0;
        let usageCacheWriteTokens = 0;

        try {
            // Tracks the message THIS generation is streaming into, so mid-stream
            // ticks edit it rather than posting duplicates. Fresh per call.
            let messageId: number | undefined;
            let lastSentContent: string = '';
            // Guard against retrying the initial send on every throttled tick after
            // a transient Telegram failure (would surface duplicate messages if a
            // later retry succeeds). Final tick (isFinal=true) still retries once.
            let initialSendFailed = false;

            // NOTE: userMessage may be (a) real Telegram user text or (b) a bot-
            // synthesized prompt wrapped in <system>…</system> (TASK_TRIGGERED_PROMPT,
            // GREETING_PROMPT, etc. — the AI is told to obey these). Real-user text is
            // stripped at its ingress point (index.ts bot.on('message')), NOT here —
            // otherwise bot-synthesized prompts get wiped to empty.
            if (addUserToHistory) {
                await addMessageToHistory(userId, 'user', userMessage);
                const preview = userMessage.length > 100
                    ? userMessage.substring(0, 100) + '...'
                    : userMessage;
                console.log(`📝 Added user message to history: "${preview.replace(/\n/g, ' ')}"`);
            }

            // Function to update Telegram message during streaming
            async function updateTelegramMessage(isFinal = false) {
                if (!shouldUpdateTelegram) return;
                try {
                    const stripped = stripInternalMarkers(aiResponseAccumulated).trim();
                    const contentToSend = isFinal ? stripped : stripped + ' ...';

                    if (!aiResponseAccumulated.length) {
                        console.warn('AI response is empty, not updating Telegram message');
                        return;
                    }
                    // Early stream may be all <thinking>/<system> — no visible content yet
                    if (!stripped.length) return;

                    if (!messageId) {
                        if (initialSendFailed && !isFinal) return;
                        // Flip hasStreamedText BEFORE awaiting safeSend (commit-on-attempt).
                        // Telegram's send roundtrip is 100-300ms; if an incoming user message
                        // races into that window, softAbortIfPretext would otherwise abort
                        // the stream while safeSend is mid-flight, leaving an orphan first
                        // chunk visible in Telegram + a duplicate full reply afterwards.
                        // Flipping early means: once we've decided to push visible text, we
                        // commit to finishing this reply.
                        try { options.onTextStreamed?.(); } catch (e) { /* listener bug shouldn't kill stream */ }
                        const sentMessage = await safeSend(bot, userId, contentToSend);
                        if (sentMessage) {
                            messageId = sentMessage.message_id;
                            lastSentContent = aiResponseAccumulated;
                            // Confirmed delivery (unlike onTextStreamed above,
                            // which is commit-on-attempt). Fires at most once PER
                            // RECURSION LEVEL (messageId is set now, so this
                            // branch never re-runs within this level; the tool-
                            // loop recursion starts a fresh message and may fire
                            // again — load-bearing for tool-first replies whose
                            // visible text only appears at depth 1+).
                            try { options.onTextDelivered?.(); } catch (e) { /* listener bug shouldn't kill stream */ }
                        } else {
                            initialSendFailed = true;
                        }
                    } else {
                        // On the FINAL tick, full content may exceed Telegram's 4096 limit.
                        // safeEdit can only truncate (one message_id). Edit the first
                        // chunk into the existing message, then deliver the remainder
                        // as follow-up messages via safeSend (which splits further).
                        if (isFinal && exceedsTelegramLimit(contentToSend)) {
                            const firstChunk = contentToSend.slice(0, 3900);
                            const rest = contentToSend.slice(3900);
                            await safeEdit(bot, firstChunk, {
                                chat_id: userId,
                                message_id: messageId,
                            });
                            await safeSend(bot, userId, rest);
                        } else {
                            await safeEdit(bot, contentToSend, {
                                chat_id: userId,
                                message_id: messageId,
                            });
                        }
                        lastSentContent = aiResponseAccumulated;
                    }
                } catch (error) {
                    console.error('Failed to update message:', error);
                }
            }

            console.log('💬 Generating AI response:', {
                userId,
                userMessage,
                timestamp: new Date().toISOString()
            });

            const baseMessages = options.baseMessages
                ?? await this.buildBaseMessages(userId, userMessage, addUserToHistory || !!options.userRowWritten);
            const messages: ProviderMessage[] = [...baseMessages, ...(appendMessagesAfterUser || [])];
            const atToolLimit = currentRecursionDepth >= MAX_TOOL_DEPTH;
            if (atToolLimit) messages.push({ role: 'user', content: TOOL_LIMIT_NOTE });

            // Get tool definitions if enabled. allowedTools narrows the offer —
            // background runs (collision fixer) get only schedule tools so the
            // model can't reach user-facing or unrelated tools at all.
            // At the limit the model must answer, but `tools` stays declared. Messages
            // already hold tool blocks, and those need it, and removing it would also
            // invalidate the thinking blocks replayed in this chain.
            const toolDefs: ToolDefinition[] | undefined = enableToolCalls || atToolLimit
                ? getAllToolDefinitions()
                    .filter(t => !options.allowedTools || options.allowedTools.includes(t.function.name))
                    .map(t => ({
                        name: t.function.name,
                        description: t.function.description || '',
                        parameters: t.function.parameters as Record<string, unknown>,
                    }))
                : undefined;

            console.debug('💬 AI request via', provider.name, {
                model,
                maxTokens,
                toolCount: toolDefs?.length ?? 0,
                ...(options.disableThinking ? { thinking: 'minimal (no-silence retry)' } : {}),
            });

            let aiResponseAccumulated = '';
            let historyResponseAccumulated = '';
            const toolCalls: ToolCallInfo[] = [];
            let assistantBlocks: AssistantBlock[] | undefined;
            let stopReason: string | undefined;
            let refusalCategory: string | null | undefined;
            // usageInputTokens/usageOutputTokens are declared at function scope
            // above (so the catch block can read them on abort).

            if (shouldUpdateTelegram) {
                await bot.sendChatAction(userId, 'typing');
            }

            // Set up periodic updates during streaming (skipped entirely in
            // silent mode — updateTelegramMessage would be a no-op anyway)
            const updateInterval_id = shouldUpdateTelegram ? setInterval(async () => {
                if (aiResponseAccumulated.length > lastSentContent.length + 100) {
                    try {
                        await updateTelegramMessage();
                    } catch (error) {
                        console.error('Failed to update message during streaming:', error);
                    }
                }
            }, 500) : undefined;

            // Consume the stream with transparent retry. A transient provider
            // failure (429, 5xx, 529 overloaded, a dropped socket) that happens
            // BEFORE any visible text reached the user is retried with backoff,
            // so the user never sees it — the reply just self-heals. We only
            // retry while `messageId === undefined`: once a chunk has been sent
            // to Telegram, a retry would duplicate or clobber it, so from that
            // point a failure falls through to the outer catch instead. Aborts,
            // auth errors, and malformed-request bugs are never retried.
            //
            // try/finally guarantees clearInterval on stream throw — without it
            // a mid-stream provider error (429, reset) leaks the 500ms timer for
            // the life of the process, each tick firing another safeEdit call.
            try {
                for (let attempt = 1; ; attempt++) {
                    try {
                        // Fresh generator per attempt — options.signal is forwarded
                        // so the burst-coalescer can abort an in-flight reply that
                        // hasn't yet shown visible text.
                        const stream = provider.streamChat({
                            systemPrompt,
                            systemPromptCachePrefix,
                            messages,
                            tools: toolDefs,
                            forbidToolUse: atToolLimit,
                            maxTokens,
                            model,
                            signal: options.signal,
                            disableThinking: options.disableThinking,
                            effort: options.disableThinking
                                ? FORCED_ANSWER_EFFORT
                                : ROUTE_EFFORT[options.purpose ?? 'reply'] ?? DEFAULT_EFFORT,
                        });

                        for await (const chunk of stream) {
                            switch (chunk.type) {
                                case 'text':
                                    aiResponseAccumulated += chunk.content;
                                    break;

                                case 'stop_reason':
                                    stopReason = chunk.reason;
                                    refusalCategory = chunk.category;
                                    break;

                                case 'fallback':
                                    // Calls from the declined model were never run.
                                    toolCalls.length = 0;
                                    break;

                                case 'tool_call_start': {
                                    if (!toolCalls[chunk.index]) {
                                        toolCalls[chunk.index] = {
                                            id: chunk.id,
                                            name: chunk.name,
                                            arguments: '',
                                        };
                                    } else {
                                        // Append name if streamed in parts
                                        toolCalls[chunk.index].name += chunk.name;
                                    }
                                    break;
                                }

                                case 'tool_call_args': {
                                    if (toolCalls[chunk.index]) {
                                        toolCalls[chunk.index].arguments += chunk.args;
                                    }
                                    break;
                                }

                                case 'thinking':
                                    console.debug(`💭 [thinking] ${chunk.content.substring(0, 200)}`);
                                    break;

                                case 'assistant_blocks':
                                    // The turn in stream order, for multi-turn thinking continuity
                                    assistantBlocks = chunk.blocks;
                                    break;

                                case 'usage':
                                    usageInputTokens = chunk.input_tokens;
                                    usageOutputTokens = chunk.output_tokens;
                                    usageCacheReadTokens = chunk.cache_read_tokens ?? 0;
                                    usageCacheWriteTokens = chunk.cache_creation_tokens ?? 0;
                                    break;

                                case 'done':
                                    break;
                            }
                        }
                        break; // stream consumed cleanly — leave the retry loop
                    } catch (streamErr) {
                        // A deliberate cancel is not a provider failure: hand it
                        // straight to the outer catch's abort branch.
                        if (options.signal?.aborted || isAbortLikeError(streamErr)) throw streamErr;

                        const kind = classifyProviderError(streamErr);
                        const canRetry = kind === 'transient'
                            && messageId === undefined      // nothing shown to the user yet
                            && attempt < MAX_STREAM_ATTEMPTS;
                        if (!canRetry) throw streamErr;     // outer catch surfaces a friendly line

                        // Discard the failed attempt's partial state BEFORE the
                        // backoff so the 500ms interval can't flush a half-baked
                        // reply (which would set messageId and block the retry).
                        aiResponseAccumulated = '';
                        toolCalls.length = 0;
                        assistantBlocks = undefined;
                        stopReason = undefined;
                        usageInputTokens = 0;
                        usageOutputTokens = 0;
                        usageCacheReadTokens = 0;
                        usageCacheWriteTokens = 0;

                        const delay = retryDelayMs(attempt, streamErr);
                        console.warn(`⟳ [${userId}] provider ${kind} error (attempt ${attempt}/${MAX_STREAM_ATTEMPTS}) — retrying in ${delay}ms: ${errMsg(streamErr)}`);
                        await sleepWithAbort(delay, options.signal);
                    }
                }
            } finally {
                clearInterval(updateInterval_id);
            }

            // Both Anthropic and OpenAI SDKs SILENTLY EXIT their stream iterator
            // on signal-triggered abort (see node_modules/@anthropic-ai/sdk/core/streaming.js:70-73
            // — `if (isAbortError(e)) return;`). Our for-await loop above sees a
            // clean iterator completion, NOT a thrown AbortError. Without this
            // explicit post-loop check, control falls through to updateTelegramMessage(true)
            // below, which would safeSend any short (<100 char) accumulated text
            // — producing an orphan partial reply in Telegram for a burst the
            // user already moved past. Bail here so the next coalesced reply
            // owns the full response.
            if (options.signal?.aborted) {
                console.log(`🛑 AI reply aborted for ${userId} (SDK silent-exit on signal)`);
                if (usageInputTokens || usageOutputTokens) {
                    recordAITokens(userId, usageInputTokens, usageOutputTokens, options.purpose ?? 'reply', model, usageCacheReadTokens, usageCacheWriteTokens)
                        .catch(err => console.warn('[token-stat] partial recordAITokens (silent abort) failed:', err instanceof Error ? err.message : err));
                }
                // This is the USUAL abort path (the catch block is the rare
                // one), so it carries the same 'aborted' marker: the ladder must
                // never retry a deliberate cancel, and an aborted turn must not
                // record a budget ask.
                return { message: '', rawResponse: '', emptyReason: 'aborted' };
            }

            // Record AI token usage. recordAITokens double-writes: per-user AND user_id=0 (global).
            // userId is the actual user the AI is replying to or working on behalf of.
            // Catch is required: SQLite write contention can reject and we don't want
            // an unhandled rejection killing the process.
            const purpose = options.purpose ?? 'reply';
            recordAITokens(userId, usageInputTokens, usageOutputTokens, purpose, model, usageCacheReadTokens, usageCacheWriteTokens)
                .catch(err => console.warn('[token-stat] recordAITokens failed:', err instanceof Error ? err.message : err));

            // Detect inline custom-emoji + sticker references the AI emitted in its reply.
            // Each unique cache_key bumped once per response (not once per occurrence in text).
            // Failures are swallowed — usage tracking is fire-and-forget.
            try {
                const emittedKeys = new Set<string>();
                const tgEmojiRe = /<tg-emoji\s+emoji-id="([^"]+)">/gi;
                let m: RegExpExecArray | null;
                while ((m = tgEmojiRe.exec(aiResponseAccumulated)) !== null) emittedKeys.add(m[1]);
                for (const key of emittedKeys) bumpStickerUsedCount(key);
            } catch (err) {
                console.warn('[used_count] inline tag scan failed:', err instanceof Error ? err.message : err);
            }

            console.log('🤖 AI RAW:', {
                userId,
                aiResponseAccumulated,
                toolCalls,
                timestamp: new Date().toISOString()
            });

            historyResponseAccumulated = aiResponseAccumulated;

            // Final display tick: mdToTelegramHtml via safeEdit strips <system>/<thinking>/legacy
            // tags through sanitize-html's nonTextTags. No separate cleanup needed.
            // Every attempt commits its own visible text now — there is no
            // supersede-and-replace, so a truncated answer is the real answer
            // (the consent ask offers to extend it) and must be shown and kept.
            // A decline ends the turn: text before it isn't an answer to send or keep,
            // and tool calls before it must not run.
            const refused = stopReason === 'refusal';
            if (refused) {
                console.warn(`🚫 ${userId}: the model declined this turn`, { category: refusalCategory ?? 'none' });
                toolCalls.length = 0;
                historyResponseAccumulated = '';
            } else {
                await updateTelegramMessage(true);
            }

            // A tool call cut off by max_tokens has partial arguments, so it can't run.
            // Dropping it lets the budget ask handle the turn instead of spending the
            // same budget on another round.
            if (stopReason === 'max_tokens') {
                toolCalls.length = 0;
            }

            // Carries the deepest generation's terminal state up so the top level
            // can tell whether the WHOLE turn finished within budget.
            let recursiveResult: AIStreamResult | undefined;

            if (toolCalls.length > 0 && enableToolCalls) {

                console.log('🔧 Executing tool calls:', {
                    userId,
                    toolCalls,
                    timestamp: new Date().toISOString()
                });

                const newAppendedMessages: ProviderMessage[] = [...(appendMessagesAfterUser || [])];
                newAppendedMessages.push({
                    role: 'assistant',
                    content: stripSystemTags(aiResponseAccumulated),
                    toolCalls: toolCalls.map(tc => ({
                        id: tc.id,
                        name: tc.name,
                        arguments: tc.arguments || '{}',
                    })),
                    // Text is stripped as above; thinking and tool blocks replay as they came.
                    blocks: assistantBlocks
                        ?.map(block => block.type === 'text' ? { ...block, text: stripSystemTags(block.text) } : block)
                        .filter(block => block.type !== 'text' || block.text),
                });

                for (const toolCall of toolCalls) {
                    // Burst-coalesce abort check: tools (DB writes, sendPhoto, addUserTask,
                    // GoogleMaps calls, etc.) are awaited synchronously with no signal
                    // wired through executeTool. If abort fires mid-tool-loop, the
                    // tools that ALREADY started will run to completion, but skip
                    // any that haven't begun — limits user-visible duplicate side-
                    // effects (tasks created twice, images sent twice) when the next
                    // coalesced reply re-issues the same calls.
                    if (options.signal?.aborted) {
                        console.log(`🛑 Skipping tool ${toolCall.name} — abort signalled`);
                        break;
                    }

                    const toolName = toolCall.name;
                    const toolArgs = toolCall.arguments;

                    // Enforce the allowlist at execution time too — the model can
                    // hallucinate tools it wasn't offered; reject without executing.
                    if (options.allowedTools && !options.allowedTools.includes(toolName)) {
                        console.warn(`🚫 Tool ${toolName} blocked — not in allowedTools for this run`);
                        newAppendedMessages.push({
                            role: 'tool_result',
                            toolCallId: toolCall.id,
                            content: JSON.stringify({ error: `Tool ${toolName} is not available in this context` }),
                        });
                        // Keep the history trace complete for history-writing
                        // callers — under-reporting what the model attempted
                        // would make later turns look inconsistent.
                        historyResponseAccumulated = `${historyResponseAccumulated}\n\n[Tool: ${toolName}]\nBlocked: not in allowedTools for this run\n`;
                        continue;
                    }

                    let parsedArgs: Record<string, unknown> = {};
                    try {
                        parsedArgs = JSON.parse(toolArgs || '{}');
                    } catch { /* ignore parse errors */ }
                    const hiddenFromHistory = HISTORY_HIDDEN_TOOLS.has(toolName);

                    // Log tool call with arguments
                    console.log(`\n🔧 Tool Call: ${toolName}`);
                    console.log(`   📥 Args: ${JSON.stringify(parsedArgs, null, 2).split('\n').join('\n   ')}`);

                    try {
                        const result = await executeTool(
                            toolName as keyof typeof tools,
                            toolArgs,
                            userId,
                        );

                        // Handle images from search results (send separately, not in history)
                        if ((toolName === 'WebSearch' || toolName === 'SearchImages') &&
                            result && typeof result === 'object' && 'images' in result) {
                            const images = (result as { images?: string[] }).images;
                            // shouldUpdateTelegram gate: the gallery is user-facing
                            // output — silent runs must not send it even if the
                            // caller wired the callback.
                            if (images && images.length > 0 && options.onImageResults && shouldUpdateTelegram) {
                                console.log(`   🖼️ Sending ${images.length} images separately`);
                                await options.onImageResults(images);
                            }
                            // Remove images from result before adding to history/context
                            delete (result as { images?: string[] }).images;
                        }

                        // Log result summary
                        const resultStr = JSON.stringify(deepStripSystemTagsInResult(result));
                        const logSummary = resultStr.length > 500
                            ? resultStr.substring(0, 500) + '...'
                            : resultStr;
                        const historySummary = resultStr.length > 300
                            ? resultStr.substring(0, 300) + '...'
                            : resultStr;
                        console.log(`   📤 Result: ${logSummary}`);
                        console.log(`   ✅ Success\n`);

                        newAppendedMessages.push({
                            role: 'tool_result',
                            toolCallId: toolCall.id,
                            content: resultStr,
                        });

                        if (!hiddenFromHistory) {
                            historyResponseAccumulated = `${historyResponseAccumulated}\n\n[Tool: ${toolName}]\nInput: ${JSON.stringify(parsedArgs)}\nOutput: ${stripSystemTags(historySummary)}\n`;
                        }
                    } catch (error) {
                        const errorMsg = error instanceof Error ? error.message : String(error);
                        console.log(`   ❌ Error: ${errorMsg}\n`);

                        newAppendedMessages.push({
                            role: 'tool_result',
                            toolCallId: toolCall.id,
                            content: JSON.stringify({error: errorMsg}),
                        });

                        if (!hiddenFromHistory) {
                            historyResponseAccumulated = `${historyResponseAccumulated}\n\n[Tool: ${toolName}]\nInput: ${JSON.stringify(parsedArgs)}\nError: ${stripSystemTags(errorMsg)}\n`;
                        }
                    }
                }

                // If abort fired during the tool loop above, newAppendedMessages
                // is missing tool_result blocks for skipped tools — sending that
                // to the API would error (Anthropic requires every tool_use to
                // have a paired tool_result). Bail out cleanly without recursing,
                // BUT first persist a partial assistant row capturing the tool
                // calls that did run. Without this, the next coalesced reply
                // sees no record of the work and re-issues the same tool calls
                // — addUserTask has no dedup, so the user ends up with
                // duplicate tasks (and duplicate sendPhoto, etc.).
                if (options.signal?.aborted) {
                    console.log(`🛑 Skipping recursive AI call — abort signalled during tool loop`);
                    if (addAssistantToHistory) {
                        const safeAssistantContent = stripSystemTags(historyResponseAccumulated);
                        if (safeAssistantContent) {
                            await addMessageToHistory(userId, 'assistant', safeAssistantContent);
                            console.log(`📝 Added partial (abort) assistant row to history (${safeAssistantContent.length} chars)`);
                        }
                    }
                    // Aborted, not empty — tools already ran here, so this must
                    // never be re-run (addUserTask has no dedup). A child hands its
                    // record up, because only depth 0 writes history.
                    return { message: '', rawResponse: historyResponseAccumulated, emptyReason: 'aborted' };
                }

                console.log(`🔄 Continuing with ${newAppendedMessages.length} tool result(s), depth: ${currentRecursionDepth + 1}`);

                recursiveResult = await this.streamAIResponse({
                    ...options,
                    currentRecursionDepth: currentRecursionDepth + 1,
                    appendMessagesAfterUser: newAppendedMessages,
                    baseMessages,
                    addUserToHistory: false, // Don't add recursive calls to history
                    // Depth 0 writes one row for the whole chain. A row per level
                    // left consecutive assistant rows, which compaction then
                    // rewrote as third-person summaries.
                    addAssistantToHistory: false,
                    // disableThinking belongs to THIS level's forced-answer floor
                    // only; letting it leak down would silently disable thinking
                    // for the rest of the chain. The child resolves its own budget
                    // from the DB, so a grant applies without being passed in.
                    disableThinking: undefined,
                });

                historyResponseAccumulated = historyResponseAccumulated + recursiveResult.rawResponse;

            }

            // Always persist what we did, even if abort fired during the
            // recursive call. historyResponseAccumulated reflects the actual
            // work completed (outer text + tool summaries + recursive text);
            // dropping it on abort caused the next coalesced reply to re-do
            // the same tool calls (creating duplicate tasks/images). Aborts
            // before any tool runs are caught earlier (catch block returns
            // empty without ever reaching this line). Skip writing if the
            // content is empty — happens when the model emits only thinking
            // blocks then silently completes; the consent ask handles that case,
            // and there is nothing to record.
            if (addAssistantToHistory) {
                const safeAssistantContent = stripSystemTags(historyResponseAccumulated);
                if (safeAssistantContent) {
                    await addMessageToHistory(userId, 'assistant', safeAssistantContent);
                    const preview = safeAssistantContent.length > 100
                        ? safeAssistantContent.substring(0, 100) + '...'
                        : safeAssistantContent;
                    console.log(`📝 Added assistant message to history: "${preview.replace(/\n/g, ' ')}"`);
                } else if (!refused) {
                    // Thinking-only completion — no text, no tools. Nothing to
                    // persist; the top level asks the user for more budget.
                    console.warn(`⚠️ AI emitted thinking-only response for ${userId} — no visible output, no history row written`, { stopReason });
                }
            }

            // "Couldn't finish within budget", folding in the recursion: if we
            // recursed, the deepest child is the turn's tail and carries the
            // verdict; otherwise it's our own stop_reason with nothing left to
            // run. usedTools is true if any tool ran at this level or below —
            // it gates the forced-answer floor (only a tool-less turn is safe to
            // re-run).
            const ownRanOut = stopReason === 'max_tokens' && toolCalls.length === 0;
            const ranOutOfTokens = recursiveResult ? !!recursiveResult.ranOutOfTokens : ownRanOut;
            const usedTools = toolCalls.some(tc => !HISTORY_HIDDEN_TOOLS.has(tc.name)) || !!recursiveResult?.usedTools;

            return {
                message: aiResponseAccumulated,
                // This level's text, tool records and everything below it, so the
                // row depth 0 writes keeps tool records from every depth.
                rawResponse: historyResponseAccumulated,
                ...(recursiveResult?.emptyReason ? { emptyReason: recursiveResult.emptyReason } : {}),
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                ...(ranOutOfTokens ? { ranOutOfTokens: true } : {}),
                ...(usedTools ? { usedTools: true } : {}),
                ...(refused || recursiveResult?.refused ? { refused: true } : {}),
            };

        } catch (error) {
            // Abort: the burst-coalescer cancelled this reply on purpose because
            // a new user message arrived in the pre-text phase. Don't show the
            // user a 🐺 error, don't write half-finished assistant content to
            // history — just unwind cleanly. The next coalesced reply (fired by
            // the debounce timer) will see the full updated history.
            // APIUserAbortError extends APIError without setting `this.name`, so
            // `error.name` is just 'Error' — match against the constructor name
            // instead. The /aborted|cancel/i regex catches the SDK's default
            // "Request was aborted." message either way; check both for defence
            // in depth across SDK versions and undici/node native abort errors.
            const aborted = options.signal?.aborted
                || (error instanceof Error && (
                    error.name === 'AbortError'
                    || error.constructor?.name === 'APIUserAbortError'
                    || /aborted|cancel/i.test(error.message)
                ));
            if (aborted) {
                console.log(`🛑 AI reply aborted for ${userId} (burst-coalesce soft cancel)`);
                // Salvage partial token usage: Anthropic's message_start lands
                // before the for-await throws, so usageInputTokens may be set.
                // Record it so internal stats reflect what the provider billed.
                if (usageInputTokens || usageOutputTokens) {
                    recordAITokens(userId, usageInputTokens, usageOutputTokens, options.purpose ?? 'reply', model, usageCacheReadTokens, usageCacheWriteTokens)
                        .catch(err => console.warn('[token-stat] partial recordAITokens (abort) failed:', err instanceof Error ? err.message : err));
                }
                // Marked 'aborted' so the top level treats this silence as
                // deliberate: the coalescer cancelled to let a newer message
                // win, so neither the consent ask nor the never-silent fallback
                // should talk over the reply that replaces this one.
                return { message: '', rawResponse: '', emptyReason: 'aborted' };
            }

            // Classify so the user sees a friendly, in-character line matched to
            // the failure — never the raw error. The full technical detail stays
            // in the server log below; the chat gets one of three vague lines.
            const kind = classifyProviderError(error);
            console.error('❌ Error generating AI response:', {
                userId,
                userMessage: userMessage.substring(0, 50) + '...',
                kind,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            }, error);

            // Silent background runs (collision fixer) get the error RETHROWN:
            // they have no user to show it to, and returning it as a normal
            // result string made failures indistinguishable from success —
            // callers would mark work done (anti-flap) on a 429.
            if (!shouldUpdateTelegram) {
                throw error;
            }

            // Proactive turns (scheduled reminders) fail QUIETLY: firing "связь
            // нестабильна" at a user who didn't ask anything is the same kind of
            // self-inflicted noise as the empty-turn fallback. The task stays
            // pending / needs_replanning and the next tick retries — the user
            // just doesn't get a spurious error out of nowhere.
            if (options.proactive) {
                return { message: '', rawResponse: '' };
            }

            // 'transient' here means the retry loop already exhausted its
            // attempts (or the failure landed after we'd shown text and couldn't
            // retry) — the network/provider stayed unhealthy, which is a
            // legitimate thing to tell the user about. 'credits' names the cause
            // outright; 'auth' is the vaguer key/access case. 'malformed'/
            // 'unknown' are our own bugs: show a neutral line, and the loud log
            // above is what actually gets acted on.
            const userText = kind === 'credits' ? AI_ERROR_CREDITS
                : kind === 'auth' ? AI_ERROR_AUTH
                : kind === 'transient' ? AI_ERROR_TRANSIENT
                : AI_ERROR_INTERNAL;
            await safeSend(bot, userId, userText);
            // Signal confirmed delivery UP the recursion. A tool-first turn
            // whose depth-0 text is empty returns that empty string as its
            // `message`, so without this the top-level never-silent floor would
            // see "nothing delivered" and stack NO_OUTPUT_FALLBACK on top of the
            // friendly line the user just got here. onTextDelivered flips the
            // top-level `delivered` flag (it chains through every recursion
            // level), which is exactly the "user saw text" signal that floor checks.
            try { options.onTextDelivered?.(); } catch { /* listener bug shouldn't matter here */ }

            // message is set (the friendly line the user just saw), so the
            // top-level never-silent fallback correctly treats the turn as
            // "delivered" and doesn't stack a second message on top.
            return {
                message: userText,
                rawResponse: userText,
            };
        }
    }

    /**
     * Recent history plus this turn's message, as sent on every request of a chain.
     *
     * When userMessage is empty (burst-coalesce path: the bursted messages are
     * already in history) the newest row IS the current turn. When addUserToHistory
     * just wrote it, the raw message replaces that row: rendering strips <system>, and
     * bot prompts such as the greeting are nothing but <system>.
     */
    private static async buildBaseMessages(userId: number, userMessage: string, alreadyInHistory: boolean): Promise<ProviderMessage[]> {
        const messages = await this.getRecentMessages(userId, 30);
        if (userMessage) {
            if (alreadyInHistory && messages[messages.length - 1]?.role === 'user') messages.pop();
            messages.push({ role: 'user', content: userMessage });
        }

        // The 4.6+ models reject a conversation that ends with an assistant
        // message ("does not support assistant message prefill"). That can
        // happen on the empty-userMessage burst path: while a slow tool-call
        // turn is still running, a newer user message is recorded, then the
        // slow turn's assistant/tool-summary rows land AFTER it — so history
        // now ends with an assistant row and the burst reply 400s (seen in
        // prod 2026-07-17, request req_011Cd7x4). Those rows go just before the
        // unanswered user messages, so the array ends on the user's last message
        // and the model still sees what ran, instead of repeating a tool.
        const trailing: ProviderMessage[] = [];
        while (messages.length && messages[messages.length - 1].role === 'assistant') {
            trailing.unshift(messages.pop()!);
        }
        let insertAt = messages.length;
        while (insertAt > 1 && messages[insertAt - 1].role === 'user') {
            insertAt--;
        }
        if (insertAt < messages.length) {
            messages.splice(insertAt, 0, ...trailing);
        }
        return messages;
    }

    /**
     * Get recent messages for context
     */
    private static async getRecentMessages(userId: number, limit: number = 30): Promise<ProviderMessage[]> {
        const recentMessages = await getRecentMessageHistory(userId, limit);

        return recentMessages.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: renderHistoryRow(m.role as 'user' | 'assistant', m.content, formatDateHuman(m.timestamp)),
        }));
    }
}
