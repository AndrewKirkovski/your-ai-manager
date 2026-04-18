/**
 * AI Command Service - DEPRECATED
 *
 * This service previously handled XML tag parsing for AI commands.
 * Commands are now handled via OpenAI function calling (tools).
 *
 * This file is kept only to clean any stray tags from AI responses
 * and for the <thinking> tag removal functionality.
 */

/**
 * Strip internal tags that must never reach the user (legacy command XML,
 * <thinking>, <system>). Handles both fully closed and unclosed-at-end forms
 * so partial chunks during streaming don't leak content before the closing tag.
 */
export function stripInternalTags(text: string): string {
    const LEGACY = 'set-routine|update-routine|delete-routine|set-task|update-task|task-complete|task-fail|update-memory|goal';
    let cleaned = text;
    // Legacy command tags (paired + self-closing)
    cleaned = cleaned.replace(new RegExp(`<(?:${LEGACY})[^>]*>[\\s\\S]*?<\\/(?:${LEGACY})>`, 'g'), '');
    cleaned = cleaned.replace(new RegExp(`<(?:${LEGACY})[^>]*\\/>`, 'g'), '');
    cleaned = cleaned.replace(new RegExp(`<(?:${LEGACY})[^>]*>[\\s\\S]*$`, 'g'), '');
    // <thinking> — internal chain-of-thought (closed + unclosed)
    cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
    cleaned = cleaned.replace(/<thinking>[\s\S]*$/g, '');
    // <system> — metadata injected by the bot (closed + unclosed)
    cleaned = cleaned.replace(/<system[^>]*>[\s\S]*?<\/system>/g, '');
    cleaned = cleaned.replace(/<system[^>]*>[\s\S]*$/g, '');
    return cleaned;
}

function cleanAIResponse(text: string): string {
    return stripInternalTags(text).replace(/\n{3,}/g, '\n\n').trim();
}

export class AICommandService {
    /**
     * Process AI response: clean tags and return clean text for display
     *
     * NOTE: Command execution is now handled via OpenAI tools/function calling.
     * This method only cleans the response text.
     */
    static async processAIResponse(userId: number, aiResponse: string): Promise<{
        message: string,
        commandResults: string[]
    }> {
        const cleanText = cleanAIResponse(aiResponse);

        // Log if any tags were found (shouldn't happen with tools-only system)
        if (cleanText !== aiResponse) {
            console.warn('⚠️ AI response contained tags that were stripped. AI should use tools instead.');
        }

        return {
            message: cleanText,
            commandResults: [] // No command execution - handled by tools
        };
    }
}
