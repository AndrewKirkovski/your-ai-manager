import test from 'node:test';
import assert from 'node:assert/strict';
import { blankUser, fakeBot, scriptedProvider, textTurn, toolTurn } from './ai-fixture.ts';
import type { AssistantBlock, StreamChunk } from '../aiProvider.ts';

process.env.DB_PATH = ':memory:';
const { resolveOutputConfig, resolveThinkingConfig, ROUTE_EFFORT } = await import('../aiProvider.ts');
const { AnthropicProvider } = await import('../aiProvider.anthropic.ts');
const { AIService } = await import('../aiService.ts');
const { addMessageToHistory, getMessageHistoryWithIds, setUser } = await import('../userStore.ts');
const { estimateCacheCostUsd, estimateCostUsd } = await import('../pricing.ts');

const OPUS = 'claude-opus-5-5';

/** An Anthropic provider whose SDK client replays events and records the request. */
function providerWith(events: unknown[], response?: unknown) {
    const provider = new AnthropicProvider('test-key');
    const calls: { params: Record<string, unknown>; viaBeta: boolean }[] = [];
    const create = (viaBeta: boolean) => async (params: Record<string, unknown>) => {
        calls.push({ params, viaBeta });
        if (response) return response;
        return (async function* () { yield* events; })();
    };
    (provider as unknown as { client: unknown }).client = {
        messages: { create: create(false) },
        beta: { messages: { create: create(true) } },
    };
    return { provider, calls };
}
const collect = async (stream: AsyncIterable<StreamChunk>) => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
};
const request = (model = OPUS) => ({ systemPrompt: 's', messages: [], maxTokens: 100, model });
const endOfTurn = { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } };

test('Opus 5.5 never gets a disabled thinking config', () => {
    assert.deepEqual(resolveThinkingConfig(OPUS), { type: 'adaptive' });
    assert.equal(resolveThinkingConfig(OPUS, true), null);
});

test('models that can turn thinking off still do on the forced retry', () => {
    assert.deepEqual(resolveThinkingConfig('claude-sonnet-4-6', true), { type: 'disabled' });
});

test('the forced retry on Opus 5.5 still sends effort, so it reallocates the budget', () => {
    assert.deepEqual(resolveOutputConfig(OPUS, null, 'low'), { effort: 'low' });
    assert.deepEqual(resolveOutputConfig('claude-sonnet-4-6', { type: 'adaptive' }, 'high'), { effort: 'high' });
    assert.equal(resolveOutputConfig('claude-sonnet-4-6', { type: 'disabled' }, 'low'), null);
    assert.equal(resolveOutputConfig('claude-sonnet-4-5', { type: 'enabled', budget_tokens: 2000 }, 'high'), null);
});

test('replies keep high effort and background routes think less, without turning off', () => {
    assert.equal(ROUTE_EFFORT.reply, 'high');
    assert.equal(ROUTE_EFFORT['task-reminder'], 'medium');
    assert.equal(ROUTE_EFFORT.compaction, 'low');
});

test('Opus 5.5 requests carry effort and the refusal fallback through the beta path', async () => {
    const { provider, calls } = providerWith([endOfTurn]);
    await collect(provider.streamChat({ ...request(), effort: 'medium' }));

    assert.equal(calls[0].viaBeta, true);
    assert.deepEqual(calls[0].params.thinking, { type: 'adaptive' });
    assert.deepEqual(calls[0].params.output_config, { effort: 'medium' });
    assert.equal(calls[0].params.fallbacks, 'default');
    assert.deepEqual(calls[0].params.betas, ['server-side-fallback-2026-07-01']);
});

test('other models stay on the plain path with no fallback', async () => {
    const { provider, calls } = providerWith([endOfTurn]);
    await collect(provider.streamChat(request('claude-sonnet-4-6')));

    assert.equal(calls[0].viaBeta, false);
    assert.equal(calls[0].params.fallbacks, undefined);
});

