import type { TravelQuery, TravelEstimate } from './luxmedAvailability';

const seconds = (value: unknown): number => typeof value === 'string' && /^\d+(\.\d+)?s$/.test(value) ? Number(value.slice(0, -1)) : NaN;
const point = (p: TravelQuery['from']) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
export function providerStreetMatches(clinicLabel: string, resolvedAddress: string): boolean {
    const street = (value: string): string | null => {
        const segment = value.split(',')[0].split(/\s[-–]\s/).at(-1) || '';
        const words = segment.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
            .match(/[a-z]+|\d+[a-z]?/g) || [];
        const number = words.findIndex((word, index) => index > 0 && /^\d+[a-z]?$/.test(word));
        if (number < 1 || number !== words.length - 1) return null;
        const name = words.slice(0, number).filter((word, index) => index !== 0 || !['ul', 'al', 'aleja', 'plac', 'pl', 'osiedle', 'os'].includes(word));
        return name.length && name.every(word => /^[a-z]{2,}$/.test(word)) ? `${name.join(' ')}:${words[number]}` : null;
    };
    const addressSegments = resolvedAddress.split(',');
    if (addressSegments.slice(1).some(segment => street(segment))) return false;
    const expected = street(clinicLabel), resolved = street(addressSegments[0]);
    return !!expected && expected === resolved;
}
export function providerCityMatches(cityName: string, resolvedAddress: string): boolean {
    const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '')
        .toLocaleLowerCase().replace(/[^a-z]+/g, ' ').trim();
    const city = normalize(cityName);
    const afterStreet = normalize(resolvedAddress.split(',').slice(1).join(' '));
    return city.length >= 3 && (` ${afterStreet} `).includes(` ${city} `);
}

/** Exact route details verify transit departures, rather than an average matrix duration. */
export async function computeGoogleRoute(q: TravelQuery, options: { apiKey?: string; fetch?: typeof fetch; now?: () => number } = {}): Promise<TravelEstimate> {
    const now = options.now || Date.now;
    const key = options.apiKey ?? process.env.GOOGLE_MAPS_API_KEY;
    if (!key) throw new Error('Google Maps is not configured.');
    const request = options.fetch || fetch;
    const base = { query: q, status: 'unknown' as const, departure: NaN, arrival: NaN, durationSeconds: NaN, distanceMeters: NaN, fetchedAt: now(), cached: false };
    let departure = q.kind === 'depart' ? q.at : q.at - 15 * 60000;
    if (q.mode === 'taxi') departure = Math.max(departure, now() + 60000);
    let verifiedTaxi: TravelEstimate | null = null;
    for (let iteration = 0; iteration < 3; iteration++) {
        const body: Record<string, unknown> = {
            origin: point(q.from), destination: point(q.to), travelMode: q.mode === 'taxi' ? 'DRIVE' : 'TRANSIT',
            ...(q.mode === 'taxi' ? { routingPreference: 'TRAFFIC_AWARE_OPTIMAL', trafficModel: 'BEST_GUESS', departureTime: new Date(departure).toISOString() }
                : { [q.kind === 'arrive' ? 'arrivalTime' : 'departureTime']: new Date(q.at).toISOString() }),
        };
        const response = await request('https://routes.googleapis.com/directions/v2:computeRoutes', {
            method: 'POST', headers: {
                'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
                'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.legs.steps.staticDuration,routes.legs.steps.travelMode,routes.legs.steps.transitDetails.stopDetails,fallbackInfo'
            },
            body: JSON.stringify(body), signal: AbortSignal.timeout(1500),
        });
        if (!response.ok) throw new Error(`Google Routes HTTP ${response.status}`);
        const data = await response.json() as any;
        if (!Array.isArray(data.routes) || !data.routes.length) return verifiedTaxi || { ...base, status: 'no_route' };
        const r = data.routes[0];
        const duration = seconds(r.duration);
        if (!Number.isFinite(duration) || !Number.isFinite(r.distanceMeters) || data.fallbackInfo) return verifiedTaxi || base;
        if (q.mode === 'taxi') {
            const arrival = departure + duration * 1000;
            const estimate: TravelEstimate = { ...base, status: 'ok', departure, arrival, durationSeconds: duration, distanceMeters: r.distanceMeters, fetchedAt: now() };
            if (q.kind === 'depart') return estimate;
            // A traffic estimate belongs to the departure sent to Google.
            // Move the next probe toward the arrival deadline in either
            // direction, but retain only a route Google actually verified.
            if (arrival <= q.at && (!verifiedTaxi || departure > verifiedTaxi.departure)) verifiedTaxi = estimate;
            const adjusted = q.at - duration * 1000;
            if (arrival <= q.at && Math.abs(adjusted - departure) <= 60000) return verifiedTaxi || base;
            if (adjusted < now() + 60000) return verifiedTaxi || base;
            departure = adjusted;
            continue;
        }
        const steps = (r.legs || []).flatMap((l: any) => l.steps || []);
        const first = steps.findIndex((s: any) => s.transitDetails?.stopDetails);
        let last = -1;
        for (let i = steps.length - 1; i >= 0; i--) if (steps[i].transitDetails?.stopDetails) { last = i; break; }
        if (first < 0) {
            if (!steps.length || steps.some((s: any) => s.travelMode !== 'WALK')) return base;
            const start = q.kind === 'arrive' ? q.at - duration * 1000 : q.at;
            return { ...base, status: 'ok', departure: start, arrival: start + duration * 1000, durationSeconds: duration, distanceMeters: r.distanceMeters, fetchedAt: now() };
        }
        const before = steps.slice(0, first).reduce((sum: number, s: any) => sum + seconds(s.staticDuration), 0);
        const after = steps.slice(last + 1).reduce((sum: number, s: any) => sum + seconds(s.staticDuration), 0);
        const start = Date.parse(steps[first].transitDetails.stopDetails.departureTime) - before * 1000;
        const end = Date.parse(steps[last].transitDetails.stopDetails.arrivalTime) + after * 1000;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || (q.kind === 'depart' && start < q.at) || (q.kind === 'arrive' && end > q.at)) return base;
        return { ...base, status: 'ok', departure: start, arrival: end, durationSeconds: Math.max(duration, (end - (q.kind === 'depart' ? q.at : start)) / 1000), distanceMeters: r.distanceMeters, fetchedAt: now() };
    }
    return verifiedTaxi || base;
}

/** Require one unambiguous street address before adding a new location. */
export async function resolveStreetAddress(address: string, request: typeof fetch = fetch): Promise<{ address: string; lat: number; lng: number } | null> {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) throw new Error('Google Maps is not configured.');
    const response = await request(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${encodeURIComponent(key)}&language=pl`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`Google Geocoding HTTP ${response.status}`);
    const data = await response.json() as any;
    if (data.status !== 'OK' || data.results?.length !== 1) return null;
    const r = data.results[0];
    if (r.partial_match || !r.address_components?.some((c: any) => c.types?.includes('street_number'))) return null;
    const lat = r.geometry?.location?.lat, lng = r.geometry?.location?.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { address: r.formatted_address, lat, lng };
}
