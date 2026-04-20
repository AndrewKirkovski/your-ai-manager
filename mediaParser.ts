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
    type StickerCacheKind,
} from './userStore';
import { gatherAllPackEmojis } from './stickerSetCache';
import { extractFramesFromWebm, stitchFramesHorizontal } from './stickerFrames';
import { renderTgsFrames } from './tgsRenderer';

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
    async parseMedia(msg: Message): Promise<ParsedMedia> {
        const mediaType = this.detectMediaType(msg);

        try {
            switch (mediaType) {
                case 'voice':
                    return await this.parseVoiceMessage(msg.voice!);
                case 'photo':
                    return await this.parsePhoto(msg.photo!, msg.caption);
                case 'sticker':
                    return await this.parseSticker(msg.sticker!);
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
    async parsePhoto(photos: PhotoSize[], caption?: string): Promise<ParsedMedia> {
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
            const description = await this.analyzeImageBase64(base64Image, prompt, 500);

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
     */
    private async analyzeImageBase64(base64: string, prompt: string, maxTokens?: number): Promise<string> {
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
        return response.choices[0]?.message?.content || 'Unable to analyze image';
    }

    /**
     * Re-analyze a previously sent image by Telegram file_id with a custom prompt.
     * Used by the AnalyzeImage tool for follow-up analysis.
     */
    async analyzeImageByFileId(fileId: string, prompt: string): Promise<string> {
        const imageBuffer = await this.downloadFile(fileId);
        const base64 = imageBuffer.toString('base64');
        return this.analyzeImageBase64(base64, prompt, 800);
    }

    // ============== STICKER PARSING ==============

    /**
     * Cache-aware sticker parser: dispatches to static / animated (.tgs) /
     * video (.webm) handlers, looks up file_unique_id in sticker_cache first,
     * gathers all pack-associated emojis, and stores the description on miss.
     */
    async parseSticker(sticker: Sticker): Promise<ParsedMedia> {
        const cacheKey = sticker.file_unique_id;
        const kind: StickerCacheKind = sticker.is_video
            ? 'video_sticker'
            : sticker.is_animated
                ? 'animated_sticker'
                : 'sticker';

        // Cache hit — skip Vision entirely
        const cached = getStickerCacheEntry(cacheKey);
        if (cached) {
            // Self-heal: Telegram file_ids occasionally rotate (e.g., when a sticker pack is republished
            // or after a long server-side TTL). Refresh on every cache hit so SendStickerToUser picks
            // a sendable id next time. Targeted update — doesn't touch description/updated_at.
            if (cached.fileId !== sticker.file_id) {
                refreshStickerCacheFileId(cacheKey, sticker.file_id);
            }
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
            const description = await this.analyzeStickerByKind(sticker, kind, allEmojis);
            upsertStickerCacheEntry({
                cacheKey,
                kind,
                emojis: allEmojis,
                setName: sticker.set_name,
                description,
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
    async parseCustomEmoji(customEmojiId: string, fallbackChar?: string): Promise<ParsedMedia> {
        const cached = getStickerCacheEntry(customEmojiId);
        if (cached) {
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

            const description = await this.analyzeStickerByKind(sticker, kind === 'custom_emoji' ? 'sticker' : kind, emojis);
            upsertStickerCacheEntry({
                cacheKey: customEmojiId,
                kind: 'custom_emoji',
                emojis,
                setName: sticker.set_name,
                description,
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
     * Throws on unrecoverable error.
     */
    private async analyzeStickerByKind(sticker: Sticker, kind: StickerCacheKind, emojis: string[]): Promise<string> {
        const buffer = await this.downloadFile(sticker.file_id);
        if (kind === 'video_sticker') {
            const frames = await extractFramesFromWebm(buffer, 5);
            const strip = await stitchFramesHorizontal(frames);
            return this.analyzeAnimatedStrip(strip, sticker, emojis, /*isVideo*/ true);
        }
        if (kind === 'animated_sticker') {
            const frames = await renderTgsFrames(buffer, 5);
            const strip = await stitchFramesHorizontal(frames);
            return this.analyzeAnimatedStrip(strip, sticker, emojis, /*isVideo*/ false);
        }
        // static .webp
        return this.analyzeStaticSticker(buffer, sticker, emojis);
    }

    private async analyzeStaticSticker(webp: Buffer, sticker: Sticker, emojis: string[]): Promise<string> {
        const stickerUrl = `data:image/webp;base64,${webp.toString('base64')}`;
        const emojiContext = emojis.length > 0
            ? `This sticker is associated in its pack with these emojis: ${emojis.join(' ')}. `
            : '';
        const setContext = sticker.set_name ? `It's from the sticker pack "${sticker.set_name}". ` : '';

        const response = await this.anthropic.chat.completions.create({
            model: this.visionModel,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `Analyze this sticker image. ${emojiContext}${setContext}` +
                            'Describe what it shows: the character, expression, action, and emotional tone. ' +
                            'What message or emotion is typically conveyed by sending this sticker? ' +
                            'Be concise (2-3 sentences).',
                    },
                    { type: 'image_url', image_url: { url: stickerUrl } },
                ],
            }],
            max_tokens: this.maxStickerTokens,
        });
        return response.choices[0]?.message?.content || 'Unable to analyze sticker';
    }

    private async analyzeAnimatedStrip(strip: Buffer, sticker: Sticker, emojis: string[], isVideo: boolean): Promise<string> {
        const url = `data:image/png;base64,${strip.toString('base64')}`;
        const emojiContext = emojis.length > 0
            ? `Pack-associated emojis: ${emojis.join(' ')}. `
            : '';
        const setContext = sticker.set_name ? `Pack: "${sticker.set_name}". ` : '';
        const sourceLabel = isVideo ? 'animated (video) sticker' : 'animated (Lottie) sticker';

        const response = await this.anthropic.chat.completions.create({
            model: this.visionModel,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `These are 5 frames (left → right, evenly spaced in time) from an ${sourceLabel}. ` +
                            `${emojiContext}${setContext}` +
                            'Describe what is happening across the frames: the character, the motion or expression change, ' +
                            'and what message/emotion the sender is typically conveying when using this sticker. ' +
                            'Be concise (3-4 sentences).',
                    },
                    { type: 'image_url', image_url: { url } },
                ],
            }],
            max_tokens: Math.max(this.maxStickerTokens, 350),
        });
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
