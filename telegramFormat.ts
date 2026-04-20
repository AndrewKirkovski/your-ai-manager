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

/** Drop `<system>` tags + their content (including nested, unclosed, orphan-close,
 * and case variants) while preserving all other markup and text. Applied at trust
 * boundaries (user ingress at bot.on('message'), history read, compaction I/O,
 * recursion context, tool-result interpolation) so user- or tool-origin `<system>`
 * content can't escape our `<system>At …</system>` prompt wrapper.
 *
 * Uses sanitize-html (htmlparser2) — handles nesting, case, partial tags, and
 * entity decoding correctly. Side-effect: `&` in output is serialized as `&amp;`
 * (sanitize-html always outputs HTML-safe). Idempotent on subsequent passes.
 * Matches the behavior already applied on the display path via mdToTelegramHtml. */
export function stripSystemTags(text: string): string {
    return sanitizeHtml(text, {
        allowedTags: false as unknown as undefined,
        allowedAttributes: false as unknown as undefined,
        exclusiveFilter: (frame) => frame.tag === 'system',
        allowVulnerableTags: true,
    });
}

/** Streaming-tick visibility gate. Strips `<system>` AND `<thinking>` (tag +
 * content) so mid-stream buffers currently all inside a thinking block don't
 * emit empty `...` placeholders. Final display still runs through
 * `mdToTelegramHtml`, which also strips both via sanitize-html's `nonTextTags`. */
export function stripInternalMarkers(text: string): string {
    return sanitizeHtml(text, {
        allowedTags: false as unknown as undefined,
        allowedAttributes: false as unknown as undefined,
        exclusiveFilter: (frame) => frame.tag === 'system' || frame.tag === 'thinking',
        allowVulnerableTags: true,
    });
}

/** Normalize a name/key/value to simple text. Task/routine/memory/stat names are
 * plain labels — no markup. Used at tool-write boundaries so AI-created names
 * containing markup (`<goal>foo</goal>`) don't survive to display or prompt
 * interpolation. Keeps text content, drops tags. Side-effect: `&` is serialized
 * as `&amp;` (sanitize-html output). */
export function textify(value: string): string;
export function textify(value: string | undefined): string | undefined;
export function textify(value: string | undefined | null): string | undefined {
    if (value == null) return value ?? undefined;
    return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} });
}

/** HTML-entity escape for raw `<`, `>`, `&` in bot-authored display templates.
 * Exported as a utility; most display paths don't need it because the values
 * going through them are already textified at write time. Kept for future
 * callers that need to interpolate genuinely untrusted external data without
 * going through the full marked+sanitize-html pipeline. */
