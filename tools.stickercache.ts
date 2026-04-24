import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import {Tool} from './tool.types';
import {
    getStickerCacheEntry,
    upsertStickerCacheEntry,
    deleteStickerCacheEntry,
    findStickerCacheEntries,
    refreshStickerCacheFileId,
    bumpStickerUsedCount,
    recordAITokens,
    getUser,
    type StickerCacheEntry,
    type StickerCacheKind,
} from './userStore';

let botInstance: TelegramBot | null = null;
let lookupClient: OpenAI | null = null;
let lookupModel: string = 'claude-haiku-4-5-20251001';

export function initStickerCacheTools(bot: TelegramBot, client: OpenAI, model?: string): void {
    botInstance = bot;
    lookupClient = client;
    if (model) lookupModel = model;
}

/** Ask the cheap lookup model to pick the cache_key whose description best matches `vibe_query`.
 * ALWAYS routes through Haiku when there are candidates — even single-candidate, because the SQL
 * pre-filter widens up to a kind-only slice when specific matches are scarce, so a "match" can
 * actually be unrelated. Haiku is the gate that prevents random sticker sends.
 * Returns null on any failure path (no client, API error, unparseable response, or model says "0"). */
async function pickStickerByVibe(vibe_query: string, candidates: StickerCacheEntry[], userId: number): Promise<StickerCacheEntry | null> {
    if (candidates.length === 0) return null;
    if (!lookupClient) {
        console.warn('[stickerPicker] no lookup client configured; returning null');
        return null;
    }

    const numbered = candidates.map((c, i) => {
        const emojis = c.emojis.length > 0 ? ` [${c.emojis.join(' ')}]` : '';
        const desc = c.description.length > 220 ? c.description.slice(0, 217) + '...' : c.description;
        return `${i + 1}.${emojis} ${desc}`;
    }).join('\n');

    const prompt =
        `Pick the single best sticker for vibe "${vibe_query}" from this numbered list. ` +
        `Match by visual content / emotion / character — not just keyword overlap. ` +
        `If NOTHING in the list is a reasonable fit for the vibe, reply with 0 (caller will send a text reply instead). ` +
        `Otherwise reply with ONLY the integer index (1-${candidates.length}), no other text.\n\n${numbered}`;

    try {
        const resp = await lookupClient.chat.completions.create({
            model: lookupModel,
            messages: [{role: 'user', content: prompt}],
            max_tokens: 10,
        });
        recordLookupUsage(resp, 'sticker_picker', userId);
        const raw = resp.choices[0]?.message?.content?.trim() ?? '';
        const idx = parseInt(raw.match(/\d+/)?.[0] ?? '', 10);
        if (Number.isFinite(idx) && idx >= 1 && idx <= candidates.length) {
            return candidates[idx - 1];
        }
        console.warn(`[stickerPicker] model rejected all candidates or returned invalid index "${raw}"; returning null`);
    } catch (err) {
        console.warn('[stickerPicker] lookup model failed; returning null:', err instanceof Error ? err.message : err);
    }
    return null;
}

/** Record token usage from a Haiku lookup-model call. Attributed to the user the
 * AI is currently replying to. recordAITokens double-writes per-user + global. */
function recordLookupUsage(resp: { usage?: { prompt_tokens?: number; completion_tokens?: number } }, purpose: string, userId: number): void {
    const u = resp.usage;
    if (!u) return;
    void recordAITokens(userId, u.prompt_tokens ?? 0, u.completion_tokens ?? 0, purpose);
}

const KIND_VALUES: StickerCacheKind[] = ['sticker', 'animated_sticker', 'video_sticker', 'custom_emoji'];

function isStickerKind(s: unknown): s is StickerCacheKind {
    return typeof s === 'string' && (KIND_VALUES as string[]).includes(s);
}

