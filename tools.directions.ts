import { Tool } from './tool.types';
import { geocode, getDirections, getWeatherForecast, isGoogleMapsConfigured, RouteResult } from './googleMapsService';
import { getLuxmedPreferences } from './userStore';

function formatRoute(route: RouteResult): string {
    const lines: string[] = [];
    const modeLabel = route.mode === 'transit' ? 'Public transport' : 'Taxi/car';
    lines.push(`${modeLabel}: ${route.duration} (${route.distance})`);

    if (route.departureTime) lines.push(`  Depart: ${route.departureTime}`);
    if (route.arrivalTime) lines.push(`  Arrive: ${route.arrivalTime}`);
    if (route.fare) lines.push(`  Fare: ${route.fare}`);

    // Show transit steps (bus/tram/metro lines)
    if (route.mode === 'transit') {
        const transitSteps = route.steps.filter(s => s.transitDetails);
        if (transitSteps.length > 0) {
            lines.push('  Route:');
            for (const step of transitSteps) {
                const td = step.transitDetails!;
                const vehicle = td.vehicle.toLowerCase();
                const icon = vehicle === 'subway' || vehicle === 'metro' ? 'M' :
                    vehicle === 'tram' ? 'T' :
                    vehicle === 'bus' ? 'B' : vehicle;
                lines.push(`    [${icon}] ${td.line}: ${td.departureStop} → ${td.arrivalStop} (${td.numStops} stops, ${step.duration})`);
            }
        }
        const walkSteps = route.steps.filter(s => s.travelMode === 'WALKING' && s.duration);
        const totalWalk = walkSteps.reduce((acc, s) => {
            const match = s.duration.match(/(\d+)/);
            return acc + (match ? parseInt(match[1]) : 0);
        }, 0);
        if (totalWalk > 0) lines.push(`  Walking: ~${totalWalk} min total`);
    }

    return lines.join('\n');
}

function weatherAdvice(weather: { temperature: number; feelsLike: number; description: string; precipitation: number; windSpeed: number }): string {
    const lines: string[] = [];
    lines.push(`Weather: ${weather.temperature}°C (feels ${weather.feelsLike}°C), ${weather.description}`);

    if (weather.precipitation > 0) {
        lines.push(`  Precipitation: ${weather.precipitation}mm — take umbrella!`);
    }
    if (weather.windSpeed > 30) {
        lines.push(`  Strong wind: ${weather.windSpeed} km/h`);
    }

    // Clothing suggestion based on feels-like
    const fl = weather.feelsLike;
    if (fl <= -10) lines.push('  Dress: Heavy winter gear, hat, gloves');
    else if (fl <= 0) lines.push('  Dress: Winter coat, scarf, gloves');
    else if (fl <= 5) lines.push('  Dress: Warm jacket, layers');
    else if (fl <= 10) lines.push('  Dress: Light jacket or sweater');
    else if (fl <= 18) lines.push('  Dress: Long sleeves, light layer');
    else if (fl <= 25) lines.push('  Dress: Light clothes');
    else lines.push('  Dress: Summer clothes, stay hydrated');

    return lines.join('\n');
}

