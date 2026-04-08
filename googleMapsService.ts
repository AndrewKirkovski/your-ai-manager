/**
 * Google Maps API wrapper — Geocoding, Directions, Distance Matrix.
 * Requires GOOGLE_MAPS_API_KEY env var.
 * All results are cached in SQLite (kv_cache table) with TTL to minimize API calls.
 */

import db from './database';

const API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const BASE = 'https://maps.googleapis.com/maps/api';

function requireApiKey(): void {
    if (!API_KEY) throw new Error('GOOGLE_MAPS_API_KEY not configured');
}

// === Persistent Cache (SQLite kv_cache table) ===

const GEOCODE_TTL = 7 * 24 * 60 * 60 * 1000;     // 7 days — addresses don't move
const DIRECTIONS_TTL = 5 * 60 * 1000;              // 5 min — transit times change
const DISTANCE_MATRIX_TTL = 10 * 60 * 1000;        // 10 min — used by monitoring loop
const WEATHER_TTL = 30 * 60 * 1000;                 // 30 min — weather forecasts

const stmts = {
    get: db.prepare<[string, number], { value: string }>('SELECT value FROM kv_cache WHERE key = ? AND expires_at > ?'),
    set: db.prepare('INSERT OR REPLACE INTO kv_cache (key, value, expires_at) VALUES (?, ?, ?)'),
    prune: db.prepare('DELETE FROM kv_cache WHERE expires_at <= ?'),
};

function cacheGet<T>(key: string): T | undefined {
    const row = stmts.get.get(key, Date.now());
    if (!row) return undefined;
    try { return JSON.parse(row.value) as T; } catch { return undefined; }
}

function cacheSet<T>(key: string, data: T, ttl: number): void {
    stmts.set.run(key, JSON.stringify(data), Date.now() + ttl);
}

// Prune expired entries every hour
setInterval(() => { stmts.prune.run(Date.now()); }, 60 * 60 * 1000);

// === Geocoding ===

export interface GeocodedPlace {
    lat: number;
    lng: number;
    formattedAddress: string;
    name: string;
}

export async function geocode(query: string): Promise<GeocodedPlace | null> {
    requireApiKey();
    const cacheKey = `geo:${query.toLowerCase().trim()}`;
    const cached = cacheGet<GeocodedPlace | null>(cacheKey);
    if (cached !== undefined) {
        console.log(`[Maps] Geocoding (cached): "${query}"`);
        return cached;
    }

    const url = `${BASE}/geocode/json?address=${encodeURIComponent(query)}&key=${API_KEY}&language=pl`;
    console.log(`[Maps] Geocoding: "${query}"`);

    const res = await fetch(url);
    const data = await res.json() as any;

    if (data.status !== 'OK' || !data.results?.[0]) {
        console.log(`[Maps] Geocode failed: ${data.status}`);
        cacheSet(cacheKey, null, GEOCODE_TTL);
        return null;
    }

    const r = data.results[0];
    const result: GeocodedPlace = {
        lat: r.geometry.location.lat,
        lng: r.geometry.location.lng,
        formattedAddress: r.formatted_address,
        name: query,
    };
    cacheSet(cacheKey, result, GEOCODE_TTL);
    return result;
}

// === Directions ===

export interface RouteStep {
    instruction: string;
    distance: string;
    duration: string;
    travelMode: string;
    transitDetails?: {
        line: string;
        vehicle: string;
        departureStop: string;
        arrivalStop: string;
        numStops: number;
    };
}

export interface RouteResult {
    mode: 'transit' | 'driving';
    distance: string;
    duration: string;
    durationSeconds: number;
    departureTime?: string;
    arrivalTime?: string;
    summary: string;
    steps: RouteStep[];
    fare?: string;
}

export async function getDirections(
    origin: { lat: number; lng: number },
    destination: { lat: number; lng: number },
    mode: 'transit' | 'driving',
    arrivalTime?: Date,
    departureTime?: Date,
): Promise<RouteResult | null> {
    requireApiKey();
    const originStr = `${origin.lat},${origin.lng}`;
    const destStr = `${destination.lat},${destination.lng}`;

    // Cache key: round time to 5-min bucket for transit (routes don't change much within 5 min)
    const timeKey = arrivalTime ? `a${Math.floor(arrivalTime.getTime() / 300000)}` :
                    departureTime ? `d${Math.floor(departureTime.getTime() / 300000)}` : 'now';
    const cacheKey = `dir:${originStr}:${destStr}:${mode}:${timeKey}`;
    const cached = cacheGet<RouteResult>(cacheKey);
    if (cached !== undefined) {
        console.log(`[Maps] Directions (cached): ${mode} ${originStr} → ${destStr}`);
        return cached;
    }

    let url = `${BASE}/directions/json?origin=${originStr}&destination=${destStr}&mode=${mode}&language=pl&key=${API_KEY}`;

    if (mode === 'transit') {
        if (arrivalTime) {
            url += `&arrival_time=${Math.floor(arrivalTime.getTime() / 1000)}`;
        } else if (departureTime) {
            url += `&departure_time=${Math.floor(departureTime.getTime() / 1000)}`;
        } else {
            url += `&departure_time=now`;
        }
    }

    console.log(`[Maps] Directions: ${mode} from ${originStr} to ${destStr}`);
    const res = await fetch(url);
    const data = await res.json() as any;

    if (data.status !== 'OK' || !data.routes?.[0]) {
        console.log(`[Maps] Directions failed: ${data.status}`);
        return null;
    }

    const route = data.routes[0];
    const leg = route.legs[0];

    const steps: RouteStep[] = (leg.steps || []).map((s: any) => {
        const step: RouteStep = {
            instruction: (s.html_instructions || '').replace(/<[^>]*>/g, ''),
            distance: s.distance?.text || '',
            duration: s.duration?.text || '',
            travelMode: s.travel_mode,
        };
        if (s.transit_details) {
            step.transitDetails = {
                line: s.transit_details.line?.short_name || s.transit_details.line?.name || '',
                vehicle: s.transit_details.line?.vehicle?.type || '',
                departureStop: s.transit_details.departure_stop?.name || '',
                arrivalStop: s.transit_details.arrival_stop?.name || '',
                numStops: s.transit_details.num_stops || 0,
            };
        }
        return step;
    });

    const result: RouteResult = {
        mode,
        distance: leg.distance?.text || '',
        duration: leg.duration?.text || '',
        durationSeconds: leg.duration?.value || 0,
        departureTime: leg.departure_time?.text,
        arrivalTime: leg.arrival_time?.text,
        summary: route.summary || '',
        steps,
        fare: route.fare?.text,
    };
    cacheSet(cacheKey, result, DIRECTIONS_TTL);
    return result;
}

