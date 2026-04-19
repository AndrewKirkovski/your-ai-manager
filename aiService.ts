import TelegramBot from 'node-telegram-bot-api';
import {addMessageToHistory, getRecentMessageHistory} from './userStore';
import {executeTool, getAllToolDefinitions, tools} from './tools';
import {formatDateHuman} from "./dateUtils";
import {safeSend, safeEdit, stripSystemTags, stripInternalMarkers} from './telegramFormat';
import type {AIProvider, ProviderMessage, ToolCallInfo, ToolDefinition, ThinkingBlockData} from './aiProvider';

export interface AIStreamOptions {
    userId: number;
    userMessage: string;
    systemPrompt: string;
    bot: TelegramBot;
    provider: AIProvider;
    model: string;
    maxTokens?: number;
    shouldUpdateTelegram?: boolean;
    addUserToHistory?: boolean;
    addAssistantToHistory?: boolean;
    currentRecursionDepth?: number;
    enableToolCalls?: boolean;
    appendMessagesAfterUser?: ProviderMessage[];
    /** Callback to handle images from search results (sent separately, not in history) */
    onImageResults?: (images: string[]) => Promise<void>;
}

export interface AIStreamResult {
    message: string;
    rawResponse: string;
    toolCalls?: ToolCallInfo[];
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

export class AIService {
    /**
     * Unified function to handle AI streaming responses with tool calling support
     */
    static async streamAIResponse(options: AIStreamOptions): Promise<AIStreamResult> {
        return this.streamAIResponseInternal({
            ...options,
            // Tools are always enabled by default (unless recursion limit reached)
            enableToolCalls: (options.currentRecursionDepth ?? 0) >= 5 ? false : (options.enableToolCalls ?? true),
        });
    }

    /**
     * Internal method to handle AI streaming responses
     */
    private static async streamAIResponseInternal(options: AIStreamOptions): Promise<AIStreamResult> {
        const {
            userId,
            userMessage,
            systemPrompt,
            bot,
            provider,
            model,
            maxTokens = 1500,
            addUserToHistory = true,
            addAssistantToHistory = true,
            enableToolCalls = false,
            currentRecursionDepth = 0,
            appendMessagesAfterUser,
        } = options;

        try {
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
                        const sentMessage = await safeSend(bot, userId, contentToSend);
                        if (sentMessage) {
                            messageId = sentMessage.message_id;
                            lastSentContent = aiResponseAccumulated;
                        } else {
                            initialSendFailed = true;
                        }
                    } else {
                        await safeEdit(bot, contentToSend, {
                            chat_id: userId,
                            message_id: messageId,
                        });
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

            // Build messages for provider
            const messages: ProviderMessage[] = [
                ...recentMessages,
                { role: 'user', content: `<system>At ${new Date().toISOString()}</system>\n${userMessage}` },
                ...(appendMessagesAfterUser || []),
            ];

            // Get tool definitions if enabled
            const toolDefs: ToolDefinition[] | undefined = enableToolCalls
                ? getAllToolDefinitions().map(t => ({
                    name: t.function.name,
                    description: t.function.description || '',
                    parameters: t.function.parameters as Record<string, unknown>,
                }))
                : undefined;

            console.debug('💬 AI request via', provider.name, { model, maxTokens, toolCount: toolDefs?.length ?? 0 });

            // Stream from provider
            const stream = provider.streamChat({
                systemPrompt,
                messages,
                tools: toolDefs,
                maxTokens,
                model,
            });

            let aiResponseAccumulated = '';
            let historyResponseAccumulated = '';
            const toolCalls: ToolCallInfo[] = [];
            let thinkingBlocks: ThinkingBlockData[] | undefined;

            await bot.sendChatAction(userId, 'typing');

            // Set up periodic updates during streaming
            const updateInterval_id = setInterval(async () => {
                if (aiResponseAccumulated.length > lastSentContent.length + 100) {
                    try {
                        await updateTelegramMessage();
                    } catch (error) {
                        console.error('Failed to update message during streaming:', error);
                    }
                }
            }, 500);

            // Process streaming response
            for await (const chunk of stream) {
                switch (chunk.type) {
                    case 'text':
                        aiResponseAccumulated += chunk.content;
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

                    case 'done':
                        clearInterval(updateInterval_id);
                        break;
                }
            }

            // Ensure interval is cleared even if 'done' wasn't received
            clearInterval(updateInterval_id);

            console.log('🤖 AI RAW:', {
                userId,
                aiResponseAccumulated,
                toolCalls,
                timestamp: new Date().toISOString()
            });

            historyResponseAccumulated = aiResponseAccumulated;

            // Final display tick: mdToTelegramHtml via safeEdit strips <system>/<thinking>/legacy
            // tags through sanitize-html's nonTextTags. No separate cleanup needed.
            await updateTelegramMessage(true);

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
                    const toolName = toolCall.name;
                    const toolArgs = toolCall.arguments;
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
                            if (images && images.length > 0 && options.onImageResults) {
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

                console.log(`🔄 Continuing with ${newAppendedMessages.length} tool result(s), depth: ${currentRecursionDepth + 1}`);

                const recursiveResult = await this.streamAIResponse({
                    ...options,
                    currentRecursionDepth: currentRecursionDepth + 1,
                    appendMessagesAfterUser: newAppendedMessages,
                    addUserToHistory: false // Don't add recursive calls to history
                });

                historyResponseAccumulated = historyResponseAccumulated + recursiveResult.rawResponse;

            }

            if(addAssistantToHistory) {
                const safeAssistantContent = stripSystemTags(historyResponseAccumulated);
                await addMessageToHistory(userId, 'assistant', safeAssistantContent);
                const preview = safeAssistantContent.length > 100
                    ? safeAssistantContent.substring(0, 100) + '...'
                    : safeAssistantContent;
                console.log(`📝 Added assistant message to history: "${preview.replace(/\n/g, ' ')}"`);
            }

            return {
                message: aiResponseAccumulated,
                rawResponse: aiResponseAccumulated,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            };

        } catch (error) {
            console.error('❌ Error generating AI response:', {
                userId,
                userMessage: userMessage.substring(0, 50) + '...',
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            }, error);

            const errorMessage = `
Ой 🐺
\`\`\`
${error instanceof Error ? error.message : String(error)}
\`\`\`
            `;
            await safeSend(bot, userId, errorMessage);

            return {
                message: errorMessage,
                rawResponse: errorMessage
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
