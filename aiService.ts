import TelegramBot from 'node-telegram-bot-api';
import {addMessageToHistory, getRecentMessageHistory, recordAITokens, bumpStickerUsedCount, getReplyMaxTokens, recordBudgetEscalation} from './userStore';
import {executeTool, getAllToolDefinitions, tools} from './tools';
import {formatDateHuman} from "./dateUtils";
import {safeSend, safeEdit, stripSystemTags, stripInternalMarkers, exceedsTelegramLimit} from './telegramFormat';
import type {AIProvider, ProviderMessage, ToolCallInfo, ToolDefinition, ThinkingBlockData} from './aiProvider';

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
     * Force thinking off for this run. Set by the no-silence retry in
     * streamAIResponse after a turn came back with no text and no tool calls;
     * hands the whole max_tokens allowance to visible text.
     */
    disableThinking?: boolean;
    /**
     * Stream into an existing Telegram message instead of sending a new one.
     * Set by the escalation ladder so a retry EDITS the partial answer in place
     * rather than posting a second message next to it.
     */
    reuseMessageId?: number;
    /**
     * Tells this attempt that the escalation ladder still has headroom and will
     * re-run it at a bigger budget if it truncates — so it must not persist its
     * half-finished text to history. Set by streamAIResponse; false on the final
     * attempt, whose text (truncated or not) is the answer and must be kept.
     */
    willRetryIfTruncated?: boolean;
    appendMessagesAfterUser?: ProviderMessage[];
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
     * Set only when the turn produced nothing the user could see.
     *  - 'aborted'   — burst-coalescer soft-cancel. Intentional; never retried,
     *                  never backfilled (the next coalesced reply answers).
     *  - 'no_output' — the stream ran to completion and yielded no text AND no
     *                  tool calls. Nothing ran, so nothing can be duplicated by
     *                  running it again — that is what makes the retry safe.
     * Absent when the turn produced text or called a tool.
     */
    emptyReason?: 'aborted' | 'no_output';
    /**
     * stop_reason was 'max_tokens': the model hit the ceiling mid-turn. This is
     * literally "failed to answer within the token budget" — it covers both a
     * reply truncated mid-sentence and a turn that spent everything on thinking
     * and said nothing. Drives the escalation ladder in streamAIResponse.
     */
    ranOutOfTokens?: boolean;
    /**
     * The provider call failed and `message` holds the user-facing error text
     * rather than an answer. Lets the ladder tell "this retry blew up" apart
     * from "this retry answered", so it can fall back to the attempt the retry
     * was supposed to replace instead of discarding it.
     */
    errored?: boolean;
    /**
     * Telegram message this turn streamed into, when it sent one. A retry
     * reuses it (`reuseMessageId`) so the fuller answer EDITS the partial one
     * in place instead of posting a second message beside it.
     */
    messageId?: number;
}

/** Recursively strip <system> from all string leaves in a tool-result value.
 * External data (web search snippets, LuxMed doctor/clinic names, geocoded
 * addresses) reaches the next-turn provider message via tool_result content;
 * without this, a `</system>` in any of those fields could escape our
 * <system>At…</system> wrapper in the following turn. */
function deepStripSystemTagsInResult(value: unknown): unknown {
    if (typeof value === 'string') return stripSystemTags(value);
    if (Array.isArray(value)) return value.map(deepStripSystemTagsInResult);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = deepStripSystemTagsInResult(v);
        return out;
    }
    return value;
}

/**
 * Starting output allowance when the user has no raised budget of their own.
 * max_tokens covers thinking AND visible text together, so at the old 1500 a
 * high-effort thinking pass could consume the whole allowance and leave nothing
 * to say. This is a starting point, not a guess at "enough" — when a task needs
 * more, the escalation ladder in streamAIResponse takes it up.
 */
const DEFAULT_MAX_TOKENS = 8000;

/**
 * Ceiling for escalation. The model's own output cap is 128k; this sits well
 * inside it and far above any reply this bot needs, existing only so a
 * pathological turn cannot spend without bound.
 */
const MAX_ESCALATED_TOKENS = 64000;

/** Each escalation step multiplies the budget. Steps from 8k: 32k → 64k. */
const ESCALATION_FACTOR = 4;

/** Last-resort words when a turn produced nothing at all, so the user is never
 * left staring at silence wondering whether the bot is alive. */
const NO_OUTPUT_FALLBACK = 'Задумался и потерял мысль 🐺 Повтори, пожалуйста?';

