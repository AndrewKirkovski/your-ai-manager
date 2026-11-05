import test from 'node:test';
import assert from 'node:assert/strict';
import { blankUser, fakeBot, scriptedProvider, textTurn, toolTurn } from './ai-fixture.ts';

process.env.DB_PATH = ':memory:';
const { AIService, messagesSinceUserWrote } = await import('../aiService.ts');
const { BATCH_REMINDER_PROMPT, HISTORY_COMPACTION_PROMPT } = await import('../constants.ts');
const { nextPingFloor, settleRemindedTask, UpdateTask } = await import('../tools.tasks.ts');
const { addMessageToHistory, addUserTask, getTask, setUser } = await import('../userStore.ts');

const DAY_MS = 24 * 60 * 60_000;
const NOW = new Date('2026-11-05T10:00:00Z');

type TaskFields = Partial<Parameters<typeof addUserTask>[1]>;
let nextId = 0;
async function task(fields: TaskFields = {}) {
    const userId = 5000 + nextId++;
    await setUser(blankUser(userId));
    const id = `t${userId}`;
    await addUserTask(userId, {
        id, name: 'Медобзвон', requiresAction: true, status: 'pending', annoyance: 'low',
        pingAt: new Date(NOW.getTime() + 3_600_000), postponeCount: 91, createdAt: NOW, ...fields,
    });
    return { userId, id };
}

test('tasks with no deadline wait 7 days on low and 1 day on med', () => {
    assert.equal(nextPingFloor({ annoyance: 'low' }, NOW)?.getTime(), NOW.getTime() + 7 * DAY_MS);
    assert.equal(nextPingFloor({ annoyance: 'med' }, NOW)?.getTime(), NOW.getTime() + DAY_MS);
});

test('high tasks, deadlines and routines keep their own spacing', () => {
    assert.equal(nextPingFloor({ annoyance: 'high' }, NOW), null);
    assert.equal(nextPingFloor({ annoyance: 'low', dueAt: new Date(NOW.getTime() + DAY_MS) }, NOW), null);
    assert.equal(nextPingFloor({ annoyance: 'low', routineId: 'r1' }, NOW), null);
});

test('a too-early ping after a reminder moves out to the floor', async () => {
    const { userId, id } = await task();
    await settleRemindedTask(userId, id, NOW);
    assert.equal((await getTask(userId, id))?.pingAt.getTime(), NOW.getTime() + 7 * DAY_MS);
});

test('a ping past the floor stays where the model put it', async () => {
    const chosen = new Date(NOW.getTime() + 10 * DAY_MS);
    const { userId, id } = await task({ pingAt: chosen });
    await settleRemindedTask(userId, id, NOW);
    assert.equal((await getTask(userId, id))?.pingAt.getTime(), chosen.getTime());
});

test('a task the model left unscheduled goes back to pending at the floor', async () => {
    const { userId, id } = await task({ status: 'needs_replanning' });
    await settleRemindedTask(userId, id, NOW);
    const settled = await getTask(userId, id);
    assert.equal(settled?.status, 'pending');
    assert.equal(settled?.pingAt.getTime(), NOW.getTime() + 7 * DAY_MS);
});

test('a high task the model left unscheduled still re-pings within minutes', async () => {
    const { userId, id } = await task({ status: 'needs_replanning', annoyance: 'high' });
    await settleRemindedTask(userId, id, NOW);
    assert.equal((await getTask(userId, id))?.pingAt.getTime(), NOW.getTime() + 4 * 60_000);
});

test('a reminder that never reached the user retries soon, with no floor', async () => {
    const { userId, id } = await task({ status: 'needs_replanning' });
    await settleRemindedTask(userId, id, NOW, false);
    const settled = await getTask(userId, id);
    assert.equal(settled?.status, 'pending');
    assert.equal(settled?.pingAt.getTime(), NOW.getTime() + 150 * 60_000);
});

test('a failed turn leaves a task the user has since moved alone', async () => {
    const chosen = new Date(NOW.getTime() + 3_600_000);
    const { userId, id } = await task({ pingAt: chosen });
    await settleRemindedTask(userId, id, NOW, false);
    assert.equal((await getTask(userId, id))?.pingAt.getTime(), chosen.getTime());
});

