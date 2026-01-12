import {Tool} from "./tool.types";
import {search, getInstantAnswer} from "./searchService";

export const WebSearch: Tool = {
    name: 'WebSearch',
    description: 'Search the web for current information, news, facts, or answers. Use when user asks about current events, needs real-time data, or asks "what is X". Returns instant answers (for facts/definitions) and web results.',
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

        const { instantAnswer, webResults } = await search(args.query, numResults);

        // Build response object
        const response: {
            query: string;
            success: boolean;
            message?: string;
            instantAnswer?: {
                answer: string;
                source: string;
                sourceUrl: string;
                type: string;
            };
            relatedTopics?: Array<{ text: string; url: string }>;
            webResults?: Array<{ title: string; url: string; snippet: string }>;
        } = {
            query: args.query,
            success: true
        };

        if (instantAnswer) {
            response.instantAnswer = {
                answer: instantAnswer.answer || instantAnswer.abstract,
                source: instantAnswer.abstractSource,
                sourceUrl: instantAnswer.abstractURL,
                type: instantAnswer.answerType
            };

            if (instantAnswer.relatedTopics.length > 0) {
                response.relatedTopics = instantAnswer.relatedTopics.slice(0, 3);
            }
        }

        if (webResults.length > 0) {
            response.webResults = webResults.map(r => ({
                title: r.title,
                url: r.url,
                snippet: r.snippet
            }));
        }

        if (!instantAnswer && webResults.length === 0) {
            response.success = false;
            response.message = 'No results found. Try a different search query.';
        }

        return response;
    }
};

export const GetInstantAnswer: Tool = {
    name: 'GetInstantAnswer',
    description: 'Get a quick factual answer from DuckDuckGo. Best for definitions, calculations, simple facts. Faster than full web search.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'The question or topic to look up'
            }
        },
        required: ['query']
    },
    execute: async (args: { userId: number; query: string }) => {
        console.log(`⚡ GetInstantAnswer tool called: "${args.query}"`);

        const answer = await getInstantAnswer(args.query);

        if (!answer) {
            return {
                success: false,
                query: args.query,
                message: 'No instant answer available. Try WebSearch for more comprehensive results.'
            };
        }

        return {
            success: true,
            query: args.query,
            answer: answer.answer || answer.abstract,
            source: answer.abstractSource,
            sourceUrl: answer.abstractURL,
            relatedTopics: answer.relatedTopics.slice(0, 3)
        };
    }
};
