/**
 * Frame extraction + stitching for animated stickers.
 *
 * Two input shapes converge here:
 *   - .webm video stickers   → extractFramesFromWebm() via ffmpeg-static
 *   - .tgs Lottie stickers   → renderTgsFrames() via puppeteer (in tgsRenderer.ts)
 *
 * Both produce an array of PNG buffers; stitchFramesHorizontal() composes them
 * into one wide PNG strip that gets sent to Claude Vision as a single image.
 */

import {promises as fs} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {randomBytes} from 'crypto';
import ffmpegPath from 'ffmpeg-static';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';

// ffmpeg-static ships only the ffmpeg binary; ffprobe lives in @ffprobe-installer/ffprobe.
// Without setFfprobePath, fluent-ffmpeg's ffprobe() throws "Cannot find ffprobe" on first call.
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobeInstaller?.path) ffmpeg.setFfprobePath(ffprobeInstaller.path);

const FRAME_SIZE = 256;
const TARGET_FRAMES = 5;

async function probeDuration(path: string): Promise<number> {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(path, (err, metadata) => {
            if (err) return reject(err);
            const duration = metadata.format.duration;
            if (typeof duration !== 'number' || duration <= 0) {
                return reject(new Error('ffprobe returned no duration'));
            }
            resolve(duration);
        });
    });
}

function uniqueTmpDir(): string {
    return join(tmpdir(), `sticker-frames-${randomBytes(6).toString('hex')}`);
}

/**
 * Extract `count` PNG frames from a webm buffer at evenly-spaced timestamps.
 * Returns frame buffers in chronological order (frame 0 = start, frame N-1 = end).
 */
export async function extractFramesFromWebm(
    webm: Buffer,
    count: number = TARGET_FRAMES,
): Promise<Buffer[]> {
    if (!ffmpegPath) throw new Error('ffmpeg-static binary not available');

    const dir = uniqueTmpDir();
    await fs.mkdir(dir, {recursive: true});
    const inputPath = join(dir, 'in.webm');
    await fs.writeFile(inputPath, webm);

    try {
        const duration = await probeDuration(inputPath);
        // Evenly-spaced timestamps. NO margin trimming — for custom emojis
        // (often 0.5–1s clips), 5% of a 0.5s clip is 0.025s which ffmpeg may round
        // to frame 0, colliding with the next timestamp. Sample from 0 to duration
        // directly; ffmpeg clamps timestamps past EOF to the last frame.
        const timestamps: number[] = [];
        for (let i = 0; i < count; i++) {
            timestamps.push((duration * i) / Math.max(1, count - 1));
        }

        const frames: Buffer[] = [];
        for (let i = 0; i < timestamps.length; i++) {
            const out = join(dir, `frame_${i}.png`);
            let stderrBuf = '';
            try {
                await new Promise<void>((resolve, reject) => {
                    ffmpeg(inputPath)
                        // Output-seek (after -i) — accurate decoding, essential on short clips
                        // where fast input-seek rounds to an I-frame past our target timestamp.
                        .seek(timestamps[i])
                        .frames(1)
                        .outputOptions([
                            '-vf',
                            `scale=${FRAME_SIZE}:${FRAME_SIZE}:force_original_aspect_ratio=decrease,pad=${FRAME_SIZE}:${FRAME_SIZE}:(ow-iw)/2:(oh-ih)/2`,
                        ])
                        .output(out)
                        .on('stderr', line => { stderrBuf += line + '\n'; })
                        .on('end', () => resolve())
                        .on('error', reject)
                        .run();
                });
            } catch (err) {
                console.warn(`[ffmpeg] frame ${i} @${timestamps[i].toFixed(3)}s failed:`, err instanceof Error ? err.message : err, stderrBuf.split('\n').slice(-3).join(' | '));
                continue; // try the next timestamp
            }
            // Verify the file actually exists before reading — ffmpeg can exit 0 without writing output.
            try {
                await fs.access(out);
            } catch {
                console.warn(`[ffmpeg] frame ${i} @${timestamps[i].toFixed(3)}s: no output file produced`);
                continue;
            }
            frames.push(await fs.readFile(out));
        }

        if (frames.length < 2) {
            throw new Error(`extractFramesFromWebm: only ${frames.length} frame(s) extracted from ${duration.toFixed(2)}s clip (needed ≥2)`);
        }
        return frames;
    } finally {
        // best-effort cleanup
        await fs.rm(dir, {recursive: true, force: true}).catch(() => {});
    }
}

/**
 * Compose N square PNG frames into one horizontal strip (1 row × N columns).
 * Each frame is normalized to FRAME_SIZE × FRAME_SIZE before compositing.
 */
export async function stitchFramesHorizontal(frames: Buffer[]): Promise<Buffer> {
    if (frames.length === 0) throw new Error('stitchFramesHorizontal: no frames');

    const normalized = await Promise.all(
        frames.map(buf =>
            sharp(buf)
                .resize(FRAME_SIZE, FRAME_SIZE, {fit: 'contain', background: {r: 255, g: 255, b: 255, alpha: 0}})
                .png()
                .toBuffer(),
        ),
    );

    const totalWidth = FRAME_SIZE * normalized.length;
    const composite = await sharp({
        create: {
            width: totalWidth,
            height: FRAME_SIZE,
            channels: 4,
            background: {r: 255, g: 255, b: 255, alpha: 1},
        },
    })
        .composite(normalized.map((input, idx) => ({input, left: idx * FRAME_SIZE, top: 0})))
        .png()
        .toBuffer();

    return composite;
}
