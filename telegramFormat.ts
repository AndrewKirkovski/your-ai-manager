import TelegramBot from 'node-telegram-bot-api';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

/** Tags whose content must NEVER reach the user (sanitize-html strips tag + children).
 * htmlparser2 auto-closes unclosed tags at end-of-input, so partial chunks mid-stream
 * (e.g. "<thinking>foo" with no closer yet) are also fully stripped.
 * First entries are sanitize-html defaults — passing `nonTextTags` REPLACES the default
 * list, so we must re-include them to keep script/style content stripping.
 */
const INTERNAL_TAGS = [
    'style', 'script', 'textarea', 'option', 'noscript',
    'thinking', 'system',
    'set-routine', 'update-routine', 'delete-routine',
    'set-task', 'update-task', 'task-complete', 'task-fail',
    'update-memory', 'goal',
];

marked.setOptions({ breaks: true, gfm: true });

/** Narrow strip for `<system>` tags only — applied at trust boundaries
 * (user ingress, history read, compaction I/O, recursion context) to prevent
 * user- or tool-origin `<system>` content from escaping our `<system>At …</system>`
 * prompt wrapper. Case-insensitive, attrs-tolerant, handles closed/unclosed/orphan
 * forms. Bounded loop defends against nested/layered forgeries. */
export function stripSystemTags(text: string): string {
    let out = text;
    for (let i = 0; i < 4; i++) {
        const before = out;
        out = out.replace(/<system\b[^>]*>[\s\S]*?<\/system>/gi, '');
        out = out.replace(/<system\b[^>]*>[\s\S]*$/gi, '');
        out = out.replace(/<\/system\s*>/gi, '');
        if (out === before) break;
    }
    return out;
}

/** Streaming-tick visibility gate only. Strips `<system>` AND `<thinking>` so
 * mid-stream buffers that are currently all-thinking don't emit empty placeholders
 * every 500 ms. Final display still runs through `mdToTelegramHtml`, which strips
 * the same tags plus legacy command XML via sanitize-html's `nonTextTags`. */
export function stripInternalMarkers(text: string): string {
    return stripSystemTags(text)
        .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<thinking\b[^>]*>[\s\S]*$/gi, '')
        .replace(/<\/thinking\s*>/gi, '');
}

/**
 * Telegram Premium custom emoji catalog — harvested from the user's own packs.
 * Each entry is a distinct visual; duplicates with the same `char` are DIFFERENT
 * animated images (different pack artwork), so keep them as separate entries.
 * Add `desc` to label semantics — labeled entries get surfaced in the system
 * prompt (see tgEmojiPromptBlock) so the AI can pick the right one by tag.
 * Unlabeled entries still auto-upgrade bare unicode via replaceUnicodeWithTgEmoji;
 * the FIRST catalog entry per unicode char wins for the bare-unicode path.
 */
export interface TgEmoji {
    char: string;
    id: string;
    desc?: string;
}

