import OpenAI from 'openai';
import TelegramBot from 'node-telegram-bot-api';
import {AICommandService} from './aiCommandService';
import {addMessageToHistory, getUser, getUserMessageHistory} from './userStore';
import {getAllToolDefinitions, executeTool, tools} from './tools';
import {ChatCompletionCreateParamsStreaming} from "openai/src/resources/chat/completions/completions";
import {ToolCall, ToolResult} from "./tool.types";
import {formatDateHuman} from "./dateUtils";

// Proper types for OpenAI messages with tool support
type OpenAIMessage =
    | { role: 'system'; content: string }
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
    | { role: 'tool'; content: string; tool_call_id: string };

export interface AIStreamOptions {
    userId: number;
    userMessage: string;
    systemPrompt: string;
    bot: TelegramBot;
    openai: OpenAI;
    model: string;
    maxTokens?: number;
    shouldUpdateTelegram?: boolean;
    addUserToHistory?: boolean;
    addAssistantToHistory?: boolean;
    currentRecursionDepth?: number;
    enableToolCalls?: boolean;
    appendMessagesAfterUser?: OpenAIMessage[];
}

export interface AIStreamResult {
    message: string;
    commandResults: string[];
    rawResponse: string;
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
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
            openai,
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

            // Add messages to history if requested
            if (addUserToHistory) {
                await addMessageToHistory(userId, 'user', userMessage);
                console.log('📝 Added user message to history:', userMessage, {
                    userId,
                    timestamp: new Date().toISOString()
                });
            }