// === Distance Matrix (batch) ===

export interface DistanceMatrixEntry {
    destinationIndex: number;
    distance: string;
    distanceMeters: number;
    duration: string;
    durationSeconds: number;
    status: string;
}

export async function getDistanceMatrix(
    origin: { lat: number; lng: number },
    destinations: { lat: number; lng: number }[],
    mode: 'transit' | 'driving' = 'transit',
): Promise<DistanceMatrixEntry[]> {
    requireApiKey();
    if (destinations.length === 0) return [];

    const originStr = `${origin.lat},${origin.lng}`;
    const destStr = destinations.map(d => `${d.lat},${d.lng}`).join('|');

    const cacheKey = `dm:${originStr}:${destStr}:${mode}`;
    const cached = cacheGet<DistanceMatrixEntry[]>(cacheKey);
    if (cached !== undefined) {
        console.log(`[Maps] Distance Matrix (cached): ${destinations.length} destinations`);
        return cached;
    }

    const url = `${BASE}/distancematrix/json?origins=${originStr}&destinations=${destStr}&mode=${mode}&departure_time=now&language=pl&key=${API_KEY}`;
    console.log(`[Maps] Distance Matrix: ${destinations.length} destinations (${mode})`);

    const res = await fetch(url);
    const data = await res.json() as any;

    if (data.status !== 'OK' || !data.rows?.[0]) {
        console.log(`[Maps] Distance Matrix failed: ${data.status}`);
        return [];
    }

    const results: DistanceMatrixEntry[] = data.rows[0].elements.map((el: any, i: number) => ({
        destinationIndex: i,
        distance: el.distance?.text || '',
        distanceMeters: el.distance?.value || 0,
        duration: el.duration?.text || '',
        durationSeconds: el.duration?.value || 0,
        status: el.status,
    }));
    cacheSet(cacheKey, results, DISTANCE_MATRIX_TTL);
    return results;
}

// === Weather forecast at specific time ===

export async function getWeatherForecast(lat: number, lng: number, time: Date): Promise<{
    temperature: number;
    feelsLike: number;
    description: string;
    precipitation: number;
    windSpeed: number;
    weatherCode: number;
} | null> {
    const date = time.toISOString().slice(0, 10);
    const hour = time.getHours();
    const cacheKey = `wx:${lat.toFixed(2)},${lng.toFixed(2)}:${date}:${hour}`;
    const cached = cacheGet<any>(cacheKey);
    if (cached !== undefined) {
        console.log(`[Weather] Forecast (cached): ${lat},${lng} at ${date} ${hour}:00`);
        return cached;
    }

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=temperature_2m,apparent_temperature,weather_code,precipitation,wind_speed_10m&start_date=${date}&end_date=${date}&timezone=Europe/Warsaw`;

    console.log(`[Weather] Forecast for ${lat},${lng} at ${time.toISOString()}`);
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json() as any;
    if (!data.hourly?.time) return null;

    // Find the closest hour
    const targetHour = time.getHours();
    const hourIndex = Math.min(targetHour, (data.hourly.time.length || 1) - 1);

    const weatherCodes: Record<number, string> = {
        0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
        45: 'Foggy', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle',
        61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain',
        71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
        80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
        85: 'Snow showers', 86: 'Heavy snow showers',
        95: 'Thunderstorm', 96: 'Thunderstorm + hail', 99: 'Thunderstorm + heavy hail',
    };

    const code = data.hourly.weather_code[hourIndex];
    const result = {
        temperature: Math.round(data.hourly.temperature_2m[hourIndex]),
        feelsLike: Math.round(data.hourly.apparent_temperature[hourIndex]),
        description: weatherCodes[code] || `Code ${code}`,
        precipitation: data.hourly.precipitation[hourIndex] || 0,
        windSpeed: Math.round(data.hourly.wind_speed_10m[hourIndex]),
        weatherCode: code,
    };
    cacheSet(cacheKey, result, WEATHER_TTL);
    return result;
}

export function isGoogleMapsConfigured(): boolean {
    return !!API_KEY;
}
