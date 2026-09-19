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

// Helper: Fetch with a localized timeout so one bad request doesn't hang the loop
async function fetchWithTimeout(resource, options = {}, timeoutMs, globalSignal) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    
    // If the global 14.5s timeout fires, abort this local fetch too
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
    const spoofedIP = getRandomIP();
    const targetUrl = `${CRAWLER_URL}?query=${encodeURIComponent(query)}&count=${count}`;
    
    try {
        const res = await fetchWithTimeout(targetUrl, {
            method: 'GET',
            headers: {
                'X-Forwarded-For': spoofedIP,
                'X-Real-IP': spoofedIP,
                'Client-IP': spoofedIP,
                'User-Agent': getRandomUserAgent(),
                'Accept': 'application/json'
            }
        }, 8000, signal); // 8s max for search
        
        if (!res.ok) throw new Error(`Crawler API returned status: ${res.status}`);
        const data = await res.json();
        return data;
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Search phase timed out.');
        throw err;
    }
}

// Step 2: Extract content (Direct Jina bypass + Fallback to Content Tacker)
async function extractContent(url, signal) {
    const spoofedIP = getRandomIP();
    const userAgent = getRandomUserAgent();
    const startTime = Date.now();
    let debugLog = { method: "None", errors: [] };

    // --- NEW: DIRECT TIER 1 JINA FETCH ---
    // We do this here so we can pass the spoofed IP directly to Jina.
    try {
        const jinaUrl = `https://r.jina.ai/${encodeURIComponent(url)}`;
        const jinaRes = await fetchWithTimeout(jinaUrl, {
            method: 'GET',
            headers: {
                'X-Forwarded-For': spoofedIP,
                'X-Real-IP': spoofedIP,
                'Accept': 'text/plain',
                'User-Agent': userAgent
            }
        }, 5000, signal); // 5 seconds max for Jina

        if (jinaRes.ok) {
            let text = await jinaRes.text();
            if (text && text.length > 100 && !text.includes("Cloudflare") && !text.includes("Just a moment...")) {
                text = text.replace(/\[.*?\]\(.*?\)/g, ''); // Strip markdown links for cleaner text
                return { 
                    url, success: true, content: text, debug: { method: "Tier 1: Direct Jina proxy", errors: [] }, latency: Date.now() - startTime 
                };
            } else {
                debugLog.errors.push("Jina returned empty or cloudflare blocked.");
            }
        } else {
            debugLog.errors.push(`Jina failed with status: ${jinaRes.status}`);
        }
    } catch (err) {
        debugLog.errors.push(`Tier 1 Direct Failed: ${err.message}`);
    }

    // --- FALLBACK: TIER 2 & 3 via CONTENT TACKER ---
    // If Jina blocks us, we fall back to your cheerio/regex scraper.
    try {
        const targetUrl = `${EXTRACTOR_URL}?url=${encodeURIComponent(url)}`;
        const res = await fetchWithTimeout(targetUrl, {
            method: 'GET',
            headers: {
                'X-Forwarded-For': spoofedIP,
                'X-Real-IP': spoofedIP,
                'User-Agent': userAgent,
                'Accept': 'application/json'
            }
        }, 6000, signal); // 6 seconds max for fallback
        
        const data = await res.json();
        
        if (!data.success) {
            debugLog.errors.push(...(data.debug?.errors || [data.error]));
            return { url, success: false, content: null, error: "All tiers failed.", debug: debugLog, latency: Date.now() - startTime };
        }
        
        return { 
            url, success: true, content: data.text, debug: data.debug, latency: Date.now() - startTime 
        };
    } catch (err) {
        return {
            url, success: false, content: null,
            error: err.name === 'AbortError' ? 'Extraction timeout exceeded.' : err.message,
            debug: debugLog, latency: Date.now() - startTime
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

        const action = input.action || 'auto'; 
        const count = parseInt(input.count || 20, 10);
        
        let finalPayload = { 
            success: true, action, results: [], failed_extractions: 0, total_time_ms: 0 
        };

        if (action === 'search' || action === 'auto') {
            if (!input.query) throw new Error("Missing 'query' parameter.");
            
            const searchData = await performSearch(input.query, count, controller.signal);
            let searchResults = searchData.results || [];
            
            if (action === 'search') {
                finalPayload.results = searchResults;
            } 
            
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
                throw new Error("Missing 'urls' array parameter.");
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
            error: err.name === 'AbortError' ? 'Global timeout (15s) reached. The request was halted to prevent server failure.' : err.message,
            total_time_ms: Date.now() - startOverallTime
        }), { status: 200, headers: CORS_HEADERS });
    }
}