export const TG_EMOJI_CATALOG: TgEmoji[] = [
    // --- labeled (harvested descriptions from user) ---
    { char: '🕺', id: '5318895530955251422', desc: 'excited' },
    { char: '🤩', id: '5321057982564278667', desc: 'very excited' },
    { char: '🗣', id: '5321451272719572916', desc: 'doing bap bap bap sounds with a mouth' },
    { char: '🫳', id: '5321096186298377093', desc: 'petting with a hand — soft speed' },
    { char: '🫳', id: '5321298358998932997', desc: 'petting with a hand — medium speed' },
    { char: '🫳', id: '5321538838512804482', desc: 'petting with a hand — fast speed' },
    { char: '🫳', id: '5321357380439515370', desc: 'petting with a hand — ridiculous speed' },
    { char: '🥹', id: '5321467748214120156', desc: 'shy with bottom fingers together' },
    { char: '👏', id: '5321335626430160095', desc: 'clapping' },
    { char: '🎧', id: '5321186573885119857', desc: 'listening to music' },
    { char: '🙋', id: '5319024268304982407', desc: 'hi / greeting' },
    { char: '🤣', id: '5321323604816699343', desc: 'laugh with tears' },
    { char: '😊', id: '5321121874497774145', desc: 'shy and happy' },

    // --- unlabeled (add `desc` as semantics are decided) ---
    { char: '1️⃣', id: '5321302898779366489' },
    { char: '☹️', id: '5321463968642898670' },
    { char: '☺️', id: '5321066267556192398' },
    { char: '✨', id: '5321254395713691212' },
    { char: '🌹', id: '5321402520545796113' },
    { char: '🍑', id: '5321204544028287877' },
    { char: '🍑', id: '5321425279577497857' },
    { char: '🎁', id: '5321267379399827012' },
    { char: '🎊', id: '5321141382239231522' },
    { char: '🏳️\u200d🌈', id: '5321070270465712412' },
    { char: '🐾', id: '5319192446339392281' },
    { char: '👉', id: '5321479121287519920' },
    { char: '👍', id: '5321508911180684443' },
    { char: '👨\u200d🎤', id: '5321230455565983728' },
    { char: '📝', id: '5321044917273763687' },
    { char: '📞', id: '5318962120128208711' },
    { char: '🔃', id: '5321508056482193671' },
    { char: '🔥', id: '5321165021739228475' },
    { char: '🔨', id: '5321052721229340333' },
    { char: '🔪', id: '5321496898157159190' },
    { char: '🔫', id: '5321055092051288462' },
    { char: '🔫', id: '5321479632388627916' },
    { char: '🗞', id: '5321413257964035474' },
    { char: '😁', id: '5321256440118126359' },
    { char: '😃', id: '5321375105769545479' },
    { char: '😇', id: '5321103977369050646' },
    { char: '😇', id: '5321302984678711733' },
    { char: '😉', id: '5321526597856010924' },
    { char: '😋', id: '5321309873806254230' },
    { char: '😌', id: '5321447286989921766' },
    { char: '😍', id: '5321502760787517865' },
    { char: '😎', id: '5319159284896898649' },
    { char: '😎', id: '5321054946022399701' },
    { char: '😏', id: '5321334672947421394' },
    { char: '😏', id: '5321397435304516776' },
    { char: '😐', id: '5319138596039434167' },
    { char: '😒', id: '5321080183250231469' },
    { char: '😓', id: '5321065992678284601' },
    { char: '😔', id: '5321337267107668414' },
    { char: '😘', id: '5321451749460946626' },
    { char: '😝', id: '5321048202923745340' },
    { char: '😟', id: '5321208534052907322' },
    { char: '😠', id: '5321460682992918980' },
    { char: '😡', id: '5321067397132590955' },
    { char: '😢', id: '5319174944347661375' },
    { char: '😦', id: '5321163488435903611' },
    { char: '😨', id: '5321555434266434932' },
    { char: '😰', id: '5319020600402910854' },
    { char: '😱', id: '5321156066732417198' },
    { char: '😲', id: '5321035090388589910' },
    { char: '😲', id: '5321174054055454535' },
    { char: '😲', id: '5321327740870205852' },
    { char: '😳', id: '5318765225942459425' },
    { char: '😳', id: '5321294308844773096' },
    { char: '😴', id: '5321387020008824378' },
    { char: '😵', id: '5321279035941069028' },
    { char: '😵\u200d💫', id: '5321518969994092037' },
    { char: '😷', id: '5321473945851927866' },
    { char: '🙂', id: '5321165253667462339' },
    { char: '🙌', id: '5321499226029432659' },
    { char: '🚪', id: '5321455103830400620' },
    { char: '🤑', id: '5321015350718898589' },
    { char: '🤓', id: '5321105772665380324' },
    { char: '🤔', id: '5319226720178414179' },
    { char: '🤔', id: '5321458844746917057' },
    { char: '🤗', id: '5319207637638717374' },
    { char: '🤘', id: '5321063209539477983' },
    { char: '🤢', id: '5321069076464804220' },
    { char: '🤨', id: '5321077022154300838' },
    { char: '🤩', id: '5321067732140041213' },
    { char: '🤪', id: '5321184692689445184' },
    { char: '🤬', id: '5321186698439172080' },
    { char: '🤭', id: '5321085474649939468' },
    { char: '🤷', id: '5321239543716781153' },
    { char: '🥰', id: '5321367752785534724' },
    { char: '🥷', id: '5321230163508207037' },
    { char: '🥷', id: '5321374929675886565' },
    { char: '🧃', id: '5321183408494222181' },
    { char: '🧡', id: '5321021569831542952' },
    { char: '🧱', id: '5321275934974680914' },
    { char: '🪙', id: '5321212665811443478' },
    { char: '🫠', id: '5321012554695188642' },
    { char: '🫡', id: '5321229575097688402' },
    { char: '🫣', id: '5321432495122555624' },
    { char: '🫥', id: '5321489235935501950' },
    { char: '🫳', id: '5321465420341845195' }, // 5th harvested variant, not in the petting-speed set
];