export function escapeHtml(s: string | number | null | undefined): string {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

/** Static catalog → first-id-by-char (catalog order wins). Stable across runtime. */
const STATIC_TG_EMOJI_BY_CHAR: Map<string, string> = (() => {
    const m = new Map<string, string>();
    for (const e of TG_EMOJI_CATALOG) if (!m.has(e.char)) m.set(e.char, e.id);
    return m;
})();

/** Dynamic merge cache (30s TTL): static catalog labels + DB-cached analyzed custom emojis.
 * The DB read is cheap (small table, indexed by kind), but we hit this on every AI request
 * via the prompt block. 30s is short enough that newly-analyzed user emojis show up quickly. */
const DYNAMIC_CACHE_TTL_MS = 30_000;
let dynamicCachedAt = 0;
let cachedPromptBlock = '';
let cachedByCharMap: Map<string, string> = STATIC_TG_EMOJI_BY_CHAR;

function rebuildDynamicCache(): void {
    // Lazy import — telegramFormat is sometimes imported from modules that load before db.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {getAllAnalyzedCustomEmojis} = require('./userStore') as typeof import('./userStore');
    const analyzed = getAllAnalyzedCustomEmojis();

    // Build merged char→id map: static catalog wins for any char it covers, cache fills the rest.
    const merged = new Map(STATIC_TG_EMOJI_BY_CHAR);
    for (const entry of analyzed) {
        for (const ch of entry.emojis) {
            if (!merged.has(ch)) merged.set(ch, entry.cacheKey);
        }
    }
    cachedByCharMap = merged;

    // Build prompt block: dedup by id (catalog labels and cached descriptions for the same id collapse,
    // catalog label wins because it appears first).
    const seenIds = new Set<string>();
    const lines: string[] = [];
    for (const e of TG_EMOJI_CATALOG) {
        if (!e.desc || seenIds.has(e.id)) continue;
        seenIds.add(e.id);
        lines.push(`  ${e.char} (${e.desc}) — <tg-emoji emoji-id="${e.id}">${e.char}</tg-emoji>`);
    }
    for (const entry of analyzed) {
        if (seenIds.has(entry.cacheKey)) continue;
        seenIds.add(entry.cacheKey);
        const ch = entry.emojis[0] || '?';
        // Truncate long Vision descriptions so the prompt stays compact.
        const shortDesc = entry.description.length > 120
            ? entry.description.slice(0, 117) + '...'
            : entry.description;
        lines.push(`  ${ch} (${shortDesc}) — <tg-emoji emoji-id="${entry.cacheKey}">${ch}</tg-emoji>`);
    }

    cachedPromptBlock = lines.length === 0 ? '' : [
        'CUSTOM EMOJI (Telegram Premium, animated):',
        '- Writing the bare unicode (e.g. 🔥) auto-upgrades to the default variant.',
        '- For the specific variants below, emit the full tag verbatim:',
        ...lines,
    ].join('\n');

    dynamicCachedAt = Date.now();
}

function ensureFresh(): void {
    if (Date.now() - dynamicCachedAt > DYNAMIC_CACHE_TTL_MS) {
        try {
            rebuildDynamicCache();
        } catch (err) {
            // Don't break the prompt path on DB issues — fall back to static catalog only.
            console.warn('[tg-emoji] dynamic cache rebuild failed, using static catalog:', err instanceof Error ? err.message : err);
            cachedByCharMap = STATIC_TG_EMOJI_BY_CHAR;
            cachedPromptBlock = (() => {
                const labeled = TG_EMOJI_CATALOG.filter(e => e.desc);
                if (labeled.length === 0) return '';
                const ls = labeled.map(e =>
                    `  ${e.char} (${e.desc}) — <tg-emoji emoji-id="${e.id}">${e.char}</tg-emoji>`);
                return [
                    'CUSTOM EMOJI (Telegram Premium, animated):',
                    '- Writing the bare unicode (e.g. 🔥) auto-upgrades to the default variant.',
                    '- For the specific variants below, emit the full tag verbatim:',
                    ...ls,
                ].join('\n');
            })();
            dynamicCachedAt = Date.now();
        }
    }
}

/** System-prompt block listing labeled variants (static catalog + DB-cached analyzed
 * custom emojis). Cached for 30s so SYSTEM_PROMPT assembly stays cheap. */
export function tgEmojiPromptBlock(): string {
    ensureFresh();
    return cachedPromptBlock;
}

/** Wrap mapped unicode emoji in <tg-emoji> tags in a single pass.
 * - Longest-first alternation so ZWJ sequences (e.g. 😵‍💫) match before their base (😵).
 * - Existing <tg-emoji> blocks are preserved verbatim (no double-wrap).
 * - Static catalog wins for chars it covers; DB-cached entries fill in chars catalog doesn't have.
 */
export function replaceUnicodeWithTgEmoji(text: string): string {
    ensureFresh();
    const map = cachedByCharMap;
    if (map.size === 0) return text;

    const chars = [...map.keys()].sort((a, b) => b.length - a.length);
    const escapeForRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const alternation = chars.map(escapeForRegex).join('|');
    const combined = new RegExp(`(<tg-emoji\\s+emoji-id="[^"]*">[\\s\\S]*?<\\/tg-emoji>)|(${alternation})`, 'g');

    return text.replace(combined, (match, preserved: string | undefined, emoji: string | undefined) => {
        if (preserved) return preserved;
        if (!emoji) return match;
        const id = map.get(emoji);
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

/** Telegram hard-limits a single sendMessage to 4096 chars. Markdown → HTML
 * expansion (`<b>`, entities like `&amp;`) makes the rendered text longer than
 * the raw AI output, so we can't trust AI maxTokens alone. Split on whitespace
 * (prefer paragraph boundaries) when needed. Returns the last-sent Message. */
const TELEGRAM_MAX = 4000; // conservative; leaves room for trailing ` ...`
function splitForTelegram(text: string, limit = TELEGRAM_MAX): string[] {
    if (text.length <= limit) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > limit) {
        let splitAt = remaining.lastIndexOf('\n\n', limit);
        if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', limit);
        if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', limit);
        if (splitAt <= 0) splitAt = limit;
        chunks.push(remaining.slice(0, splitAt).trim());
        remaining = remaining.slice(splitAt).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

/** Send a message with HTML parse_mode, falling back to plain text on parse failure. */
export async function safeSend(
    bot: TelegramBot,
    chatId: number | string,
    text: string,
    opts?: SendOpts,
): Promise<TelegramBot.Message | null> {
    const finalText = (!opts || !('parse_mode' in opts)) ? mdToTelegramHtml(text) : text;
    const finalOpts: SendOpts = { parse_mode: 'HTML', ...opts };
    // Split at 4096-char boundary. Each chunk goes through the same fallback
    // path. Return the LAST chunk's Message so callers can track message_id.
    if (finalText.length > TELEGRAM_MAX) {
        const chunks = splitForTelegram(finalText);
        let last: TelegramBot.Message | null = null;
        for (const chunk of chunks) {
            try {
                last = await bot.sendMessage(chatId, chunk, finalOpts);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error('[telegramFormat] chunked sendMessage failed:', msg);
                if (finalOpts.parse_mode && msg.includes("can't parse entities")) {
                    try { last = await bot.sendMessage(chatId, chunk); } catch { /* best effort */ }
                }
            }
        }
        return last;
    }
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

/** Edit a message with HTML parse_mode, falling back to plain text on parse failure.
 * `editMessageText` has Telegram's same 4096-char cap but unlike sendMessage we
 * can't split across multiple messages (one message_id per edit). Truncate
 * overflow with an ellipsis tail. Callers that need the full text (e.g. the
 * final streaming tick) should detect `overflow` and follow up via safeSend. */
export function exceedsTelegramLimit(text: string): boolean {
    return text.length > TELEGRAM_MAX;
}
export async function safeEdit(
    bot: TelegramBot,
    text: string,
    opts: EditOpts,
): Promise<void> {
    let finalText = (!('parse_mode' in opts)) ? mdToTelegramHtml(text) : text;
    if (finalText.length > TELEGRAM_MAX) {
        // Truncate HTML-safe: slice at TELEGRAM_MAX-10 chars and append ellipsis.
        // Mid-HTML-tag truncation is handled by Telegram's parser — it rejects
        // malformed tags, at which point the plain-text fallback kicks in.
        finalText = finalText.slice(0, TELEGRAM_MAX - 10) + '\n…';
    }
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

