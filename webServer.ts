import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllUsers, getUser, updateUserTask, updateUserMemory, setUser } from './userStore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

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
        const user = await getUser(parseInt(req.params.id));
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({
            userId: user.userId,
            tasks: user.tasks,
            routines: user.routines,
            memory: user.memory,
            messages: user.messageHistory,
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
        const userId = parseInt(req.params.id);
        const { taskId } = req.params;
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
        const userId = parseInt(req.params.id);
        const { key } = req.params;
        const { value } = req.body;

        await updateUserMemory(userId, key, value);
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating memory:', error);
        res.status(500).json({ error: 'Failed to update memory' });
    }
});

// PATCH /api/users/:id/messages/:index - edit message
app.patch('/api/users/:id/messages/:index', async (req: Request, res: Response) => {
    try {
        const userId = parseInt(req.params.id);
        const index = parseInt(req.params.index);
        const { content } = req.body;

        const user = await getUser(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (!user.messageHistory[index]) {
            return res.status(404).json({ error: 'Message not found' });
        }

        user.messageHistory[index].content = content;
        await setUser(user);
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating message:', error);
        res.status(500).json({ error: 'Failed to update message' });
    }
});

const PORT = process.env.WEB_PORT || 3000;
app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`🌐 Web UI available at http://localhost:${PORT}`);
});