/** First-occurrence-wins map used by the bare-unicode auto-upgrade path. */
const DEFAULT_TG_EMOJI_BY_CHAR: Map<string, string> = (() => {
    const m = new Map<string, string>();
    for (const e of TG_EMOJI_CATALOG) if (!m.has(e.char)) m.set(e.char, e.id);
    return m;
})();

/** System-prompt block listing labeled variants so the AI can emit the right tag.
 * Unlabeled entries are omitted — they'll still auto-upgrade from bare unicode. */
export function tgEmojiPromptBlock(): string {
    const labeled = TG_EMOJI_CATALOG.filter(e => e.desc);
    if (labeled.length === 0) return '';
    const lines = labeled.map(e =>
        `  ${e.char} (${e.desc}) — <tg-emoji emoji-id="${e.id}">${e.char}</tg-emoji>`);
    return [
        'CUSTOM EMOJI (Telegram Premium, animated):',
        '- Writing the bare unicode (e.g. 🔥) auto-upgrades to the default animated variant.',
        '- For the specific variants below, emit the full tag verbatim:',
        ...lines,
    ].join('\n');
}

/** Wrap mapped unicode emoji in <tg-emoji> tags in a single pass.
 * - Longest-first alternation so ZWJ sequences (e.g. 😵‍💫) match before their base (😵).
 * - Existing <tg-emoji> blocks are preserved verbatim (no double-wrap).
 * - For chars with multiple catalog entries, the first-occurrence variant wins.
 */
export function replaceUnicodeWithTgEmoji(text: string): string {
    if (DEFAULT_TG_EMOJI_BY_CHAR.size === 0) return text;

    const chars = [...DEFAULT_TG_EMOJI_BY_CHAR.keys()].sort((a, b) => b.length - a.length);
    const escapeForRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const alternation = chars.map(escapeForRegex).join('|');
    const combined = new RegExp(`(<tg-emoji\\s+emoji-id="[^"]*">[\\s\\S]*?<\\/tg-emoji>)|(${alternation})`, 'g');

    return text.replace(combined, (match, preserved: string | undefined, emoji: string | undefined) => {
        if (preserved) return preserved;
        if (!emoji) return match;
        const id = DEFAULT_TG_EMOJI_BY_CHAR.get(emoji);
        return `<tg-emoji emoji-id="${id}">${emoji}</tg-emoji>`;
    });
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
        // Telegram HTML parse_mode only honors these schemes in <a href>. Tightening
        // from sanitize-html's default (includes ftp/mailto) avoids spurious plain-
        // text fallbacks when AI emits a mailto link and Telegram rejects the message.
        allowedSchemes: ['http', 'https', 'tg', 'tme'],
        nonTextTags: INTERNAL_TAGS,
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
                // Fallback uses the PRE-conversion `text`, not the HTML finalText,
                // so users don't see raw <tg-emoji>/<b> tags when HTML parsing fails.
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
                // Same rationale as safeSend: use pre-conversion `text` so users
                // don't see raw <tg-emoji>/<b> tags when HTML parsing fails.
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

