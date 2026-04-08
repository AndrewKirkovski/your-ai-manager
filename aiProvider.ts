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

export type ProviderMessage =
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string; toolCalls?: ToolCallInfo[]; thinkingBlocks?: ThinkingBlockData[] }
    | { role: 'tool_result'; toolCallId: string; content: string };

// --- Stream chunk types ---

export type StreamChunk =
    | { type: 'text'; content: string }
    | { type: 'tool_call_start'; index: number; id: string; name: string }
    | { type: 'tool_call_args'; index: number; args: string }
    | { type: 'thinking'; content: string }
    | { type: 'thinking_blocks'; blocks: ThinkingBlockData[] }
    | { type: 'done' };

// --- Request types ---

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
}

export interface StreamRequest {
    systemPrompt: string;
    messages: ProviderMessage[];
    tools?: ToolDefinition[];
    maxTokens: number;
    model: string;
}

export interface CompletionRequest {
    systemPrompt?: string;
    messages: ProviderMessage[];
    maxTokens: number;
    model: string;
}

// --- Provider interface ---

export interface AIProvider {
    readonly name: string;
    streamChat(request: StreamRequest): AsyncIterable<StreamChunk>;
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
