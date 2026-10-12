import type TelegramBot from 'node-telegram-bot-api';

/** Longest silence allowed on a Telegram API socket before the call fails.
 * getUpdates long-polls for 10 s, so 30 s without a byte means the connection
 * is dead (for example a NAT or router drop that never sent a reset). Without
 * this limit that getUpdates call never settles, the library never schedules
 * the next poll, and the bot stops receiving messages while sends on fresh
 * connections still work and nothing is logged. With it the call fails with
 * ESOCKETTIMEDOUT, which reaches the polling_error handler, and polling
 * continues. The limit is on idle time, so a slow upload that is still sending
 * data is not cut off. */
export const TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;

export function telegramBotOptions(requestTimeoutMs = TELEGRAM_REQUEST_TIMEOUT_MS): TelegramBot.ConstructorOptions {
    return {
        // Telegram keeps the last allowed_updates list, so request callback queries explicitly or inline buttons are silently dropped.
        // The library form-encodes getUpdates params, so the array must be sent as a JSON string.
        polling: {params: {allowed_updates: JSON.stringify(['message', 'callback_query']) as unknown as string[]}},
        request: {timeout: requestTimeoutMs} as TelegramBot.ConstructorOptions['request'],
    };
}
