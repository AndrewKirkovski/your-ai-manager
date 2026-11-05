/**
 * Abstract AI provider interface.
 * Allows switching between OpenAI SDK and native Anthropic SDK.
 */

// --- Normalized message types (provider-agnostic) ---

export interface ToolCallInfo {
    id: string;
    name: string;
    arguments: string; // JSON string
}

export type ThinkingBlockData =
    | { type: 'thinking'; thinking: string; signature: string }
    | { type: 'redacted_thinking'; data: string };

/** One block of an assistant turn, in the order the model produced it. */
export type AssistantBlock =
    | ThinkingBlockData
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown };

export type ProviderMessage =
    | { role: 'user'; content: string }
    /** `blocks` is the turn exactly as streamed, for providers that must replay it unchanged. */
    | { role: 'assistant'; content: string; toolCalls?: ToolCallInfo[]; blocks?: AssistantBlock[] }
    | { role: 'tool_result'; toolCallId: string; content: string };

// --- Stream chunk types ---

export type StreamChunk =
    | { type: 'text'; content: string }
    | { type: 'tool_call_start'; index: number; id: string; name: string }
    | { type: 'tool_call_args'; index: number; args: string }
    | { type: 'thinking'; content: string }
    | { type: 'assistant_blocks'; blocks: AssistantBlock[] }
    | { type: 'usage'; input_tokens: number; output_tokens: number; cache_creation_tokens?: number; cache_read_tokens?: number }
    /** Why the model stopped. 'max_tokens' on a turn with no text is the
     * signature of thinking having consumed the whole allowance. The no-silence
     * recovery keys off "no output", not off a reason, so an unreported or
     * unexpected stop reason can't defeat it. 'refusal' carries a category
     * when the API gives one. */
    | { type: 'stop_reason'; reason: string; category?: string | null }
    /** The request moved to a fallback model mid-stream. Tool calls from before
     * this point were never run and must not be. */
    | { type: 'fallback' }
    | { type: 'done' };

// --- Request types ---

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
}

// --- Thinking configuration (shared by both providers) ---

export type ThinkingConfig =
    | { type: 'adaptive' }
    | { type: 'enabled'; budget_tokens: number }
    | { type: 'disabled' };

export type Effort = 'low' | 'medium' | 'high';

/** Thinking depth per route, keyed on `purpose`. Set explicitly rather than
 * inheriting the API default, which differs between models. Thinking stays on at
 * every level; a lower level only keeps it shorter. */
export const ROUTE_EFFORT: Record<string, Effort> = {
    reply: 'high',
    'task-reminder': 'medium',
    'collision-fix': 'medium',
    'style-scan': 'medium',
    compaction: 'low',
};
export const DEFAULT_EFFORT: Effort = 'high';

/** The last-resort retry keeps the same budget and thinks less, so more of the
 * allowance can reach visible text. */
export const FORCED_ANSWER_EFFORT: Effort = 'low';

/** Pre-4.6 models have no `adaptive` mode, only a fixed token budget. */
const LEGACY_THINKING_BUDGET = 2000;

/** Model families that can think at all. Anything else takes no thinking param. */
const THINKING_MODELS = /opus|sonnet|fable|mythos|claude-3[.-]7/i;

/**
 * Models that take `thinking: {type:'enabled', budget_tokens}` — the pre-4.6
 * generation. Everything else that thinks uses `adaptive`.
 *
 * Deliberately an allowlist of OLD models rather than a regex for new ones:
 * `budget_tokens` is REJECTED WITH A 400 on Opus 4.7/4.8, Sonnet 5 and Fable 5,
 * so a rule that fails open to it would take the bot down the moment
 * OPENAI_MODEL is bumped — the same shape of silent config failure as the
 * incident this file exists to fix. Failing open to `adaptive` is safe: it is
 * the mode every current model wants.
 */
const LEGACY_BUDGET_MODELS = /claude-3[.-]7|sonnet-4-5|sonnet-4-0|sonnet-4-2|opus-4-5|opus-4-1|opus-4-0|opus-4-2/i;

/** Thinking is always on here and cannot be turned off; an explicit
 * `{type:'disabled'}` is a 400, so the config must simply be omitted. */
const ALWAYS_THINKING_MODELS = /fable|mythos|opus-5-5/i;