test('an unknown annoyance value still settles', async () => {
    const { userId, id } = await task({ status: 'needs_replanning', annoyance: 'medium' as never });
    await settleRemindedTask(userId, id, NOW, false);
    assert.equal((await getTask(userId, id))?.pingAt.getTime(), NOW.getTime() + 45 * 60_000);
});

test('a deadline task keeps the ping the model chose', async () => {
    const chosen = new Date(NOW.getTime() + 3_600_000);
    const { userId, id } = await task({ pingAt: chosen, dueAt: new Date(NOW.getTime() + 5 * DAY_MS) });
    await settleRemindedTask(userId, id, NOW);
    assert.equal((await getTask(userId, id))?.pingAt.getTime(), chosen.getTime());
});

test('a ping set from chat is not held to the floor', async () => {
    const { userId, id } = await task();
    const inAnHour = new Date(Date.now() + 3_600_000);
    await UpdateTask.execute({ userId: String(userId), task_id: id, ping_at: inAnHour.toISOString() });
    assert.equal((await getTask(userId, id))?.pingAt.getTime(), inAnHour.getTime());
});

test('task tool results show the model real dates and no postpone count', async () => {
    const { userId, id } = await task();
    await addMessageToHistory(userId, 'user', 'привет');
    const { provider, requests } = scriptedProvider([toolTurn('GetTaskById', { task_id: id }), textTurn('ок')]);

    await AIService.streamAIResponse({
        userId, userMessage: '', systemPrompt: '', bot: fakeBot().bot, provider, model: 'fixture',
        addUserToHistory: false, addAssistantToHistory: true, enableToolCalls: true,
    });

    const toolResult = requests[1].messages.at(-1);
    assert.equal(toolResult?.role, 'tool_result');
    assert.doesNotMatch(toolResult!.content, /postponeCount/);
    assert.match(toolResult!.content, /"pingAt":"2026-11-05T11:00:00\.000Z"/);
});

test('the reminder prompt names the earliest next ping and gives no count', () => {
    const prompt = BATCH_REMINDER_PROMPT('memory', [{
        id: 'x', name: 'Медобзвон', requiresAction: true, annoyance: 'low',
        earliestNextPing: new Date('2026-11-12T10:00:00Z'),
    }]);
    assert.match(prompt, /earliest next ping: 2026-11-12T11:00\+01:00/);
    assert.doesNotMatch(prompt, /postponeCount/);
    assert.doesNotMatch(prompt, /low: 2-3h/);
});

test('the floor is a whole minute, as the model sees and picks it', () => {
    const floor = nextPingFloor({ annoyance: 'low' }, new Date('2026-11-05T10:00:37.500Z'));
    assert.equal(floor?.toISOString(), '2026-11-12T10:00:00.000Z');
});

test('only what the bot said after the user last wrote counts as unanswered', () => {
    const history = [
        { role: 'assistant', content: 'старое' },
        { role: 'user', content: 'привет' },
        { role: 'assistant', content: 'первое\n\n[Tool: UpdateTask]\nInput: {}\nOutput: {}\n' },
        { role: 'assistant', content: 'второе' },
    ];
    assert.deepEqual(messagesSinceUserWrote(history), ['первое', 'второе']);
    assert.deepEqual(messagesSinceUserWrote([...history, { role: 'user', content: 'ок' }]), []);
});

test('at most the newest three unanswered messages are kept', () => {
    const history = ['а', 'б', 'в', 'г'].map(content => ({ role: 'assistant', content }));
    assert.deepEqual(messagesSinceUserWrote(history), ['б', 'в', 'г']);
});

test('the reminder prompt shows unanswered messages and asks for something new', () => {
    const task = { id: 'x', name: 'Медобзвон', requiresAction: true, annoyance: 'low' };
    const withHistory = BATCH_REMINDER_PROMPT('memory', [task], ['пора звонить врачу']);
    assert.match(withHistory, /YOUR MESSAGES SINCE THE USER LAST WROTE[\s\S]*- пора звонить врачу/);
    assert.match(withHistory, /one thing you haven't tried yet/);
    assert.doesNotMatch(BATCH_REMINDER_PROMPT('memory', [task]), /YOUR MESSAGES SINCE/);
});

test('the summarizer is no longer told to keep counts', () => {
    assert.doesNotMatch(HISTORY_COMPACTION_PROMPT('range', 'messages'), /N times/);
});
