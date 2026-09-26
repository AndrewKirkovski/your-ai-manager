import assert from 'node:assert/strict';
import { luxmedGetMonitorings, luxmedHealthCheck, LuxmedApiError } from '../luxmedAdapter.ts';

assert.equal(await luxmedHealthCheck(), true);
if (process.env.EXPECT_AUTH_FAILURE === 'true') {
    await assert.rejects(luxmedGetMonitorings(424242), (err: unknown) =>
        err instanceof LuxmedApiError && (err.status === 401 || err.status === 503));
} else {
    assert.deepEqual(await luxmedGetMonitorings(424242), []);
}
console.log('Bot adapter authentication and database read passed.');
