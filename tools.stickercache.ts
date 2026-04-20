import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import {Tool} from './tool.types';
import {
    getStickerCacheEntry,
    upsertStickerCacheEntry,
    deleteStickerCacheEntry,
    findStickerCacheEntries,
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
 * Returns the chosen entry, or candidates[0] on any error so the caller still sends *something*. */
async function pickStickerByVibe(vibe_query: string, candidates: StickerCacheEntry[]): Promise<StickerCacheEntry> {
    if (candidates.length <= 1 || !lookupClient) return candidates[0];

    const numbered = candidates.map((c, i) => {
        const emojis = c.emojis.length > 0 ? ` [${c.emojis.join(' ')}]` : '';
        const desc = c.description.length > 220 ? c.description.slice(0, 217) + '...' : c.description;
        return `${i + 1}.${emojis} ${desc}`;
    }).join('\n');

    const prompt =
        `Pick the single best sticker for vibe "${vibe_query}" from this numbered list. ` +
        `Match by visual content / emotion / character — not just keyword overlap. ` +
        `If nothing fits well, still pick the closest. ` +
        `Reply with ONLY the integer index (1-${candidates.length}), no other text.\n\n${numbered}`;

    try {
        const resp = await lookupClient.chat.completions.create({
            model: lookupModel,
            messages: [{role: 'user', content: prompt}],
            max_tokens: 10,
        });
        const raw = resp.choices[0]?.message?.content?.trim() ?? '';
        const idx = parseInt(raw.match(/\d+/)?.[0] ?? '', 10);
        if (Number.isFinite(idx) && idx >= 1 && idx <= candidates.length) {
            return candidates[idx - 1];
        }
    } catch (err) {
        console.warn('[stickerPicker] lookup model failed, falling back to first candidate:', err instanceof Error ? err.message : err);
    }
    return candidates[0];
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
        //   2) substring match on emoji list
        //   3) full kind/emoji slice (no description filter) — gives ranker the room to be smart
        const PRE_LIMIT = 30;
        const seen = new Map<string, StickerCacheEntry>();
        const collect = (rows: StickerCacheEntry[]) => {
            for (const r of rows) if (r.fileId && !seen.has(r.cacheKey)) seen.set(r.cacheKey, r);
        };
        collect(findStickerCacheEntries({descriptionContains: query, emojiContains: args.emoji, kind, limit: PRE_LIMIT}));
        if (seen.size < 5) {
            collect(findStickerCacheEntries({emojiContains: args.emoji ?? query, kind, limit: PRE_LIMIT}));
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

        const pick = await pickStickerByVibe(query, candidates);

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
            return {
                success: false,
                message: `Failed to send sticker: ${err instanceof Error ? err.message : String(err)}`,
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
