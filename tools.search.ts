import { Tool } from "./tool.types";
import { search, searchImages } from "./searchService";

export const WebSearch: Tool = {
    name: 'WebSearch',
    description: 'Search the web using Google. Use when user asks about current events, needs real-time data, or asks "what is X". Returns web results and images.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'The search query (in English for best results)'
            },
            num_results: {
                type: 'number',
                description: 'Number of web results to return (default: 5, max: 10)'
            }
        },
        required: ['query']
    },
    execute: async (args: { userId: number; query: string; num_results?: number }) => {
        const numResults = Math.min(args.num_results || 5, 10);

        console.log(`🔍 WebSearch tool called: "${args.query}" (${numResults} results)`);

        const searchResponse = await search(args.query, numResults);

        // Build response object
        const response: {
            query: string;
            success: boolean;
            message?: string;
            webResults?: Array<{ title: string; url: string; snippet: string }>;
            images?: string[];
            totalResults?: string;
        } = {
            query: args.query,
            success: true
        };

        if (searchResponse.results.length > 0) {
            response.webResults = searchResponse.results.map(r => ({
                title: r.title,
                url: r.url,
                snippet: r.snippet
            }));
        }

        // Include images for aiService to handle separately
        if (searchResponse.images.length > 0) {
            response.images = searchResponse.images;
        }

        if (searchResponse.totalResults) {
            response.totalResults = searchResponse.totalResults;
        }

        if (searchResponse.results.length === 0) {
            response.success = false;
            response.message = 'No results found. Try a different search query.';
        }

        return response;
    }
};

export const SearchImages: Tool = {
    name: 'SearchImages',
    description: 'Search for images using Google. Use when user specifically asks for images or pictures.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'The image search query'
            },
            num_results: {
                type: 'number',
                description: 'Number of images to return (default: 3, max: 10)'
            }
        },
        required: ['query']
    },
    execute: async (args: { userId: number; query: string; num_results?: number }) => {
        const numResults = Math.min(args.num_results || 3, 10);

        console.log(`🖼️ SearchImages tool called: "${args.query}" (${numResults} images)`);

        const images = await searchImages(args.query, numResults);

        return {
            query: args.query,
            success: images.length > 0,
            images,
            message: images.length === 0 ? 'No images found.' : undefined
        };
    }
};
