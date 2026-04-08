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
        const messages = this.convertMessages(request.systemPrompt, request.messages);
        const tools = request.tools?.map(t => this.convertTool(t));

        const requestOptions: Record<string, unknown> = {
            model: request.model,
            max_tokens: request.maxTokens,
            stream: true as const,
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
            }
        }

        const stream = await this.client.chat.completions.create(
            requestOptions as unknown as OpenAI.ChatCompletionCreateParamsStreaming
        );

        for await (const chunk of stream) {
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
                yield { type: 'done' };
                break;
            }
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
            return { type: 'enabled', budget_tokens: 8000 };
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