export const UpdateStickerCache: Tool = {
    name: 'UpdateStickerCache',
    description:
        "Overwrite the cached visual analysis of a sticker or custom emoji when the user clarifies what it actually means to them (e.g. \"that one means annoyed not happy\", \"this is sarcasm\"). " +
        "The cache_key comes from the 'cache_key:' line of a sticker context block in recent message history, or from FindStickerInCache.",
    parameters: {
        type: 'object',
        properties: {
            cache_key: {
                type: 'string',
                description: 'The cache_key (Telegram file_unique_id for stickers, or custom_emoji_id for premium emojis) shown in recent sticker context blocks.',
            },
            description: {
                type: 'string',
                description: "The corrected meaning. Be concrete: describe the visual AND the user-specific meaning (e.g. 'wolf laughing — used by this user as sarcastic/annoyed, not genuine amusement').",
            },
        },
        required: ['cache_key', 'description'],
    },
    execute: async (args: {userId: number; cache_key: string; description: string}) => {
        const existing = getStickerCacheEntry(args.cache_key);
        if (!existing) {
            return {
                success: false,
                message: `No cache entry for cache_key="${args.cache_key}". The sticker has never been seen by the bot, so there's nothing to overwrite. Wait until the user sends it once, then update.`,
            };
        }
        upsertStickerCacheEntry({
            cacheKey: args.cache_key,
            kind: existing.kind,
            emojis: existing.emojis,
            setName: existing.setName,
            description: args.description,
            fileId: existing.fileId,
            userCorrected: true,
        });
        return {
            success: true,
            cache_key: args.cache_key,
            kind: existing.kind,
            old_description: existing.description,
            new_description: args.description,
        };
    },
};

export const DeleteStickerCache: Tool = {
    name: 'DeleteStickerCache',
    description:
        "Remove a cached sticker / custom emoji description so it gets re-analyzed by Vision the next time the user sends it. " +
        "Use when the user says the cached meaning is wrong and you want a fresh analysis instead of writing one yourself.",
    parameters: {
        type: 'object',
        properties: {
            cache_key: {
                type: 'string',
                description: 'The cache_key (file_unique_id or custom_emoji_id) shown in recent sticker context blocks.',
            },
        },
        required: ['cache_key'],
    },
    execute: async (args: {userId: number; cache_key: string}) => {
        const existed = !!getStickerCacheEntry(args.cache_key);
        const deleted = deleteStickerCacheEntry(args.cache_key);
        return {
            success: true,
            cache_key: args.cache_key,
            existed,
            deleted,
        };
    },
};

export const FindStickerInCache: Tool = {
    name: 'FindStickerInCache',
    description:
        "Search the sticker cache by emoji, description text, sticker pack name, or kind. " +
        "Use when the user references a sticker that's not in recent message history — e.g. \"the wolf-dancing one\", \"that sad one from yesterday\". " +
        "Returns up to 10 matching entries with their cache_keys so you can call UpdateStickerCache or EchoStickerToUser.",
    parameters: {
        type: 'object',
        properties: {
            emoji_contains: {
                type: 'string',
                description: 'Emoji character(s) the sticker should be associated with (e.g. "😂"). Substring match against the JSON emoji list.',
            },
            description_contains: {
                type: 'string',
                description: 'Substring to search in the cached description (e.g. "wolf dancing").',
            },
            pack_name: {
                type: 'string',
                description: 'Substring of the sticker pack name (e.g. "WolfPack").',
            },
            kind: {
                type: 'string',
                enum: ['sticker', 'animated_sticker', 'video_sticker', 'custom_emoji'],
                description: 'Filter by sticker kind.',
            },
            limit: {
                type: 'number',
                description: 'Max results (1-50, default 10).',
            },
        },
    },
    execute: async (args: {
        userId: number;
        emoji_contains?: string;
        description_contains?: string;
        pack_name?: string;
        kind?: string;
        limit?: number;
    }) => {
        const kind = isStickerKind(args.kind) ? args.kind : undefined;
        const matches = findStickerCacheEntries({
            emojiContains: args.emoji_contains,
            descriptionContains: args.description_contains,
            packName: args.pack_name,
            kind,
            limit: args.limit,
        });
        return {
            success: true,
            count: matches.length,
            entries: matches.map(m => ({
                cache_key: m.cacheKey,
                kind: m.kind,
                emojis: m.emojis,
                pack: m.setName,
                description: m.description,
                user_corrected: m.userCorrected,
                updated_at: m.updatedAt.toISOString(),
            })),
        };
    },
};

