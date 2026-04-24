import TelegramBot, { Message, Voice, PhotoSize, Sticker } from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { createReadStream } from 'fs';
import {
    getStickerCacheEntry,
    upsertStickerCacheEntry,
    refreshStickerCacheFileId,
    bumpStickerUsedCount,
    recordAITokens,
    type StickerCacheKind,
} from './userStore';
import { gatherAllPackEmojis } from './stickerSetCache';
import { extractFramesFromWebm, stitchFramesHorizontal } from './stickerFrames';
import { renderTgsFrames } from './tgsRenderer';
import sharp from 'sharp';

// ============== TYPE DEFINITIONS ==============

export type MediaType = 'voice' | 'photo' | 'sticker' | 'location' | 'text' | 'unsupported';

export interface ParsedMedia {
    type: MediaType;
    content: string;           // Transcribed text or description
    originalType: string;      // e.g., 'voice', 'photo', 'sticker'
    metadata?: {
        duration?: number;     // For voice messages
        emoji?: string;        // For stickers — what the *sender* picked
        emojis?: string[];     // For stickers — full pack-associated emoji list
        setName?: string;      // For stickers
        fileSize?: number;
        fileId?: string;       // Telegram file_id for re-downloading
        cacheKey?: string;     // For stickers / custom emojis — file_unique_id or custom_emoji_id
        stickerKind?: StickerCacheKind;
        cacheHit?: boolean;    // True if description came from sticker_cache
        mimeType?: string;
        // Location metadata
        latitude?: number;
        longitude?: number;
        horizontalAccuracy?: number;
        livePeriod?: number;   // For live location sharing
        heading?: number;      // Direction of travel
    };
    error?: string;            // If parsing failed
}

export interface MediaParserConfig {
    bot: TelegramBot;
    openaiWhisper: OpenAI | null;  // OpenAI client for Whisper (null if not configured)
    anthropic: OpenAI;              // Anthropic client (OpenAI-compatible) for vision
    visionModel: string;            // e.g., 'claude-sonnet-4-20250514' — used for ALL vision (photos + stickers + custom emojis)
    whisperModel?: string;          // Default: 'whisper-1'
    language?: string;              // Default: 'ru' for transcription
    maxImageTokens?: number;        // Default: 300
    maxStickerTokens?: number;      // Default: 200
}

// ============== STICKER DESCRIPTION PROMPTS + CLEANUP ==============

/** Strict prompt for static-sticker Vision analysis. Optimized for compact output:
 * no preamble, no markdown headers, no "this sticker" filler, no emoji name echoes.
 * Now also asks for a TAG: line — a 3-6 word hyphenated semantic phrase used in the
 * compact "vocabulary" prompt block the AI sees on every request. */
const STICKER_DESCRIPTION_PROMPT =
    'Describe the sticker in 2-3 sentences of plain prose, then on a NEW LINE provide a TAG.\n' +
    'STRICT FORMAT RULES — violating any of these wastes tokens in our cache:\n' +
    '1. NO preamble. Do NOT start with "The sticker", "This sticker", "Sticker", "Image", "I see", or any meta-reference. Start directly with the visual description (e.g. "Anthropomorphic gray wolf with...").\n' +
    '2. NO markdown headers, NO "##", NO "Sticker Analysis" titles, NO bullet lists. Plain prose only.\n' +
    '3. NO mention of the associated emoji char or pack name — those are tracked separately.\n' +
    '4. NO meta-phrases like "Senders typically use this to" or "essentially a stylized X" — just say what the meaning IS.\n' +
    '5. END with a separate line in EXACTLY this format: "TAG: hyphenated-3-to-6-word-semantic-phrase". The tag should be the most distinctive descriptor (e.g. "wolf-laughing-maniac", "tsuki-heart-floats-love", "pepe-shocked-pogchamp"). Lowercase. Use - between words.\n' +
    'WHAT to include in the prose: the character/subject, expression/pose, emotional tone, and what feeling/message the sender conveys. ' +
    'WHEN named characters are recognizable (e.g. "Pepe the Frog", a known anime character), use **bold** ONLY for the proper noun. Otherwise no markdown.';