/**
 * Resolve a model's thinking config, or null when the model can't think or the
 * config must be omitted.
 *
 * `disableThinking` is the escape hatch behind the no-silence floor. `max_tokens`
 * caps thinking AND visible text *together*, and adaptive thinking expands to fill
 * whatever it is given — so a model can spend the entire budget thinking and return
 * zero text and zero tool calls. That is not a budget too small to fix by raising
 * it; no value rules it out. On a model that can turn thinking off, re-running that
 * way gives the whole budget to visible text. An always-thinking model can't, so its
 * retry runs at FORCED_ANSWER_EFFORT, which leaves more room for text but guarantees
 * none. See AIService.streamAIResponse.
 */
export function resolveThinkingConfig(model: string, disableThinking = false): ThinkingConfig | null {
    if (!THINKING_MODELS.test(model)) return null; // never thinks; send no thinking param
    if (disableThinking) {
        // Omitting beats an explicit disable on always-thinking models, which
        // reject it. Their thinking can't be switched off, so the no-silence
        // retry leans on the escalation ladder and the fallback there instead.
        return ALWAYS_THINKING_MODELS.test(model) ? null : { type: 'disabled' };
    }
    return LEGACY_BUDGET_MODELS.test(model)
        ? { type: 'enabled', budget_tokens: LEGACY_THINKING_BUDGET }
        : { type: 'adaptive' };
}

/** `output_config` for a request, or null when it takes none. Adaptive models take
 * effort, and so does an always-thinking model run with `thinking` omitted. */
export function resolveOutputConfig(model: string, thinking: ThinkingConfig | null, effort: Effort): { effort: Effort } | null {
    const takesEffort = thinking?.type === 'adaptive' || (thinking === null && ALWAYS_THINKING_MODELS.test(model));
    return takesEffort ? { effort } : null;
}

/**
 * A declared thinking budget must be strictly below max_tokens or the API
 * rejects the request outright. Only `enabled` declares one — `adaptive` has no
 * budget field to compare against, which is exactly why the old
 * `if (budget && …)` guard silently skipped every 4.6 request and let thinking
 * consume the whole allowance.
 */
export function floorMaxTokensForThinking(maxTokens: number, thinking: ThinkingConfig | null): number {
    if (thinking?.type !== 'enabled') return maxTokens;
    return maxTokens <= thinking.budget_tokens ? thinking.budget_tokens + 4000 : maxTokens;
}

export interface StreamRequest {
    systemPrompt: string;
    /**
     * Optional static prefix for the system prompt. When set, providers that
     * support caching (Anthropic native) place this BEFORE `systemPrompt` and
     * mark it as a cache breakpoint. Use it for the long, never-changing system
     * scaffolding (CHARACTER + RULES + sticker catalog), and put per-turn
     * dynamic content (memory dump, current tasks) into `systemPrompt`.
     * Providers without caching (OpenAI compat) just concatenate the two.
     */
    systemPromptCachePrefix?: string;
    messages: ProviderMessage[];
    tools?: ToolDefinition[];
    maxTokens: number;
    model: string;
    /**
     * Optional AbortSignal — when fired, the provider's underlying SDK aborts
     * the in-flight stream and the for-await loop in the consumer throws an
     * AbortError. Used by the burst-coalescing layer to soft-cancel a reply
     * that hasn't yet streamed visible text.
     */
    signal?: AbortSignal;
    /**
     * Re-run with thinking off, handing the entire max_tokens allowance to
     * visible text. Set by the no-silence retry after a turn came back with no
     * text and no tool calls. See resolveThinkingConfig.
     */
    disableThinking?: boolean;
    effort?: Effort;
}

export interface CompletionRequest {
    systemPrompt?: string;
    messages: ProviderMessage[];
    maxTokens: number;
    model: string;
    effort?: Effort;
}

// --- Provider interface ---

export interface AIProvider {
    readonly name: string;
    streamChat(request: StreamRequest): AsyncIterable<StreamChunk>;
    /** Throws rather than return empty or cut-off text: callers replace stored rows
     * with the result, so a bad completion must not reach them. */
    completeChat(request: CompletionRequest): Promise<string>;
}

// --- Factory ---

export interface ProviderConfig {
    apiKey: string;
    baseURL?: string;
    provider: 'openai' | 'anthropic';
}

export async function createProvider(config: ProviderConfig): Promise<AIProvider> {
    if (config.provider === 'anthropic') {
        const { AnthropicProvider } = await import('./aiProvider.anthropic');
        return new AnthropicProvider(config.apiKey);
    } else {
        const { OpenAIProvider } = await import('./aiProvider.openai');
        return new OpenAIProvider(config.apiKey, config.baseURL);
    }
}
