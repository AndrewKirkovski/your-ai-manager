/**
 * DuckDuckGo Search Service
 *
 * Uses DuckDuckGo's Instant Answer API for quick facts and
 * HTML search for web results.
 */

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}

export interface InstantAnswer {
    abstract: string;
    abstractSource: string;
    abstractURL: string;
    answer: string;
    answerType: string;
    relatedTopics: Array<{
        text: string;
        url: string;
    }>;
}

interface DDGInstantAnswerResponse {
    Abstract: string;
    AbstractSource: string;
    AbstractURL: string;
    Answer: string;
    AnswerType: string;
    RelatedTopics: Array<{
        Text?: string;
        FirstURL?: string;
        Topics?: Array<{
            Text: string;
            FirstURL: string;
        }>;
    }>;
}

// Rate limiting: 1 request per second
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1000; // 1 second

async function rateLimitedFetch(url: string, options?: RequestInit): Promise<Response> {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;

    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
    }

    lastRequestTime = Date.now();
    return fetch(url, options);
}

/**
 * Get instant answer from DuckDuckGo
 * Good for quick facts, definitions, calculations
 */
export async function getInstantAnswer(query: string): Promise<InstantAnswer | null> {
    try {
        const encodedQuery = encodeURIComponent(query);
        const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`;

        const response = await rateLimitedFetch(url, {
            headers: {
                'User-Agent': 'AIManagerBot/1.0 (Telegram Bot; https://github.com/)'
            }
        });

        if (!response.ok) {
            console.error('DuckDuckGo API error:', response.status);
            return null;
        }

        const data = await response.json() as DDGInstantAnswerResponse;

        // Check if we got a useful answer
        if (!data.Abstract && !data.Answer && (!data.RelatedTopics || data.RelatedTopics.length === 0)) {
            return null;
        }

        const relatedTopics = data.RelatedTopics
            .filter(topic => topic.Text && topic.FirstURL)
            .slice(0, 5)
            .map(topic => ({
                text: topic.Text!,
                url: topic.FirstURL!
            }));

        return {
            abstract: data.Abstract || '',
            abstractSource: data.AbstractSource || '',
            abstractURL: data.AbstractURL || '',
            answer: data.Answer || '',
            answerType: data.AnswerType || '',
            relatedTopics
        };
    } catch (error) {
        console.error('Error fetching instant answer:', error);
        return null;
    }
}

/**
 * Search DuckDuckGo HTML and parse results
 * Returns web search results
 */
export async function searchWeb(query: string, numResults: number = 5): Promise<SearchResult[]> {
    try {
        const encodedQuery = encodeURIComponent(query);
        // Use DuckDuckGo HTML search
        const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

        const response = await rateLimitedFetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            }
        });

        if (!response.ok) {
            console.error('DuckDuckGo search error:', response.status);
            return [];
        }

        const html = await response.text();

        // Parse results from HTML
        const results: SearchResult[] = [];

        // Match result blocks - DuckDuckGo HTML format
        const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([^<]*)<\/a>/g;
        let match;

        while ((match = resultRegex.exec(html)) !== null && results.length < numResults) {
            const url = decodeURIComponent(match[1].replace(/^\/\/duckduckgo.com\/l\/\?uddg=/, '').split('&')[0]);
            const title = match[2].trim();
            const snippet = match[3].trim();

            if (url && title && !url.includes('duckduckgo.com')) {
                results.push({
                    title,
                    url,
                    snippet
                });
            }
        }

        // Fallback: try alternative parsing if first method fails
        if (results.length === 0) {
            const altRegex = /<div class="result[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>[\s\S]*?<h2[^>]*>([^<]*)<\/h2>[\s\S]*?<span[^>]*class="[^"]*snippet[^"]*"[^>]*>([^<]*)<\/span>/g;

            while ((match = altRegex.exec(html)) !== null && results.length < numResults) {
                const url = match[1];
                const title = match[2].trim();
                const snippet = match[3].trim();

                if (url && title && !url.includes('duckduckgo.com')) {
                    results.push({
                        title,
                        url,
                        snippet
                    });
                }
            }
        }

        console.log(`🔍 DuckDuckGo search for "${query}" returned ${results.length} results`);
        return results;
    } catch (error) {
        console.error('Error searching web:', error);
        return [];
    }
}

/**
 * Combined search: tries instant answer first, then web search
 */
export async function search(query: string, numResults: number = 5): Promise<{
    instantAnswer: InstantAnswer | null;
    webResults: SearchResult[];
}> {
    // Try instant answer first (for facts, definitions, etc.)
    const instantAnswer = await getInstantAnswer(query);

    // If no instant answer or user needs web results, do web search
    const webResults = await searchWeb(query, numResults);

    return {
        instantAnswer,
        webResults
    };
}
