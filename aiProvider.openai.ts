import OpenAI from 'openai';
import type {
    AIProvider,
    StreamRequest,
    CompletionRequest,
    StreamChunk,
    ProviderMessage,
    ToolDefinition,
} from './aiProvider';

export class OpenAIProvider implements AIProvider {
    readonly name = 'openai';
    private client: OpenAI;
    private isAnthropicEndpoint: boolean;

    constructor(apiKey: string, baseURL?: string) {
        this.client = new OpenAI({
            apiKey,
            ...(baseURL && { baseURL }),
        });
        this.isAnthropicEndpoint = !!baseURL && baseURL.includes('anthropic');
    }

    async *streamChat(request: StreamRequest): AsyncIterable<StreamChunk> {
        // OpenAI compat layer doesn't expose Anthropic's cache_control directly,
        // so just concatenate prefix + main into a single system string. We lose
        // the caching benefit on this path; native Anthropic provider keeps it.
        const fullSystem = request.systemPromptCachePrefix
            ? `${request.systemPromptCachePrefix}\n\n${request.systemPrompt}`
            : request.systemPrompt;
        const messages = this.convertMessages(fullSystem, request.messages);
        const tools = request.tools?.map(t => this.convertTool(t));

        const requestOptions: Record<string, unknown> = {
            model: request.model,
            max_tokens: request.maxTokens,
            stream: true as const,
            stream_options: { include_usage: true },
            messages,
        };

        if (tools?.length) {
            requestOptions.tools = tools;
            requestOptions.tool_choice = 'auto';
        }

        // Enable extended thinking via extra_body (Anthropic compat layer)
        if (this.isAnthropicEndpoint) {
            const thinkingConfig = this.getThinkingConfig(request.model);
            if (thinkingConfig) {
                requestOptions.extra_body = { thinking: thinkingConfig };
                // max_tokens must be > budget_tokens
                const budget = (thinkingConfig as any).budget_tokens;
                if (budget && (request.maxTokens || 1500) <= budget) {
                    requestOptions.max_tokens = budget + 4000;
                }
            }
        }

        const stream = await this.client.chat.completions.create(
            requestOptions as unknown as OpenAI.ChatCompletionCreateParamsStreaming
        );

        let pendingDone = false;
        // try/finally so when the consumer (aiService) breaks the for-await early —
        // via throw, return, or generator.throw — we abort the underlying HTTP socket
        // instead of letting the SDK keep it open until the server hangs up.
        try {
        for await (const chunk of stream) {
            // With include_usage:true the LAST chunk has empty choices[] and a populated usage field.
            // Some providers also send usage on a chunk that still has finish_reason — handle both.
            const usage = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }).usage;
            if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
                yield {
                    type: 'usage',
                    input_tokens: usage.prompt_tokens ?? 0,
                    output_tokens: usage.completion_tokens ?? 0,
                    cache_creation_tokens: usage.cache_creation_input_tokens,
                    cache_read_tokens: usage.cache_read_input_tokens,
                };
            }

            const delta = chunk.choices[0]?.delta;

            if (delta?.content) {
                yield { type: 'text', content: delta.content };
            }

            if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                    if (tc.index !== undefined) {
                        if (tc.id) {
                            yield {
                                type: 'tool_call_start',
                                index: tc.index,
                                id: tc.id,
                                name: tc.function?.name || '',
                            };
                        }
                        if (tc.function?.arguments) {
                            yield {
                                type: 'tool_call_args',
                                index: tc.index,
                                args: tc.function.arguments,
                            };
                        }
                    }
                }
            }

            if (chunk.choices[0]?.finish_reason) {
                pendingDone = true;
                // Don't break here — let the final usage-only chunk arrive after finish_reason.
            }
        }
        if (pendingDone) yield { type: 'done' };
        } finally {
            // OpenAI's Stream exposes `controller` (AbortController). Aborting on
            // exit closes the socket. Safe to call after a clean finish — the SDK
            // ignores aborts on already-completed streams.
            const abort = (stream as { controller?: AbortController }).controller;
            try { abort?.abort(); } catch { /* ignore */ }
        }
    }

    async completeChat(request: CompletionRequest): Promise<string> {
        const messages = this.convertMessages(request.systemPrompt || '', request.messages);

        const response = await this.client.chat.completions.create({
            model: request.model,
            max_tokens: request.maxTokens,
            messages,
        });

        return response.choices[0]?.message?.content || '';
    }

    private convertMessages(
        systemPrompt: string,
        messages: ProviderMessage[]
    ): OpenAI.ChatCompletionMessageParam[] {
        const result: OpenAI.ChatCompletionMessageParam[] = [];

        if (systemPrompt) {
            result.push({ role: 'system', content: systemPrompt });
        }

        for (const msg of messages) {
            if (msg.role === 'user') {
                result.push({ role: 'user', content: msg.content });
            } else if (msg.role === 'assistant') {
                const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
                    role: 'assistant',
                    content: msg.content,
                };
                if (msg.toolCalls?.length) {
                    assistantMsg.tool_calls = msg.toolCalls.map(tc => ({
                        id: tc.id,
                        type: 'function' as const,
                        function: { name: tc.name, arguments: tc.arguments },
                    }));
                }
                result.push(assistantMsg);
            } else if (msg.role === 'tool_result') {
                result.push({
                    role: 'tool',
                    tool_call_id: msg.toolCallId,
                    content: msg.content,
                });
            }
        }

        return result;
    }

    private getThinkingConfig(model: string): Record<string, unknown> | null {
        // 4.6 models: adaptive thinking (recommended)
        if (/4-6|4\.6/i.test(model)) {
            return { type: 'adaptive' };
        }
        // Older models that support thinking: use enabled with budget
        if (/opus|sonnet-4|claude-3[.-]7/i.test(model)) {
            return { type: 'enabled', budget_tokens: 2000 };
        }
        return null;
    }

    private convertTool(tool: ToolDefinition): OpenAI.ChatCompletionTool {
        return {
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters as OpenAI.FunctionParameters,
            },
        };
    }
}
