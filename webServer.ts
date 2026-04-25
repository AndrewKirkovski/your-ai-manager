import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllUsers, getUser, updateUserTask, updateUserMemory, updateMessageById, getRecentImages, getTrackedStatNames, getLatestStat, getStatCount, getTokenUsageStats, type TokenUsageScope } from './userStore';
import { textify, stripSystemTags } from './telegramFormat';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Auth gate. Set WEB_AUTH_TOKEN in env — clients must send `Authorization: Bearer <token>`
// or include `?token=<token>` in the query. Without WEB_AUTH_TOKEN set, requests from
// non-loopback IPs are rejected (keeps local dev easy while blocking LAN access on Docker).
// The LuxMed webhook has its own shared-secret check inside the handler (X-Luxmed-Secret).
const AUTH_TOKEN = process.env.WEB_AUTH_TOKEN || '';
const LUXMED_WEBHOOK_SECRET = process.env.LUXMED_WEBHOOK_SECRET || '';
if (!AUTH_TOKEN) {
    console.warn('⚠️  WEB_AUTH_TOKEN not set — /api/* is loopback-only. LAN access will be rejected.');
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
        return next();
    }
    // No token configured — allow loopback only.
    const ip = req.ip || req.socket.remoteAddress || '';
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!loopback) {
        return res.status(401).json({ error: 'Unauthorized — set WEB_AUTH_TOKEN for non-loopback access' });
    }
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
//   ?scope=me|global|system  (default 'global'; 'me' requires user_id query param)
//   ?user_id=N               (required when scope='me')
//   ?days=N                  (default 30; window of last N days ending now)
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
        const report = getTokenUsageStats({
            scope,
            userId: scope === 'me' ? userIdRaw : undefined,
            from,
            to,
        });
        res.json(report);
    } catch (error) {
        console.error('Error fetching token usage:', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch token usage' });
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

// LuxMed monitoring webhook — receives notifications from the sidecar.
// Reachable on 0.0.0.0 inside the Docker network; protected by a shared secret.
// Accepts the secret either as `X-Luxmed-Secret` header (preferred) or as a
// `?secret=` query param (fallback for the upstream sidecar, which hardcodes
// only Content-Type and can't add custom headers — embed the secret in
// MONITORING_WEBHOOK_URL instead). If LUXMED_WEBHOOK_SECRET is unset, all
// requests are rejected (fail-closed).
app.post('/api/luxmed/monitoring-callback', (req: Request, res: Response) => {
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
        // TODO: Forward message to Telegram user via bot.sendMessage(chatId, message)
        // This requires access to the bot instance — will be wired in Phase 5
        res.json({ success: true });
    } catch (error) {
        console.error('LuxMed webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

const PORT = process.env.WEB_PORT || 3000;
// Bind 0.0.0.0 so Docker port publish works + the LuxMed sidecar webhook path
// is reachable via `http://bot:3000/...`. Protection comes from the auth gate
// above — not from the bind address.
app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`🌐 Web UI available at http://localhost:${PORT}`);
});
