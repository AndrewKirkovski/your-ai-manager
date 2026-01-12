/**
 * Weather Service - Open-Meteo API
 *
 * Free weather API, no API key required.
 * Uses Nominatim for city geocoding.
 */

export interface WeatherData {
    location: string;
    temperature: number;
    feelsLike: number;
    humidity: number;
    description: string;
    windSpeed: number;
    weatherCode: number;
}

interface OpenMeteoResponse {
    current: {
        temperature_2m: number;
        relative_humidity_2m: number;
        apparent_temperature: number;
        weather_code: number;
        wind_speed_10m: number;
    };
}

interface NominatimResult {
    lat: string;
    lon: string;
    display_name: string;
}

// WMO Weather interpretation codes
// https://open-meteo.com/en/docs
const weatherCodeDescriptions: Record<number, string> = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail',
};

function weatherCodeToDescription(code: number): string {
    return weatherCodeDescriptions[code] || `Unknown (code: ${code})`;
}

/**
 * Get weather by coordinates
 */
export async function getWeather(latitude: number, longitude: number): Promise<WeatherData> {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=Europe/Warsaw`;

    console.log(`🌤️ Fetching weather for ${latitude}, ${longitude}`);

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Weather API error: ${response.status}`);
    }

    const data: OpenMeteoResponse = await response.json();

    return {
        location: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
        temperature: Math.round(data.current.temperature_2m),
        feelsLike: Math.round(data.current.apparent_temperature),
        humidity: data.current.relative_humidity_2m,
        description: weatherCodeToDescription(data.current.weather_code),
        windSpeed: Math.round(data.current.wind_speed_10m),
        weatherCode: data.current.weather_code,
    };
}

/**
 * Get weather by city name
 * Uses Nominatim to geocode city first
 */
export async function getWeatherByCity(city: string): Promise<WeatherData> {
    console.log(`🌤️ Getting weather for city: ${city}`);

    // Geocode city to coordinates
    const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`;

    const geoResponse = await fetch(geoUrl, {
        headers: {
            'User-Agent': 'AIManagerBot/1.0',
        },
    });

    if (!geoResponse.ok) {
        throw new Error(`Geocoding error: ${geoResponse.status}`);
    }

    const geoData: NominatimResult[] = await geoResponse.json();

    if (!geoData[0]) {
        throw new Error(`City "${city}" not found`);
    }

    const { lat, lon, display_name } = geoData[0];
    const weather = await getWeather(parseFloat(lat), parseFloat(lon));

    // Use cleaner city name
    weather.location = display_name.split(',')[0];

    console.log(`🌤️ Weather for ${weather.location}: ${weather.temperature}°C, ${weather.description}`);

    return weather;
}
