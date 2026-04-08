import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllUsers, getUser, updateUserTask, updateUserMemory, updateMessageById, getRecentImages, getTrackedStatNames, getLatestStat, getStatCount } from './userStore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

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

// PATCH /api/users/:id/tasks/:taskId - edit task
app.patch('/api/users/:id/tasks/:taskId', async (req: Request, res: Response) => {
    try {
        const userId = parseInt(param(req, 'id'));
        const taskId = param(req, 'taskId');
        const updates = req.body;

        await updateUserTask(userId, taskId, (task) => {
            if (updates.name !== undefined) task.name = updates.name;
            if (updates.status !== undefined) task.status = updates.status;
            if (updates.annoyance !== undefined) task.annoyance = updates.annoyance;
            if (updates.pingAt !== undefined) task.pingAt = new Date(updates.pingAt);
            if (updates.dueAt !== undefined) task.dueAt = updates.dueAt ? new Date(updates.dueAt) : undefined;
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

        await updateUserMemory(userId, key, value);
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

        const updated = updateMessageById(userId, messageId, content);
        if (!updated) {
            return res.status(404).json({ error: 'Message not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating message:', error);
        res.status(500).json({ error: 'Failed to update message' });
    }
});

// LuxMed monitoring webhook — receives notifications from the sidecar
app.post('/api/luxmed/monitoring-callback', (req: Request, res: Response) => {
    try {
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
app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`🌐 Web UI available at http://localhost:${PORT}`);
});
