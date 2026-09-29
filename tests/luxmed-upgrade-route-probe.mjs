// Fixture-only route probe. The request omits attemptId, so the current
// controller rejects it before an account lookup or any provider operation.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const base = process.env.SIDECAR_PROBE_URL;
const securitySecret = process.env.SIDECAR_PROBE_SECRET;
const path = process.env.SIDECAR_PROBE_PATH;
const expected = process.env.SIDECAR_PROBE_EXPECT;
assert.ok(base && securitySecret && path && ['present', 'absent', 'held'].includes(expected));

const secret = createHmac('sha256', securitySecret).update('luxmed-rest-auth-v1').digest('hex');
const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-LuxMed-Secret': secret },
    body: JSON.stringify({
        cityId: 1, clinicId: 2, clinicGroupId: 2, clinic: 'Fixture',
        doctorId: 3, doctorFirstName: 'Fixture', doctorLastName: 'Doctor', doctorAcademicTitle: '',
        roomId: 4, scheduleId: 5, serviceId: 6,
        dateTimeFrom: '2026-10-06T12:00:00', dateTimeTo: '2026-10-06T12:30:00',
        isTelemedicine: false, isAdditional: false, isImpediment: false,
        ...(expected === 'held' ? { attemptId: '00000000-0000-0000-0000-000000424259' } : {}),
    }),
    signal: AbortSignal.timeout(5000),
});

if (expected === 'present') {
    assert.equal(response.status, 400, `Expected the v4 controller's pre-submit rejection, got HTTP ${response.status}`);
    const result = await response.json();
    assert.equal(result.success, false);
    assert.equal(result.error, 'Booking attempt ID is required');
} else if (expected === 'held') {
    assert.equal(response.status, 200, `Expected a definite mixed-image booking hold, got HTTP ${response.status}`);
    const result = await response.json();
    assert.equal(result.success, true);
    assert.equal(result.data?.state, 'failed');
    assert.equal(result.data?.errorCode, 'BOT_UPGRADE_REQUIRED');
} else {
    assert.ok([404, 405].includes(response.status), `Expected an absent POST route, got HTTP ${response.status}`);
}
console.log(`Fixture smart booking POST route ${expected}: HTTP ${response.status}`);
