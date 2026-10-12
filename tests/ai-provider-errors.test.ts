import test from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type TelegramBot from 'node-telegram-bot-api';
import type { AIProvider, StreamChunk } from '../aiProvider.ts';

// Dynamic import so the test can never open the operator's bot.sqlite.
process.env.DB_PATH = ':memory:';
const { AIService, classifyProviderError } = await import('../aiService.ts');

const CREDIT_MESSAGE = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
const headers = new Headers();
const anthropicError = (status: number, type: string, message: string) =>
    Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, undefined, headers);
const openAIError = (status: number, error: Record<string, string>) =>
    OpenAI.APIError.generate(status, { error }, undefined, headers);

test('an exhausted Anthropic balance is classified as credits in both provider modes', () => {
    assert.equal(classifyProviderError(anthropicError(400, 'invalid_request_error', CREDIT_MESSAGE)), 'credits');
    assert.equal(classifyProviderError(openAIError(400, { type: 'invalid_request_error', message: CREDIT_MESSAGE })), 'credits');
    assert.equal(classifyProviderError(openAIError(429, { type: 'insufficient_quota', code: 'insufficient_quota',
        message: 'You exceeded your current quota, please check your plan and billing details.' })), 'credits');
});

test('other provider failures keep their previous classes', () => {
    assert.equal(classifyProviderError(anthropicError(401, 'authentication_error', 'invalid x-api-key')), 'auth');
    assert.equal(classifyProviderError(anthropicError(429, 'rate_limit_error', 'This request would exceed the rate limit for your organization.')), 'transient');
    assert.equal(classifyProviderError(anthropicError(529, 'overloaded_error', 'Overloaded')), 'transient');
    assert.equal(classifyProviderError(anthropicError(400, 'invalid_request_error', 'messages: roles must alternate')), 'malformed');
});

test('a reply that fails on credits tells the user once and is not retried', async () => {
    let calls = 0;
    const provider: AIProvider = {
        name: 'fixture',
        // eslint-disable-next-line require-yield
        async *streamChat(): AsyncIterable<StreamChunk> {
            calls++;
            throw anthropicError(400, 'invalid_request_error', CREDIT_MESSAGE);
        },
    } as AIProvider;
    const sent: string[] = [];
    const bot = new Proxy({}, {
        get: (_target, method) => async (...args: unknown[]) => {
            if (method === 'sendMessage') sent.push(String(args[1]));
            return { message_id: 1, chat: { id: 1 }, date: 0 };
        },
    }) as TelegramBot;

    const result = await AIService.streamAIResponse({
        userId: 1, userMessage: 'привет', systemPrompt: 'fixture', bot, provider, model: 'fixture',
        addUserToHistory: false, addAssistantToHistory: false, enableToolCalls: false,
    });

    assert.equal(calls, 1);
    assert.deepEqual(sent, ['У меня кончились токены 🐺 Пополни баланс Anthropic — до этого я отвечать не смогу.']);
    assert.equal(result.message, sent[0]);
});
