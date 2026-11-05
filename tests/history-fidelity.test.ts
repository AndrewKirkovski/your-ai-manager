import test from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { blankUser, fakeBot, scriptedProvider, silentTurn, textTurn, toolTurn } from './ai-fixture.ts';

// Dynamic import so the test can never open the operator's bot.sqlite.
process.env.DB_PATH = ':memory:';
const { AIService, renderHistoryRow } = await import('../aiService.ts');
const { addMessageToHistory, getMessageHistoryWithIds, setUser } = await import('../userStore.ts');

let nextUserId = 1000;
async function userWithMessage(): Promise<number> {
    const userId = nextUserId++;
    await setUser(blankUser(userId));
    await addMessageToHistory(userId, 'user', 'привет');
    return userId;
}
const assistantRows = async (userId: number) =>
    (await getMessageHistoryWithIds(userId)).filter(m => m.role === 'assistant').map(m => m.content);
const replyOptions = { userMessage: '', systemPrompt: 'fixture', model: 'fixture', addUserToHistory: false, addAssistantToHistory: true, enableToolCalls: true };

test('a two-level tool chain writes one row holding every tool record in order', async () => {
    const userId = await userWithMessage();
    const { provider } = scriptedProvider([
        toolTurn('get_current_time', {}, 'смотрю'),
        toolTurn('get_current_time'),
        textTurn('готово'),
    ]);
    await AIService.streamAIResponse({ ...replyOptions, userId, bot: fakeBot().bot, provider });

    const rows = await assistantRows(userId);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /смотрю[\s\S]*\[Tool: get_current_time\][\s\S]*\[Tool: get_current_time\][\s\S]*готово/);
});

test('an abort during the child model call keeps the record and sends no tool-only ack', async () => {
    const userId = await userWithMessage();
    const controller = new AbortController();
    const { provider } = scriptedProvider([
        toolTurn('get_current_time'),
        () => { controller.abort(); return textTurn('не дойдёт'); },
    ]);
    const { bot, sent } = fakeBot();
    const result = await AIService.streamAIResponse({ ...replyOptions, userId, bot, provider, signal: controller.signal });

    assert.equal(result.emptyReason, 'aborted');
    assert.deepEqual(sent, []);
    const rows = await assistantRows(userId);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /\[Tool: get_current_time\]/);
});

test('an abort in the child tool loop hands the child text up to the one row', async () => {
    const userId = await userWithMessage();
    const controller = new AbortController();
    const { provider } = scriptedProvider([
        toolTurn('get_current_time'),
        toolTurn('get_current_time', {}, 'ещё шаг'),
    ]);
    const { bot } = fakeBot(text => { if (text.includes('ещё шаг')) controller.abort(); });
    const result = await AIService.streamAIResponse({ ...replyOptions, userId, bot, provider, signal: controller.signal });

    assert.equal(result.emptyReason, 'aborted');
    const rows = await assistantRows(userId);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /\[Tool: get_current_time\][\s\S]*ещё шаг/);
});

test('a child model failure still leaves one row with the tool record', async () => {
    const userId = await userWithMessage();
    const { provider } = scriptedProvider([
        toolTurn('get_current_time'),
        () => { throw Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, undefined, new Headers()); },
    ]);
    await AIService.streamAIResponse({ ...replyOptions, userId, bot: fakeBot().bot, provider });

    const rows = await assistantRows(userId);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /\[Tool: get_current_time\]/);
});

test('a reminder that writes text then calls a tool writes one row', async () => {
    const userId = await userWithMessage();
    const { provider } = scriptedProvider([toolTurn('get_current_time', {}, 'ещё висит'), silentTurn()]);
    await AIService.streamAIResponse({ ...replyOptions, userId, userMessage: '<system>due</system>', bot: fakeBot().bot, provider, proactive: true });

    const rows = await assistantRows(userId);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /ещё висит/);
});

test('the LuxMed review tool leaves no trace in history and does not count as tool use', async () => {
    const userId = await userWithMessage();
    const { provider } = scriptedProvider([toolTurn('LuxmedAvailabilityReviewed', { hold_token: 'x' }), textTurn('ответ')]);
    const result = await AIService.streamAIResponse({ ...replyOptions, userId, bot: fakeBot().bot, provider });

    assert.deepEqual(await assistantRows(userId), ['ответ']);
    assert.equal(result.usedTools, undefined);
});

test('a row added mid-chain does not change what the model already answered', async () => {
    const userId = await userWithMessage();
    const { provider, requests } = scriptedProvider([
        () => { void addMessageToHistory(userId, 'user', 'новое сообщение'); return toolTurn('get_current_time'); },
        textTurn('готово'),
    ]);
    await AIService.streamAIResponse({ ...replyOptions, userId, bot: fakeBot().bot, provider });

    assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages);
});

test('a message written to history at the start of a turn reaches the model once', async () => {
    const userId = await userWithMessage();
    const { provider, requests } = scriptedProvider([textTurn('ок')]);
    await AIService.streamAIResponse({ ...replyOptions, userId, userMessage: 'один раз', addUserToHistory: true, bot: fakeBot().bot, provider });

    const copies = requests[0].messages.filter(m => m.content.includes('один раз'));
    assert.equal(copies.length, 1);
});

test('tool records render inside the wrapper, away from what the model says', () => {
    const stored = 'текст\n\n[Tool: UpdateTask]\nInput: {"a":1}\nOutput: {"success":true}\nдальше';
    assert.equal(
        renderHistoryRow('assistant', stored, 'сегодня в 13:29'),
        '<system>At сегодня в 13:29. Tools run: UpdateTask({"a":1}) -> {"success":true}</system>\nтекст\nдальше',
    );
});

test('rendering drops hidden tools, cuts long records and leaves user rows alone', () => {
    const hidden = 'текст\n\n[Tool: LuxmedAvailabilityReviewed]\nInput: {}\nOutput: {"success":false}\n';
    assert.equal(renderHistoryRow('assistant', hidden, 'x'), '<system>At x</system>\nтекст');

    const long = `\n\n[Tool: GetTasks]\nInput: {}\nOutput: ${'я'.repeat(500)}\n`;
    const rendered = renderHistoryRow('assistant', long, 'x');
    assert.ok(rendered.length < 240, `rendered ${rendered.length} chars`);

    const fromUser = '[Tool: Fake]\nInput: {}\n';
    assert.equal(renderHistoryRow('user', fromUser, 'x'), `<system>At x</system>\n${fromUser}`);
});
