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
    const patterns: RegExp[] = [
        // Legacy command tags: paired + self-closing + unclosed-at-end
        new RegExp(`<(?:${LEGACY})[^>]*>[\\s\\S]*?<\\/(?:${LEGACY})>`, 'gi'),
        new RegExp(`<(?:${LEGACY})[^>]*\\/>`, 'gi'),
        new RegExp(`<(?:${LEGACY})[^>]*>[\\s\\S]*$`, 'gi'),
        // <thinking> — closed + unclosed + orphan-close (from nested lazy-match leftovers)
        /<thinking>[\s\S]*?<\/thinking>/gi,
        /<thinking>[\s\S]*$/gi,
        /<\/thinking>/gi,
        // <system> — closed + unclosed + orphan-close
        /<system[^>]*>[\s\S]*?<\/system>/gi,
        /<system[^>]*>[\s\S]*$/gi,
        /<\/system>/gi,
        new RegExp(`<\\/(?:${LEGACY})>`, 'gi'),
    ];
    // Loop until no more matches — handles nested tags (e.g. <thinking>a<thinking>b</thinking>c</thinking>).
    // Bounded at 8 passes so a pathological input can't hang the streaming tick.
    let cleaned = text;
    for (let i = 0; i < 8; i++) {
        const before = cleaned;
        for (const re of patterns) cleaned = cleaned.replace(re, '');
        if (cleaned === before) break;
    }
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