export class AIService {
    /**
     * Unified function to handle AI streaming responses with tool calling support.
     *
     * Also guarantees the turn FINISHES, however complex the task, and never
     * ends in silence.
     *
     * The failure this defends against: max_tokens caps thinking and visible
     * text *together*, and adaptive thinking expands to fill whatever it is
     * given — so a turn can spend its whole allowance thinking and return no
     * text and no tool calls (production incident 2026-07-17, max_tokens=1500).
     * No budget rules that out, so picking a bigger number is not a fix. The
     * ladder instead reacts to what the model reports:
     *
     *   1. ESCALATE while the model says it ran out of room (stop_reason
     *      'max_tokens' — covers both a truncated reply and a thinking-only
     *      turn). Each step multiplies the budget up to MAX_ESCALATED_TOKENS,
     *      so complexity is met with room rather than an apology. Only ever
     *      re-runs when NO tool executed, so there are no side effects to
     *      duplicate; a retry reuses the same Telegram message, so the fuller
     *      answer replaces the partial one instead of posting beside it.
     *   2. THINKING OFF, if the ceiling is reached and there is still nothing.
     *      The whole allowance then goes to visible text, so this cannot come
     *      back thinking-only at any budget.
     *   3. SPEAK ANYWAY, if the user still received nothing. Keyed off delivery
     *      rather than any specific failure mode, so it also covers refusals and
     *      empty replies we haven't seen yet.
     *
     * A turn that had to escalate is recorded (recordBudgetEscalation) so the
     * next turn asks the user whether to keep the higher budget — see
     * getCurrentInfo in index.ts and the SetReplyTokenBudget tool.
     */
    static async streamAIResponse(options: AIStreamOptions): Promise<AIStreamResult> {
        const withDefaults = (opts: AIStreamOptions): AIStreamOptions => ({
            ...opts,
            // Tools are always enabled by default (unless recursion limit reached)
            enableToolCalls: (opts.currentRecursionDepth ?? 0) >= 5 ? false : (opts.enableToolCalls ?? true),
        });

        // Track confirmed delivery across the whole turn, including the tool-call
        // recursion — onTextDelivered fires per level, and a tool-first reply's
        // only visible text may come from depth 1+.
        let delivered = false;
        const observed = withDefaults({
            ...options,
            onTextDelivered: () => {
                delivered = true;
                options.onTextDelivered?.();
            },
        });

        const isTopLevel = (options.currentRecursionDepth ?? 0) === 0;
        // An explicit maxTokens from a caller (collision fixer, style scan) is a
        // deliberate cap, but it is a starting point like any other — the ladder
        // may still raise it rather than let that caller's task go unfinished.
        const startBudget = options.maxTokens
            ?? (isTopLevel ? await getReplyMaxTokens(options.userId) : undefined)
            ?? DEFAULT_MAX_TOKENS;

        let budget = startBudget;
        // While headroom remains, a truncated attempt is provisional — tell it
        // not to persist text the next attempt will replace.
        let result = await this.streamAIResponseInternal({
            ...observed,
            maxTokens: budget,
            willRetryIfTruncated: budget < MAX_ESCALATED_TOKENS,
        });

        /** Options shared by every attempt AFTER the first. The user row is
         * already written by attempt 1 and re-writing it would duplicate the
         * prompt in history (the /goal and greeting paths pass
         * addUserToHistory: true) — the tool-call recursion guards the same way. */
        const retryBase = { ...observed, addUserToHistory: false };

        // Escalate while the model reports it ran out of room. Gated on no tool
        // having run: that is what makes re-running free of duplicate side
        // effects (addUserTask has no dedup). When a tool DID run, the tool-call
        // recursion continues the work and each level gets its own fresh budget.
        while (result.ranOutOfTokens && !result.toolCalls?.length && budget < MAX_ESCALATED_TOKENS) {
            const raised = Math.min(budget * ESCALATION_FACTOR, MAX_ESCALATED_TOKENS);
            console.warn(`📈 ${options.userId}: ${budget} tokens was not enough — escalating to ${raised}`);
            budget = raised;
            const superseded = result;
            result = await this.streamAIResponseInternal({
                ...retryBase,
                maxTokens: budget,
                reuseMessageId: result.messageId,
                willRetryIfTruncated: budget < MAX_ESCALATED_TOKENS,
            });
            // The retry errored out, so the attempt it was meant to replace is
            // the best answer we have — but it deliberately skipped its own
            // history write on the promise of being replaced. Commit it now, or
            // the turn leaves no assistant row at all and the next turn's
            // context sees a user message that was never answered.
            if (result.errored && superseded.message) {
                result = await this.commitSupersededAttempt(options, superseded, result);
                break;
            }
        }

        // Ceiling reached and still nothing to show: hand the entire allowance
        // to visible text. This is by definition the final attempt, so it must
        // NOT inherit a stale willRetryIfTruncated (in recursion it would
        // otherwise arrive as true and make this attempt discard its own text).
        const budgetFixedIt = budget > startBudget && !result.emptyReason;
        if (result.emptyReason === 'no_output') {
            console.warn(`🔁 ${options.userId}: still no output at ${budget} — retrying with thinking off`);
            result = await this.streamAIResponseInternal({
                ...retryBase,
                maxTokens: budget,
                disableThinking: true,
                reuseMessageId: result.messageId,
                willRetryIfTruncated: false,
            });
        }

        // Ask about the higher budget only when the higher budget is what
        // actually finished the turn. If the thinking-off retry is what produced
        // the answer, more tokens would NOT have helped, and asking the user to
        // adopt this budget for every future reply would be wrong advice.
        // Silent runs are excluded: nobody saw "your previous answer".
        if (isTopLevel && budgetFixedIt && !result.emptyReason
            && (options.shouldUpdateTelegram ?? true)) {
            await recordBudgetEscalation(options.userId, budget)
                .catch(err => console.warn('[budget] recordBudgetEscalation failed:', err instanceof Error ? err.message : err));
        }

        // Backstop. Keyed on "the user received nothing", NOT on any particular
        // failure mode — that is what makes it total. It therefore also covers
        // the case the emptyReason checks miss: the model calls a tool with no
        // preamble and the recursive turn then yields no text, so tools ran (no
        // 'no_output' anywhere) yet nothing ever reached the user.
        //
        // Excluded: aborts (deliberate silence — the next coalesced reply
        // answers), silent background runs (no user to speak to), and any turn
        // that already has a message to show — notably the error path, which
        // sent its own 🐺 text and would otherwise get a second message.
        // Only the top level may speak for the turn.
        if (isTopLevel && !delivered && !result.message
            && result.emptyReason !== 'aborted'
            && (options.shouldUpdateTelegram ?? true)) {
            console.error(`🚨 ${options.userId}: turn delivered nothing to the user — sending fallback`);
            await safeSend(options.bot, options.userId, NO_OUTPUT_FALLBACK);
            return { ...result, message: NO_OUTPUT_FALLBACK, rawResponse: NO_OUTPUT_FALLBACK };
        }

        return result;
    }

