import test from 'node:test';
import assert from 'node:assert/strict';
import { blankUser, scriptedProvider } from './ai-fixture.ts';

process.env.DB_PATH = ':memory:';
const { findCompactableRuns, runHistoryCompaction } = await import('../historyCompaction.ts');
const { addMessageToHistory, compactMessages, getMessageHistoryWithIds, setUser } = await import('../userStore.ts');

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

test('a reply near the start of a history selects nothing', () => {
    // These ended a run at index 1 or 2, where the tail cut-off goes negative. slice()
    // then read it from the end and swallowed the whole history, user rows included.
    for (const roles of ['ua', 'au', 'uau', 'uaua', 'uauaua', 'auauau', 'uauauauauauauauauauaua', 'uuaua']) {
        assert.deepEqual(spans(roles), [], roles);
    }
});

test('no selected run ever holds a user row, for any history', () => {
    for (let length = 1; length <= 14; length++) {
        for (let bits = 0; bits < 2 ** length; bits++) {
            const roles = Array.from({ length }, (_, i) => (bits >> i) & 1 ? 'a' : 'u').join('');
            const rows = history(roles);
            for (const run of findCompactableRuns(rows)) {
                const covered = rows.filter(r => r.id >= run.startId && r.id <= run.endId);
                assert.ok(covered.every(r => r.role === 'assistant'), roles);
                assert.equal(covered.length, run.messages.length, roles);
                assert.ok(covered.length >= 2, roles);
                assert.equal(covered.at(-1)!.id < rows.length - 3 || rows[run.endId + 1]?.role === 'assistant', true, roles);
            }
        }
    }
});

test('a wrong range can never delete a user message', async () => {
    const userId = 2002;
    await setUser(blankUser(userId));
    for (const [role, text] of [['user', 'раз'], ['assistant', 'два'], ['user', 'три'], ['assistant', 'четыре']] as const) {
        await addMessageToHistory(userId, role, text);
    }
    const rows = await getMessageHistoryWithIds(userId);

    assert.throws(() => compactMessages(userId, rows[0].id, rows[3].id, 'итог', rows[0].timestamp), /Refusing to compact/);
    assert.deepEqual((await getMessageHistoryWithIds(userId)).map(r => r.content), ['раз', 'два', 'три', 'четыре']);
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
