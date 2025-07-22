import OpenAI from 'openai';
import TelegramBot from 'node-telegram-bot-api';
import { AICommandService } from './aiCommandService';
import { addMessageToHistory, getUser, getUserMessageHistory } from './userStore';

export interface AIStreamOptions {
    userId: number;
    userMessage: string;
    systemPrompt: string;
    bot: TelegramBot;
    openai: OpenAI;
    model: string;
    maxTokens?: number;
    shouldUpdateTelegram?: boolean;
    shouldAddToHistory?: boolean;
}

export interface AIStreamResult {
    message: string;
    commandResults: string[];
    rawResponse: string;
}

export class AIService {
    /**
     * Unified function to handle AI streaming responses
     */
    static async streamAIResponse(options: AIStreamOptions): Promise<AIStreamResult> {
        const {
            userId,
            userMessage,
            systemPrompt,
            bot,
            openai,
            model,
            maxTokens = 250,
            shouldAddToHistory = true
        } = options;

        try {
            let messageId: number | undefined;
            let lastSentContent: string = '';

            // Function to update Telegram message during streaming
            async function updateTelegramMessage(isFinal = false) {
                try {
                    const contentToSend = isFinal ? aiResponseAccumulated : aiResponseAccumulated + ' ...';

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
                userMessage: userMessage.substring(0, 100) + (userMessage.length > 100 ? '...' : ''),
                timestamp: new Date().toISOString()
            });

            // Get recent message history for context
            const recentMessages = await this.getRecentMessages(userId, 50);

            const messages = [
                {
                    role: 'system' as const,
                    content: systemPrompt
                },
                ...recentMessages,
                { role: 'user' as const, content: userMessage }
            ];

            // Create streaming request
            const stream = await openai.chat.completions.create({
                max_tokens: maxTokens,
                model: model,
                stream: true,
                messages
            });

            let aiResponseAccumulated = '';
            

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
                const content = chunk.choices[0]?.delta?.content;
                if (content) {
                    aiResponseAccumulated += content;
                }

                // Check if stream is done
                if (chunk.choices[0]?.finish_reason) {
                    clearInterval(updateInterval_id);
                    break;
                }
            }

            console.log('🤖 AI RAW:', {
                userId,
                accumulatedContent: aiResponseAccumulated,
                timestamp: new Date().toISOString()
            });

            // Process AI commands and return clean response
            const { message, commandResults } = await AICommandService.processAIResponse(userId, aiResponseAccumulated);

            // Add messages to history if requested
            if (shouldAddToHistory) {
                await addMessageToHistory(userId, 'user', userMessage);
                await addMessageToHistory(userId, 'assistant', aiResponseAccumulated);

                console.log('📝 Messages added to history:', {
                    userId,
                    userMessageLength: userMessage.length,
                    aiMessageLength: message.length,
                    totalHistoryAfter: (await getUserMessageHistory(userId)).length,
                    timestamp: new Date().toISOString()
                });
            }

            const finalContent = message + (commandResults.length > 0 ? '\n\n' + commandResults.join('\n') : '');
            aiResponseAccumulated = finalContent;
            await updateTelegramMessage(true);

            return {
                message,
                commandResults,
                rawResponse: aiResponseAccumulated
            };

        } catch (error) {
            console.error('❌ Error generating AI response:', {
                userId,
                userMessage: userMessage.substring(0, 50) + '...',
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            });
            
            const errorMessage = `
Ой 🐺
\`\`\`
${error instanceof Error ? error.message : String(error)}
\`\`\`            
            `;
            await bot.sendMessage(userId, errorMessage,{
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
    private static async getRecentMessages(userId: number, limit: number = 30): Promise<{
        role: 'user' | 'assistant',
        content: string
    }[]> {
        const messageHistory = await getUserMessageHistory(userId);
        const recentMessages = messageHistory.slice(-limit);

        return recentMessages.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: m.content
        }));
    }

    /**
     * Legacy function for backward compatibility (non-streaming)
     */
    static async generateMessage(
        prompt: string,
        systemPrompt: string,
        messages: { role: 'user' | 'assistant', content: string }[] = [],
        openai: OpenAI,
        model: string,
        maxTokens: number = 250
    ): Promise<string> {
        try {
            const response = await openai.chat.completions.create({
                max_tokens: maxTokens,
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...messages,
                    { role: 'user', content: prompt }
                ]
            });

            return response.choices[0].message?.content?.trim() || 'Ошибка генерации сообщения';
        } catch (error) {
            console.error('Error generating message:', error);
            return 'Извини, проблемы с генерацией сообщения 🐺';
        }
    }
} 