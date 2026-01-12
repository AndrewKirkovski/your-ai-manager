import { Tool } from "./tool.types";
import { getWeather, getWeatherByCity } from "./weatherService";

export const GetWeather: Tool = {
    name: 'GetWeather',
    description: 'Get current weather for a location. Use when user asks about weather, temperature, or conditions.',
    parameters: {
        type: 'object',
        properties: {
            city: {
                type: 'string',
                description: 'City name (e.g., "Warsaw", "Moscow", "New York", "Варшава")'
            },
            latitude: {
                type: 'number',
                description: 'Latitude coordinate (use if user shared location)'
            },
            longitude: {
                type: 'number',
                description: 'Longitude coordinate (use if user shared location)'
            }
        }
    },
    execute: async (args: { userId: number; city?: string; latitude?: number; longitude?: number }) => {
        console.log(`🌤️ GetWeather tool called:`, args);

        try {
            let weather;

            if (args.city) {
                weather = await getWeatherByCity(args.city);
            } else if (args.latitude !== undefined && args.longitude !== undefined) {
                weather = await getWeather(args.latitude, args.longitude);
            } else {
                return {
                    success: false,
                    error: 'Please provide either a city name or coordinates'
                };
            }

            return {
                success: true,
                location: weather.location,
                temperature: `${weather.temperature}°C`,
                feelsLike: `${weather.feelsLike}°C`,
                humidity: `${weather.humidity}%`,
                description: weather.description,
                windSpeed: `${weather.windSpeed} km/h`
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to get weather'
            };
        }
    }
};