    /**
     * Rescue an attempt whose replacement errored out.
     *
     * A superseded attempt skips its own history write because a retry was
     * expected to replace it. When that retry instead fails, this persists the
     * superseded text so the turn still leaves an assistant row, and returns it
     * as the turn's answer — the user has already seen it streamed, and it beats
     * showing only an error with no record of the reply.
     */
    private static async commitSupersededAttempt(
        options: AIStreamOptions,
        superseded: AIStreamResult,
        errorResult: AIStreamResult,
    ): Promise<AIStreamResult> {
        console.warn(`↩️ ${options.userId}: escalated retry failed — keeping the partial answer from the previous attempt`);
        if (options.addAssistantToHistory ?? true) {
            const safeContent = stripSystemTags(superseded.message);
            if (safeContent) {
                await addMessageToHistory(options.userId, 'assistant', safeContent)
                    .catch(err => console.warn('[budget] committing superseded attempt failed:', err instanceof Error ? err.message : err));
            }
        }
        // Keep errored so callers still know the turn degraded, but carry the
        // real text: the backstop must not treat this as "nothing delivered".
        return { ...superseded, errored: errorResult.errored };
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
            maxTokens = DEFAULT_MAX_TOKENS,
            shouldUpdateTelegram = true,
            addUserToHistory = true,
            addAssistantToHistory = true,
            enableToolCalls = false,
            currentRecursionDepth = 0,
            appendMessagesAfterUser,
        } = options;

        // Hoisted to function scope so the abort catch can salvage partial
        // billing data. Anthropic emits `message_start` with input_tokens
        // (and cache info) very early in the stream — well before the for-
        // await throws on AbortError. Recording those after abort keeps
        // internal token accounting honest about what we actually paid for.
        let usageInputTokens = 0;
        let usageOutputTokens = 0;

