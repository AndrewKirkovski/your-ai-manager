import test from 'node:test';
import assert from 'node:assert/strict';
import { blankUser, scriptedProvider } from './ai-fixture.ts';

// runStyleScan logs for every user, and each test here adds more users. The test runner
// reads results from this process's stdout, and that much logging intermittently broke
// the stream with "Unable to deserialize cloned data".
console.log = () => {};

process.env.DB_PATH = ':memory:';
const { runStyleScan, userWordsInRow } = await import('../styleScan.ts');
const { addMessageToHistory, getUserMemory, setUser, updateUserMemory } = await import('../userStore.ts');

const PRIOR = 'Long notes about how this user writes and reacts. '.repeat(10);
const TEXT = 'обычное сообщение пользователя про дела и планы на неделю, с подробностями и мнением о них. ';
const reply = (style: string, adhd: string) =>
    `<communication_style>${style}</communication_style>\n<adhd_reactions>${adhd}</adhd_reactions>`;

let nextUserId = 3000;
async function userWithRows(rows: string[], prior = true): Promise<number> {
    const userId = nextUserId++;
    await setUser(blankUser(userId));
    if (prior) {
        await updateUserMemory(userId, 'communication_style', PRIOR);
        await updateUserMemory(userId, 'adhd_reactions', PRIOR);
    }
    await new Promise(resolve => setTimeout(resolve, 2));
    for (const row of rows) await addMessageToHistory(userId, 'user', row);
    return userId;
}
const textRows = (count: number) => Array.from({ length: count }, () => TEXT);
const PHOTO = '[User sent a photo]\nImage description: two people\n[End of photo description]';

// runStyleScan walks every user, so each test checks the prompts about its own text.
const scanned = (prompts: { messages: { content: string }[] }[], marker: string) =>
    prompts.filter(p => p.messages[0].content.includes(marker));

test('media descriptions and synthetic prompts are not the user\'s words', () => {
    assert.equal(userWordsInRow(PHOTO), '');
    assert.equal(userWordsInRow(`${PHOTO}\nсмотри какая красота`), 'смотри какая красота');
    assert.equal(userWordsInRow('[User shared location]\nlat 52'), '');
    assert.equal(userWordsInRow('<system>due</system>'), '');
    assert.equal(userWordsInRow('просто текст'), 'просто текст');
    assert.equal(userWordsInRow('[Custom emojis in this message:\n- 😀 (cache_key=1): laughing wolf\n]\nок'), 'ок');
});

test('a thin sample does not reach the model and leaves the notes alone', async () => {
    const marker = 'тонкая выборка';
    const userId = await userWithRows([`${marker} ${TEXT}`, `${marker} ${TEXT}`, `${marker} ${TEXT}`]);
    const { provider, completions } = scriptedProvider([], () => reply('x', 'y'));
    await runStyleScan(provider, 'fixture');

    assert.deepEqual(scanned(completions, marker), []);
    assert.equal(await getUserMemory(userId, 'communication_style'), PRIOR);
});

test('a run of photos is not a sample, however many there are', async () => {
    const userId = await userWithRows(Array.from({ length: 30 }, () => PHOTO));
    const { provider } = scriptedProvider([], () => reply('описание фото', 'описание фото'));
    await runStyleScan(provider, 'fixture');

    assert.equal(await getUserMemory(userId, 'communication_style'), PRIOR);
});

test('output much shorter than the prior notes is rejected', async () => {
    const userId = await userWithRows(textRows(25));
    const { provider } = scriptedProvider([], () => reply('All prior notes hold.', 'No signal.'));
    await runStyleScan(provider, 'fixture');

    assert.equal(await getUserMemory(userId, 'communication_style'), PRIOR);
    assert.equal(await getUserMemory(userId, 'adhd_reactions'), PRIOR);
});

test('no_change keeps the notes and those messages are not scanned again', async () => {
    const marker = 'без изменений';
    const userId = await userWithRows(textRows(25).map(row => `${marker} ${row}`));
    const { provider, completions } = scriptedProvider([], () => '<no_change/>');
    await runStyleScan(provider, 'fixture');
    await new Promise(resolve => setTimeout(resolve, 2));
    await runStyleScan(provider, 'fixture');

    assert.equal(scanned(completions, marker).length, 1);
    assert.equal(await getUserMemory(userId, 'communication_style'), PRIOR);
});

test('a full update replaces the notes', async () => {
    const userId = await userWithRows(textRows(25));
    const next = 'Updated notes that keep what still holds and add what changed. '.repeat(8).trim();
    const { provider } = scriptedProvider([], () => reply(next, next));
    await runStyleScan(provider, 'fixture');

    assert.equal(await getUserMemory(userId, 'communication_style'), next);
});

test('deleted notes are rebuilt from the user rows', async () => {
    const userId = await userWithRows(textRows(25), false);
    const { provider } = scriptedProvider([], () => reply('rebuilt style', 'rebuilt adhd'));
    await runStyleScan(provider, 'fixture');

    assert.equal(await getUserMemory(userId, 'communication_style'), 'rebuilt style');
    assert.equal(await getUserMemory(userId, 'adhd_reactions'), 'rebuilt adhd');
});
