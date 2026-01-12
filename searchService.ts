/**
 * Google Custom Search Service
 *
 * Uses Google Custom Search JSON API.
 * Requires API key and Search Engine ID from Google Cloud Console.
 */

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}

export interface SearchResponse {
    results: SearchResult[];
    images: string[];
    totalResults?: string;
    searchTime?: number;
}

interface GoogleSearchItem {
    title: string;
    link: string;
    snippet: string;
    pagemap?: {
        cse_image?: Array<{ src: string }>;
        cse_thumbnail?: Array<{ src: string; width: string; height: string }>;
    };
}

interface GoogleSearchResponse {
    items?: GoogleSearchItem[];
    searchInformation?: {
        totalResults: string;
        searchTime: number;
    };
    error?: {
        code: number;
        message: string;
    };
}

/**
 * Search using Google Custom Search API
 * Returns both text results and images
 */
export async function search(query: string, numResults: number = 5): Promise<SearchResponse> {
    const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
    const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

    if (!apiKey || !searchEngineId) {
        console.error('❌ Google Search API credentials not configured');
        return {
            results: [],
            images: [],
        };
    }

    const num = Math.min(Math.max(numResults, 1), 10); // Google allows 1-10
    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${searchEngineId}&q=${encodeURIComponent(query)}&num=${num}`;

    console.log(`🔍 Google Search: "${query}" (${num} results)`);

    try {
        const response = await fetch(url);
        const data: GoogleSearchResponse = await response.json();

        if (data.error) {
            console.error('❌ Google Search API error:', data.error.message);
            return {
                results: [],
                images: [],
            };
        }

        const results: SearchResult[] = [];
        const images: string[] = [];

        for (const item of data.items || []) {
            results.push({
                title: item.title,
                url: item.link,
                snippet: item.snippet || '',
            });

            // Extract images from pagemap
            const imageUrl = item.pagemap?.cse_image?.[0]?.src ||
                            item.pagemap?.cse_thumbnail?.[0]?.src;
            if (imageUrl && !images.includes(imageUrl)) {
                images.push(imageUrl);
            }
        }

        console.log(`🔍 Found ${results.length} results, ${images.length} images`);

        return {
            results,
            images,
            totalResults: data.searchInformation?.totalResults,
            searchTime: data.searchInformation?.searchTime,
        };
    } catch (error) {
        console.error('❌ Google Search error:', error);
        return {
            results: [],
            images: [],
        };
    }
}

/**
 * Image-focused search using Google Custom Search API
 */
export async function searchImages(query: string, numResults: number = 5): Promise<string[]> {
    const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
    const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

    if (!apiKey || !searchEngineId) {
        console.error('❌ Google Search API credentials not configured');
        return [];
    }

    const num = Math.min(Math.max(numResults, 1), 10);
    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${searchEngineId}&q=${encodeURIComponent(query)}&num=${num}&searchType=image`;

    console.log(`🖼️ Google Image Search: "${query}" (${num} results)`);

    try {
        const response = await fetch(url);
        const data: GoogleSearchResponse = await response.json();

        if (data.error) {
            console.error('❌ Google Image Search API error:', data.error.message);
            return [];
        }

        const images = (data.items || []).map(item => item.link);

        console.log(`🖼️ Found ${images.length} images`);
        return images;
    } catch (error) {
        console.error('❌ Google Image Search error:', error);
        return [];
    }
}
