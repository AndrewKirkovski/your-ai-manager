import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type TelegramBot from 'node-telegram-bot-api';
import { getAllUsers, getUser, updateUserTask, updateUserMemory, updateMessageById, getRecentImages, getTrackedStatNames, getLatestStat, getStatCount, getTokenUsageStats, getDistinctTokenModels, listStickerCacheEntries, updateStickerCacheText, getStickerCacheEntry, type TokenUsageScope, type StickerCacheKind } from './userStore';
import { textify, stripSystemTags, safeSend } from './telegramFormat';
import { renderTgsFrames } from './tgsRenderer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Bot instance — set via startWebServer(bot). webServer used to be a side-effect
// import; now it's a function call so the LuxMed webhook can actually deliver
// notifications via bot.sendMessage instead of just logging them.
let botInstance: TelegramBot | null = null;

const app = express();
app.use(express.json());

// Auth gate. Set WEB_AUTH_TOKEN in env to require `Authorization: Bearer <token>`
// (or `?token=<token>` query param). Without WEB_AUTH_TOKEN the dashboard is OPEN to
// any reachable network — fine for a home-LAN admin UI behind the router, dangerous
// if port 3000 is ever exposed to the internet.
// The LuxMed webhook has its own shared-secret check inside the handler (X-Luxmed-Secret).
const AUTH_TOKEN = process.env.WEB_AUTH_TOKEN || '';
const LUXMED_WEBHOOK_SECRET = process.env.LUXMED_WEBHOOK_SECRET || '';
if (!AUTH_TOKEN) {
    console.warn('⚠️  WEB_AUTH_TOKEN not set — /api/* is OPEN to any caller. Set the env var to require a token.');
}
if (!LUXMED_WEBHOOK_SECRET) {
    console.warn('⚠️  LUXMED_WEBHOOK_SECRET not set — LuxMed webhook will reject all requests.');
}
app.use((req, res, next) => {
    // Static files bypass auth; the LuxMed webhook does its own shared-secret check.
    if (!req.path.startsWith('/api/') || req.path === '/api/luxmed/monitoring-callback') {
        return next();
    }
    if (AUTH_TOKEN) {
        const header = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
        if (header !== AUTH_TOKEN && queryToken !== AUTH_TOKEN) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }
    // No token configured → no gate. The host is responsible for keeping port 3000
    // off the public internet.
    next();
});

// Express 5 types params as string | string[] — extract first string safely
function param(req: Request, name: string): string {
    const val = req.params[name];
    return Array.isArray(val) ? val[0] : val;
}

// Serve static files from /web folder
app.use(express.static(path.join(__dirname, 'web')));