            // Function to update Telegram message during streaming
            async function updateTelegramMessage(isFinal = false) {
                try {
                    const contentToSend = isFinal ? aiResponseAccumulated : aiResponseAccumulated + ' ...';

                    if(!aiResponseAccumulated.length) {
                        console.warn('AI response is empty, not updating Telegram message');
                        return;
                    }

                    if (!messageId) {
                        // Send initial message
                        const sentMessage = await bot.sendMessage(userId, contentToSend, {
                            parse_mode: 'Markdown',
                        });
                        messageId = sentMessage.message_id;
                    } else {
                        // Update existing message
                        await bot.editMessageText(contentToSend, {
                            chat_id: userId,
                            message_id: messageId,
                            parse_mode: 'Markdown',
                        });
                    }

                    lastSentContent = aiResponseAccumulated;
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

            const messages: OpenAIMessage[] = [
                {
                    role: 'system',
                    content: systemPrompt
                },
                ...recentMessages,
                {role: 'user', content: `<system>At ${new Date().toISOString()}</system>\n${userMessage}`},
                ...(appendMessagesAfterUser || []),
            ];

            // Create streaming request
            const requestOptions: ChatCompletionCreateParamsStreaming = {
                max_tokens: maxTokens,
                model: model,
                stream: true,
                messages
            };

            // Add tools if tool calling is enabled
            if (enableToolCalls) {
                requestOptions.tools = getAllToolDefinitions()
                requestOptions.tool_choice = 'auto';
            }

            console.debug('💬 FULL AI PROMPT:', requestOptions);

            const stream = await openai.chat.completions.create(requestOptions);

            let aiResponseAccumulated = '';
            let historyResponseAccumulated = '';
            let toolCalls: ToolCall[] = [];

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
                const delta = chunk.choices[0]?.delta;

                // Handle content
                if (delta?.content) {
                    aiResponseAccumulated += delta.content;
                }

                // Handle tool calls
                if (delta?.tool_calls) {
                    for (const toolCallDelta of delta.tool_calls) {
                        if (toolCallDelta.index !== undefined) {
                            let currentToolCall = toolCalls[toolCallDelta.index];
                            // Start of a new tool call
                            if (!currentToolCall) {
                                currentToolCall = toolCalls[toolCallDelta.index] = {
                                    id: toolCallDelta.id || '',
                                    type: 'function',
                                    function: {
                                        name: '',
                                        arguments: ''
                                    }
                                };
                            }
                            if (toolCallDelta.function?.name) {
                                currentToolCall.function!.name += toolCallDelta.function.name;
                            }
                            if (toolCallDelta.function?.arguments) {
                                currentToolCall.function!.arguments += toolCallDelta.function.arguments;
                            }
                        }
                    }
                }

                // Check if stream is done
                if (chunk.choices[0]?.finish_reason) {
                    clearInterval(updateInterval_id);
                    break;
                }
            }

            console.log('🤖 AI RAW:', {
                userId,
                aiResponseAccumulated,
                toolCalls,
                timestamp: new Date().toISOString()
            });

            historyResponseAccumulated = aiResponseAccumulated;

            // Process AI commands and return clean response
            const {message, commandResults} = await AICommandService.processAIResponse(userId, aiResponseAccumulated);

            const finalContent = message + (commandResults.length > 0 ? '\n\n' + commandResults.join('\n') : '');
            aiResponseAccumulated = finalContent;
            await updateTelegramMessage(true);

            if (toolCalls.length > 0 && enableToolCalls) {

                console.log('🔧 Executing tool calls:', {
                    userId,
                    toolCalls,
                    timestamp: new Date().toISOString()
                });

                const newAppendedMessages = [...appendMessagesAfterUser || []];
               newAppendedMessages.push({
                    role: 'assistant',
                    content: aiResponseAccumulated,
                    tool_calls: toolCalls.map(tc => ({
                        ...tc,
                        function: {
                            name: tc.function.name,
                            arguments: tc.function.arguments || '{}'
                        }
                    }))
                });

                for (const toolCall of toolCalls) {
                    try {
                        const result = await executeTool(
                            toolCall.function.name as keyof typeof tools,
                            toolCall.function.arguments,
                            userId,
                        );

                        newAppendedMessages.push({
                            role: 'tool',
                            content: JSON.stringify(result),
                            tool_call_id: toolCall.id,
                        })

                        console.log('✅ Tool executed:', {
                            userId,
                            toolName: toolCall.function.name,
                            result: result,
                            timestamp: new Date().toISOString()
                        });

                        historyResponseAccumulated = `${historyResponseAccumulated}\n\n[Success call a tool: ${toolCall.function.name}]\n\n`;
                    } catch (error) {
                        console.error('❌ Tool execution failed:', {
                            userId,
                            toolName: toolCall.function.name,
                            error: error instanceof Error ? error.message : String(error),
                            timestamp: new Date().toISOString()
                        });

                        newAppendedMessages.push({
                            tool_call_id: toolCall.id,
                            role: 'tool',
                            content: JSON.stringify({error: error instanceof Error ? error.message : String(error)})
                        })

                        historyResponseAccumulated = `${historyResponseAccumulated}\n\n[Failed call a tool: ${toolCall.function.name}]\n\n`;
                    }
                }

                console.log('🔄 Making recursive call with tool results:', {
                    userId,
                    newAppendedMessages,
                    recursionDepth: currentRecursionDepth + 1,
                    timestamp: new Date().toISOString()
                });

                const recursiveResult = await this.streamAIResponse({
                    ...options,
                    currentRecursionDepth: currentRecursionDepth + 1,
                    appendMessagesAfterUser: newAppendedMessages,
                    addUserToHistory: false // Don't add recursive calls to history
                });

                historyResponseAccumulated = historyResponseAccumulated + recursiveResult.rawResponse;

            }




            if(addAssistantToHistory) {
                await addMessageToHistory(userId, 'assistant', historyResponseAccumulated);
                console.log('📝 Added ass message to history:', historyResponseAccumulated, {
                    userId,
                    timestamp: new Date().toISOString()
                });
            }

            return {
                message,
                commandResults,
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
            await bot.sendMessage(userId, errorMessage, {
                parse_mode: 'Markdown',
            });

            return {
                message: errorMessage,
                commandResults: [],
                rawResponse: errorMessage
            };
        }
    }

    /**
     * Get recent messages for context
     */
    private static async getRecentMessages(userId: number, limit: number = 30): Promise<OpenAIMessage[]> {
        const messageHistory = await getUserMessageHistory(userId);
        const recentMessages = messageHistory.slice(-limit);

        return recentMessages.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: `<system>At ${formatDateHuman(m.timestamp)}</system>\n${m.content}`
        }));
    }
} 