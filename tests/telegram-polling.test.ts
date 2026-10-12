import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_REQUEST_TIMEOUT_MS, telegramBotOptions } from '../telegramBotOptions.ts';

/** Fake Telegram API. The first getUpdates call is accepted and never answered,
 * like a connection that died without a reset. Later calls deliver one message. */
async function startSilentFirstPollServer() {
    let polls = 0;
    const server = http.createServer((req, res) => {
        if (!req.url?.endsWith('/getUpdates')) {
            res.end(JSON.stringify({ ok: true, result: true }));
            return;
        }
        req.resume();
        polls++;
        if (polls === 1) return;
        const result = polls === 2 ? [{ update_id: 1, message: {
            message_id: 1, date: 1, chat: { id: 1, type: 'private' }, text: 'hello',
        } }] : [];
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, result }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        baseApiUrl: `http://127.0.0.1:${port}`,
        polls: () => polls,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
}

function receiveMessage(bot: TelegramBot, withinMs: number): Promise<string | null> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), withinMs);
        bot.once('message', msg => { clearTimeout(timer); resolve(msg.text ?? ''); });
    });
}

test('production Telegram options limit every request', () => {
    assert.equal(TELEGRAM_REQUEST_TIMEOUT_MS, 30_000);
    assert.deepEqual(telegramBotOptions().request, { timeout: 30_000 });
});

test('polling recovers after a getUpdates connection goes silent', async () => {
    const server = await startSilentFirstPollServer();
    const bot = new TelegramBot('fixture-token', { ...telegramBotOptions(300), baseApiUrl: server.baseApiUrl });
    const errors: string[] = [];
    bot.on('polling_error', err => errors.push((err as Error).message));
    try {
        const text = await receiveMessage(bot, 5_000);
        assert.equal(text, 'hello');
        assert.ok(errors.some(message => message.includes('ESOCKETTIMEDOUT')), `expected a socket timeout, got ${JSON.stringify(errors)}`);
        assert.ok(server.polls() >= 2);
    } finally {
        // Not { cancel: true }: the library's finally handler still runs on
        // cancel and schedules another poll. Closing the server ends a hung call.
        const stopped = bot.stopPolling();
        await server.close();
        await stopped;
    }
});

test('without a request limit the same silent connection stops polling', async () => {
    const server = await startSilentFirstPollServer();
    const { request: _limit, ...unlimited } = telegramBotOptions();
    const bot = new TelegramBot('fixture-token', { ...unlimited, baseApiUrl: server.baseApiUrl });
    const errors: string[] = [];
    bot.on('polling_error', err => errors.push((err as Error).message));
    try {
        const text = await receiveMessage(bot, 1_500);
        assert.equal(text, null);
        assert.equal(server.polls(), 1);
        assert.deepEqual(errors, []);
    } finally {
        // Not { cancel: true }: the library's finally handler still runs on
        // cancel and schedules another poll. Closing the server ends a hung call.
        const stopped = bot.stopPolling();
        await server.close();
        await stopped;
    }
});
