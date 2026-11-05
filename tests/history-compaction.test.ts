import test from 'node:test';
import assert from 'node:assert/strict';
import { blankUser, scriptedProvider } from './ai-fixture.ts';

process.env.DB_PATH = ':memory:';
const { findCompactableRuns, runHistoryCompaction } = await import('../historyCompaction.ts');
const { addMessageToHistory, getMessageHistoryWithIds, setUser } = await import('../userStore.ts');

const history = (roles: string) => [...roles].map((r, id) => ({
    id, role: r === 'u' ? 'user' as const : 'assistant' as const, content: String(id), timestamp: new Date(),
}));
const spans = (roles: string) => findCompactableRuns(history(roles)).map(run => [run.startId, run.endId]);

test('a reply and the reminder after it stay as they are', () => {
    assert.deepEqual(spans('uaa'), []);
});

test('the reply after a user row is never summarized', () => {
    assert.deepEqual(spans('uaaaaaa'), [[2, 3]]);
});

test('the last three rows of a run stay readable', () => {
    assert.deepEqual(spans('aaaaa'), [[0, 1]]);
    assert.deepEqual(spans('uaaaa'), []);
});

test('runs between user rows are handled separately', () => {
    assert.deepEqual(spans('uaaaaaauaaaaaa'), [[2, 3], [9, 10]]);
});

test('compaction keeps rows when the summarizer returns nothing', async () => {
    const userId = 2000;
    await setUser(blankUser(userId));
    await addMessageToHistory(userId, 'user', 'привет');
    for (let i = 0; i < 6; i++) await addMessageToHistory(userId, 'assistant', `напоминание ${i}`);

    const { provider } = scriptedProvider([], () => '   ');
    await runHistoryCompaction(provider, 'fixture');

    assert.equal((await getMessageHistoryWithIds(userId)).length, 7);
});

test('a new summary uses absolute dates and carries no relative words', async () => {
    const userId = 2001;
    await setUser(blankUser(userId));
    await addMessageToHistory(userId, 'user', 'привет');
    for (let i = 0; i < 6; i++) await addMessageToHistory(userId, 'assistant', `напоминание ${i}`);

    const { provider, completions } = scriptedProvider([], () => 'Сегодня напомнил про врача, завтра снова');
    await runHistoryCompaction(provider, 'fixture');

    const prompt = completions[0].messages[0].content;
    assert.doesNotMatch(prompt, /сегодня в \d/);
    assert.match(prompt, /\d{4}, \d\d:\d\d/);

    const summary = (await getMessageHistoryWithIds(userId)).find(m => m.content.includes('Compacted summary'));
    assert.ok(summary);
    assert.match(summary.content, /<\/system>\nВ тот день напомнил про врача, на следующий день снова$/);
    assert.doesNotMatch(summary.content, /сегодня/i);
});
