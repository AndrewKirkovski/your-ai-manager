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
 * Clean AI response by removing any XML-like tags that might slip through.
 * This is a safety net - the AI should use tools, not tags.
 */
function cleanAIResponse(text: string): string {
    // Remove any AI command tags (legacy, shouldn't appear anymore)
    let cleaned = text.replace(/<(?:set-routine|update-routine|delete-routine|set-task|update-task|task-complete|task-fail|update-memory|goal)[^>]*>.*?<\/(?:set-routine|update-routine|delete-routine|set-task|update-task|task-complete|task-fail|update-memory|goal)>/gs, '');

    // Remove self-closing legacy tags
    cleaned = cleaned.replace(/<(?:set-routine|update-routine|delete-routine|set-task|update-task|task-complete|task-fail|update-memory)[^>]*\/>/g, '');

    // Remove <thinking> tags (internal thoughts, not for user display)
    cleaned = cleaned.replace(/<thinking>.*?<\/thinking>/gs, '');

    // Clean up excessive whitespace
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    return cleaned;
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