test('a turn replays in the order it streamed, with thinking between other blocks', async () => {
    const { provider } = providerWith([
        { type: 'content_block_start', content_block: { type: 'thinking' } },
        { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'sig1' } },
        { type: 'content_block_stop' },
        { type: 'content_block_start', content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'привет' } },
        { type: 'content_block_stop' },
        { type: 'content_block_start', content_block: { type: 'thinking' } },
        { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'sig2' } },
        { type: 'content_block_stop' },
        { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Tool' } },
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a":1}' } },
        { type: 'content_block_stop' },
        endOfTurn,
    ]);
    const chunks = await collect(provider.streamChat(request()));
    const blocks = chunks.find(c => c.type === 'assistant_blocks') as { blocks: AssistantBlock[] };

    assert.deepEqual(blocks.blocks.map(b => b.type), ['thinking', 'text', 'thinking', 'tool_use']);
    assert.deepEqual(blocks.blocks.at(-1), { type: 'tool_use', id: 't1', name: 'Tool', input: { a: 1 } });

    const convert = (provider as unknown as { convertMessages(m: unknown[]): { content: unknown }[] }).convertMessages;
    assert.deepEqual(convert([{ role: 'assistant', content: 'ignored', blocks: blocks.blocks }])[0].content, blocks.blocks);
});

test('a fallback block drops thinking and tool blocks from before it and keeps text', async () => {
    const { provider } = providerWith([
        { type: 'content_block_start', content_block: { type: 'thinking' } },
        { type: 'content_block_stop' },
        { type: 'content_block_start', content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'начало' } },
        { type: 'content_block_stop' },
        { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Tool' } },
        { type: 'content_block_stop' },
        { type: 'content_block_start', content_block: { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } } },
        { type: 'content_block_stop' },
        endOfTurn,
    ]);
    const chunks = await collect(provider.streamChat(request()));
    const blocks = chunks.find(c => c.type === 'assistant_blocks') as { blocks: AssistantBlock[] };

    assert.ok(chunks.some(c => c.type === 'fallback'));
    assert.deepEqual(blocks.blocks, [{ type: 'text', text: 'начало' }]);
});

test('the refusal category reaches the consumer', async () => {
    const { provider } = providerWith([{ type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { category: 'bio' } }, usage: { output_tokens: 0 } }]);
    const chunks = await collect(provider.streamChat(request()));
    assert.deepEqual(chunks.find(c => c.type === 'stop_reason'), { type: 'stop_reason', reason: 'refusal', category: 'bio' });
});

for (const [label, content, stopReason] of [
    ['empty text', [{ type: 'text', text: '   ' }], 'end_turn'],
    ['only thinking', [{ type: 'thinking', thinking: '', signature: 's' }], 'end_turn'],
    ['a cut-off summary', [{ type: 'text', text: 'половина' }], 'max_tokens'],
    ['a refusal', [{ type: 'text', text: 'частично' }], 'refusal'],
] as const) {
    test(`completeChat throws on ${label}, so no stored row gets replaced`, async () => {
        const { provider } = providerWith([], { content, stop_reason: stopReason });
        await assert.rejects(provider.completeChat(request()), /Completion unusable/);
    });
}

test('completeChat keeps thinking on and sends the route effort', async () => {
    const { provider, calls } = providerWith([], { content: [{ type: 'text', text: 'итог' }], stop_reason: 'end_turn' });
    assert.equal(await provider.completeChat({ ...request(), effort: 'low' }), 'итог');
    assert.deepEqual(calls[0].params.thinking, { type: 'adaptive' });
    assert.deepEqual(calls[0].params.output_config, { effort: 'low' });
});

