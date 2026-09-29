import test from 'node:test';
import assert from 'node:assert/strict';
import TelegramBot from 'node-telegram-bot-api';
import { slashMessageNeedsAvailabilityHold, slashMessageNeedsIngressHold } from '../luxmedAvailabilityIngress.ts';

test('Telegram delivers the message ingress before matching slash handlers', () => {
    const bot = new TelegramBot('fixture-token', { polling: false });
    const order: string[] = [];
    bot.on('message', () => order.push('message'));
    bot.onText(/\/busy/, () => order.push('onText'));
    bot.processUpdate({ update_id: 1, message: {
        message_id: 1, date: 1, chat: { id: 1, type: 'private' }, text: '/busy Tuesday 10-12',
    } } as TelegramBot.Update);
    assert.deepEqual(order, ['message', 'onText']);
});

test('unknown slash schedule text holds availability before command dispatch', () => {
    assert.equal(slashMessageNeedsAvailabilityHold('/busy Tuesday 10-12'), true);
    assert.equal(slashMessageNeedsAvailabilityHold('/book after 11 Tuesday'), true);
    assert.equal(slashMessageNeedsAvailabilityHold('/goal Polish until 11 Tuesday'), true);
    assert.equal(slashMessageNeedsAvailabilityHold('/forget Friday trip'), true);
    assert.equal(slashMessageNeedsAvailabilityHold('/tasks after 11 Tuesday'), true);
});

test('exact read-only commands and a version challenge do not pause booking', () => {
    assert.equal(slashMessageNeedsAvailabilityHold('/tasks'), false);
    assert.equal(slashMessageNeedsAvailabilityHold('/goal'), false);
    assert.equal(slashMessageNeedsAvailabilityHold('/version abcdefgh'), false);
    assert.equal(slashMessageNeedsAvailabilityHold('/version good_nonce'), false);
    assert.equal(slashMessageNeedsAvailabilityHold('/version short'), true);
    assert.equal(slashMessageNeedsAvailabilityHold('/version bad!'), true);
    assert.equal(slashMessageNeedsAvailabilityHold('Polish until 11 Tuesday'), false);
});

test('goal text is held only by its command handler, keeping its pause token visible', () => {
    assert.equal(slashMessageNeedsAvailabilityHold('/goal I am away Friday'), true);
    assert.equal(slashMessageNeedsIngressHold('/goal I am away Friday'), false);
    assert.equal(slashMessageNeedsIngressHold('/goal@my_bot I am away Friday'), false);
    assert.equal(slashMessageNeedsIngressHold('/goal\nI am away Friday'), true);
    assert.equal(slashMessageNeedsIngressHold('/goal  \nI am away Friday'), true);
    assert.equal(slashMessageNeedsIngressHold('/busy Friday'), true);
});