/** Animated variant — same rules, plus describe motion across frames. */
const ANIMATED_DESCRIPTION_PROMPT =
    'Describe what happens across the frames in 3-4 sentences of plain prose, then on a NEW LINE provide a TAG.\n' +
    'STRICT FORMAT RULES:\n' +
    '1. NO preamble. Do NOT start with "The sticker", "Across the frames", "This animation". Start with the subject (e.g. "Anthropomorphic wolf gradually...").\n' +
    '2. NO markdown headers, NO "##", NO bullet lists. Plain prose only.\n' +
    '3. NO mention of the associated emoji char or pack name.\n' +
    '4. NO meta-phrases like "Senders typically use this sticker to" — state the meaning directly.\n' +
    '5. END with a separate line: "TAG: hyphenated-3-to-6-word-semantic-phrase" (lowercase, dash-separated). Capture the motion + emotion concisely.\n' +
    'WHAT to include in the prose: subject, motion/expression change across frames, what feeling/message the animation conveys. ' +
    'WHEN named characters are recognizable, **bold** the proper noun. Otherwise no markdown.';

export type ParsedDescription = { description: string; shortTag: string };

/** Split Vision output into prose description + short TAG. Defense-in-depth strip
 * for known boilerplate. Idempotent. Falls back to deriving a tag from the description
 * if Vision forgot to emit a TAG: line. */
export function parseStickerDescription(text: string): ParsedDescription {
    let raw = text.trim();
    let shortTag = '';

    // Pull TAG: line if present — usually the last line.
    const tagMatch = raw.match(/^TAG\s*:\s*([^\n]+)$/im);
    if (tagMatch) {
        shortTag = tagMatch[1].trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 60);
        raw = raw.replace(tagMatch[0], '').trim();
    }

    let s = raw;
    s = s.replace(/^#{1,6}\s+[^\n]*\n+/, '');
    s = s.replace(/^(?:\*\*)?(?:The|This)\s+(?:sticker|image|emoji|animation|gif)(?:\*\*)?\s+(?:features?|depicts?|shows?|displays?|presents?|portrays?|is)\s+(?:a|an)?\s*/i, '');
    s = s.replace(/^Across the frames,?\s+/i, '');
    if (s.length > 0) s = s[0].toUpperCase() + s.slice(1);

    // Fallback tag if Vision didn't emit one: take first 4 words of cleaned description.
    if (!shortTag && s.length > 0) {
        shortTag = s
            .replace(/\*\*/g, '')
            .toLowerCase()
            .split(/[\s,.;:—-]+/)
            .filter(Boolean)
            .slice(0, 4)
            .join('-')
            .replace(/[^a-z0-9-]/g, '')
            .slice(0, 60);
    }

    return { description: s, shortTag };
}

// Legacy back-compat for any caller still importing cleanStickerDescription.
function cleanStickerDescription(text: string): string {
    return parseStickerDescription(text).description;
}

// Test surface for unit testing — not exported via index, but accessible via direct import.
export const __TEST_ONLY__ = { cleanStickerDescription, parseStickerDescription };

/** Record token usage from a Vision response. Attributed to the user whose
 * incoming message triggered the analysis. recordAITokens double-writes to
 * the user AND user_id=0 (denormalized global). Fire-and-forget. */
function recordVisionUsage(response: { usage?: { prompt_tokens?: number; completion_tokens?: number } }, purpose: string, userId: number): void {
    const u = response.usage;
    if (!u) return;
    void recordAITokens(userId, u.prompt_tokens ?? 0, u.completion_tokens ?? 0, purpose);
}

// ============== MAIN CLASS ==============

export class MediaParser {
    private bot: TelegramBot;
    private openaiWhisper: OpenAI | null;
    private anthropic: OpenAI;
    private visionModel: string;
    private whisperModel: string;
    private language: string;
    private maxImageTokens: number;
    private maxStickerTokens: number;

    constructor(config: MediaParserConfig) {
        this.bot = config.bot;
        this.openaiWhisper = config.openaiWhisper;
        this.anthropic = config.anthropic;
        this.visionModel = config.visionModel;
        this.whisperModel = config.whisperModel || 'whisper-1';
        this.language = config.language || 'ru';
        this.maxImageTokens = config.maxImageTokens || 300;
        this.maxStickerTokens = config.maxStickerTokens || 200;
    }

    // ============== MEDIA TYPE DETECTION ==============

