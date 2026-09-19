export const config = {
    runtime: 'edge',
};

const CRAWLER_URL = 'https://web-crawler-pink.vercel.app/api/crawler';
const EXTRACTOR_URL = 'https://content-tacker.vercel.app/api/extract';

// Strict 14-second timeout. Guarantees a safe JSON return before Vercel's 15s hard limit.
const TOTAL_TIMEOUT_MS = 14000; 

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
    
    // If the global timeout fires, abort this local fetch too
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
        }, 6000, signal); 
        
        const text = await res.text();
        
        if (!res.ok) throw new Error(`Crawler API returned status: ${res.status}. Body: ${text.substring(0, 100)}`);
        
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error(`Crawler returned invalid JSON.`);
        }
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Search phase timed out.');
        throw err;
    }
}

// Step 2: Extract content in parallel
async function extractContent(url, signal, maxTimeoutMs) {
    const startTime = Date.now();

    try {
        const targetUrl = `${EXTRACTOR_URL}?url=${encodeURIComponent(url)}`;
        
        const res = await fetchWithTimeout(targetUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        }, maxTimeoutMs, signal); 
        
        const text = await res.text();
        let data;
        
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error(`Extractor returned invalid JSON (Status ${res.status}).`);
        }
        
        if (!data.success) {
            return { 
                url, 
                success: false, 
                content: null, 
                error: data.error, 
                debug: data.debug, 
                latency: Date.now() - startTime 
            };
        }
        
        return { 
            url, 
            success: true, 
            content: data.text, 
            debug: data.debug, 
            latency: Date.now() - startTime 
        };
    } catch (err) {
        return {
            url, 
            success: false, 
            content: null,
            error: err.name === 'AbortError' ? `Extraction timeout exceeded.` : err.message,
            debug: { method: "None", errors: [err.message] }, 
            latency: Date.now() - startTime
        };
    }
}

export default async function handler(req) {
    // 1. Handle CORS Preflight Requests
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2. Global Abort Controller to ensure we return safely before Vercel kills the function
    const controller = new AbortController();
    const globalTimeoutId = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
    const startOverallTime = Date.now();

    try {
        let input = {};
        if (req.method === 'POST') {
            try {
                input = await req.json();
            } catch (e) {
                // Ignore empty bodies
            }
        } else {
            const urlObj = new URL(req.url);
            input = Object.fromEntries(urlObj.searchParams.entries());
        }

        const action = input.action || 'auto'; 
        const count = parseInt(input.count || 20, 10);
        
        // Flexible query matching to prevent "Missing query" errors
        const query = input.query || input.q || input.search;
        
        let finalPayload = { 
            success: true, action, results: [], failed_extractions: 0, total_time_ms: 0 
        };

        if (action === 'search' || action === 'auto') {
            if (!query) {
                return new Response(JSON.stringify({ 
                    success: false, 
                    error: "Missing 'query' parameter. Please provide a ?query=... in the URL." 
                }), { status: 400, headers: CORS_HEADERS });
            }
            
            const searchData = await performSearch(query, count, controller.signal);
            let searchResults = searchData.results || [];
            
            if (action === 'search') {
                finalPayload.results = searchResults;
            } 
            
            if (action === 'auto') {
                // TRUE PARALLELIZATION: No batching! Fire all requests simultaneously!
                const timeElapsed = Date.now() - startOverallTime;
                let timeLeft = TOTAL_TIMEOUT_MS - timeElapsed;
                
                // Give extraction minimum 2 seconds to attempt, otherwise safely abort
                if (timeLeft < 2000) timeLeft = 2000; 
                const extractionTimeout = timeLeft - 500; 

                // Fire 59+ requests at the exact same time
                const extractionPromises = searchResults.map(async (res) => {
                    const ext = await extractContent(res.url, controller.signal, extractionTimeout);
                    if (!ext.success) finalPayload.failed_extractions++;
                    return { ...res, extraction: ext };
                });
                
                finalPayload.results = await Promise.all(extractionPromises);
            }
        } 
        else if (action === 'extract') {
            if (!input.urls || !Array.isArray(input.urls)) {
                return new Response(JSON.stringify({ 
                    success: false, 
                    error: "Missing 'urls' array parameter for extraction." 
                }), { status: 400, headers: CORS_HEADERS });
            }
            const extractionPromises = input.urls.map(async (url) => {
                const ext = await extractContent(url, controller.signal, TOTAL_TIMEOUT_MS - 500);
                if (!ext.success) finalPayload.failed_extractions++;
                return { url, extraction: ext };
            });
            finalPayload.results = await Promise.all(extractionPromises);
        } else {
            return new Response(JSON.stringify({ 
                success: false, 
                error: "Invalid action. Use 'auto', 'search', or 'extract'." 
            }), { status: 400, headers: CORS_HEADERS });
        }

        clearTimeout(globalTimeoutId);
        finalPayload.total_time_ms = Date.now() - startOverallTime;

        return new Response(JSON.stringify(finalPayload), { status: 200, headers: CORS_HEADERS });

    } catch (err) {
        clearTimeout(globalTimeoutId);
        return new Response(JSON.stringify({
            success: false,
            error: err.name === 'AbortError' ? 'Global timeout reached. Safely aborted to prevent 504 server crash.' : err.message,
            total_time_ms: Date.now() - startOverallTime
        }), { status: 200, headers: CORS_HEADERS });
    }
}