/** Direct-send tool — AI picks the cache_key from the EMOJIS/STICKERS catalog visible
 * in the system prompt, no Haiku ranker round-trip. The natural-flow primary path. */
export const SendStickerById: Tool = {
    name: 'SendStickerById',
    description:
        "Send a specific sticker by its cache_key. Pick the cache_key from the STICKERS section " +
        "of your system prompt vocabulary (each line shows: emoji + cache_key + short tag). " +
        "Use this whenever a sticker fits your reaction — natural in-flow choice, no need to ask the user. " +
        "Don't force it; if no listed sticker matches the moment, just write text. " +
        "If the cache_key isn't in the catalog OR the sticker has no current file_id, returns success=false — fall back to text.",
    parameters: {
        type: 'object',
        properties: {
            cache_key: {
                type: 'string',
                description: 'EXACT cache_key string from the STICKERS catalog line (e.g. "AgADfQADl7yyCQ"). NOT the short tag, NOT a guess — copy verbatim.',
            },
        },
        required: ['cache_key'],
    },
    execute: async (args: {userId: number; cache_key: string}) => {
        if (!botInstance) return {success: false, message: 'SendStickerById: bot not initialized'};
        const entry = getStickerCacheEntry(args.cache_key);
        if (!entry) {
            return {success: false, no_match: true, message: `No sticker with cache_key="${args.cache_key}" in the catalog. Reply with text.`};
        }
        if (!entry.fileId) {
            return {success: false, no_match: true, message: `Sticker "${args.cache_key}" has no current file_id (Telegram rotated it). Will refresh on next user send. Reply with text.`};
        }
        const user = await getUser(args.userId);
        if (!user?.chatId) return {success: false, message: 'User chat_id unknown.'};
        try {
            const sent = await botInstance.sendSticker(user.chatId, entry.fileId);
            bumpStickerUsedCount(args.cache_key);
            return {
                success: true,
                cache_key: args.cache_key,
                kind: entry.kind,
                short_tag: entry.shortTag,
                sent_message_id: sent.message_id,
            };
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (/file_id|wrong type|invalid/i.test(errMsg)) {
                refreshStickerCacheFileId(args.cache_key, null);
                console.warn(`[SendStickerById] cleared stale file_id for ${args.cache_key}: ${errMsg}`);
            }
            return {success: false, message: `sendSticker failed: ${errMsg}`};
        }
    },
};

/** Batch suggestion tool — for multi-intent replies where the AI can't quickly find
 * the right pieces in the EMOJIS/STICKERS catalog scan. ONE Haiku call ranks the
 * candidate pool against ALL intents simultaneously, returns top-2 per intent. */
