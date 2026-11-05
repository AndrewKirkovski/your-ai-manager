import test from 'node:test';
import assert from 'node:assert/strict';
import { blankUser, fakeBot, scriptedProvider, textTurn, toolTurn } from './ai-fixture.ts';

process.env.DB_PATH = ':memory:';
const { AIService } = await import('../aiService.ts');
const { addMessageToHistory, setUser } = await import('../userStore.ts');
const { formatDateAbsolute, formatDateWithOffset, formatNowForPrompt } = await import('../dateUtils.ts');

test('the Now line names the weekday, date and Warsaw offset', () => {
    assert.equal(
        formatNowForPrompt(new Date('2026-10-26T12:29:00Z')),
        'Now: понедельник, 26 октября 2026, 13:29 (2026-10-26T13:29+01:00, Europe/Warsaw)',
    );
});

test('the offset follows daylight saving', () => {
    assert.equal(formatDateWithOffset(new Date('2026-07-01T10:00:00Z')), '2026-07-01T12:00+02:00');
    assert.equal(formatDateWithOffset(new Date('2026-11-05T10:00:00Z')), '2026-11-05T11:00+01:00');
});

test('absolute dates carry the year and no relative words', () => {
    assert.equal(formatDateAbsolute(new Date()).includes('сегодня'), false);
    assert.equal(formatDateAbsolute(new Date('2026-10-13T08:00:00Z')), '13 октября 2026, 10:00');
});

test('the burst path, which has no current message, still gets today\'s date', async () => {
    const userId = 4000;
    await setUser(blankUser(userId));
    await addMessageToHistory(userId, 'user', 'а сегодня какое');
    const { provider, requests } = scriptedProvider([textTurn('ок')]);

    await AIService.streamAIResponse({
        userId, userMessage: '', systemPrompt: 'контекст', bot: fakeBot().bot, provider, model: 'fixture',
        addUserToHistory: false, addAssistantToHistory: true,
    });

    assert.match(requests[0].systemPrompt, new RegExp(`^Now: .*${new Date().getFullYear()}.*Europe/Warsaw\\)\\nконтекст$`));
});

test('a tool chain keeps one identical Now line', async () => {
    const userId = 4001;
    await setUser(blankUser(userId));
    await addMessageToHistory(userId, 'user', 'привет');
    const { provider, requests } = scriptedProvider([toolTurn('get_current_time'), toolTurn('get_current_time'), textTurn('ок')]);

    await AIService.streamAIResponse({
        userId, userMessage: '', systemPrompt: 'контекст', bot: fakeBot().bot, provider, model: 'fixture',
        addUserToHistory: false, addAssistantToHistory: true, enableToolCalls: true,
    });

    assert.equal(requests.length, 3);
    for (const request of requests) {
        assert.equal(request.systemPrompt, requests[0].systemPrompt);
        assert.equal(request.systemPrompt.match(/Now: /g)?.length, 1);
    }
});

test('no message reaches the model with a bare UTC stamp', async () => {
    const userId = 4002;
    await setUser(blankUser(userId));
    const { provider, requests } = scriptedProvider([textTurn('ок')]);

    await AIService.streamAIResponse({
        userId, userMessage: '<system>due</system>', systemPrompt: '', bot: fakeBot().bot, provider, model: 'fixture',
        addUserToHistory: false, addAssistantToHistory: false,
    });

    assert.doesNotMatch(JSON.stringify(requests[0].messages), /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
});
