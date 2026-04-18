import TelegramBot from 'node-telegram-bot-api';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

marked.setOptions({ breaks: true, gfm: true });

/**
 * Custom emoji map: unicode char → Telegram custom emoji ID.
 * Populate after harvesting IDs from user-sent premium emoji (see index.ts emoji-harvest logs).
 * Targeted set: wolf, fire, thumbs_up, thumbs_down, thinking, warning, question, heart, laugh, eyeroll.
 */
export const TG_EMOJI: Record<string, string> = {
    // '🐺': '',
    // '🔥': '',
    // '👍': '',
    // '👎': '',
    // '💭': '',
    // '❗': '',
    // '❓': '',
    // '❤️': '',
    // '😂': '',
    // '🙄': '',
};

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Wrap mapped unicode emoji in <tg-emoji> tags. Unmapped emoji pass through.
 * Preserves AI-authored <tg-emoji>…</tg-emoji> blocks (no double-wrap). */
export function replaceUnicodeWithTgEmoji(text: string): string {
    const activeEntries = Object.entries(TG_EMOJI).filter(([, id]) => !!id);
    if (activeEntries.length === 0) return text;

    // Split on existing tg-emoji tags; only replace in segments outside them.
    const parts = text.split(/(<tg-emoji\s+emoji-id="[^"]*">[\s\S]*?<\/tg-emoji>)/g);
    return parts.map((part, i) => {
        if (i % 2 === 1) return part; // existing tg-emoji block — skip
        let out = part;
        for (const [ch, id] of activeEntries) {
            const tag = `<tg-emoji emoji-id="${id}">${ch}</tg-emoji>`;
            out = out.split(ch).join(tag);
        }
        return out;
    }).join('');
}

/** Convert Markdown (or plain text with inline HTML) to Telegram-safe HTML. */
export function mdToTelegramHtml(text: string): string {
    const rawHtml = marked.parse(text, { async: false }) as string;

    const processed = rawHtml
        .replace(/<\/p>\s*<p>/g, '\n\n')
        .replace(/<p>/g, '')
        .replace(/<\/p>/g, '\n')
        .replace(/<br\s*\/?>/g, '\n')
        .replace(/<li>/g, '• ')
        .replace(/<\/li>/g, '\n')
        .replace(/<\/?[uo]l>/g, '')
        .replace(/<h[1-6][^>]*>/g, '<b>')
        .replace(/<\/h[1-6]>/g, '</b>\n')
        .replace(/<hr\s*\/?>/g, '────────\n');

    const clean = sanitizeHtml(processed, {
        allowedTags: ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
            'a', 'code', 'pre', 'blockquote', 'tg-emoji'],
        allowedAttributes: { 'a': ['href'], 'tg-emoji': ['emoji-id'] },
        transformTags: {
            'strong': 'b',
            'em': 'i',
            'ins': 'u',
            'strike': 's',
            'del': 's',
        },
    });

    const collapsed = clean.replace(/\n{3,}/g, '\n\n').trim();
    return replaceUnicodeWithTgEmoji(collapsed);
}

type SendOpts = TelegramBot.SendMessageOptions;
type EditOpts = TelegramBot.EditMessageTextOptions;

/** Send a message with HTML parse_mode, falling back to plain text on parse failure. */
export async function safeSend(
    bot: TelegramBot,
    chatId: number | string,
    text: string,
    opts?: SendOpts,
): Promise<TelegramBot.Message | null> {
    const finalText = (!opts || !('parse_mode' in opts)) ? mdToTelegramHtml(text) : text;
    const finalOpts: SendOpts = { parse_mode: 'HTML', ...opts };
    try {
        return await bot.sendMessage(chatId, finalText, finalOpts);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[telegramFormat] sendMessage failed:', msg);
        if (finalOpts.parse_mode && msg.includes("can't parse entities")) {
            try {
                return await bot.sendMessage(chatId, text);
            } catch (retryErr) {
                console.error('[telegramFormat] plain-text fallback also failed:',
                    retryErr instanceof Error ? retryErr.message : retryErr);
                return null;
            }
        }
        return null;
    }
}

/** Edit a message with HTML parse_mode, falling back to plain text on parse failure. */
export async function safeEdit(
    bot: TelegramBot,
    text: string,
    opts: EditOpts,
): Promise<void> {
    const finalText = (!('parse_mode' in opts)) ? mdToTelegramHtml(text) : text;
    const finalOpts: EditOpts = { parse_mode: 'HTML', ...opts };
    try {
        await bot.editMessageText(finalText, finalOpts);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // "message is not modified" is benign — same content edit
        if (msg.includes('message is not modified')) return;
        console.error('[telegramFormat] editMessageText failed:', msg);
        if (finalOpts.parse_mode && msg.includes("can't parse entities")) {
            try {
                const { parse_mode, ...rest } = finalOpts;
                await bot.editMessageText(text, rest as EditOpts);
            } catch (retryErr) {
                if (retryErr instanceof Error && retryErr.message.includes('message is not modified')) return;
                console.error('[telegramFormat] plain-text edit fallback also failed:',
                    retryErr instanceof Error ? retryErr.message : retryErr);
            }
        }
    }
}

/**
 * Send a plain-text message with tg-emoji upgrades — no Markdown parsing.
 * Use for bot-authored literal strings (commands, notifications) where `_` or `*`
 * must NOT be interpreted as emphasis.
 */
export async function safeSendPlain(
    bot: TelegramBot,
    chatId: number | string,
    text: string,
    opts?: SendOpts,
): Promise<TelegramBot.Message | null> {
    const escaped = escHtml(text);
    const finalText = replaceUnicodeWithTgEmoji(escaped);
    const finalOpts: SendOpts = { parse_mode: 'HTML', ...opts };
    try {
        return await bot.sendMessage(chatId, finalText, finalOpts);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[telegramFormat] sendMessage (plain) failed:', msg);
        if (finalOpts.parse_mode && msg.includes("can't parse entities")) {
            try {
                return await bot.sendMessage(chatId, text);
            } catch (retryErr) {
                console.error('[telegramFormat] plain-text fallback also failed:',
                    retryErr instanceof Error ? retryErr.message : retryErr);
                return null;
            }
        }
        return null;
    }
}