export const SuggestExpressions: Tool = {
    name: 'SuggestExpressions',
    description:
        "Get a map of stickers/custom-emojis matching multiple intents in ONE call. " +
        "Use this BEFORE writing your reply when (a) you'll express several emotional beats and (b) you can't quickly spot all the right pieces in the EMOJIS/STICKERS catalog visible in your system prompt. " +
        "Returns top-2 candidates per intent (cache_key + emoji + short_tag + snippet) so you can weave them into your message naturally. " +
        "For just ONE expression you've already spotted in the catalog, use SendStickerById or write the <tg-emoji> tag inline directly — don't waste a tool call.",
    parameters: {
        type: 'object',
        properties: {
            intents: {
                type: 'array',
                items: {type: 'string'},
                description: 'Short list of moods/intents to find matches for (e.g. ["sarcastic agreement", "pretending to listen", "exhausted"]). 2-6 intents per call works best.',
            },
            kind: {
                type: 'string',
                enum: ['sticker', 'animated_sticker', 'video_sticker', 'custom_emoji'],
                description: "Optional: restrict suggestions to one kind. Omit to consider both stickers and custom emojis.",
            },
        },
        required: ['intents'],
    },
    execute: async (args: {userId: number; intents: string[]; kind?: string}) => {
        const intents = (args.intents ?? []).map(s => s?.trim()).filter(s => s && s.length > 0);
        if (intents.length === 0) return {success: false, message: 'intents is empty'};
        const kind = isStickerKind(args.kind) ? args.kind : undefined;

        // Pull a wide pool — the Haiku ranker handles semantic match.
        const POOL = 100;
        const pool = findStickerCacheEntries({kind, limit: POOL}).filter(c => !!c.fileId || c.kind === 'custom_emoji');
        if (pool.length === 0) {
            return {success: false, no_match: true, message: 'Cache is empty — nothing to suggest.'};
        }

        // Default: text-LIKE per-intent fallback (if Haiku unavailable or fails)
        const fallback = (): Record<string, Array<{cache_key: string; kind: string; emoji: string; short_tag: string; snippet: string}>> => {
            const out: Record<string, Array<{cache_key: string; kind: string; emoji: string; short_tag: string; snippet: string}>> = {};
            for (const intent of intents) {
                const matches = pool
                    .filter(c => (c.shortTag + ' ' + c.description).toLowerCase().includes(intent.toLowerCase()))
                    .slice(0, 2);
                out[intent] = matches.map(c => ({
                    cache_key: c.cacheKey,
                    kind: c.kind,
                    emoji: c.emojis[0] ?? '?',
                    short_tag: c.shortTag,
                    snippet: c.description.slice(0, 80),
                }));
            }
            return out;
        };

        if (!lookupClient) {
            return {success: true, source: 'text_fallback', suggestions: fallback()};
        }

        // Format candidates compactly for Haiku.
        const lines = pool.map((c, i) => {
            const tag = c.shortTag || '?';
            const snip = c.description.length > 70 ? c.description.slice(0, 67) + '…' : c.description;
            return `${i + 1}. [${c.kind === 'custom_emoji' ? 'E' : 'S'}] ${c.emojis[0] ?? '?'} ${tag} | ${snip}`;
        }).join('\n');

        const prompt =
            `Match each INTENT to up to 2 candidate indices from the LIST. Reply ONLY in the format:\n` +
            `intent: idx1, idx2\n` +
            `intent: idx1\n` +
            `(no header, no explanation, lowercase intent, comma-separated indices, one intent per line. ` +
            `If no candidate fits an intent, write "intent: -")\n\n` +
            `INTENTS:\n${intents.map((it, i) => `${i + 1}. ${it}`).join('\n')}\n\n` +
            `LIST:\n${lines}`;

        try {
            const resp = await lookupClient.chat.completions.create({
                model: lookupModel,
                messages: [{role: 'user', content: prompt}],
                max_tokens: Math.max(50, intents.length * 25),
            });
            recordLookupUsage(resp, 'suggest_expressions', args.userId);
            const raw = resp.choices[0]?.message?.content?.trim() ?? '';

            const out: Record<string, Array<{cache_key: string; kind: string; emoji: string; short_tag: string; snippet: string}>> = {};
            const lineRe = /^([^:\n]+):\s*(.+)$/gm;
            let m: RegExpExecArray | null;
            while ((m = lineRe.exec(raw)) !== null) {
                // Strip leading "1. " / "1) " / "- " / "* " — Haiku occasionally adds list
                // prefixes despite the prompt saying "no header". Without this the intent
                // exact-match below silently misses and the caller sees an empty array.
                const intentLabel = m[1].trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '');
                const matchedIntent = intents.find(it => it.toLowerCase() === intentLabel.toLowerCase());
                if (!matchedIntent) continue;
                const idxList = m[2]
                    .split(',')
                    .map(s => parseInt(s.trim(), 10))
                    .filter(n => Number.isFinite(n) && n >= 1 && n <= pool.length);
                out[matchedIntent] = idxList.slice(0, 2).map(i => {
                    const c = pool[i - 1];
                    return {
                        cache_key: c.cacheKey,
                        kind: c.kind,
                        emoji: c.emojis[0] ?? '?',
                        short_tag: c.shortTag,
                        snippet: c.description.slice(0, 80),
                    };
                });
            }
            // Fill any intents the model omitted with empty arrays so AI sees explicit no-match.
            for (const it of intents) if (!(it in out)) out[it] = [];
            return {success: true, source: 'haiku_ranker', considered: pool.length, suggestions: out};
        } catch (err) {
            console.warn('[SuggestExpressions] Haiku call failed, falling back to text-LIKE:', err instanceof Error ? err.message : err);
            return {success: true, source: 'text_fallback', error: err instanceof Error ? err.message : String(err), suggestions: fallback()};
        }
    },
};

