import 'dotenv/config';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { computeGoogleRoute } from '../googleRoutes.ts';
import { rankWithJev } from '../luxmedJev.ts';
import type { FeasibleSlot, Place } from '../luxmedAvailability.ts';

assert.equal(process.env.RUN_LUXMED_LIVE_READONLY, 'yes', 'Set RUN_LUXMED_LIVE_READONLY=yes to permit the read-only provider check.');
assert.ok(process.env.GOOGLE_MAPS_API_KEY, 'Google Maps key is missing.');
assert.ok(process.env.OPENROUTER_API_KEY, 'OpenRouter key is missing.');
const from: Place = { id: 'fixture-a', revision: '1', address: 'Public Warsaw coordinates', lat: 52.23, lng: 21.01 };
const to: Place = { id: 'fixture-b', revision: '1', address: 'Public Warsaw coordinates', lat: 52.24, lng: 21.02 };
const at = DateTime.now().setZone('Europe/Warsaw').plus({ days: 1 }).set({ hour: 13, minute: 0, second: 0, millisecond: 0 }).toMillis();
for (const mode of ['transit', 'taxi'] as const) {
    const route = await computeGoogleRoute({ from, to, at, kind: 'depart', mode });
    assert.equal(route.status, 'ok'); assert.ok(route.arrival >= route.departure); console.log(`Google ${mode} route verified.`);
}
const candidate: FeasibleSlot = { slot: { id: 'a', start: at, end: at + 1800000, telemedicine: false, preparationRequired: false }, day: DateTime.fromMillis(at, { zone: 'Europe/Warsaw' }).toISODate()!, taxiLegs: 0, travelSeconds: 900, leaveAt: at - 1800000, returnAt: at + 3600000, legs: [] };
const ranked = await rankWithJev([candidate, { ...candidate, slot: { ...candidate.slot, id: 'b', start: at + 3600000 }, travelSeconds: 1800 }], ['Prefer a short journey'], 1);
assert.equal(ranked?.source, 'jev', 'Jev did not return a valid ranking within its deadline.');
console.log('Jev live response and 800 ms deadline verified. No LuxMed request was made.');