    /**
     * Detect the type of media in a Telegram message
     */
    detectMediaType(msg: Message): MediaType {
        if (msg.voice) return 'voice';
        if (msg.photo && msg.photo.length > 0) return 'photo';
        if (msg.sticker) return 'sticker';
        if (msg.location) return 'location';
        if (msg.text) return 'text';
        return 'unsupported';
    }

    /**
     * Check if message contains parseable media
     */
    hasParseableMedia(msg: Message): boolean {
        const type = this.detectMediaType(msg);
        return type !== 'text' && type !== 'unsupported';
    }

    // ============== MAIN PARSING ENTRY POINT ==============

    /**
     * Parse any supported media type from a message
     * Returns formatted content ready for AI conversation
     */
    async parseMedia(msg: Message, userId: number): Promise<ParsedMedia> {
        const mediaType = this.detectMediaType(msg);

        try {
            switch (mediaType) {
                case 'voice':
                    return await this.parseVoiceMessage(msg.voice!);
                case 'photo':
                    return await this.parsePhoto(msg.photo!, msg.caption, userId);
                case 'sticker':
                    return await this.parseSticker(msg.sticker!, userId);
                case 'location':
                    return this.parseLocation(msg.location!);
                case 'text':
                    return {
                        type: 'text',
                        content: msg.text || '',
                        originalType: 'text'
                    };
                default:
                    return {
                        type: 'unsupported',
                        content: '',
                        originalType: 'unknown',
                        error: 'Unsupported media type'
                    };
            }
        } catch (error) {
            console.error('Media parsing error:', {
                mediaType,
                error: error instanceof Error ? error.message : String(error)
            });
            return {
                type: mediaType,
                content: '',
                originalType: mediaType,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    // ============== VOICE MESSAGE PARSING ==============

    /**
     * Download and transcribe voice message using OpenAI Whisper
     */
    async parseVoiceMessage(voice: Voice): Promise<ParsedMedia> {
        // Check if Whisper client is configured
        if (!this.openaiWhisper) {
            return {
                type: 'voice',
                content: '[Voice message received but transcription is not configured]',
                originalType: 'voice',
                metadata: { duration: voice.duration },
                error: 'Whisper API not configured (OPENAI_WHISPER_API_KEY missing)'
            };
        }

        const tempFilePath = join(tmpdir(), `voice_${Date.now()}_${voice.file_id.slice(0, 8)}.ogg`);

        try {
            // Step 1: Download voice file from Telegram
            const fileStream = this.bot.getFileStream(voice.file_id);
            const chunks: Buffer[] = [];

            for await (const chunk of fileStream) {
                chunks.push(chunk as Buffer);
            }
            const audioBuffer = Buffer.concat(chunks);

            // Check file size (Whisper limit is 25MB)
            if (audioBuffer.length > 25 * 1024 * 1024) {
                return {
                    type: 'voice',
                    content: '[Voice message too large to transcribe]',
                    originalType: 'voice',
                    metadata: { duration: voice.duration, fileSize: audioBuffer.length },
                    error: 'Voice message exceeds 25MB limit'
                };
            }

            // Step 2: Write to temp file (required by OpenAI SDK)
            await writeFile(tempFilePath, audioBuffer);

            // Step 3: Transcribe with Whisper
            const transcription = await this.openaiWhisper.audio.transcriptions.create({
                file: createReadStream(tempFilePath),
                model: this.whisperModel,
                language: this.language,
            });

            return {
                type: 'voice',
                content: transcription.text,
                originalType: 'voice',
                metadata: {
                    duration: voice.duration,
                    fileSize: voice.file_size,
                    mimeType: voice.mime_type || 'audio/ogg'
                }
            };
        } catch (error) {
            console.error('Voice parsing failed:', {
                error: error instanceof Error ? error.message : String(error),
                voiceFileId: voice.file_id.slice(0, 10) + '...',
                duration: voice.duration
            });

            return {
                type: 'voice',
                content: '[Voice message could not be transcribed]',
                originalType: 'voice',
                metadata: { duration: voice.duration },
                error: error instanceof Error ? error.message : 'Unknown transcription error'
            };
        } finally {
            // Always cleanup temp file
            try {
                await unlink(tempFilePath);
            } catch {
                // Ignore cleanup errors
            }
        }
    }

    // ============== PHOTO PARSING ==============

    /**
     * Download and analyze photo using Claude Vision.
     * If caption is provided, uses it to focus the analysis.
     */
    async parsePhoto(photos: PhotoSize[], caption: string | undefined, userId: number): Promise<ParsedMedia> {
        try {
            // Get highest resolution photo (last in array)
            const bestPhoto = photos[photos.length - 1];

            // Step 1: Download photo from Telegram
            const imageBuffer = await this.downloadFile(bestPhoto.file_id);

            // Step 2: Convert to base64 for Vision API
            const base64Image = imageBuffer.toString('base64');

            // Step 3: Build prompt — caption-aware if provided
            const prompt = caption
                ? `The user sent this photo with the message: "${caption}". ` +
                  'Analyze the image with that context in mind. Describe what you see, focusing on what\'s relevant to the user\'s message. ' +
                  'Include any text visible in the image.'
                : 'Describe this image in detail. Include any text visible in the image. ' +
                  'If it appears to be a screenshot, describe what application or content is shown. ' +
                  'Be concise but thorough.';

            // Step 4: Analyze with Claude Vision
            const description = await this.analyzeImageBase64(base64Image, prompt, userId, 500, 'vision_photo');

            return {
                type: 'photo',
                content: description,
                originalType: 'photo',
                metadata: {
                    fileSize: bestPhoto.file_size,
                    fileId: bestPhoto.file_id,
                }
            };
        } catch (error) {
            console.error('Photo parsing failed:', {
                error: error instanceof Error ? error.message : String(error)
            });

            return {
                type: 'photo',
                content: '[Image could not be analyzed]',
                originalType: 'photo',
                error: error instanceof Error ? error.message : 'Unknown vision error'
            };
        }
    }

    // ============== SHARED HELPERS ==============

    /**
     * Download a file from Telegram by file_id, return as Buffer.
     */
    private async downloadFile(fileId: string): Promise<Buffer> {
        const fileStream = this.bot.getFileStream(fileId);
        const chunks: Buffer[] = [];
        for await (const chunk of fileStream) {
            chunks.push(chunk as Buffer);
        }
        return Buffer.concat(chunks);
    }

    /**
     * Send a base64 image to Claude Vision with a custom prompt.
     * Records token usage as a system stat (user_id=0) tagged with the supplied purpose.
     */
    private async analyzeImageBase64(base64: string, prompt: string, userId: number, maxTokens?: number, purpose: string = 'vision_photo'): Promise<string> {
        const imageUrl = `data:image/jpeg;base64,${base64}`;
        const response = await this.anthropic.chat.completions.create({
            model: this.visionModel,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: imageUrl } }
                ]
            }],
            max_tokens: maxTokens ?? this.maxImageTokens
        });
        recordVisionUsage(response, purpose, userId);
        return response.choices[0]?.message?.content || 'Unable to analyze image';
    }

    /**
     * Re-analyze a previously sent image by Telegram file_id with a custom prompt.
     * Used by the AnalyzeImage tool for follow-up analysis.
     */
    async analyzeImageByFileId(fileId: string, prompt: string, userId: number): Promise<string> {
        const imageBuffer = await this.downloadFile(fileId);
        const base64 = imageBuffer.toString('base64');
        return this.analyzeImageBase64(base64, prompt, userId, 800, 'vision_photo_reanalyze');
    }

    // ============== STICKER PARSING ==============

    /**
     * Cache-aware sticker parser: dispatches to static / animated (.tgs) /
     * video (.webm) handlers, looks up file_unique_id in sticker_cache first,
     * gathers all pack-associated emojis, and stores the description on miss.
     */
    async parseSticker(sticker: Sticker, userId: number): Promise<ParsedMedia> {
        const cacheKey = sticker.file_unique_id;
        const kind: StickerCacheKind = sticker.is_video
            ? 'video_sticker'
            : sticker.is_animated
                ? 'animated_sticker'
                : 'sticker';

        // Cache hit — skip Vision entirely
        const cached = getStickerCacheEntry(cacheKey);
        if (cached) {
            // Self-heal: Telegram file_ids occasionally rotate. Refresh on every cache hit
            // so SendStickerById/SendStickerToUser picks a sendable id next time.
            if (cached.fileId !== sticker.file_id) {
                refreshStickerCacheFileId(cacheKey, sticker.file_id);
            }
            // User-send is a usage signal — boosts ranking in the system-prompt vocabulary.
            // Wrap in try so a transient DB lock doesn't crash the parse path.
            try { bumpStickerUsedCount(cacheKey); }
            catch (err) { console.warn('[mediaParser] bumpStickerUsedCount failed:', err instanceof Error ? err.message : err); }
            return {
                type: 'sticker',
                content: cached.description,
                originalType: cached.kind,
                metadata: {
                    emoji: sticker.emoji,
                    emojis: cached.emojis,
                    setName: cached.setName,
                    fileSize: sticker.file_size,
                    fileId: sticker.file_id,
                    cacheKey,
                    stickerKind: cached.kind,
                    cacheHit: true,
                },
            };
        }

        // Cache miss — gather full emoji list from the pack (best-effort)
        const allEmojis = await gatherAllPackEmojis(this.bot, sticker.set_name, cacheKey, sticker.emoji);

        try {
            const rawDescription = await this.analyzeStickerByKind(sticker, kind, allEmojis, userId);
            const { description, shortTag } = parseStickerDescription(rawDescription);
            upsertStickerCacheEntry({
                cacheKey,
                kind,
                emojis: allEmojis,
                setName: sticker.set_name,
                description,
                shortTag,
                fileId: sticker.file_id,
            });
            return {
                type: 'sticker',
                content: description,
                originalType: kind,
                metadata: {
                    emoji: sticker.emoji,
                    emojis: allEmojis,
                    setName: sticker.set_name,
                    fileSize: sticker.file_size,
                    fileId: sticker.file_id,
                    cacheKey,
                    stickerKind: kind,
                    cacheHit: false,
                },
            };
        } catch (error) {
            console.error('Sticker parsing failed:', {
                error: error instanceof Error ? error.message : String(error),
                kind,
                emoji: sticker.emoji,
                setName: sticker.set_name,
                cacheKey,
            });
            const emojiHint = allEmojis.length > 0 ? ` (${allEmojis.join(' ')})` : '';
            return {
                type: 'sticker',
                content: `User sent a ${kind}${emojiHint}`,
                originalType: kind,
                metadata: {
                    emoji: sticker.emoji,
                    emojis: allEmojis,
                    setName: sticker.set_name,
                    fileId: sticker.file_id,
                    cacheKey,
                    stickerKind: kind,
                },
                error: error instanceof Error ? error.message : 'Unknown sticker error',
            };
        }
    }

    /**
     * Analyze a custom (premium) emoji by its custom_emoji_id. Looks up the
     * sticker_cache; on miss, fetches the underlying sticker via
     * bot.getCustomEmojiStickers and runs Vision on it.
     */
    async parseCustomEmoji(customEmojiId: string, fallbackChar: string | undefined, userId: number): Promise<ParsedMedia> {
        const cached = getStickerCacheEntry(customEmojiId);
        if (cached) {
            try { bumpStickerUsedCount(customEmojiId); }
            catch (err) { console.warn('[mediaParser] bumpStickerUsedCount failed:', err instanceof Error ? err.message : err); }
            let fileId = cached.fileId;
            // Lazy re-fetch: if file_id was previously nulled (Telegram rejected an old id during
            // SendStickerToUser), try once to recover via the free Bot API call. Cheap, no Vision cost.
            if (!fileId) {
                try {
                    const fresh = (await this.bot.getCustomEmojiStickers([customEmojiId]))?.[0];
                    if (fresh?.file_id) {
                        fileId = fresh.file_id;
                        refreshStickerCacheFileId(customEmojiId, fileId);
                    }
                } catch {
                    // ignore; description still serves the AI even without a sendable id
                }
            }
            return {
                type: 'sticker',
                content: cached.description,
                originalType: 'custom_emoji',
                metadata: {
                    emoji: fallbackChar,
                    emojis: cached.emojis,
                    setName: cached.setName,
                    fileId,
                    cacheKey: customEmojiId,
                    stickerKind: 'custom_emoji',
                    cacheHit: true,
                },
            };
        }

        try {
            const stickers = await this.bot.getCustomEmojiStickers([customEmojiId]);
            const sticker = stickers?.[0];
            if (!sticker) {
                throw new Error(`getCustomEmojiStickers returned no sticker for ${customEmojiId}`);
            }
            const charForList = sticker.emoji || fallbackChar;
            const emojis = charForList ? [charForList] : [];
            const kind: StickerCacheKind = sticker.is_video
                ? 'video_sticker'
                : sticker.is_animated
                    ? 'animated_sticker'
                    : 'custom_emoji';

            const rawDescription = await this.analyzeStickerByKind(sticker, kind === 'custom_emoji' ? 'sticker' : kind, emojis, userId);
            const { description, shortTag } = parseStickerDescription(rawDescription);
            upsertStickerCacheEntry({
                cacheKey: customEmojiId,
                kind: 'custom_emoji',
                emojis,
                setName: sticker.set_name,
                description,
                shortTag,
                fileId: sticker.file_id,
            });
            return {
                type: 'sticker',
                content: description,
                originalType: 'custom_emoji',
                metadata: {
                    emoji: fallbackChar,
                    emojis,
                    setName: sticker.set_name,
                    fileId: sticker.file_id,
                    cacheKey: customEmojiId,
                    stickerKind: 'custom_emoji',
                    cacheHit: false,
                },
            };
        } catch (error) {
            console.error('Custom emoji parsing failed:', {
                error: error instanceof Error ? error.message : String(error),
                customEmojiId,
            });
            const fallbackDesc = fallbackChar
                ? `Custom emoji rendering of ${fallbackChar} (analysis unavailable)`
                : 'Custom emoji (analysis unavailable)';
            return {
                type: 'sticker',
                content: fallbackDesc,
                originalType: 'custom_emoji',
                metadata: {
                    emoji: fallbackChar,
                    emojis: fallbackChar ? [fallbackChar] : [],
                    cacheKey: customEmojiId,
                    stickerKind: 'custom_emoji',
                },
                error: error instanceof Error ? error.message : 'Unknown custom emoji error',
            };
        }
    }

    /**
     * Dispatch by sticker kind. Returns the Vision-generated description string.
     * Throws on unrecoverable error (caller: parseSticker / parseCustomEmoji have
     * their own outer try/catch that produces a fallback ParsedMedia with error set).
     *
     * For animated/video kinds: if frame extraction fails (short clips, codec quirks,
     * TGS render errors), falls back to analyzing the Telegram-provided thumbnail —
     * worse than an animated strip but far better than "[analysis unavailable]".
     */
    private async analyzeStickerByKind(sticker: Sticker, kind: StickerCacheKind, emojis: string[], userId: number): Promise<string> {
        const buffer = await this.downloadFile(sticker.file_id);
        if (kind === 'video_sticker') {
            try {
                const frames = await extractFramesFromWebm(buffer, 5);
                return this.analyzeFramesOrStatic(frames, sticker, emojis, 'video', userId);
            } catch (err) {
                console.warn(`[mediaParser] video frame extraction failed for ${sticker.file_unique_id}, falling back to thumbnail:`, err instanceof Error ? err.message : err);
                return this.analyzeFromThumbnail(sticker, emojis, 'video', userId);
            }
        }
        if (kind === 'animated_sticker') {
            try {
                const frames = await renderTgsFrames(buffer, 5);
                return this.analyzeFramesOrStatic(frames, sticker, emojis, 'lottie', userId);
            } catch (err) {
                console.warn(`[mediaParser] TGS render failed for ${sticker.file_unique_id}, falling back to thumbnail:`, err instanceof Error ? err.message : err);
                return this.analyzeFromThumbnail(sticker, emojis, 'lottie', userId);
            }
        }
        // static .webp
        return this.analyzeStaticSticker(buffer, sticker, emojis, userId);
    }

    /** Route extracted frames to animated-strip or static analysis based on count.
     * Handles the common cases: source has <5 distinct frames, or is static-animated
     * (1 frame in a video container / 1-frame Lottie). Avoids wasting Vision tokens on
     * a 5-copies strip when 1 frame would do. */
    private async analyzeFramesOrStatic(frames: Buffer[], sticker: Sticker, emojis: string[], animKind: 'video' | 'lottie', userId: number): Promise<string> {
        if (frames.length === 0) {
            throw new Error(`no frames extracted from ${animKind} sticker`);
        }
        if (frames.length === 1) {
            // Source is effectively static — no motion to observe, skip the animated-strip prompt.
            return this.analyzeStaticSticker(frames[0], sticker, emojis, userId);
        }
        const strip = await stitchFramesHorizontal(frames);
        return this.analyzeAnimatedStrip(strip, sticker, emojis, animKind === 'video', userId);
    }

    /** Fallback path when we can't render frames: use the static thumbnail Telegram
     * ships with every animated/video sticker. Loses motion information but preserves
     * character/visual identity, which is what the AI mostly needs. */
    private async analyzeFromThumbnail(sticker: Sticker, emojis: string[], animKind: 'video' | 'lottie', userId: number): Promise<string> {
        const thumbId = sticker.thumbnail?.file_id;
        if (!thumbId) {
            throw new Error(`no thumbnail available for ${animKind} sticker ${sticker.file_unique_id}`);
        }
        const thumbBuf = await this.downloadFile(thumbId);
        const desc = await this.analyzeStaticSticker(thumbBuf, sticker, emojis, userId);
        return `[Static thumbnail only — ${animKind === 'video' ? 'video frame extraction failed' : 'Lottie render failed'}, animation not visible]\n${desc}`;
    }

    private async analyzeStaticSticker(rawBuf: Buffer, sticker: Sticker, emojis: string[], userId: number): Promise<string> {
        // Normalize to PNG before sending. Inputs vary (real .webp stickers, PNG/JPEG
        // thumbnails from the fallback path, single-frame extracts) and Anthropic Vision
        // sniffs the bytes — hardcoding image/webp as we used to caused 400 errors like
        // "specified using image/webp media type, but the image appears to be image/png".
        const pngBuf = await sharp(rawBuf).png().toBuffer();
        const stickerUrl = `data:image/png;base64,${pngBuf.toString('base64')}`;
        const ctxParts: string[] = [];
        if (emojis.length > 0) ctxParts.push(`Pack emojis: ${emojis.join(' ')}.`);
        if (sticker.set_name) ctxParts.push(`Pack: "${sticker.set_name}".`);
        const context = ctxParts.length > 0 ? ctxParts.join(' ') + ' ' : '';

        const response = await this.anthropic.chat.completions.create({
            model: this.visionModel,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: context + STICKER_DESCRIPTION_PROMPT,
                    },
                    { type: 'image_url', image_url: { url: stickerUrl } },
                ],
            }],
            max_tokens: this.maxStickerTokens,
        });
        recordVisionUsage(response, 'vision_sticker', userId);
        return response.choices[0]?.message?.content || 'Unable to analyze sticker';
    }

    private async analyzeAnimatedStrip(strip: Buffer, sticker: Sticker, emojis: string[], isVideo: boolean, userId: number): Promise<string> {
        const url = `data:image/png;base64,${strip.toString('base64')}`;
        const ctxParts: string[] = [];
        if (emojis.length > 0) ctxParts.push(`Pack emojis: ${emojis.join(' ')}.`);
        if (sticker.set_name) ctxParts.push(`Pack: "${sticker.set_name}".`);
        const context = ctxParts.length > 0 ? ctxParts.join(' ') + ' ' : '';
        const sourceLabel = isVideo ? 'animated (video)' : 'animated (Lottie)';

        const response = await this.anthropic.chat.completions.create({
            model: this.visionModel,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `5 frames (left → right, evenly spaced in time) from an ${sourceLabel} sticker. ` +
                            context + ANIMATED_DESCRIPTION_PROMPT,
                    },
                    { type: 'image_url', image_url: { url } },
                ],
            }],
            max_tokens: Math.max(this.maxStickerTokens, 350),
        });
        recordVisionUsage(response, isVideo ? 'vision_video_sticker' : 'vision_animated_sticker', userId);
        return response.choices[0]?.message?.content || 'Unable to analyze animated sticker';
    }

    // ============== LOCATION MESSAGE PARSING ==============

    /**
     * Parse location message from Telegram
     * Location messages include coordinates and optionally accuracy/live period
     */
    parseLocation(location: { latitude: number; longitude: number; horizontal_accuracy?: number; live_period?: number; heading?: number; proximity_alert_radius?: number }): ParsedMedia {
        const { latitude, longitude, horizontal_accuracy, live_period, heading } = location;

        // Format coordinates for display
        const coords = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;

        // Build description
        let description = `Location: ${coords}`;

        if (horizontal_accuracy) {
            description += ` (accuracy: ~${Math.round(horizontal_accuracy)}m)`;
        }

        if (live_period) {
            description += ` [LIVE - updating for ${Math.round(live_period / 60)} min]`;
        }

        if (heading !== undefined) {
            description += ` heading: ${heading}°`;
        }

        console.log(`📍 Location received: ${coords}`, {
            accuracy: horizontal_accuracy,
            live: !!live_period
        });

        return {
            type: 'location',
            content: description,
            originalType: live_period ? 'live_location' : 'location',
            metadata: {
                latitude,
                longitude,
                horizontalAccuracy: horizontal_accuracy,
                livePeriod: live_period,
                heading
            }
        };
    }

    // ============== AI INTEGRATION HELPERS ==============

    /**
     * Format parsed media for inclusion in AI conversation
     * Returns a user-friendly message that the AI can understand and respond to
     */
    formatForAI(parsed: ParsedMedia): string {
        if (parsed.error && !parsed.content) {
            return `[Media Error: ${parsed.error}]`;
        }

        switch (parsed.type) {
            case 'voice':
                // Voice is transcribed - treat as direct user speech
                return parsed.content;

            case 'photo':
                return `[User sent a photo]\nImage description: ${parsed.content}\n[End of photo description]`;

            case 'sticker': {
                const m = parsed.metadata ?? {};
                const kindLabel = m.stickerKind === 'video_sticker'
                    ? 'video sticker'
                    : m.stickerKind === 'animated_sticker'
                        ? 'animated sticker'
                        : m.stickerKind === 'custom_emoji'
                            ? 'custom emoji'
                            : 'sticker';
                const lines: string[] = [`[User sent a ${kindLabel}]`];
                if (m.cacheKey) lines.push(`cache_key: ${m.cacheKey}`);
                if (m.emoji) lines.push(`sender chose emoji: ${m.emoji}`);
                if (m.emojis && m.emojis.length > 0) lines.push(`pack-associated emojis: ${m.emojis.join(' ')}`);
                if (m.setName) lines.push(`pack: ${m.setName}`);
                lines.push(`analysis: ${parsed.content}`);
                lines.push(`[End of ${kindLabel}]`);
                return lines.join('\n');
            }

            case 'location':
                const liveHint = parsed.metadata?.livePeriod ? ' (LIVE)' : '';
                const lat = parsed.metadata?.latitude?.toFixed(6) || '?';
                const lng = parsed.metadata?.longitude?.toFixed(6) || '?';
                return `[User shared their location${liveHint}]\nCoordinates: ${lat}, ${lng}\n[End of location]`;

            case 'text':
                return parsed.content;

            default:
                return '[Unsupported media type received]';
        }
    }

    /**
     * Get a brief indicator for logging purposes
     */
    getMediaIndicator(parsed: ParsedMedia): string {
        switch (parsed.type) {
            case 'voice':
                return `[Voice ${parsed.metadata?.duration}s]`;
            case 'photo':
                return '[Photo]';
            case 'sticker': {
                const m = parsed.metadata ?? {};
                const kindAbbrev = m.stickerKind === 'video_sticker'
                    ? 'VidSticker'
                    : m.stickerKind === 'animated_sticker'
                        ? 'AnimSticker'
                        : m.stickerKind === 'custom_emoji'
                            ? 'CustomEmoji'
                            : 'Sticker';
                const e = m.emojis && m.emojis.length > 0 ? m.emojis.join('') : (m.emoji || '');
                const hit = m.cacheHit ? ' cached' : '';
                return `[${kindAbbrev} ${e}${hit}]`;
            }
            case 'location':
                return parsed.metadata?.livePeriod ? '[Live Location]' : '[Location]';
            default:
                return '[Media]';
        }
    }
}

// ============== SINGLETON FACTORY ==============

let mediaParserInstance: MediaParser | null = null;

/**
 * Initialize the MediaParser singleton
 * Call this once at app startup after bot and API clients are initialized
 */
export function initializeMediaParser(config: MediaParserConfig): MediaParser {
    mediaParserInstance = new MediaParser(config);
    return mediaParserInstance;
}

/**
 * Get the initialized MediaParser instance
 * Throws if not initialized
 */
export function getMediaParser(): MediaParser {
    if (!mediaParserInstance) {
        throw new Error('MediaParser not initialized. Call initializeMediaParser() first.');
    }
    return mediaParserInstance;
}
