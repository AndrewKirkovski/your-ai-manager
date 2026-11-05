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

test('a bot prompt written to history at the start of a turn still reaches the model', async () => {
    // /start and /goal pass prompts that are only <system>, which rendering strips.
    const userId = await userWithMessage();
    const prompt = '<system>New user just started the bot. Greet them.</system>';
    const { provider, requests } = scriptedProvider([textTurn('ок')]);
    await AIService.streamAIResponse({ ...replyOptions, userId, userMessage: prompt, addUserToHistory: true, bot: fakeBot().bot, provider });

    assert.equal(requests[0].messages.at(-1)?.content, prompt);
    assert.equal(requests[0].messages.filter(m => m.content.includes('Greet them')).length, 1);
});

test('a prompt is sent as written, with no bare UTC stamp, when it is not stored', async () => {
    const userId = await userWithMessage();
    const prompt = '<system>due</system>';
    const { provider, requests } = scriptedProvider([textTurn('ок')]);
    await AIService.streamAIResponse({ ...replyOptions, userId, userMessage: prompt, bot: fakeBot().bot, provider });

    assert.equal(requests[0].messages.at(-1)?.content, prompt);
});

test('the forced retry does not send a stored message twice', async () => {
    const userId = await userWithMessage();
    const { provider, requests } = scriptedProvider([textTurn('ок')]);
    await AIService.streamAIResponse({
        ...replyOptions, userId, userMessage: '<system>prompt</system>', userRowWritten: true, bot: fakeBot().bot, provider,
    });

    assert.equal(requests[0].messages.filter(m => m.content.includes('prompt')).length, 1);
});

test('a tool record that lands after a newer message stays visible to the model', async () => {
    // A user message during a tool chain leaves rows user, user, assistant.
    const userId = await userWithMessage();
    await addMessageToHistory(userId, 'assistant', 'ранний ответ');
    await addMessageToHistory(userId, 'user', 'первый');
    await addMessageToHistory(userId, 'user', 'второй');
    await addMessageToHistory(userId, 'assistant', 'поздний\n\n[Tool: AddTask]\nInput: {"name":"молоко"}\nOutput: {"success":true}\n');
    const { provider, requests } = scriptedProvider([textTurn('ок')]);
    await AIService.streamAIResponse({ ...replyOptions, userId, bot: fakeBot().bot, provider });

    const sent = requests[0].messages;
    assert.equal(sent.at(-1)?.role, 'user');
    assert.match(sent.at(-1)!.content, /второй/);
    assert.ok(sent.some(m => m.role === 'assistant' && m.content.includes('Tools run: AddTask')));
});

test('a user-only history with a trailing bot row still ends on a user message', async () => {
    const userId = nextUserId++;
    await setUser(blankUser(userId));
    await addMessageToHistory(userId, 'user', 'один');
    await addMessageToHistory(userId, 'assistant', 'ответ');
    const { provider, requests } = scriptedProvider([textTurn('ок')]);
    await AIService.streamAIResponse({ ...replyOptions, userId, bot: fakeBot().bot, provider });

    assert.equal(requests[0].messages.at(-1)?.role, 'user');
});

test('at the tool depth limit tools stay declared and the model must answer', async () => {
    const userId = await userWithMessage();
    const rounds = Array.from({ length: 5 }, () => toolTurn('get_current_time'));
    const { provider, requests } = scriptedProvider([...rounds, textTurn('всё')]);
    await AIService.streamAIResponse({ ...replyOptions, userId, bot: fakeBot().bot, provider });

    assert.equal(requests.length, 6);
    assert.ok(requests[5].tools?.length);
    assert.deepEqual(requests[5].tools, requests[0].tools);
    assert.equal(requests[5].forbidToolUse, true);
    assert.equal(requests[4].forbidToolUse, false);

    // The note comes after the tool results and changes nothing before it.
    const last = requests[5].messages;
    assert.equal(last.at(-2)?.role, 'tool_result');
    assert.match(last.at(-1)!.content, /last tool round/);
    assert.deepEqual(last.slice(0, requests[4].messages.length), requests[4].messages);
});

test('a tool call cut off by max_tokens does not run, and the turn asks for budget', async () => {
    const userId = await userWithMessage();
    const { provider, requests } = scriptedProvider([[
        { type: 'text', content: 'начал' },
        { type: 'tool_call_start', index: 0, id: 'c1', name: 'get_current_time' },
        { type: 'tool_call_args', index: 0, args: '{"task' },
        { type: 'stop_reason', reason: 'max_tokens' },
        { type: 'done' },
    ]]);
    const { bot, sent } = fakeBot();
    const result = await AIService.streamAIResponse({ ...replyOptions, userId, bot, provider });

    assert.equal(requests.length, 1);
    assert.equal(result.ranOutOfTokens, true);
    assert.match(sent.at(-1) ?? '', /лимит/);
});

test('text with a less-than sign survives into history', async () => {
    const userId = await userWithMessage();
    const { provider } = scriptedProvider([toolTurn('get_current_time', { note: 'лампы <E27' }, 'если a<b то'), textTurn('готово')]);
    await AIService.streamAIResponse({ ...replyOptions, userId, bot: fakeBot().bot, provider });

    const [row] = await assistantRows(userId);
    assert.match(row, /если a<b то/);
    assert.match(row, /лампы <E27/);
    assert.match(row, /готово/);
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
