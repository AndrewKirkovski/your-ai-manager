import Anthropic from '@anthropic-ai/sdk';
import type {
    AIProvider,
    StreamRequest,
    CompletionRequest,
    StreamChunk,
    ProviderMessage,
    ToolDefinition,
    ThinkingBlockData,
} from './aiProvider';

export class AnthropicProvider implements AIProvider {
    readonly name = 'anthropic';
    private client: Anthropic;

    constructor(apiKey: string) {
        this.client = new Anthropic({ apiKey });
    }

    async *streamChat(request: StreamRequest): AsyncIterable<StreamChunk> {
        const messages = this.convertMessages(request.messages);
        const tools = request.tools?.map(t => this.convertTool(t));

        const thinkingConfig = /4-6|4\.6/i.test(request.model)
            ? { type: 'adaptive' as const }
            : /opus|sonnet-4|claude-3[.-]7/i.test(request.model)
                ? { type: 'enabled' as const, budget_tokens: 8000 }
                : null;
        const params: Anthropic.MessageCreateParams = {
            model: request.model,
            max_tokens: request.maxTokens,
            system: request.systemPrompt,
            messages,
            ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
            stream: true as const,
        };

        if (tools?.length) {
            params.tools = tools;
            params.tool_choice = { type: 'auto' };
        }

        const stream = await this.client.messages.create(params);

        // Track tool call indices — Anthropic uses content_block index, we map to sequential tool index
        let toolIndex = -1;

        // Capture thinking blocks (text + cryptographic signature) for multi-turn continuity
        const thinkingBlocks: ThinkingBlockData[] = [];
        let currentThinking: { thinking: string; signature: string } | null = null;

        for await (const event of stream as AsyncIterable<Anthropic.MessageStreamEvent>) {
            switch (event.type) {
                case 'content_block_start': {
                    const block = event.content_block;
                    if (block.type === 'tool_use') {
                        toolIndex++;
                        yield {
                            type: 'tool_call_start',
                            index: toolIndex,
                            id: block.id,
                            name: block.name,
                        };
                    } else if (block.type === 'thinking') {
                        currentThinking = { thinking: '', signature: '' };
                    } else if (block.type === 'redacted_thinking') {
                        thinkingBlocks.push({ type: 'redacted_thinking', data: (block as { data: string }).data });
                    }
                    break;
                }

                case 'content_block_delta': {
                    const delta = event.delta;
                    if (delta.type === 'text_delta') {
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
                        thinkingBlocks.push({
                            type: 'thinking',
                            thinking: currentThinking.thinking,
                            signature: currentThinking.signature,
                        });
                        currentThinking = null;
                    }
                    break;
                }

                case 'message_delta': {
                    // Emit accumulated thinking blocks before done (needed for recursive tool calls)
                    if (thinkingBlocks.length > 0) {
                        yield { type: 'thinking_blocks', blocks: thinkingBlocks };
                    }
                    yield { type: 'done' };
                    break;
                }

                // message_start, message_stop — no action needed
            }
        }
    }

    async completeChat(request: CompletionRequest): Promise<string> {
        const messages = this.convertMessages(request.messages);

        const response = await this.client.messages.create({
            model: request.model,
            max_tokens: request.maxTokens,
            ...(request.systemPrompt && { system: request.systemPrompt }),
            messages,
        });

        // Extract text from content blocks
        const textBlocks = response.content.filter(
            (b): b is Anthropic.TextBlock => b.type === 'text'
        );
        return textBlocks.map(b => b.text).join('') || '';
    }

    private convertMessages(messages: ProviderMessage[]): Anthropic.MessageParam[] {
        const result: Anthropic.MessageParam[] = [];

        for (const msg of messages) {
            if (msg.role === 'user') {
                result.push({ role: 'user', content: msg.content });
            } else if (msg.role === 'assistant') {
                const contentBlocks: Anthropic.ContentBlockParam[] = [];

                // Add thinking blocks first (required for multi-turn thinking continuity)
                if (msg.thinkingBlocks?.length) {
                    for (const tb of msg.thinkingBlocks) {
                        if (tb.type === 'thinking') {
                            contentBlocks.push({
                                type: 'thinking',
                                thinking: tb.thinking,
                                signature: tb.signature,
                            });
                        } else {
                            contentBlocks.push({
                                type: 'redacted_thinking',
                                data: tb.data,
                            });
                        }
                    }
                }

                // Add text if present
                if (msg.content) {
                    contentBlocks.push({ type: 'text', text: msg.content });
                }

                // Convert tool calls to tool_use content blocks
                if (msg.toolCalls?.length) {
                    for (const tc of msg.toolCalls) {
                        let input: unknown;
                        try {
                            input = JSON.parse(tc.arguments || '{}');
                        } catch {
                            input = {};
                        }
                        contentBlocks.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.name,
                            input: input as Record<string, unknown>,
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
