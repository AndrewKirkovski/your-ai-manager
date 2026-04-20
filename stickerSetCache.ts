/**
 * Sticker set cache — wraps bot.getStickerSet() with a 24h kv_cache TTL.
 *
 * The same visual (file_unique_id) can appear in a pack under multiple emoji
 * shortcuts. The incoming `msg.sticker.emoji` is only what the *sender* chose;
 * to discover the full emoji mapping we must fetch the whole pack and filter.
 *
 * Pack contents change rarely, so 24h TTL is safe. In-memory layer avoids
 * hitting SQLite on every sticker.
 */

import type TelegramBot from 'node-telegram-bot-api';
import db from './database';

const STICKER_SET_TTL_MS = 24 * 60 * 60 * 1000;

const stmts = {
    get: db.prepare<[string, number], { value: string }>('SELECT value FROM kv_cache WHERE key = ? AND expires_at > ?'),
    set: db.prepare('INSERT OR REPLACE INTO kv_cache (key, value, expires_at) VALUES (?, ?, ?)'),
};

const memoryCache = new Map<string, { set: TelegramBot.StickerSet; expiresAt: number }>();

function cacheKey(setName: string): string {
    return `stickerset:${setName.toLowerCase()}`;
}

export async function getStickerSetCached(
    bot: TelegramBot,
    setName: string,
): Promise<TelegramBot.StickerSet | undefined> {
    const now = Date.now();
    const memHit = memoryCache.get(setName);
    if (memHit && memHit.expiresAt > now) return memHit.set;

    const dbRow = stmts.get.get(cacheKey(setName), now);
    if (dbRow) {
        try {
            const parsed = JSON.parse(dbRow.value) as TelegramBot.StickerSet;
            memoryCache.set(setName, { set: parsed, expiresAt: now + STICKER_SET_TTL_MS });
            return parsed;
        } catch {
            // fall through to fetch
        }
    }

    try {
        const set = await bot.getStickerSet(setName);
        const expiresAt = now + STICKER_SET_TTL_MS;
        memoryCache.set(setName, { set, expiresAt });
        stmts.set.run(cacheKey(setName), JSON.stringify(set), expiresAt);
        return set;
    } catch (err) {
        console.warn(`[stickerSetCache] failed to fetch set "${setName}":`, err instanceof Error ? err.message : err);
        return undefined;
    }
}

/**
 * Returns all emojis that map to this specific visual (file_unique_id) inside its pack.
 * Falls back to [senderEmoji] if the pack lookup fails or the sticker isn't found.
 */
export async function gatherAllPackEmojis(
    bot: TelegramBot,
    setName: string | undefined,
    fileUniqueId: string,
    senderEmoji: string | undefined,
): Promise<string[]> {
    const fallback = senderEmoji ? [senderEmoji] : [];
    if (!setName) return fallback;

    const set = await getStickerSetCached(bot, setName);
    if (!set) return fallback;

    const emojis: string[] = [];
    const seen = new Set<string>();
    for (const s of set.stickers) {
        if (s.file_unique_id === fileUniqueId && s.emoji && !seen.has(s.emoji)) {
            seen.add(s.emoji);
            emojis.push(s.emoji);
        }
    }

    if (emojis.length === 0) return fallback;
    if (senderEmoji && !seen.has(senderEmoji)) emojis.unshift(senderEmoji);
    return emojis;
}