export const SendStickerToUser: Tool = {
    name: 'SendStickerToUser',
    description:
        "Send a cached sticker as part of your reaction (instead of, or alongside, a text reply). " +
        "Pass a vibe phrase describing the mood / content you want (e.g. 'wolf laughing', 'agreement', 'tired', 'heart love'). " +
        "A cheap lookup model (Haiku) ranks the cached descriptions by semantic match to your vibe and picks the best one — better than keyword matching. " +
        "If nothing in the cache fits the vibe, returns success=false with no_match=true — fall back to a normal text reply, do NOT pretend you sent something. " +
        "Cache only contains stickers users have sent the bot before, so the available repertoire grows organically.",
    parameters: {
        type: 'object',
        properties: {
            vibe_query: {
                type: 'string',
                description: "Free-text description of the mood or content (e.g. 'laughing wolf', 'sad cat', 'celebration', 'thumbs up'). The picker model matches by meaning, so vivid phrases work better than single keywords.",
            },
            emoji: {
                type: 'string',
                description: "Optional: only consider stickers associated with this emoji (e.g. '😂'). Useful when vibe_query alone is too broad.",
            },
            kind: {
                type: 'string',
                enum: ['sticker', 'animated_sticker', 'video_sticker', 'custom_emoji'],
                description: "Optional: restrict to a sticker kind. Use 'custom_emoji' when you want a small inline reaction; 'sticker'/'animated_sticker'/'video_sticker' for full stickers.",
            },
        },
        required: ['vibe_query'],
    },
    execute: async (args: {userId: number; vibe_query: string; emoji?: string; kind?: string}) => {
        if (!botInstance) {
            return {success: false, message: 'SendStickerToUser: bot instance not initialized'};
        }
        const query = args.vibe_query?.trim();
        if (!query) {
            return {success: false, message: 'vibe_query is empty'};
        }
        const kind = isStickerKind(args.kind) ? args.kind : undefined;

        // Pull a BROAD candidate pool. The Haiku ranker handles semantic match;
        // SQL just narrows to plausible options + recency. Three passes with widening:
        //   1) substring match on description (cheap, often hits)
        //   2) substring match on emoji list — only if AI explicitly passed an emoji filter
        //      (using the vibe_query as an emoji substring is nonsense — emojis are JSON like ["😴"])
        //   3) full kind/emoji slice (no description filter) — gives ranker the room to be smart
        const PRE_LIMIT = 30;
        const seen = new Map<string, StickerCacheEntry>();
        const collect = (rows: StickerCacheEntry[]) => {
            for (const r of rows) if (r.fileId && !seen.has(r.cacheKey)) seen.set(r.cacheKey, r);
        };
        collect(findStickerCacheEntries({descriptionContains: query, emojiContains: args.emoji, kind, limit: PRE_LIMIT}));
        if (seen.size < 5 && args.emoji) {
            collect(findStickerCacheEntries({emojiContains: args.emoji, kind, limit: PRE_LIMIT}));
        }
        if (seen.size < 5) {
            collect(findStickerCacheEntries({kind, limit: PRE_LIMIT}));
        }

        const candidates = Array.from(seen.values());
        if (candidates.length === 0) {
            return {
                success: false,
                no_match: true,
                vibe_query: query,
                message: `No cached sticker available${kind ? ` of kind ${kind}` : ''}${args.emoji ? ` for emoji ${args.emoji}` : ''}. Reply with text instead.`,
            };
        }

        const pick = await pickStickerByVibe(query, candidates, args.userId);
        if (!pick) {
            return {
                success: false,
                no_match: true,
                vibe_query: query,
                considered: candidates.length,
                message: `Lookup model couldn't find a good sticker match for "${query}" among ${candidates.length} candidates. Reply with text instead.`,
            };
        }

        const user = await getUser(args.userId);
        if (!user?.chatId) {
            return {success: false, message: 'User chat_id unknown; cannot send sticker.'};
        }
        try {
            const sent = await botInstance.sendSticker(user.chatId, pick.fileId!);
            return {
                success: true,
                cache_key: pick.cacheKey,
                kind: pick.kind,
                emojis: pick.emojis,
                description: pick.description,
                sent_message_id: sent.message_id,
                considered: candidates.length,
            };
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            // Telegram rejects stale/invalid file_ids with messages like "wrong file_id" or
            // "wrong type of the web page content". Null the file_id so this entry stops being
            // a SendStickerToUser candidate; parseSticker / parseCustomEmoji will re-populate
            // it next time the user sends the same sticker (sticker.file_id is fresh per send).
            if (/file_id|wrong type|invalid/i.test(errMsg)) {
                refreshStickerCacheFileId(pick.cacheKey, null);
                console.warn(`[SendStickerToUser] cleared stale file_id for ${pick.cacheKey}: ${errMsg}`);
            }
            return {
                success: false,
                message: `Failed to send sticker: ${errMsg}`,
            };
        }
    },
};

