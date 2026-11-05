import Anthropic from '@anthropic-ai/sdk';
import type {
    AIProvider,
    AssistantBlock,
    StreamRequest,
    CompletionRequest,
    StreamChunk,
    ProviderMessage,
    ToolDefinition,
} from './aiProvider';
import { resolveThinkingConfig, resolveOutputConfig, floorMaxTokensForThinking, DEFAULT_EFFORT } from './aiProvider';

/** Models that opt in to the server retrying a declined request on another model.
 * Without this a request on these models simply stops on a refusal. */
const SERVER_FALLBACK_MODELS = /opus-5-5/i;
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function parseToolInput(json: string): unknown {
    try {
        return JSON.parse(json || '{}');
    } catch {
        return {};
    }
}

export class AnthropicProvider implements AIProvider {
    readonly name = 'anthropic';
    private client: Anthropic;

    constructor(apiKey: string) {
        this.client = new Anthropic({ apiKey });
    }

    async *streamChat(request: StreamRequest): AsyncIterable<StreamChunk> {
        const messages = this.convertMessages(request.messages);
        const tools = request.tools?.map(t => this.convertTool(t));

        const thinkingConfig = resolveThinkingConfig(request.model, request.disableThinking);
        const maxTokens = floorMaxTokensForThinking(request.maxTokens, thinkingConfig);
        const outputConfig = resolveOutputConfig(request.model, thinkingConfig, request.effort ?? DEFAULT_EFFORT);
        // Build the system param. When `systemPromptCachePrefix` is provided we
        // emit it as a separate text block with cache_control={type:'ephemeral'}
        // so Anthropic prompt-caching applies to the static scaffolding. The
        // dynamic suffix (per-turn memory dump etc.) follows in a second block
        // without cache_control. When no prefix is set, fall back to the legacy
        // single-string form so older callers keep working.
        const systemParam: Anthropic.MessageCreateParams['system'] = request.systemPromptCachePrefix
            ? [
                { type: 'text', text: request.systemPromptCachePrefix, cache_control: { type: 'ephemeral' } },
                ...(request.systemPrompt ? [{ type: 'text' as const, text: request.systemPrompt }] : []),
            ]
            : request.systemPrompt;

        const params: Anthropic.MessageCreateParams = {
            model: request.model,
            max_tokens: maxTokens,
            system: systemParam,
            messages,
            ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
            // Effort drives thinking depth. API defaults differ between models,
            // so say it explicitly and keep the depth visible at the call site.
            ...(outputConfig ? { output_config: outputConfig } : {}),
            stream: true as const,
        };

        if (tools?.length) {
            params.tools = tools;
            params.tool_choice = { type: 'auto' };
        }

        // Forward the AbortSignal from the burst-coalescing layer down to the
        // SDK's underlying fetch. When the signal aborts, the for-await loop
        // below throws AbortError; the try/finally still runs and closes the
        // socket. Anthropic SDK reads `signal` from the second arg's options.
        const requestOptions = request.signal ? { signal: request.signal } : undefined;
        const stream = SERVER_FALLBACK_MODELS.test(request.model)
            ? await this.client.beta.messages.create(
                { ...params, betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' } as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming,
                requestOptions,
            )
            : await this.client.messages.create(params, requestOptions);

        // Track tool call indices — Anthropic uses content_block index, we map to sequential tool index
        let toolIndex = -1;

        // The turn in stream order. Thinking can sit between text and tool blocks,
        // and it must be replayed exactly where it came, with its signature.
        const blocks: AssistantBlock[] = [];
        let currentThinking: { thinking: string; signature: string } | null = null;
        let currentText: string | null = null;
        let currentTool: { id: string; name: string; json: string } | null = null;
        // Anthropic emits prompt-side input_tokens in message_start, output_tokens in message_delta usage.
        let inputTokens = 0;
        let cacheCreationTokens = 0;
        let cacheReadTokens = 0;

        // try/finally so when the consumer (aiService) breaks the for-await early — via
        // throw, return, or generator.throw — we abort the underlying HTTP socket
        // instead of letting the SDK keep it open until the server hangs up.
        try {
        for await (const event of stream as unknown as AsyncIterable<Anthropic.MessageStreamEvent>) {
            switch (event.type) {
                case 'content_block_start': {
                    const block = event.content_block;
                    if (block.type === 'tool_use') {
                        toolIndex++;
                        currentTool = { id: block.id, name: block.name, json: '' };
                        yield {
                            type: 'tool_call_start',
                            index: toolIndex,
                            id: block.id,
                            name: block.name,
                        };
                    } else if (block.type === 'text') {
                        currentText = '';
                    } else if (block.type === 'thinking') {
                        currentThinking = { thinking: '', signature: '' };
                    } else if (block.type === 'redacted_thinking') {
                        blocks.push({ type: 'redacted_thinking', data: (block as { data: string }).data });
                    } else if ((block as { type: string }).type === 'fallback') {
                        // Only text carries over to the fallback model. Thinking and
                        // tool blocks before this point must not be echoed back.
                        const text = blocks.filter(b => b.type === 'text');
                        blocks.length = 0;
                        blocks.push(...text);
                        toolIndex = -1;
                        yield { type: 'fallback' };
                    }
                    break;
                }

                case 'content_block_delta': {
                    const delta = event.delta;
                    if (delta.type === 'text_delta') {
                        if (currentText !== null) {
                            currentText += delta.text;
                        }
                        yield { type: 'text', content: delta.text };
                    } else if (delta.type === 'thinking_delta') {
                        if (currentThinking) {
                            currentThinking.thinking += delta.thinking;
                        }
                        yield { type: 'thinking', content: delta.thinking };
                    } else if (delta.type === 'signature_delta') {
                        if (currentThinking) {
                            currentThinking.signature += delta.signature;
                        }
                    } else if (delta.type === 'input_json_delta') {
                        if (currentTool) {
                            currentTool.json += delta.partial_json;
                        }
                        yield {
                            type: 'tool_call_args',
                            index: toolIndex,
                            args: delta.partial_json,
                        };
                    }
                    break;
                }

                case 'content_block_stop': {
                    if (currentThinking) {
                        blocks.push({
                            type: 'thinking',
                            thinking: currentThinking.thinking,
                            signature: currentThinking.signature,
                        });
                        currentThinking = null;
                    } else if (currentTool) {
                        blocks.push({
                            type: 'tool_use',
                            id: currentTool.id,
                            name: currentTool.name,
                            input: parseToolInput(currentTool.json),
                        });
                        currentTool = null;
                    } else if (currentText !== null) {
                        if (currentText) blocks.push({ type: 'text', text: currentText });
                        currentText = null;
                    }
                    break;
                }

                case 'message_start': {
                    const u = (event as Anthropic.MessageStartEvent).message?.usage;
                    if (u) {
                        inputTokens = u.input_tokens ?? 0;
                        cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
                        cacheReadTokens = u.cache_read_input_tokens ?? 0;
                        // Emit a partial usage chunk early so the consumer can record
                        // input-side billing even if the stream is cut short (burst-
                        // coalesce abort). output_tokens is set to 0 here; message_delta
                        // emits a corrected total at end-of-stream when not aborted.
                        yield {
                            type: 'usage',
                            input_tokens: inputTokens,
                            output_tokens: 0,
                            cache_creation_tokens: cacheCreationTokens || undefined,
                            cache_read_tokens: cacheReadTokens || undefined,
                        };
                    }
                    break;
                }

                case 'message_delta': {
                    // Emit the whole turn before done (needed for recursive tool calls)
                    if (blocks.length > 0) {
                        yield { type: 'assistant_blocks', blocks };
                    }
                    const delta = (event as Anthropic.MessageDeltaEvent).delta as { stop_reason?: string | null; stop_details?: { category?: string | null } | null };
                    if (delta?.stop_reason) {
                        yield { type: 'stop_reason', reason: delta.stop_reason, category: delta.stop_details?.category };
                    }
                    // Emit usage with the final output_token count from message_delta
                    const u = (event as Anthropic.MessageDeltaEvent).usage;
                    if (u) {
                        yield {
                            type: 'usage',
                            input_tokens: inputTokens,
                            output_tokens: u.output_tokens ?? 0,
                            cache_creation_tokens: cacheCreationTokens || undefined,
                            cache_read_tokens: cacheReadTokens || undefined,
                        };
                    }
                    yield { type: 'done' };
                    break;
                }

                // message_stop — no action needed
            }
        }
        } finally {
            // Anthropic's Stream exposes `controller` (AbortController). Aborting on
            // exit closes the socket. Safe to call after a clean finish — the SDK
            // ignores aborts on already-completed streams.
            const abort = (stream as { controller?: AbortController }).controller;
            try { abort?.abort(); } catch { /* ignore */ }
        }
    }

    async completeChat(request: CompletionRequest): Promise<string> {
        const messages = this.convertMessages(request.messages);
        const thinking = resolveThinkingConfig(request.model);
        const outputConfig = resolveOutputConfig(request.model, thinking, request.effort ?? DEFAULT_EFFORT);

        const response = await this.client.messages.create({
            model: request.model,
            max_tokens: floorMaxTokensForThinking(request.maxTokens, thinking),
            ...(request.systemPrompt && { system: request.systemPrompt }),
            ...(thinking ? { thinking } : {}),
            ...(outputConfig ? { output_config: outputConfig } : {}),
            messages,
        });

        // Extract text from content blocks
        const textBlocks = response.content.filter(
            (b): b is Anthropic.TextBlock => b.type === 'text'
        );
        const text = textBlocks.map(b => b.text).join('');
        if (!text.trim() || response.stop_reason === 'max_tokens' || response.stop_reason === 'refusal') {
            throw new Error(`Completion unusable: stop_reason=${response.stop_reason}`);
        }
        return text;
    }

    private convertMessages(messages: ProviderMessage[]): Anthropic.MessageParam[] {
        const result: Anthropic.MessageParam[] = [];

        for (const msg of messages) {
            if (msg.role === 'user') {
                result.push({ role: 'user', content: msg.content });
            } else if (msg.role === 'assistant') {
                if (msg.blocks?.length) {
                    result.push({ role: 'assistant', content: msg.blocks as Anthropic.ContentBlockParam[] });
                    continue;
                }

                const contentBlocks: Anthropic.ContentBlockParam[] = [];

                // Add text if present
                if (msg.content) {
                    contentBlocks.push({ type: 'text', text: msg.content });
                }

                // Convert tool calls to tool_use content blocks
                if (msg.toolCalls?.length) {
                    for (const tc of msg.toolCalls) {
                        contentBlocks.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.name,
                            input: parseToolInput(tc.arguments) as Record<string, unknown>,
                        });
                    }
                }

                result.push({ role: 'assistant', content: contentBlocks });
            } else if (msg.role === 'tool_result') {
                // Anthropic: tool results go as user messages with tool_result blocks
                // Check if last message is already a user message with tool_result blocks — merge
                const last = result[result.length - 1];
                const toolResultBlock: Anthropic.ToolResultBlockParam = {
                    type: 'tool_result',
                    tool_use_id: msg.toolCallId,
                    content: msg.content,
                };

                if (last && last.role === 'user' && Array.isArray(last.content)) {
                    // Merge into existing user message
                    (last.content as Anthropic.ToolResultBlockParam[]).push(toolResultBlock);
                } else {
                    result.push({
                        role: 'user',
                        content: [toolResultBlock],
                    });
                }
            }
        }

        return result;
    }

    private convertTool(tool: ToolDefinition): Anthropic.Tool {
        return {
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters as Anthropic.Tool.InputSchema,
        };
    }
}
