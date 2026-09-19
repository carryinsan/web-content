export const config = {
    runtime: 'edge',
};

const CRAWLER_URL = 'https://web-crawler-pink.vercel.app/api/crawler';
const EXTRACTOR_URL = 'https://content-tacker.vercel.app/api/extract';

// Generous 28-second timeout for the edge function to maximize success rate
const TOTAL_TIMEOUT_MS = 28000; 

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
};

// Helper: Fetch with a localized timeout so one bad request doesn't hang the loop
async function fetchWithTimeout(resource, options = {}, timeoutMs, globalSignal) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    
    if (globalSignal) {
        globalSignal.addEventListener('abort', () => controller.abort());
    }
    
    try {
        const response = await fetch(resource, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// Step 1: Perform the search
async function performSearch(query, count, signal) {
    const targetUrl = `${CRAWLER_URL}?query=${encodeURIComponent(query)}&count=${count}`;
    
    try {
        const res = await fetchWithTimeout(targetUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        }, 10000, signal); 
        
        if (!res.ok) throw new Error(`Crawler API returned status: ${res.status}`);
        return await res.json();
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Search phase timed out.');
        throw err;
    }
}

// Step 2: Extract content (Delegates to content-tacker)
async function extractContent(url, signal) {
    const startTime = Date.now();

    try {
        const targetUrl = `${EXTRACTOR_URL}?url=${encodeURIComponent(url)}`;
        
        // Massive 25-second timeout to let content-tacker do proxy work safely
        const res = await fetchWithTimeout(targetUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        }, 25000, signal); 
        
        const data = await res.json();
        
        if (!data.success) {
            return { 
                url, success: false, content: null, 
                error: data.error, debug: data.debug, latency: Date.now() - startTime 
            };
        }
        
        return { 
            url, success: true, content: data.text, 
            debug: data.debug, latency: Date.now() - startTime 
        };
    } catch (err) {
        return {
            url, success: false, content: null,
            error: err.name === 'AbortError' ? 'Extraction timeout exceeded.' : err.message,
            debug: { method: "None", errors: [err.message] }, 
            latency: Date.now() - startTime
        };
    }
}

export default async function handler(req) {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const controller = new AbortController();
    const globalTimeoutId = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
    const startOverallTime = Date.now();

    try {
        let input = {};
        const urlObj = new URL(req.url);
        const queryParams = Object.fromEntries(urlObj.searchParams.entries());

        if (req.method === 'POST') {
            try {
                input = await req.json();
            } catch (e) {
                // Ignore empty POST bodies safely
            }
        }

        // Merge inputs, giving priority to POST body but retaining URL params
        input = { ...queryParams, ...input };

        const action = input.action || 'auto'; 
        const count = parseInt(input.count || 20, 10);
        
        // Universal query mapping to prevent "Missing query" errors!
        const query = input.query || input.q || input.search;
        
        let finalPayload = { 
            success: true, action, results: [], failed_extractions: 0, total_time_ms: 0 
        };

        if (action === 'search' || action === 'auto') {
            if (!query) {
                throw new Error("Missing 'query' parameter. Please pass ?query=YOUR_SEARCH in the URL.");
            }
            
            const searchData = await performSearch(query, count, controller.signal);
            let searchResults = searchData.results || [];
            
            if (action === 'search') {
                finalPayload.results = searchResults;
            } 
            
            if (action === 'auto') {
                // TRUE PARALLELIZATION: Fire all extractions at the exact same time
                const extractionPromises = searchResults.map(async (res) => {
                    const ext = await extractContent(res.url, controller.signal);
                    if (!ext.success) finalPayload.failed_extractions++;
                    return { ...res, extraction: ext };
                });
                
                finalPayload.results = await Promise.all(extractionPromises);
            }
        } 
        else if (action === 'extract') {
            if (!input.urls || !Array.isArray(input.urls)) {
                throw new Error("Missing 'urls' array parameter for extraction.");
            }
            const extractionPromises = input.urls.map(async (url) => {
                const ext = await extractContent(url, controller.signal);
                if (!ext.success) finalPayload.failed_extractions++;
                return { url, extraction: ext };
            });
            finalPayload.results = await Promise.all(extractionPromises);
        } else {
            throw new Error("Invalid action. Use 'auto', 'search', or 'extract'.");
        }

        clearTimeout(globalTimeoutId);
        finalPayload.total_time_ms = Date.now() - startOverallTime;

        return new Response(JSON.stringify(finalPayload), { status: 200, headers: CORS_HEADERS });

    } catch (err) {
        clearTimeout(globalTimeoutId);
        return new Response(JSON.stringify({
            success: false,
            error: err.name === 'AbortError' ? 'Global timeout reached. Safely halted.' : err.message,
            total_time_ms: Date.now() - startOverallTime
        }), { status: 200, headers: CORS_HEADERS }); // Return 200 to prevent frontend crashes
    }
}