export const EchoStickerToUser: Tool = {
    name: 'EchoStickerToUser',
    description:
        "Send a cached sticker back to the user as a visual confirmation. " +
        "Use to disambiguate before calling UpdateStickerCache when the user's reference is unclear (e.g. \"this one?\" before applying their correction). " +
        "Only works for entries with a stored file_id (most sticker entries; some old custom emojis may not have one).",
    parameters: {
        type: 'object',
        properties: {
            cache_key: {
                type: 'string',
                description: 'The cache_key of the sticker to send back.',
            },
        },
        required: ['cache_key'],
    },
    execute: async (args: {userId: number; cache_key: string}) => {
        if (!botInstance) {
            return {success: false, message: 'EchoStickerToUser: bot instance not initialized'};
        }
        const entry = getStickerCacheEntry(args.cache_key);
        if (!entry) {
            return {success: false, message: `No cache entry for cache_key="${args.cache_key}".`};
        }
        if (!entry.fileId) {
            return {
                success: false,
                message: `Cache entry "${args.cache_key}" has no stored file_id, so it can't be sent back. Describe it in text instead.`,
            };
        }
        const user = await getUser(args.userId);
        if (!user?.chatId) {
            return {success: false, message: 'User chat_id unknown; cannot send sticker.'};
        }
        try {
            const sent = await botInstance.sendSticker(user.chatId, entry.fileId);
            return {
                success: true,
                cache_key: args.cache_key,
                sent_message_id: sent.message_id,
            };
        } catch (err) {
            return {
                success: false,
                message: `Failed to send sticker: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    },
};
