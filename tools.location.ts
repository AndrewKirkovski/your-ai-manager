import {Tool} from "./tool.types";
import {
    reverseGeocode,
    searchNearby,
    findAmenities,
    getLocationSummary
} from "./locationService";

export const ReverseGeocode: Tool = {
    name: 'ReverseGeocode',
    description: 'Convert coordinates to a human-readable address. Use when user shares location and you want to understand where they are.',
    parameters: {
        type: 'object',
        properties: {
            latitude: {
                type: 'number',
                description: 'Latitude coordinate'
            },
            longitude: {
                type: 'number',
                description: 'Longitude coordinate'
            }
        },
        required: ['latitude', 'longitude']
    },
    execute: async (args: { userId: number; latitude: number; longitude: number }) => {
        console.log(`📍 ReverseGeocode tool: ${args.latitude}, ${args.longitude}`);

        const address = await reverseGeocode(args.latitude, args.longitude);

        if (!address) {
            return {
                success: false,
                message: 'Could not determine address for these coordinates'
            };
        }

        return {
            success: true,
            address: {
                full: address.displayName,
                street: address.street,
                houseNumber: address.houseNumber,
                neighbourhood: address.neighbourhood,
                city: address.city,
                country: address.country,
                postcode: address.postcode
            }
        };
    }
};

export const SearchNearbyPlaces: Tool = {
    name: 'SearchNearbyPlaces',
    description: 'Find places near given coordinates. Use when user asks "what\'s nearby?", "find me a cafe", "is there a pharmacy?", etc.',
    parameters: {
        type: 'object',
        properties: {
            latitude: {
                type: 'number',
                description: 'Latitude coordinate'
            },
            longitude: {
                type: 'number',
                description: 'Longitude coordinate'
            },
            query: {
                type: 'string',
                description: 'What to search for (e.g., "cafe", "pharmacy", "restaurant", "supermarket"). Optional - if not provided, returns general nearby places.'
            },
            radius_meters: {
                type: 'number',
                description: 'Search radius in meters (default: 500, max: 2000)'
            }
        },
        required: ['latitude', 'longitude']
    },
    execute: async (args: { userId: number; latitude: number; longitude: number; query?: string; radius_meters?: number }) => {
        const radius = Math.min(args.radius_meters || 500, 2000);

        console.log(`📍 SearchNearbyPlaces tool: "${args.query || 'any'}" near ${args.latitude}, ${args.longitude}`);

        let places;
        if (args.query) {
            places = await findAmenities(args.latitude, args.longitude, args.query, radius);
        } else {
            places = await searchNearby(args.latitude, args.longitude, undefined, radius);
        }

        if (places.length === 0) {
            return {
                success: true,
                query: args.query || 'nearby places',
                radius: radius,
                count: 0,
                message: `No ${args.query || 'places'} found within ${radius}m`
            };
        }

        return {
            success: true,
            query: args.query || 'nearby places',
            radius: radius,
            count: places.length,
            places: places.slice(0, 5).map(p => ({
                name: p.name,
                type: p.type,
                category: p.category,
                distance: `${p.distance}m`,
                address: p.address
            }))
        };
    }
};

export const GetLocationSummary: Tool = {
    name: 'GetLocationSummary',
    description: 'Get a brief, human-readable summary of a location. Simpler than ReverseGeocode - returns just a short address string.',
    parameters: {
        type: 'object',
        properties: {
            latitude: {
                type: 'number',
                description: 'Latitude coordinate'
            },
            longitude: {
                type: 'number',
                description: 'Longitude coordinate'
            }
        },
        required: ['latitude', 'longitude']
    },
    execute: async (args: { userId: number; latitude: number; longitude: number }) => {
        console.log(`📍 GetLocationSummary tool: ${args.latitude}, ${args.longitude}`);

        const summary = await getLocationSummary(args.latitude, args.longitude);

        return {
            success: true,
            location: summary,
            coordinates: {
                latitude: args.latitude,
                longitude: args.longitude
            }
        };
    }
};
