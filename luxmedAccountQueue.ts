type Work = { priority: number; run: () => Promise<unknown>; resolve: (value: any) => void; reject: (reason: unknown) => void };
/** Never preempt an HTTP request; submit bookings before queued searches. */
export class AccountQueue {
    private queues = new Map<number, Work[]>();
    private running = new Set<number>();
    run<T>(accountId: number, priority: number, run: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const queue = this.queues.get(accountId) || [];
            queue.push({ priority, run, resolve, reject }); this.queues.set(accountId, queue); this.pump(accountId);
        });
    }
    private pump(accountId: number): void {
        if (this.running.has(accountId)) return;
        const queue = this.queues.get(accountId);
        if (!queue?.length) { this.queues.delete(accountId); return; }
        queue.sort((a, b) => b.priority - a.priority);
        const job = queue.shift()!; this.running.add(accountId);
        void Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { this.running.delete(accountId); this.pump(accountId); });
    }
}
export const luxmedAccountQueue = new AccountQueue();
