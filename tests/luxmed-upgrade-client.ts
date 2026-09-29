import assert from 'node:assert/strict';
// Dynamic import lets the same fixture use the adapter bundled in either bot
// image. The pinned old image has none of the smart capability functions.
const api = await import('../luxmedAdapter.ts');

assert.equal(await api.luxmedHealthCheck(), true);
if (process.env.EXPECT_LEGACY_BOT_AUTH_FAILURE === 'true') {
    await assert.rejects(api.luxmedGetMonitorings(424242), (err: unknown) =>
        err instanceof Error && err.message === 'Unauthorized');
} else if (process.env.EXPECT_LEGACY_BOT_READ === 'true') {
    assert.deepEqual(await api.luxmedGetMonitorings(424242), []);
} else if (process.env.EXPECT_AUTH_FAILURE === 'true') {
    await assert.rejects(api.luxmedGetMonitorings(424242), (err: unknown) =>
        err instanceof api.LuxmedApiError && (err.status === 401 || err.status === 503));
} else {
    assert.deepEqual(await api.luxmedGetMonitorings(424242), []);
    if(process.env.EXPECT_LEGACY_SMART_CAPABILITIES==='true') {
        const capabilities = await api.luxmedCapabilities();
        assert.ok(capabilities.includes('cancellation-receipts-v1'));
        assert.ok(!capabilities.includes('cancellation-receipts-v2'));
    } else if(process.env.EXPECT_SMART_CAPABILITIES==='true') {
        const capabilities = await api.luxmedCapabilities();
        for (const required of ['smart-booking-v1', 'reservation-end-times-v1', 'smart-booking-attempts-v2', 'monitor-quiesce-v1', 'reservation-range-complete-v1', 'legacy-monitor-fence-v1', 'legacy-booking-barrier-v1', 'smart-booking-enrollment-fence-v2', 'smart-booking-identity-fence-v1', 'cancellation-receipts-v2'])
            assert.ok(capabilities.includes(required), `missing ${required}`);
        assert.equal((await api.luxmedLegacyBookingBarrier(424242)).state, 'clear');
        assert.equal((await api.luxmedSmartEnrollment(424242)).enrolled, false);
        if(process.env.EXPECT_ATTEMPT_PERSISTENCE==='true') {
            assert.equal((await api.luxmedBookingAttempt(424242,'00000000-0000-0000-0000-000000424242')).state,'unknown');
            await api.luxmedEnrollSmartAccount(424242, []);
            assert.equal((await api.luxmedSmartEnrollment(424242)).enrolled, true);
        }
    } else {
        // The new bot must leave smart booking disabled when Watchtower updates it first.
        await assert.rejects(api.luxmedCapabilities());
    }
}
console.log(process.env.EXPECT_LEGACY_BOT_AUTH_FAILURE === 'true'
    ? 'Pinned old bot cannot authenticate to the new sidecar during sidecar-first replacement.'
    : 'Bot adapter authentication and database read passed.');