test('each route sends its effort, and the forced retry sends low', async () => {
    const userId = 6000;
    await setUser(blankUser(userId));
    await addMessageToHistory(userId, 'user', 'привет');
    const run = async (extra: object) => {
        const { provider, requests } = scriptedProvider([textTurn('ок')]);
        await AIService.streamAIResponse({
            userId, userMessage: '', systemPrompt: '', bot: fakeBot().bot, provider, model: OPUS,
            addUserToHistory: false, addAssistantToHistory: false, ...extra,
        });
        return requests[0].effort;
    };
    assert.equal(await run({}), 'high');
    assert.equal(await run({ purpose: 'task-reminder' }), 'medium');
    assert.equal(await run({ disableThinking: true }), 'low');
});

test('a refusal stores nothing, runs no tools and tells the user plainly', async () => {
    const userId = 6001;
    await setUser(blankUser(userId));
    await addMessageToHistory(userId, 'user', 'привет');
    const declined: StreamChunk[] = [
        { type: 'text', content: 'частично' },
        { type: 'tool_call_start', index: 0, id: 'c1', name: 'get_current_time' },
        { type: 'tool_call_args', index: 0, args: '{}' },
        { type: 'stop_reason', reason: 'refusal', category: 'bio' },
        { type: 'done' },
    ];
    const { provider, requests } = scriptedProvider([declined]);
    const { bot, sent } = fakeBot();
    const result = await AIService.streamAIResponse({
        userId, userMessage: '', systemPrompt: '', bot, provider, model: OPUS,
        addUserToHistory: false, addAssistantToHistory: true, enableToolCalls: true,
    });

    assert.equal(requests.length, 1);
    assert.equal(result.refused, true);
    assert.equal(sent.at(-1), 'С этим не помогу 🐺');
    assert.deepEqual((await getMessageHistoryWithIds(userId)).filter(m => m.role === 'assistant'), []);
});

test('a refusal after a tool ran keeps the tool record and still tells the user', async () => {
    const userId = 6002;
    await setUser(blankUser(userId));
    await addMessageToHistory(userId, 'user', 'привет');
    const { provider } = scriptedProvider([
        toolTurn('get_current_time'),
        [{ type: 'stop_reason', reason: 'refusal', category: null }, { type: 'done' }],
    ]);
    const { bot, sent } = fakeBot();
    await AIService.streamAIResponse({
        userId, userMessage: '', systemPrompt: '', bot, provider, model: OPUS,
        addUserToHistory: false, addAssistantToHistory: true, enableToolCalls: true,
    });

    assert.equal(sent.at(-1), 'С этим не помогу 🐺');
    const rows = (await getMessageHistoryWithIds(userId)).filter(m => m.role === 'assistant');
    assert.equal(rows.length, 1);
    assert.match(rows[0].content, /\[Tool: get_current_time\]/);
});

test('calls from a declined model are dropped when the fallback takes over', async () => {
    const userId = 6003;
    await setUser(blankUser(userId));
    await addMessageToHistory(userId, 'user', 'привет');
    const { provider, requests } = scriptedProvider([[
        { type: 'tool_call_start', index: 0, id: 'c1', name: 'get_current_time' },
        { type: 'tool_call_args', index: 0, args: '{}' },
        { type: 'fallback' },
        { type: 'text', content: 'ответ запасной модели' },
        { type: 'stop_reason', reason: 'end_turn' },
        { type: 'done' },
    ]]);
    await AIService.streamAIResponse({
        userId, userMessage: '', systemPrompt: '', bot: fakeBot().bot, provider, model: OPUS,
        addUserToHistory: false, addAssistantToHistory: true, enableToolCalls: true,
    });

    assert.equal(requests.length, 1);
});

test('prices cover the new model, and cache traffic has its own price', () => {
    assert.equal(estimateCostUsd(OPUS, 1_000_000, 1_000_000), 24);
    assert.equal(estimateCacheCostUsd(OPUS, 1_000_000, 0), 0.20);
    assert.equal(estimateCacheCostUsd(OPUS, 0, 1_000_000), 5);
    assert.equal(estimateCostUsd('claude-opus-4-7', 1_000_000, 0), 5);
});
