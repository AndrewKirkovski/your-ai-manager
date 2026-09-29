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
    if (process.env.EXPECT_LEGACY_BARRIER_ACK === 'v1' || process.env.EXPECT_LEGACY_BARRIER_ACK === 'v2') {
        const barrier = await api.luxmedLegacyBookingBarrier(424248);
        assert.equal(barrier.state, 'succeeded');
        assert.equal(barrier.reservationId, 77248);
        if (process.env.EXPECT_LEGACY_BARRIER_ACK === 'v1')
            await api.luxmedAcknowledgeLegacyBooking(424248, 77248);
        else
            await api.luxmedAcknowledgeLegacyBooking(424248, 77248, barrier.id, barrier.start);
        assert.equal((await api.luxmedLegacyBookingBarrier(424248)).state, 'clear');
    }
} else if (process.env.EXPECT_AUTH_FAILURE === 'true') {
    await assert.rejects(api.luxmedGetMonitorings(424242), (err: unknown) =>
        err instanceof api.LuxmedApiError && (err.status === 401 || err.status === 503));
} else {
    assert.deepEqual(await api.luxmedGetMonitorings(424242), []);
    if(process.env.EXPECT_LEGACY_SMART_CAPABILITIES==='true') {
        const capabilities = await api.luxmedCapabilities();
        assert.ok(capabilities.includes('cancellation-receipts-v1'));
        assert.ok(!capabilities.includes('cancellation-receipts-v2'));
    } else if(process.env.EXPECT_LEGACY_V2_CAPABILITIES==='true') {
        const capabilities = await api.luxmedCapabilities();
        assert.ok(capabilities.includes('smart-booking-attempts-v2'));
        assert.ok(capabilities.includes('cancellation-receipts-v2'));
        assert.ok(!capabilities.includes('smart-booking-attempts-v4'));
    } else if(process.env.EXPECT_SMART_CAPABILITIES==='true') {
        const capabilities = await api.luxmedCapabilities();
        for (const required of ['smart-booking-v1', 'reservation-end-times-v1', 'smart-booking-attempts-v3', 'smart-booking-attempts-v4', 'smart-booking-lockterm-review-v1', 'monitor-quiesce-v1', 'reservation-range-complete-v1', 'legacy-monitor-fence-v1', 'legacy-booking-barrier-v2', 'smart-booking-enrollment-fence-v2', 'smart-booking-identity-fence-v1', 'cancellation-receipts-v3'])
            assert.ok(capabilities.includes(required), `missing ${required}`);
        assert.equal((await api.luxmedLegacyBookingBarrier(424242)).state, 'clear');
        assert.equal((await api.luxmedSmartEnrollment(424242)).enrolled, false);
        if(process.env.EXPECT_ATTEMPT_PERSISTENCE==='true') {
            assert.equal((await api.luxmedBookingAttempt(424242,'00000000-0000-0000-0000-000000424242')).state,'unknown');
            assert.equal((await api.luxmedBookingAttempt(424247,'00000000-0000-0000-0000-000000424247')).state,'succeeded');
            await api.luxmedAcknowledgeBookingAttempt(424247,'00000000-0000-0000-0000-000000424247',77247);
            await assert.rejects(api.luxmedEnrollSmartAccount(424242, []),
                (error: unknown) => error instanceof api.LuxmedApiError && error.status === 409 && error.message.includes('ACCOUNT_BUSY'));
            await api.luxmedEnrollSmartAccount(424249, []);
            assert.equal((await api.luxmedSmartEnrollment(424249)).enrolled, true);
        }
    } else {
        // The new bot must leave smart booking disabled when Watchtower updates it first.
        await assert.rejects(api.luxmedCapabilities());
    }
}
console.log(process.env.EXPECT_LEGACY_BOT_AUTH_FAILURE === 'true'
    ? 'Pinned old bot cannot authenticate to the new sidecar during sidecar-first replacement.'
    : 'Bot adapter authentication and database read passed.');