// GET /api/users - list all users
app.get('/api/users', async (_req: Request, res: Response) => {
    try {
        const users = await getAllUsers();
        res.json(users.map(u => ({
            userId: u.userId,
            taskCount: u.tasks.length,
            routineCount: u.routines.length,
            goal: u.preferences.goal || ''
        })));
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// GET /api/users/:id - get full user data
app.get('/api/users/:id', async (req: Request, res: Response) => {
    try {
        const user = await getUser(parseInt(param(req, 'id')));
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        const images = await getRecentImages(user.userId);
        const statNames = await getTrackedStatNames(user.userId);
        const stats = await Promise.all(statNames.map(async (s) => {
            const latest = await getLatestStat(user.userId, s.name);
            const count = await getStatCount(user.userId, s.name);
            return { name: s.name, unit: s.unit, lastValue: latest?.value, lastRecorded: latest?.timestamp.toISOString(), totalEntries: count };
        }));

        res.json({
            userId: user.userId,
            tasks: user.tasks,
            routines: user.routines,
            memory: user.memory,
            messages: user.messageHistory,
            images,
            stats,
            goal: user.preferences.goal || ''
        });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// GET /api/token-usage - aggregated AI token usage stats
//   ?scope=me|global         (default 'global'; 'me' requires user_id query param)
//   ?user_id=N               (required when scope='me')
//   ?days=N                  (default 30; window of last N days ending now)
//   ?model=<id>              (optional; filter to a single model id)
app.get('/api/token-usage', async (req: Request, res: Response) => {
    try {
        const scopeRaw = (typeof req.query.scope === 'string' ? req.query.scope : 'global');
        const scope: TokenUsageScope = (scopeRaw === 'me' || scopeRaw === 'global') ? scopeRaw : 'global';
        const userIdRaw = typeof req.query.user_id === 'string' ? parseInt(req.query.user_id, 10) : undefined;
        if (scope === 'me' && (userIdRaw === undefined || !Number.isFinite(userIdRaw))) {
            return res.status(400).json({ error: "scope='me' requires user_id query param" });
        }
        const days = Math.max(1, Math.min(365, parseInt(typeof req.query.days === 'string' ? req.query.days : '30', 10) || 30));
        const to = new Date();
        const from = new Date(to.getTime() - days * 86400000);
        const model = typeof req.query.model === 'string' && req.query.model.trim() ? req.query.model.trim() : undefined;
        const report = getTokenUsageStats({
            scope,
            userId: scope === 'me' ? userIdRaw : undefined,
            from,
            to,
            model,
        });
        res.json(report);
    } catch (error) {
        console.error('Error fetching token usage:', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch token usage' });
    }
});

// GET /api/token-usage/models - distinct model ids that appear in the period.
// Used by the dashboard to populate the model filter dropdown without forcing
// the caller to fetch the full report.
app.get('/api/token-usage/models', async (req: Request, res: Response) => {
    try {
        const scopeRaw = (typeof req.query.scope === 'string' ? req.query.scope : 'global');
        const scope: TokenUsageScope = (scopeRaw === 'me' || scopeRaw === 'global') ? scopeRaw : 'global';
        const userIdRaw = typeof req.query.user_id === 'string' ? parseInt(req.query.user_id, 10) : undefined;
        if (scope === 'me' && (userIdRaw === undefined || !Number.isFinite(userIdRaw))) {
            return res.status(400).json({ error: "scope='me' requires user_id query param" });
        }
        const days = Math.max(1, Math.min(365, parseInt(typeof req.query.days === 'string' ? req.query.days : '30', 10) || 30));
        const to = new Date();
        const from = new Date(to.getTime() - days * 86400000);
        const models = getDistinctTokenModels({
            scope,
            userId: scope === 'me' ? userIdRaw : undefined,
            from,
            to,
        });
        res.json({ models });
    } catch (error) {
        console.error('Error fetching token-usage models:', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch token-usage models' });
    }
});

// PATCH /api/users/:id/tasks/:taskId - edit task
app.patch('/api/users/:id/tasks/:taskId', async (req: Request, res: Response) => {
    try {
        const userId = parseInt(param(req, 'id'));
        const taskId = param(req, 'taskId');
        const updates = req.body;

        // Validate dates up front so an invalid admin input doesn't persist as
        // "Invalid Date" and break the routine tick comparison (`Invalid Date <=
        // now` is always false — ping would never fire).
        let pingAt: Date | undefined;
        let dueAt: Date | null | undefined;
        if (updates.pingAt !== undefined) {
            pingAt = new Date(updates.pingAt);
            if (Number.isNaN(pingAt.getTime())) {
                return res.status(400).json({ error: 'Invalid pingAt (expected ISO 8601)' });
            }
        }
        if (updates.dueAt !== undefined) {
            if (updates.dueAt === null || updates.dueAt === '') {
                dueAt = null;
            } else {
                const d = new Date(updates.dueAt);
                if (Number.isNaN(d.getTime())) {
                    return res.status(400).json({ error: 'Invalid dueAt (expected ISO 8601)' });
                }
                dueAt = d;
            }
        }

        await updateUserTask(userId, taskId, (task) => {
            // Symmetric with tool-call path (tools.tasks.ts:UpdateTask) — admin edits
            // must textify user-controlled name to match what the AI would write.
            if (updates.name !== undefined) task.name = textify(updates.name);
            if (updates.status !== undefined) task.status = updates.status;
            if (updates.annoyance !== undefined) task.annoyance = updates.annoyance;
            if (pingAt !== undefined) task.pingAt = pingAt;
            if (dueAt !== undefined) task.dueAt = dueAt ?? undefined;
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Error updating task:', error);
        res.status(500).json({ error: 'Failed to update task' });
    }
});

// PATCH /api/users/:id/memory/:key - edit memory
app.patch('/api/users/:id/memory/:key', async (req: Request, res: Response) => {
    try {
        const userId = parseInt(param(req, 'id'));
        const key = param(req, 'key');
        const { value } = req.body;

        // Symmetric with tool-call path (tools.memory.ts:UpdateMemory).
        await updateUserMemory(userId, textify(key), textify(value));
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating memory:', error);
        res.status(500).json({ error: 'Failed to update memory' });
    }
});

// PATCH /api/users/:id/messages/:messageId - edit message by ID
app.patch('/api/users/:id/messages/:messageId', async (req: Request, res: Response) => {
    try {
        const userId = parseInt(param(req, 'id'));
        const messageId = parseInt(param(req, 'messageId'));
        const { content } = req.body;

        // Strip <system> from admin-edited message content — same rule as the
        // getRecentMessages read-time wrap defense.
        const updated = updateMessageById(userId, messageId, stripSystemTags(content ?? ''));
        if (!updated) {
            return res.status(404).json({ error: 'Message not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating message:', error);
        res.status(500).json({ error: 'Failed to update message' });
    }
});

// ─── Sticker / emoji editor ─────────────────────────────────────────────────
// The dashboard surfaces every cached sticker + custom_emoji so a human can
// audit and overwrite the AI-generated description/short_tag when Vision missed
// something. PATCH always flags user_corrected = 1.

const STICKER_KINDS: ReadonlyArray<StickerCacheKind> = ['sticker', 'animated_sticker', 'video_sticker', 'custom_emoji'];

function isStickerKind(s: unknown): s is StickerCacheKind {
    return typeof s === 'string' && (STICKER_KINDS as readonly string[]).includes(s);
}

// In-memory cache for animated_sticker rendered frames. Puppeteer rendering is
// expensive (~500ms per call), so we cache the PNG buffer keyed by file_id.
// Bounded LRU; entries evict in insertion order once the cap is hit.
const TGS_FRAME_CACHE = new Map<string, Buffer>();
const TGS_FRAME_CACHE_MAX = 200;

function rememberTgsFrame(fileId: string, png: Buffer): void {
    if (TGS_FRAME_CACHE.size >= TGS_FRAME_CACHE_MAX) {
        const oldest = TGS_FRAME_CACHE.keys().next().value;
        if (oldest !== undefined) TGS_FRAME_CACHE.delete(oldest);
    }
    TGS_FRAME_CACHE.set(fileId, png);
}

// GET /api/stickers - paginated cache list
//   ?kind=sticker|animated_sticker|video_sticker|custom_emoji
//   ?q=<text>            (matches description/set_name/emojis/short_tag)
//   ?limit=N             (default 30, max 100)
//   ?offset=N            (default 0)
app.get('/api/stickers', async (req: Request, res: Response) => {
    try {
        const kindRaw = typeof req.query.kind === 'string' ? req.query.kind : '';
        const kind = isStickerKind(kindRaw) ? kindRaw : undefined;
        const q = typeof req.query.q === 'string' ? req.query.q : undefined;
        const limit = Math.max(1, Math.min(100, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '30', 10) || 30));
        const offset = Math.max(0, parseInt(typeof req.query.offset === 'string' ? req.query.offset : '0', 10) || 0);
        const { entries, total } = listStickerCacheEntries({ kind, q, limit, offset });
        res.json({
            entries: entries.map(e => ({
                cacheKey: e.cacheKey,
                kind: e.kind,
                emojis: e.emojis,
                setName: e.setName,
                description: e.description,
                shortTag: e.shortTag,
                hasImage: !!e.fileId,
                userCorrected: e.userCorrected,
                usedCount: e.usedCount,
                updatedAt: e.updatedAt.toISOString(),
            })),
            total,
            limit,
            offset,
            hasMore: offset + entries.length < total,
        });
    } catch (error) {
        console.error('Error listing stickers:', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list stickers' });
    }
});

// GET /api/stickers/:cacheKey/image - proxy the actual image bytes
// Format is detected from magic bytes, not the `kind` column — custom_emoji
// can be any of TGS / WebM / WebP / PNG depending on the source pack, so
// blindly trusting `kind` would mis-serve animated emojis as raw gzip.
//   - gzip (1f 8b) → TGS Lottie. Render middle frame via tgsRenderer, return PNG.
//   - EBML (1a 45 df a3) → WebM. Serve as video/webm.
//   - PNG/WebP/JPEG/GIF → serve as the matching image MIME.
//
// 404 if no fileId on the entry. file_id is durable for ~24h server-side, so we
// set Cache-Control max-age=3600. Browser cache + lazy <img> absorbs reloads.
app.get('/api/stickers/:cacheKey/image', async (req: Request, res: Response) => {
    try {
        const cacheKey = param(req, 'cacheKey');
        const entry = getStickerCacheEntry(cacheKey);
        if (!entry) {
            return res.status(404).json({ error: 'Sticker not found' });
        }
        if (!entry.fileId) {
            return res.status(404).json({ error: 'No file_id stored for this entry' });
        }
        if (!botInstance) {
            return res.status(503).json({ error: 'Bot not initialized' });
        }

        // TGS rendered output is the only path with a process-side cache (puppeteer
        // is the expensive bit). Static images and WebM go straight through the
        // Telegram-stream → response pipe with browser-cache absorbing the cost.
        const cached = TGS_FRAME_CACHE.get(entry.fileId);
        if (cached) {
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            return res.end(cached);
        }

        const buf = await downloadTelegramFile(botInstance, entry.fileId);
        const fmt = detectFileFormat(buf);

        if (fmt === 'tgs') {
            const frames = await renderTgsFrames(buf, 1);
            const png = frames[0];
            if (!png) {
                return res.status(500).json({ error: 'TGS render produced no frames' });
            }
            rememberTgsFrame(entry.fileId, png);
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            return res.end(png);
        }

        res.setHeader('Content-Type', fmt.mime);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.end(buf);
    } catch (error) {
        console.error('Error serving sticker image:', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to serve image' });
    }
});

// PATCH /api/stickers/:cacheKey - manual description/short_tag override
app.patch('/api/stickers/:cacheKey', async (req: Request, res: Response) => {
    try {
        const cacheKey = param(req, 'cacheKey');
        const { description, shortTag } = req.body as { description?: string; shortTag?: string };
        // textify both fields — same defense the AI tool path uses against
        // <system> wrapping and the like in user-supplied free text.
        const patch: { description?: string; shortTag?: string } = {};
        if (typeof description === 'string') patch.description = textify(description);
        if (typeof shortTag === 'string') patch.shortTag = textify(shortTag);
        const updated = updateStickerCacheText(cacheKey, patch);
        if (!updated) {
            return res.status(404).json({ error: 'Sticker not found' });
        }
        res.json({
            cacheKey: updated.cacheKey,
            kind: updated.kind,
            emojis: updated.emojis,
            setName: updated.setName,
            description: updated.description,
            shortTag: updated.shortTag,
            hasImage: !!updated.fileId,
            userCorrected: updated.userCorrected,
            usedCount: updated.usedCount,
            updatedAt: updated.updatedAt.toISOString(),
        });
    } catch (error) {
        console.error('Error updating sticker:', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update sticker' });
    }
});

/** Drain a Telegram file stream into a Buffer. Mirrors mediaParser's
 * downloadFile (kept here so webServer doesn't need to import the bot's
 * MediaParser instance just for this). */
async function downloadTelegramFile(bot: TelegramBot, fileId: string): Promise<Buffer> {
    const stream = bot.getFileStream(fileId);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}

/** Sniff sticker / emoji file format from magic bytes. Returns the literal
 * `'tgs'` for gzipped Lottie (caller renders via tgsRenderer); otherwise an
 * object with the appropriate MIME type for direct serving. Defaults to
 * image/webp for unknown bytes — browsers handle the mismatch gracefully. */
type FileFormat = 'tgs' | { mime: string };
function detectFileFormat(buf: Buffer): FileFormat {
    // Gzip → TGS (Lottie animation, gzipped JSON).
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'tgs';
    // EBML → WebM (video stickers, animated WebP-like custom emojis).
    if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { mime: 'video/webm' };
    // PNG.
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png' };
    // RIFF…WEBP.
    if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp' };
    // JPEG.
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg' };
    // GIF.
    if (buf.length >= 6 && buf.subarray(0, 6).toString('ascii').startsWith('GIF8')) return { mime: 'image/gif' };
    return { mime: 'image/webp' };
}

// LuxMed monitoring webhook — receives notifications from the sidecar.
// Reachable on 0.0.0.0 inside the Docker network; protected by a shared secret.
// Accepts the secret either as `X-Luxmed-Secret` header (preferred) or as a
// `?secret=` query param (fallback for the upstream sidecar, which hardcodes
// only Content-Type and can't add custom headers — embed the secret in
// MONITORING_WEBHOOK_URL instead). If LUXMED_WEBHOOK_SECRET is unset, all
// requests are rejected (fail-closed).
app.post('/api/luxmed/monitoring-callback', async (req: Request, res: Response) => {
    try {
        if (!LUXMED_WEBHOOK_SECRET) {
            return res.status(503).json({ error: 'Webhook disabled: LUXMED_WEBHOOK_SECRET not configured' });
        }
        const headerSecret = req.header('X-Luxmed-Secret') || '';
        const querySecret = typeof req.query.secret === 'string' ? req.query.secret : '';
        if (headerSecret !== LUXMED_WEBHOOK_SECRET && querySecret !== LUXMED_WEBHOOK_SECRET) {
            return res.status(401).json({ error: 'Invalid webhook secret' });
        }
        const { chatId, message } = req.body as { chatId?: string; sourceSystemId?: number; message?: string };
        if (!chatId || !message) {
            res.status(400).json({ error: 'Missing chatId or message' });
            return;
        }
        console.log(`[LuxMed webhook] chatId=${chatId}: ${message.slice(0, 100)}`);

        // Deliver to Telegram. The sidecar's chatId is a string but bot.sendMessage
        // accepts string|number — Telegram chat IDs are numeric, so coerce.
        // We DON'T propagate the send failure back to the sidecar (still 200) —
        // a transient Telegram outage shouldn't make the sidecar retry forever.
        if (!botInstance) {
            console.warn('[LuxMed webhook] received notification but bot instance not initialized; dropping');
        } else {
            const numericChatId = /^-?\d+$/.test(chatId) ? Number(chatId) : chatId;
            try {
                await safeSend(botInstance, numericChatId, message);
            } catch (sendErr) {
                console.error('[LuxMed webhook] safeSend failed:', sendErr instanceof Error ? sendErr.message : sendErr);
            }
        }
        res.json({ success: true });
    } catch (error) {
        console.error('LuxMed webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

const PORT = process.env.WEB_PORT || 3000;

/**
 * Start the admin/webhook web server. Pass the running bot so the LuxMed
 * monitoring webhook can deliver notifications via bot.sendMessage. Call this
 * once from index.ts after the TelegramBot instance is constructed.
 */
export function startWebServer(bot: TelegramBot): void {
    botInstance = bot;
    // Bind 0.0.0.0 so Docker port publish works + the LuxMed sidecar webhook path
    // is reachable via `http://bot:3000/...`. Protection comes from the auth gate
    // above — not from the bind address.
    app.listen(Number(PORT), '0.0.0.0', () => {
        console.log(`🌐 Web UI available at http://localhost:${PORT}`);
    });
}