export const GetDirections: Tool = {
    name: 'GetDirections',
    description: 'Get detailed travel directions to a destination with both public transport and taxi options, including weather forecast and clothing advice. Resolves destination names to coordinates. Use when user asks "how to get to X", "I need to be at X by Y", travel planning, etc.',
    parameters: {
        type: 'object',
        properties: {
            destination: {
                type: 'string',
                description: 'Destination name or address (e.g., "Warsaw Central Station", "Lotnisko Chopina", "ul. Marszałkowska 1, Warszawa"). Will be geocoded.',
            },
            arrival_time: {
                type: 'string',
                description: 'When to arrive (ISO datetime, e.g., "2026-04-09T10:00:00"). Used to calculate departure time and weather.',
            },
            departure_time: {
                type: 'string',
                description: 'When to depart (ISO datetime). Use this OR arrival_time, not both.',
            },
            origin_lat: {
                type: 'number',
                description: 'Origin latitude. Omit to use user home location from LuxMed preferences.',
            },
            origin_lng: {
                type: 'number',
                description: 'Origin longitude. Omit to use user home location.',
            },
            origin_address: {
                type: 'string',
                description: 'Origin address (will be geocoded). Omit to use home location.',
            },
            buffer_minutes: {
                type: 'number',
                description: 'Minutes of buffer before arrival (default 10). E.g., if arrival_time=10:00 and buffer=10, calculates to arrive by 9:50.',
            },
        },
        required: ['destination'],
    },
    execute: async (args: {
        userId: number;
        destination: string;
        arrival_time?: string;
        departure_time?: string;
        origin_lat?: number;
        origin_lng?: number;
        origin_address?: string;
        buffer_minutes?: number;
    }) => {
        if (!isGoogleMapsConfigured()) {
            return { success: false, message: 'Google Maps API key not configured. Set GOOGLE_MAPS_API_KEY.' };
        }

        // Resolve destination
        const dest = await geocode(args.destination);
        if (!dest) {
            return { success: false, message: `Could not find location: "${args.destination}". Try a more specific address.` };
        }
        console.log(`[Directions] Destination resolved: ${dest.formattedAddress} (${dest.lat}, ${dest.lng})`);

        // Resolve origin
        let origin: { lat: number; lng: number };
        if (args.origin_lat != null && args.origin_lng != null) {
            origin = { lat: args.origin_lat, lng: args.origin_lng };
        } else if (args.origin_address) {
            const originPlace = await geocode(args.origin_address);
            if (!originPlace) {
                return { success: false, message: `Could not find origin: "${args.origin_address}".` };
            }
            origin = { lat: originPlace.lat, lng: originPlace.lng };
        } else {
            const prefs = getLuxmedPreferences(args.userId);
            if (prefs.homeLat != null && prefs.homeLng != null) {
                origin = { lat: prefs.homeLat, lng: prefs.homeLng };
            } else {
                return {
                    success: false,
                    message: 'No origin specified and no home location saved. Provide origin_address or set home location with LuxmedSetPreferences (home_lat, home_lng).',
                };
            }
        }

        // Calculate times
        const buffer = args.buffer_minutes ?? 10;
        let arrivalTime: Date | undefined;
        let departureTime: Date | undefined;

        if (args.arrival_time) {
            arrivalTime = new Date(args.arrival_time);
            // Subtract buffer so we arrive early
            arrivalTime = new Date(arrivalTime.getTime() - buffer * 60 * 1000);
        } else if (args.departure_time) {
            departureTime = new Date(args.departure_time);
        }

        // Get both transit and driving routes in parallel
        const [transitRoute, drivingRoute] = await Promise.all([
            getDirections(origin, dest, 'transit', arrivalTime, departureTime).catch(() => null),
            getDirections(origin, dest, 'driving', undefined, departureTime || arrivalTime ? undefined : undefined).catch(() => null),
        ]);

        // Get weather forecast at the departure/arrival time
        const weatherTime = arrivalTime || departureTime || new Date();
        const weather = await getWeatherForecast(dest.lat, dest.lng, weatherTime).catch(() => null);

        // Build comprehensive result
        const result: any = {
            success: true,
            destination: dest.formattedAddress,
            destinationCoords: { lat: dest.lat, lng: dest.lng },
        };

        const reportParts: string[] = [];
        reportParts.push(`Destination: ${dest.formattedAddress}`);
        if (args.arrival_time) {
            reportParts.push(`Target arrival: ${args.arrival_time} (with ${buffer} min buffer)`);
        }
        reportParts.push('');

        if (transitRoute) {
            result.transit = {
                duration: transitRoute.duration,
                durationSeconds: transitRoute.durationSeconds,
                distance: transitRoute.distance,
                departureTime: transitRoute.departureTime,
                arrivalTime: transitRoute.arrivalTime,
                fare: transitRoute.fare,
                steps: transitRoute.steps.filter(s => s.transitDetails).map(s => ({
                    line: s.transitDetails!.line,
                    vehicle: s.transitDetails!.vehicle,
                    from: s.transitDetails!.departureStop,
                    to: s.transitDetails!.arrivalStop,
                    stops: s.transitDetails!.numStops,
                })),
            };
            reportParts.push(formatRoute(transitRoute));
        } else {
            reportParts.push('Public transport: route not available');
        }

        reportParts.push('');

        if (drivingRoute) {
            // Estimate taxi: driving time + 5-10 min wait
            const waitMinutes = 7; // average taxi wait in Warsaw
            const totalTaxiSeconds = drivingRoute.durationSeconds + waitMinutes * 60;
            const totalTaxiMin = Math.ceil(totalTaxiSeconds / 60);

            result.taxi = {
                drivingDuration: drivingRoute.duration,
                drivingDurationSeconds: drivingRoute.durationSeconds,
                estimatedWaitMinutes: waitMinutes,
                totalMinutes: totalTaxiMin,
                distance: drivingRoute.distance,
            };

            let taxiDepartureNote = '';
            if (arrivalTime) {
                const taxiDepart = new Date(arrivalTime.getTime() - totalTaxiSeconds * 1000);
                taxiDepartureNote = ` — order by ${taxiDepart.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`;
            }

            reportParts.push(`Taxi: ~${totalTaxiMin} min total (${drivingRoute.duration} driving + ~${waitMinutes} min wait${taxiDepartureNote})`);
            reportParts.push(`  Distance: ${drivingRoute.distance}`);
        }

        if (weather) {
            result.weather = weather;
            reportParts.push('');
            reportParts.push(weatherAdvice(weather));
        }

        // Smart recommendation
        if (transitRoute && drivingRoute) {
            reportParts.push('');
            const transitMin = Math.ceil(transitRoute.durationSeconds / 60);
            const taxiMin = Math.ceil(drivingRoute.durationSeconds / 60) + 7;
            const timeSaved = transitMin - taxiMin;

            if (weather?.precipitation && weather.precipitation > 1) {
                reportParts.push(`Recommendation: Taxi recommended — rain expected (${weather.precipitation}mm). Saves ~${timeSaved} min vs transit.`);
            } else if (timeSaved > 15) {
                reportParts.push(`Recommendation: Consider taxi — saves ~${timeSaved} min vs public transport.`);
            } else if (timeSaved < -5) {
                reportParts.push(`Recommendation: Public transport is faster by ~${-timeSaved} min.`);
            } else {
                reportParts.push(`Recommendation: Similar travel time. Public transport is cheaper, taxi is more comfortable.`);
            }
        }

        result.report = reportParts.join('\n');
        return result;
    },
};
