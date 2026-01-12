/**
 * Location Service - Nominatim (OpenStreetMap)
 *
 * Free geocoding and reverse geocoding service.
 * Rate limit: 1 request per second (we enforce this)
 * No API key required.
 */

export interface Address {
    displayName: string;
    street?: string;
    houseNumber?: string;
    city?: string;
    state?: string;
    country?: string;
    postcode?: string;
    neighbourhood?: string;
}

export interface NearbyPlace {
    name: string;
    type: string;
    category: string;
    distance: number; // meters
    latitude: number;
    longitude: number;
    address?: string;
}

interface NominatimAddress {
    house_number?: string;
    road?: string;
    neighbourhood?: string;
    suburb?: string;
    city?: string;
    town?: string;
    village?: string;
    state?: string;
    country?: string;
    postcode?: string;
}

interface NominatimResult {
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
    type: string;
    class: string;
    address?: NominatimAddress;
    name?: string;
    importance?: number;
}

// Rate limiting: 1 request per second
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1100; // 1.1 seconds to be safe

async function rateLimitedFetch(url: string): Promise<Response> {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;

    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
    }

    lastRequestTime = Date.now();

    return fetch(url, {
        headers: {
            'User-Agent': 'AIManagerBot/1.0 (Telegram Bot; contact@example.com)',
            'Accept-Language': 'en,ru;q=0.9'
        }
    });
}

/**
 * Reverse geocode coordinates to an address
 */
export async function reverseGeocode(latitude: number, longitude: number): Promise<Address | null> {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1`;

        console.log(`📍 Reverse geocoding: ${latitude}, ${longitude}`);

        const response = await rateLimitedFetch(url);

        if (!response.ok) {
            console.error('Nominatim reverse geocode error:', response.status);
            return null;
        }

        const data = await response.json() as NominatimResult;

        if (!data.display_name) {
            return null;
        }

        const addr = data.address || {};

        return {
            displayName: data.display_name,
            street: addr.road,
            houseNumber: addr.house_number,
            city: addr.city || addr.town || addr.village,
            state: addr.state,
            country: addr.country,
            postcode: addr.postcode,
            neighbourhood: addr.neighbourhood || addr.suburb
        };
    } catch (error) {
        console.error('Reverse geocode error:', error);
        return null;
    }
}

/**
 * Search for nearby places of a specific type
 */
export async function searchNearby(
    latitude: number,
    longitude: number,
    query?: string,
    radiusMeters: number = 1000
): Promise<NearbyPlace[]> {
    try {
        // Calculate bounding box from radius
        // Rough approximation: 1 degree latitude ≈ 111km
        const latDelta = radiusMeters / 111000;
        const lonDelta = radiusMeters / (111000 * Math.cos(latitude * Math.PI / 180));

        const minLat = latitude - latDelta;
        const maxLat = latitude + latDelta;
        const minLon = longitude - lonDelta;
        const maxLon = longitude + lonDelta;

        let url: string;

        if (query) {
            // Search for specific place type
            const encodedQuery = encodeURIComponent(query);
            url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodedQuery}&viewbox=${minLon},${maxLat},${maxLon},${minLat}&bounded=1&limit=10&addressdetails=1`;
        } else {
            // Without a query, search for common POIs (amenities) in the area
            // Nominatim requires a query term, so we search for common place types
            url = `https://nominatim.openstreetmap.org/search?format=json&q=cafe+restaurant+shop+pharmacy&viewbox=${minLon},${maxLat},${maxLon},${minLat}&bounded=1&limit=10&addressdetails=1`;
        }

        console.log(`📍 Searching nearby: "${query || 'any'}" within ${radiusMeters}m of ${latitude}, ${longitude}`);

        const response = await rateLimitedFetch(url);

        if (!response.ok) {
            console.error('Nominatim search error:', response.status);
            return [];
        }

        const results = await response.json() as NominatimResult[];

        // Calculate distances and format results
        const places: NearbyPlace[] = results
            .filter(r => r.name || r.display_name)
            .map(r => {
                const placeLat = parseFloat(r.lat);
                const placeLon = parseFloat(r.lon);
                const distance = calculateDistance(latitude, longitude, placeLat, placeLon);

                return {
                    name: r.name || r.display_name.split(',')[0],
                    type: r.type,
                    category: r.class,
                    distance: Math.round(distance),
                    latitude: placeLat,
                    longitude: placeLon,
                    address: r.display_name
                };
            })
            .filter(p => p.distance <= radiusMeters)
            .sort((a, b) => a.distance - b.distance);

        console.log(`📍 Found ${places.length} nearby places`);
        return places;
    } catch (error) {
        console.error('Search nearby error:', error);
        return [];
    }
}

/**
 * Search for common amenities near a location
 */
export async function findAmenities(
    latitude: number,
    longitude: number,
    amenityType: string,
    radiusMeters: number = 500
): Promise<NearbyPlace[]> {
    // Map common amenity requests to Nominatim search terms
    const amenityMap: Record<string, string> = {
        'coffee': 'cafe coffee',
        'cafe': 'cafe coffee',
        'restaurant': 'restaurant',
        'food': 'restaurant food',
        'pharmacy': 'pharmacy',
        'atm': 'atm bank',
        'bank': 'bank',
        'gas': 'fuel gas station',
        'fuel': 'fuel gas station',
        'parking': 'parking',
        'hospital': 'hospital clinic',
        'supermarket': 'supermarket grocery',
        'grocery': 'supermarket grocery market',
        'shop': 'shop store',
        'hotel': 'hotel',
        'bus': 'bus stop station',
        'metro': 'metro subway station',
        'train': 'train station railway',
    };

    const searchTerm = amenityMap[amenityType.toLowerCase()] || amenityType;
    return searchNearby(latitude, longitude, searchTerm, radiusMeters);
}

/**
 * Calculate distance between two points using Haversine formula
 */
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000; // Earth's radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Get a human-readable location summary
 */
export async function getLocationSummary(latitude: number, longitude: number): Promise<string> {
    const address = await reverseGeocode(latitude, longitude);

    if (!address) {
        return `Location: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
    }

    const parts = [];
    if (address.street) {
        parts.push(address.houseNumber ? `${address.street} ${address.houseNumber}` : address.street);
    }
    if (address.neighbourhood) {
        parts.push(address.neighbourhood);
    }
    if (address.city) {
        parts.push(address.city);
    }
    if (address.country && !parts.includes(address.country)) {
        parts.push(address.country);
    }

    return parts.join(', ') || address.displayName;
}