        try {
            // Seeded on a ladder retry so the fuller answer edits the partial
            // one in place — from the user's side it just looks like streaming.
            let messageId: number | undefined = options.reuseMessageId;
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

            // Get recent message history for context
            const recentMessages = await this.getRecentMessages(userId, 30);

            // Build messages for provider. When userMessage is empty (burst-
            // coalesce path: the bursted messages are already in history and
            // we don't have a single fresh "current" turn to wrap), skip the
            // synthetic stub — otherwise the model sees N user msgs followed
            // by an empty-bodied wrapper and can get confused about what to
            // answer. The most-recent history row IS the "current" turn.
            const messages: ProviderMessage[] = [
                ...recentMessages,
                ...(userMessage
                    ? [{ role: 'user' as const, content: `<system>At ${new Date().toISOString()}</system>\n${userMessage}` }]
                    : []),
                ...(appendMessagesAfterUser || []),
            ];

            // Get tool definitions if enabled. allowedTools narrows the offer —
            // background runs (collision fixer) get only schedule tools so the
            // model can't reach user-facing or unrelated tools at all.
            const toolDefs: ToolDefinition[] | undefined = enableToolCalls
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
                ...(options.disableThinking ? { thinking: 'off (no-silence retry)' } : {}),
            });

            // Stream from provider. options.signal is forwarded so the burst-
            // coalescer can abort an in-flight reply that hasn't yet shown
            // visible text.
            const stream = provider.streamChat({
                systemPrompt,
                systemPromptCachePrefix,
                messages,
                tools: toolDefs,
                maxTokens,
                model,
                signal: options.signal,
                disableThinking: options.disableThinking,
            });

            let aiResponseAccumulated = '';
            let historyResponseAccumulated = '';
            const toolCalls: ToolCallInfo[] = [];
            let thinkingBlocks: ThinkingBlockData[] | undefined;
            let stopReason: string | undefined;
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

            // try/finally guarantees clearInterval on stream throw — without it
            // a mid-stream provider error (429, reset) leaks the 500ms timer for
            // the life of the process, each tick firing another safeEdit call.
            try {
                for await (const chunk of stream) {
                    switch (chunk.type) {
                        case 'text':
                            aiResponseAccumulated += chunk.content;
                            break;

                        case 'stop_reason':
                            stopReason = chunk.reason;
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

                        case 'thinking_blocks':
                            // Captured thinking blocks (with signatures) for multi-turn continuity
                            thinkingBlocks = chunk.blocks;
                            break;

                        case 'usage':
                            usageInputTokens = chunk.input_tokens;
                            usageOutputTokens = chunk.output_tokens;
                            break;

                        case 'done':
                            break;
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
                    recordAITokens(userId, usageInputTokens, usageOutputTokens, options.purpose ?? 'reply', model)
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
            recordAITokens(userId, usageInputTokens, usageOutputTokens, purpose, model)
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

            // This attempt ran out of room and the ladder still has headroom, so
            // it is about to be re-run at a bigger budget and everything below
            // is provisional. Skip the final tick: it is the only place that
            // splits an over-long reply into EXTRA messages, and those extras
            // cannot be taken back — a retry only edits the first message, so
            // the overflow from a superseded attempt would linger under the real
            // answer as stale, half-finished text. Mid-stream edits already put
            // the partial in the first message; the retry overwrites it there.
            const willBeSuperseded = options.willRetryIfTruncated === true
                && stopReason === 'max_tokens'
                && toolCalls.length === 0;

            // Final display tick: mdToTelegramHtml via safeEdit strips <system>/<thinking>/legacy
            // tags through sanitize-html's nonTextTags. No separate cleanup needed.
            if (!willBeSuperseded) {
                await updateTelegramMessage(true);
            }

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
                    thinkingBlocks,
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
                        const resultStr = JSON.stringify(result);
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
                            content: JSON.stringify(deepStripSystemTagsInResult(result)),
                        });

                        historyResponseAccumulated = `${historyResponseAccumulated}\n\n[Tool: ${toolName}]\nInput: ${JSON.stringify(parsedArgs)}\nOutput: ${stripSystemTags(historySummary)}\n`;
                    } catch (error) {
                        const errorMsg = error instanceof Error ? error.message : String(error);
                        console.log(`   ❌ Error: ${errorMsg}\n`);

                        newAppendedMessages.push({
                            role: 'tool_result',
                            toolCallId: toolCall.id,
                            content: JSON.stringify({error: errorMsg}),
                        });

                        historyResponseAccumulated = `${historyResponseAccumulated}\n\n[Tool: ${toolName}]\nInput: ${JSON.stringify(parsedArgs)}\nError: ${stripSystemTags(errorMsg)}\n`;
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
                    // never be re-run (addUserTask has no dedup).
                    return { message: '', rawResponse: '', emptyReason: 'aborted' };
                }

                console.log(`🔄 Continuing with ${newAppendedMessages.length} tool result(s), depth: ${currentRecursionDepth + 1}`);

                const recursiveResult = await this.streamAIResponse({
                    ...options,
                    currentRecursionDepth: currentRecursionDepth + 1,
                    appendMessagesAfterUser: newAppendedMessages,
                    addUserToHistory: false, // Don't add recursive calls to history
                    // Per-attempt flags belong to THIS level only and must not
                    // leak downward: reuseMessageId would make the child edit
                    // our message instead of sending its own, disableThinking
                    // would silently disable thinking for the rest of the chain,
                    // and a stale willRetryIfTruncated would make the child
                    // discard text nobody is going to replace.
                    reuseMessageId: undefined,
                    disableThinking: undefined,
                    willRetryIfTruncated: undefined,
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
            // blocks then silently completes (no text, no tools, no recursion).
            // Same reason the final display tick was skipped above: this
            // attempt is about to be replaced, so persisting its half-finished
            // text would leave a stale row next to the complete answer — and
            // feed the truncated version back as context on later turns. (The
            // thinking-only case needs no guard: empty content is never
            // written.)
            if (addAssistantToHistory && !willBeSuperseded) {
                const safeAssistantContent = stripSystemTags(historyResponseAccumulated);
                if (safeAssistantContent) {
                    await addMessageToHistory(userId, 'assistant', safeAssistantContent);
                    const preview = safeAssistantContent.length > 100
                        ? safeAssistantContent.substring(0, 100) + '...'
                        : safeAssistantContent;
                    console.log(`📝 Added assistant message to history: "${preview.replace(/\n/g, ' ')}"`);
                } else {
                    // Thinking-only completion — model emitted thinking blocks
                    // but no text, no tool calls, no recursion. Nothing to
                    // persist; streamAIResponse retries this with thinking off.
                    console.warn(`⚠️ AI emitted thinking-only response for ${userId} — no visible output, no history row written`, { stopReason });
                }
            }

            // No text and no tool calls means the turn accomplished nothing —
            // and, because no tool ran, that it can be re-run with no risk of
            // duplicating side effects. streamAIResponse keys its retry off this.
            const producedNothing = !aiResponseAccumulated.length && toolCalls.length === 0;

            return {
                message: aiResponseAccumulated,
                rawResponse: aiResponseAccumulated,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                ...(producedNothing ? { emptyReason: 'no_output' as const } : {}),
                ...(stopReason === 'max_tokens' ? { ranOutOfTokens: true } : {}),
                ...(messageId !== undefined ? { messageId } : {}),
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
                    recordAITokens(userId, usageInputTokens, usageOutputTokens, options.purpose ?? 'reply', model)
                        .catch(err => console.warn('[token-stat] partial recordAITokens (abort) failed:', err instanceof Error ? err.message : err));
                }
                // 'aborted', NOT 'no_output': this silence is deliberate. The
                // coalescer cancelled to let a newer message win, and the retry
                // would fight it (and the fallback would talk over the reply
                // that replaces this one).
                return { message: '', rawResponse: '', emptyReason: 'aborted' };
            }

            console.error('❌ Error generating AI response:', {
                userId,
                userMessage: userMessage.substring(0, 50) + '...',
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

            const errorMessage = `
Ой 🐺
\`\`\`
${error instanceof Error ? error.message : String(error)}
\`\`\`
            `;
            await safeSend(bot, userId, errorMessage);

            return {
                message: errorMessage,
                rawResponse: errorMessage,
                errored: true,
            };
        }
    }

    /**
     * Get recent messages for context
     */
    private static async getRecentMessages(userId: number, limit: number = 30): Promise<ProviderMessage[]> {
        const recentMessages = await getRecentMessageHistory(userId, limit);

        return recentMessages.map(m => ({
            role: m.role as 'user' | 'assistant',
            // Defense-in-depth: legacy rows predating the write-time strip may still carry
            // stray <system> chars from past user inputs. Strip on read too.
            content: `<system>At ${formatDateHuman(m.timestamp)}</system>\n${stripSystemTags(m.content)}`
        }));
    }
}
