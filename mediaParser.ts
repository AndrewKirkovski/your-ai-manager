import TelegramBot, { Message, Voice, PhotoSize, Sticker } from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { createReadStream } from 'fs';

// ============== TYPE DEFINITIONS ==============

export type MediaType = 'voice' | 'photo' | 'sticker' | 'location' | 'text' | 'unsupported';

export interface ParsedMedia {
    type: MediaType;
    content: string;           // Transcribed text or description
    originalType: string;      // e.g., 'voice', 'photo', 'sticker'
    metadata?: {
        duration?: number;     // For voice messages
        emoji?: string;        // For stickers
        setName?: string;      // For stickers
        fileSize?: number;
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
    visionModel: string;            // e.g., 'claude-sonnet-4-20250514'
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
        if (msg.sticker && !msg.sticker.is_animated && !msg.sticker.is_video) return 'sticker';
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
                    return await this.parsePhoto(msg.photo!);
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
     * Download and analyze photo using Claude Vision
     */
    async parsePhoto(photos: PhotoSize[]): Promise<ParsedMedia> {
        try {
            // Get highest resolution photo (last in array)
            const bestPhoto = photos[photos.length - 1];

            // Step 1: Download photo from Telegram
            const fileStream = this.bot.getFileStream(bestPhoto.file_id);
            const chunks: Buffer[] = [];

            for await (const chunk of fileStream) {
                chunks.push(chunk as Buffer);
            }
            const imageBuffer = Buffer.concat(chunks);

            // Step 2: Convert to base64 for Vision API
            const base64Image = imageBuffer.toString('base64');
            const imageUrl = `data:image/jpeg;base64,${base64Image}`;

            // Step 3: Analyze with Claude Vision
            const response = await this.anthropic.chat.completions.create({
                model: this.visionModel,
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: 'Describe this image in detail. Include any text visible in the image. ' +
                                    'If it appears to be a screenshot, describe what application or content is shown. ' +
                                    'Be concise but thorough.'
                            },
                            {
                                type: 'image_url',
                                image_url: { url: imageUrl }
                            }
                        ]
                    }
                ],
                max_tokens: this.maxImageTokens
            });

            const description = response.choices[0]?.message?.content || 'Unable to analyze image';

            return {
                type: 'photo',
                content: description,
                originalType: 'photo',
                metadata: {
                    fileSize: bestPhoto.file_size
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

    // ============== STICKER PARSING ==============

    /**
     * Download and analyze static sticker using Claude Vision
     * Includes emoji context for better AI understanding
     */
    async parseSticker(sticker: Sticker): Promise<ParsedMedia> {
        // Reject animated/video stickers
        if (sticker.is_animated || sticker.is_video) {
            return {
                type: 'sticker',
                content: `User sent an animated sticker with emoji ${sticker.emoji || 'unknown'}`,
                originalType: 'animated_sticker',
                metadata: {
                    emoji: sticker.emoji,
                    setName: sticker.set_name
                },
                error: 'Animated stickers are not supported for visual analysis'
            };
        }

        try {
            // Step 1: Download sticker (WebP format)
            const fileStream = this.bot.getFileStream(sticker.file_id);
            const chunks: Buffer[] = [];

            for await (const chunk of fileStream) {
                chunks.push(chunk as Buffer);
            }
            const stickerBuffer = Buffer.concat(chunks);

            // Step 2: Convert to base64
            const base64Sticker = stickerBuffer.toString('base64');
            const stickerUrl = `data:image/webp;base64,${base64Sticker}`;

            // Step 3: Build context-aware prompt
            const emojiContext = sticker.emoji ? `This sticker is associated with the emoji: ${sticker.emoji}. ` : '';
            const setContext = sticker.set_name ? `It's from the sticker pack "${sticker.set_name}". ` : '';

            // Step 4: Analyze with Claude Vision
            const response = await this.anthropic.chat.completions.create({
                model: this.visionModel,
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: `Analyze this sticker image. ${emojiContext}${setContext}` +
                                    'Describe what it shows: the character, expression, action, and emotional tone. ' +
                                    'What message or emotion is the user trying to convey by sending this sticker? '
                            },
                            {
                                type: 'image_url',
                                image_url: { url: stickerUrl }
                            }
                        ]
                    }
                ],
                max_tokens: this.maxStickerTokens
            });

            const description = response.choices[0]?.message?.content || 'Unable to analyze sticker';

            return {
                type: 'sticker',
                content: description,
                originalType: 'sticker',
                metadata: {
                    emoji: sticker.emoji,
                    setName: sticker.set_name,
                    fileSize: sticker.file_size
                }
            };
        } catch (error) {
            console.error('Sticker parsing failed:', {
                error: error instanceof Error ? error.message : String(error),
                emoji: sticker.emoji,
                setName: sticker.set_name
            });

            // Fallback to emoji-only description
            const emojiHint = sticker.emoji ? ` (${sticker.emoji})` : '';
            return {
                type: 'sticker',
                content: `User sent a sticker${emojiHint}`,
                originalType: 'sticker',
                metadata: {
                    emoji: sticker.emoji,
                    setName: sticker.set_name
                },
                error: error instanceof Error ? error.message : 'Unknown sticker error'
            };
        }
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

            case 'sticker':
                const emojiHint = parsed.metadata?.emoji ? ` (${parsed.metadata.emoji})` : '';
                return `[User sent a sticker${emojiHint}]\nSticker analysis: ${parsed.content}\n[End of sticker analysis]`;

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
            case 'sticker':
                return `[Sticker ${parsed.metadata?.emoji || ''}]`;
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
