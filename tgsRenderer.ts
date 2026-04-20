/**
 * .tgs (gzipped Lottie JSON) renderer using puppeteer-core + lottie-web.
 *
 * Holds a single headless browser instance for the lifetime of the bot. On the
 * first TGS request the browser launches; subsequent requests reuse it. The
 * browser is shut down on SIGTERM via `shutdownTgsRenderer()`.
 *
 * Each render opens a fresh page (cheap), injects lottie_canvas.min.js from
 * node_modules, loads the JSON, and steps to N evenly-spaced frames capturing
 * the canvas as PNG.
 *
 * On Windows dev machines: requires PUPPETEER_EXECUTABLE_PATH env var pointing
 * at chrome.exe (or auto-detects via puppeteer-core's defaults).
 * On Docker (bookworm-slim): PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium.
 */

import {gunzipSync} from 'zlib';
import {readFileSync} from 'fs';
import {fileURLToPath} from 'url';
import {dirname, resolve} from 'path';
import puppeteer, {type Browser, type Page} from 'puppeteer-core';

const CANVAS_SIZE = 256;
// DoS guard: cap gunzip output to defend against zip-bomb .tgs payloads.
const TGS_MAX_DECOMPRESSED_BYTES = 10 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const LOTTIE_PATH = resolve(__dirname, 'node_modules', 'lottie-web', 'build', 'player', 'lottie_canvas.min.js');

let lottieScript: string | undefined;
function loadLottieScript(): string {
    if (!lottieScript) lottieScript = readFileSync(LOTTIE_PATH, 'utf-8');
    return lottieScript;
}

let browserPromise: Promise<Browser> | undefined;

function resolveExecutablePath(): string {
    const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (envPath && envPath.trim()) return envPath.trim();
    // Reasonable Windows fallbacks for local dev
    const candidates = [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
    ];
    return candidates[0]; // best effort; puppeteer will surface a clear error if missing
}

async function getBrowser(): Promise<Browser> {
    if (!browserPromise) {
        browserPromise = puppeteer.launch({
            executablePath: resolveExecutablePath(),
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        }).catch(err => {
            browserPromise = undefined; // allow retry on next call
            throw err;
        });
    }
    return browserPromise;
}

export async function shutdownTgsRenderer(): Promise<void> {
    if (!browserPromise) return;
    try {
        const browser = await browserPromise;
        await browser.close();
    } catch {
        // ignore
    } finally {
        browserPromise = undefined;
    }
}

/**
 * Decompress a .tgs buffer and parse it as a Lottie JSON object.
 */
export function decompressTgs(buffer: Buffer): unknown {
    const json = gunzipSync(buffer, {maxOutputLength: TGS_MAX_DECOMPRESSED_BYTES}).toString('utf-8');
    return JSON.parse(json);
}

/**
 * Render `count` evenly-spaced frames from a .tgs Lottie sticker as PNG buffers.
 * Returns frames in chronological order.
 */
export async function renderTgsFrames(buffer: Buffer, count: number = 5): Promise<Buffer[]> {
    const animationData = decompressTgs(buffer);
    const browser = await getBrowser();
    let page: Page | undefined;
    try {
        page = await browser.newPage();
        await page.setViewport({width: CANVAS_SIZE, height: CANVAS_SIZE, deviceScaleFactor: 1});
        await page.setContent(
            `<!DOCTYPE html><html><head><style>html,body{margin:0;padding:0;background:transparent;}#c{width:${CANVAS_SIZE}px;height:${CANVAS_SIZE}px;}</style></head><body><div id="c"></div></body></html>`,
            {waitUntil: 'load'},
        );
        await page.addScriptTag({content: loadLottieScript()});

        // Initialize the animation (paused at frame 0). Returns the totalFrames count.
        const totalFrames = await page.evaluate(
            (data: unknown) => {
                const w = window as unknown as {
                    lottie: {
                        loadAnimation: (cfg: Record<string, unknown>) => {totalFrames: number; goToAndStop: (frame: number, isFrame: boolean) => void};
                    };
                    __anim?: {totalFrames: number; goToAndStop: (frame: number, isFrame: boolean) => void};
                };
                const anim = w.lottie.loadAnimation({
                    container: document.getElementById('c'),
                    renderer: 'canvas',
                    loop: false,
                    autoplay: false,
                    animationData: data,
                });
                w.__anim = anim;
                return anim.totalFrames;
            },
            animationData as never,
        );

        // Don't render more positions than there are distinct frames in the animation.
        // A 1-frame (static) Lottie gets exactly 1 screenshot; a 3-frame loop gets 3.
        const safeTotal = Math.max(0, totalFrames - 1);
        const actualCount = Math.max(1, Math.min(count, safeTotal + 1));
        const positions: number[] = [];
        for (let i = 0; i < actualCount; i++) {
            positions.push(actualCount === 1 ? 0 : (safeTotal * i) / (actualCount - 1));
        }

        const frames: Buffer[] = [];
        for (const frameNum of positions) {
            await page.evaluate((f: number) => {
                const w = window as unknown as {__anim: {goToAndStop: (frame: number, isFrame: boolean) => void}};
                w.__anim.goToAndStop(f, true);
            }, frameNum);
            // Give the canvas a microtask to flush the draw.
            await new Promise(r => setTimeout(r, 30));
            const shot = await page.screenshot({type: 'png', omitBackground: true, clip: {x: 0, y: 0, width: CANVAS_SIZE, height: CANVAS_SIZE}});
            frames.push(Buffer.from(shot));
        }
        return frames;
    } finally {
        if (page) await page.close().catch(() => {});
    }
}
