import { AsyncLocalStorage } from 'node:async_hooks';
import { smartStore } from './luxmedSmartStore';

/** Background reminder turns cannot approve review of incoming user messages. */
export const availabilityTurn = new AsyncLocalStorage<{ userId: number; holdToken: string | null; releasedToken?: string }>();

export function requireCurrentAvailabilityTurn(userId: number): void {
    const turn = availabilityTurn.getStore();
    if (!turn || turn.userId !== userId || turn.holdToken !== (smartStore.policy(userId)?.holdToken || null)) {
        throw new Error('A newer user message needs review before changing or confirming availability.');
    }
}
