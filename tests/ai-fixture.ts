import type TelegramBot from 'node-telegram-bot-api';
import type { AIProvider, CompletionRequest, StreamChunk, StreamRequest } from '../aiProvider.ts';

type Turn = StreamChunk[] | (() => StreamChunk[]);

export const textTurn = (text: string): StreamChunk[] => [
    { type: 'text', content: text },
    { type: 'stop_reason', reason: 'end_turn' },
    { type: 'done' },
];

export const toolTurn = (name: string, args: Record<string, unknown> = {}, text?: string): StreamChunk[] => [
    ...(text ? [{ type: 'text', content: text } as StreamChunk] : []),
    { type: 'tool_call_start', index: 0, id: `call_${name}`, name },
    { type: 'tool_call_args', index: 0, args: JSON.stringify(args) },
    { type: 'stop_reason', reason: 'tool_use' },
    { type: 'done' },
];

export const silentTurn = (): StreamChunk[] => [{ type: 'stop_reason', reason: 'end_turn' }, { type: 'done' }];

/** A provider that plays the given turns in order and keeps every request it saw. */
export function scriptedProvider(turns: Turn[], complete: (request: CompletionRequest) => string = () => '') {
    const requests: StreamRequest[] = [];
    const completions: CompletionRequest[] = [];
    const provider: AIProvider = {
        name: 'fixture',
        async *streamChat(request) {
            requests.push(request);
            const next = turns.shift();
            if (!next) throw new Error('Provider got a request the test did not expect');
            yield* typeof next === 'function' ? next() : next;
        },
        async completeChat(request) {
            completions.push(request);
            return complete(request);
        },
    };
    return { provider, requests, completions };
}

/** A Telegram client that records sent text. `onSend` runs before each send returns. */
export function fakeBot(onSend?: (text: string) => void) {
    const sent: string[] = [];
    const bot = new Proxy({}, {
        get: (_target, method) => async (...args: unknown[]) => {
            if (method === 'sendMessage') {
                sent.push(String(args[1]));
                onSend?.(String(args[1]));
            }
            return { message_id: 1, chat: { id: 1 }, date: 0 };
        },
    }) as TelegramBot;
    return { bot, sent };
}

export const blankUser = (userId: number) => ({
    userId, preferences: { goal: '' }, routines: [], tasks: [], memory: {}, messageHistory: [],
});
