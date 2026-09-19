export const config = {
    runtime: 'edge',
};

const CRAWLER_URL = 'https://web-crawler-pink.vercel.app/api/crawler';
const EXTRACTOR_URL = 'https://content-tacker.vercel.app/api/extract';

// Strict 14.5s timeout to safely return before Vercel's 15s absolute cutoff.
const TOTAL_TIMEOUT_MS = 14500; 

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
};

// Bypassing basic IP-based rate limiting by rotating believable Public IP ranges
function getRandomIP() {
    const validFirstOctets = [8, 12, 17, 23, 34, 45, 50, 67, 72, 80, 99, 104, 142, 168, 173, 198, 203];
    const first = validFirstOctets[Math.floor(Math.random() * validFirstOctets.length)];
    return `${first}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

// Randomizing User-Agents to prevent bot detection blocking
function getRandomUserAgent() {
    const uas = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
    ];
    return uas[Math.floor(Math.random() * uas.length)];
}

// Step 1: Perform the search
async function performSearch(query, count, signal) {
    const spoofedIP = getRandomIP();
    const targetUrl = `${CRAWLER_URL}?query=${encodeURIComponent(query)}&count=${count}`;
    
    try {
        const res = await fetch(targetUrl, {
            method: 'GET',
            headers: {
                'X-Forwarded-For': spoofedIP,
                'X-Real-IP': spoofedIP,
                'Client-IP': spoofedIP,
                'User-Agent': getRandomUserAgent(),
                'Accept': 'application/json'
            },
            signal
        });
        
        if (!res.ok) throw new Error(`Crawler API returned status: ${res.status}`);
        const data = await res.json();
        return data;
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Search phase timed out.');
        throw err;
    }
}

// Step 2: Extract content (Designed to run in parallel without blocking others)
async function extractContent(url, signal) {
    const spoofedIP = getRandomIP();
    const targetUrl = `${EXTRACTOR_URL}?url=${encodeURIComponent(url)}`;
    
    const startTime = Date.now();
    try {
        const res = await fetch(targetUrl, {
            method: 'GET',
            headers: {
                'X-Forwarded-For': spoofedIP,
                'X-Real-IP': spoofedIP,
                'Client-IP': spoofedIP,
                'User-Agent': getRandomUserAgent(),
                'Accept': 'application/json'
            },
            signal
        });
        
        const data = await res.json();
        
        if (!data.success) {
            return { url, success: false, content: null, error: data.error, latency: Date.now() - startTime };
        }
        
        return { 
            url, 
            success: true, 
            content: data.text, 
            debug: data.debug,
            latency: Date.now() - startTime 
        };
    } catch (err) {
        // Fail gracefully so other parallel requests continue seamlessly
        return {
            url,
            success: false,
            content: null,
            error: err.name === 'AbortError' ? 'Extraction timeout exceeded before completion.' : err.message,
            latency: Date.now() - startTime
        };
    }
}

export default async function handler(req) {
    // 1. Handle CORS Preflight Requests
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2. Global Abort Controller to ensure 15s Vercel limit is never hit
    const controller = new AbortController();
    const globalTimeoutId = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
    const startOverallTime = Date.now();

    try {
        let input = {};
        if (req.method === 'POST') {
            input = await req.json();
        } else {
            const urlObj = new URL(req.url);
            input = Object.fromEntries(urlObj.searchParams.entries());
        }

        // Available actions: 'auto' (search + extract), 'search' (search only), 'extract' (extract provided URLs)
        const action = input.action || 'auto'; 
        const count = parseInt(input.count || 20, 10);
        
        let finalPayload = { 
            success: true, 
            action, 
            results: [], 
            failed_extractions: 0, 
            total_time_ms: 0 
        };

        if (action === 'search' || action === 'auto') {
            if (!input.query) {
                throw new Error("Missing 'query' parameter for search.");
            }
            
            // Phase A: Get URLs
            const searchData = await performSearch(input.query, count, controller.signal);
            let searchResults = searchData.results || [];
            
            if (action === 'search') {
                finalPayload.results = searchResults;
            } 
            
            // Phase B: Auto Extract (Massively Parallel)
            if (action === 'auto') {
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
            
            // Phase B (Standalone): Extract directly from user-provided URLs in parallel
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

        return new Response(JSON.stringify(finalPayload), {
            status: 200,
            headers: CORS_HEADERS
        });

    } catch (err) {
        clearTimeout(globalTimeoutId);
        
        return new Response(JSON.stringify({
            success: false,
            error: err.name === 'AbortError' ? 'Global timeout (15s) reached. The request was halted to prevent server failure.' : err.message,
            total_time_ms: Date.now() - startOverallTime
        }), {
            status: 200, // Returning 200 guarantees the frontend can beautifully parse the JSON error
            headers: CORS_HEADERS
        });
    }
}
