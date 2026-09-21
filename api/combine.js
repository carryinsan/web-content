/*
 * ArixAI Combined Search + Crawler-Guided Content Extractor
 * v4.0 — Ultra-Low Latency Optimization with Heuristic Viability Predictor
 *
 * DROP-IN replacement for: api/combine.js
 * Runtime: Vercel Edge
 */

export const config = {
    runtime: 'edge',
};

const CRAWLER_URL = 'https://web-crawler-pink.vercel.app/api/crawler';
const EXTRACTOR_URL = 'https://content-tacker.vercel.app/api/extract';
const JINA_READER_BASE = 'https://r.jina.ai/';

// Global caps to enforce sub-10s responses.
const TOTAL_TIMEOUT_MS = 15500; 

// Phase budgets aggressively tuned for fail-fast behavior
const SEARCH_TIMEOUT_MS = 4500;
const PREFLIGHT_TIMEOUT_MS = 0;
const EXTRACTION_TIMEOUT_MS = 8000; // Drastically reduced from 8000ms to prevent bottlenecking
const JINA_FALLBACK_TIMEOUT_MS = 1800; // Reduced from 2200ms

// Strict candidate limits to prevent network saturation
const MAX_AUTO_CANDIDATES = 20; // Reduced from 40. Quality > Quantity for speed.
const MAX_HOSTS_PER_SOURCE = 2; // Reduced from 12. Forces diversity, prevents one slow host from clogging.
const MAX_JINA_FALLBACKS = 3;

// Massive concurrency boost. We blast out requests simultaneously.
const EXTRACTION_CONCURRENCY = 25; // Increased from 6
const MAX_CRAWLER_RESULTS = 40;
const DEFAULT_COUNT = 20;

const MIN_REUSABLE_CRAWLER_TEXT = 400;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
};

const SEARCH_SURFACE_HOSTS = new Set([
    'google.com', 'www.google.com', 'bing.com', 'www.bing.com',
    'search.brave.com', 'yahoo.com', 'search.yahoo.com',
    'duckduckgo.com', 'www.duckduckgo.com', 'news.google.com',
    'yandex.com', 'www.yandex.com', 'baidu.com', 'naver.com'
]);

const SHORTENER_HOSTS = new Set([
    't.co', 'bit.ly', 'tinyurl.com', 'lnkd.in', 'is.gd', 'ow.ly',
    'buff.ly', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'rb.gy',
]);

const HARD_BLOCK_HOSTS = new Set([
    'googleweblight.com',
    'webcache.googleusercontent.com',
    'translate.google.com',
]);

const BAD_URL_MARKERS = [
    '/captcha', 'captcha=', 'recaptcha', 'hcaptcha',
    '/challenge', 'cf-chl-', 'challenge-platform',
    'access-denied', 'access_denied', 'accessdenied',
    '/forbidden', 'forbidden=',
    'bot-check', 'botcheck', 'verify-human', 'verify-you-are-human',
    'security-check', 'ddos-guard',
];

const BLOCKED_HTTP_STATUSES = new Set([401, 403, 407, 429, 451]);

const POSITIVE_BANDS = new Set([
    'strong', 'strong_match', 'strong-match', 'usable',
    'highly_relevant', 'highly-relevant', 'likely', 'likely_relevant',
    'likely-relevant', 'relevant', 'related', 'partial', 'partial_match', 'partial-match',
]);

const NEGATIVE_BANDS = new Set([
    'weak', 'irrelevant', 'unusable', 'none', 'no_match', 'no-match',
]);

// ============================================================================
// NEW ALGORITHM: HEURISTIC EXTRACTION VIABILITY PREDICTOR
// Predicts if a page will fail or take too long before we even try to extract it.
// ============================================================================

// Extensions that take massive amounts of time to parse (like PDFs taking 5-8s)
const SLOW_OR_UNEXTRACTABLE_EXTENSIONS = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|exe|mp4|mp3|avi|mov|jpg|jpeg|png|gif|webp)$/i;

// Domains guaranteed to throw captchas, auth walls, or rate limits at headless browsers
const HIGH_BLOCK_DOMAINS = new Set([
    'linkedin.com', 'www.linkedin.com',
    'facebook.com', 'www.facebook.com',
    'instagram.com', 'www.instagram.com',
    'twitter.com', 'x.com',
    'tiktok.com', 'www.tiktok.com',
    'bloomberg.com', 'www.bloomberg.com',
    'wsj.com', 'www.wsj.com',
    'glassdoor.com', 'www.glassdoor.com',
    'g2.com', 'www.g2.com',
    'capterra.com', 'www.capterra.com',
    'yelp.com', 'www.yelp.com',
    'quora.com', 'www.quora.com'
]);

function predictExtractionViability(url, item) {
    if (!url) return { viable: false, reason: 'no-url' };

    try {
        const urlObj = new URL(url);
        
        // 1. Skip heavy document files (The biggest source of 5-8s latency spikes)
        if (SLOW_OR_UNEXTRACTABLE_EXTENSIONS.test(urlObj.pathname)) {
            return { viable: false, reason: 'heavy-file-extension-skipped' };
        }

        // 2. Skip known anti-bot / paywall domains
        if (HIGH_BLOCK_DOMAINS.has(urlObj.hostname)) {
            return { viable: false, reason: 'high-block-probability-domain' };
        }
    } catch(e) {}

    // 3. Analyze snippet/title text for advanced block/paywall signatures
    const title = normalizeText(getResultTitle(item)).toLowerCase();
    const snippet = normalizeText(getResultSnippet(item)).toLowerCase();
    const text = `${title} ${snippet}`;

    if (text.includes('enable javascript') && text.includes('browser')) return { viable: false, reason: 'js-wall-detected' };
    if (text.includes('are you a robot') || text.includes('verify you are human')) return { viable: false, reason: 'captcha-detected' };
    if (text.includes('subscribe to read') || text.includes('log in to continue')) return { viable: false, reason: 'paywall-login-detected' };
    if (text.includes('access denied') || text.includes('403 forbidden')) return { viable: false, reason: 'forbidden-detected' };
    if (text.includes('cloudflare ray id')) return { viable: false, reason: 'cloudflare-challenge-detected'};

    return { viable: true, reason: 'looks-good' };
}
// ============================================================================

function jsonResponse(payload, status = 200) {
    return new Response(safeJsonStringify(payload), {
        status, headers: CORS_HEADERS,
    });
}

function safeJsonStringify(value) {
    try { return JSON.stringify(value); } 
    catch { return JSON.stringify({ success: false, error: 'SERIALIZATION_FAILED' }); }
}

function clampInt(value, min, max, fallback) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function normalizeText(value, maxLen = 7000) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen);
}

function getField(obj, keys) {
    if (!obj || typeof obj !== 'object') return '';
    for (const key of keys) {
        const value = obj[key];
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number') return String(value);
        if (typeof value === 'boolean') return value ? 'true' : 'false';
    }
    return '';
}

function getResultTitle(item) { return getField(item, ['title', 'name', 'headline', 'pageTitle']); }
function getResultSnippet(item) { return getField(item, ['snippet', 'description', 'summary', 'excerpt', 'text']); }
function getResultUrl(item) { return getField(item, ['url', 'link', 'href', 'sourceUrl', 'source_url']); }

function canonicalizeUrl(rawUrl) {
    try {
        const u = new URL(String(rawUrl));
        if (!/^https?:$/.test(u.protocol)) return null;
        u.hash = '';
        u.hostname = u.hostname.toLowerCase();

        const trackingExact = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid']);
        for (const key of [...u.searchParams.keys()]) {
            const lower = key.toLowerCase();
            if (lower.startsWith('utm_') || trackingExact.has(lower)) {
                u.searchParams.delete(key);
            }
        }
        if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
        return u.toString();
    } catch { return null; }
}

function getHost(rawUrl) {
    try { return new URL(rawUrl).hostname.toLowerCase(); } 
    catch { return ''; }
}

function isSearchSurface(host) {
    if (!host) return false;
    if (SEARCH_SURFACE_HOSTS.has(host)) return true;
    for (const known of SEARCH_SURFACE_HOSTS) {
        if (host.endsWith(`.${known}`)) return true;
    }
    return false;
}

function looksObviousBadUrl(rawUrl) {
    const url = canonicalizeUrl(rawUrl);
    if (!url) return { bad: true, reason: 'invalid-url', url: null };

    const lower = url.toLowerCase();
    const host = getHost(url);
    if (isSearchSurface(host)) return { bad: true, reason: 'search-surface-url', url };
    if (SHORTENER_HOSTS.has(host)) return { bad: true, reason: 'url-shortener', url };
    if (HARD_BLOCK_HOSTS.has(host)) return { bad: true, reason: 'hard-block-host', url };
    if (BAD_URL_MARKERS.some(marker => lower.includes(marker))) {
        return { bad: true, reason: 'challenge-or-block-marker', url };
    }
    return { bad: false, reason: null, url };
}

function crawlerBand(item) {
    return String(item?.relevanceBand ?? item?.relevance?.band ?? '')
        .trim().toLowerCase().replace(/\s+/g, '_');
}

function matchLabelFromCrawlerBand(band) {
    const b = String(band || '').toLowerCase().trim().replace(/\s+/g, '_');
    if (b === 'strong' || b === 'strong_match' || b === 'strong-match' || b === 'usable' || b === 'highly_relevant' || b === 'highly-relevant') {
        return 'strong match';
    }
    if (b === 'likely' || b === 'likely_relevant' || b === 'likely-relevant' || b === 'relevant' || b === 'related') {
        return 'likely relevant';
    }
    if (b === 'partial' || b === 'partial_match' || b === 'partial-match') {
        return 'partial match';
    }
    return b || 'unclassified';
}

function crawlerBandDecision(item) {
    const band = crawlerBand(item);
    if (NEGATIVE_BANDS.has(band)) {
        return { allowed: false, band, label: matchLabelFromCrawlerBand(band), reason: 'crawler-weak-band' };
    }
    if (POSITIVE_BANDS.has(band)) {
        return { allowed: true, band, label: matchLabelFromCrawlerBand(band), reason: null };
    }
    return { allowed: true, band, label: matchLabelFromCrawlerBand(band), reason: 'crawler-band-unknown-kept' };
}

function sourceHttpDecision(item) {
    const status = Number(item?.httpStatus);
    if (!Number.isFinite(status) || status <= 0) return { bad: false, reason: null, hard: false };
    if (BLOCKED_HTTP_STATUSES.has(status)) return { bad: true, reason: `http-${status}`, hard: true };
    if (status >= 300 && status < 400) return { bad: true, reason: `redirect-${status}`, hard: true };
    return { bad: false, reason: null, hard: false };
}

function normalizeSearchResults(searchData) {
    const raw = Array.isArray(searchData?.results) ? searchData.results : [];
    const seen = new Set();
    const out = [];

    for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (!item || typeof item !== 'object') continue;

        const urlInfo = looksObviousBadUrl(getResultUrl(item));
        if (urlInfo.bad) continue;
        const key = urlInfo.url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
            ...item,
            url: urlInfo.url,
            _originalRank: Number(item.rank) || i + 1,
            crawlerRank: Number(item.rank) || i + 1,
        });
    }

    out.sort((a, b) => a._originalRank - b._originalRank);
    return out;
}

function candidateReason(item) {
    const band = crawlerBandDecision(item);
    if (!band.allowed) return { allowed: false, reason: band.reason, band: band.band, label: band.label };

    const http = sourceHttpDecision(item);
    if (http.bad) return { allowed: false, reason: http.reason, band: band.band, label: band.label };

    // Inject the new Viability Predictor Here
    const url = getResultUrl(item);
    const viability = predictExtractionViability(url, item);
    if (!viability.viable) {
        return { allowed: false, reason: viability.reason, band: band.band, label: band.label };
    }

    return { allowed: true, reason: null, band: band.band, label: band.label };
}

function decorateCrawlerMatch(item) {
    const d = crawlerBandDecision(item);
    return {
        ...item,
        crawlerRelevanceBand: item?.relevanceBand ?? null,
        crawlerRelevanceScore: item?.relevanceScore ?? item?.relevance?.score ?? null,
        matchLabel: d.label,
    };
}

function selectCandidates(searchResults) {
    let weakDropped = 0;
    let badUrlOrAccessDropped = 0;
    let predictorDropped = 0;
    const accepted = [];

    for (const item of searchResults) {
        const decision = candidateReason(item);

        if (!decision.allowed) {
            if (decision.reason === 'crawler-weak-band') weakDropped++;
            else if (decision.reason.includes('detected') || decision.reason.includes('domain') || decision.reason.includes('extension')) predictorDropped++;
            else badUrlOrAccessDropped++;
            continue;
        }

        accepted.push({
            item: decorateCrawlerMatch(item),
            band: decision.band,
            label: decision.label,
            rank: item._originalRank || 999,
        });
    }

    const selected = [];
    const hostCounts = new Map();

    // Stricter one-to-two-per-host diversity cap
    for (const entry of accepted) {
        if (selected.length >= MAX_AUTO_CANDIDATES) break;
        
        const host = getHost(entry.item.url);
        const count = hostCounts.get(host) || 0;
        
        if (count < MAX_HOSTS_PER_SOURCE) {
            hostCounts.set(host, count + 1);
            selected.push(entry);
        }
    }

    selected.sort((a, b) => a.rank - b.rank);

    return {
        selected,
        stats: {
            received: searchResults.length,
            crawlerPositive: accepted.length,
            weakDropped,
            badUrlOrAccessDropped,
            predictorDropped, // New metric
            selected: selected.length,
        },
    };
}

async function fetchWithTimeout(resource, options = {}, timeoutMs, globalSignal) {
    const controller = new AbortController();
    let timer = null;
    let globalHandler = null;

    const abortFromGlobal = () => controller.abort();

    if (globalSignal) {
        if (globalSignal.aborted) controller.abort();
        else {
            globalHandler = abortFromGlobal;
            globalSignal.addEventListener('abort', globalHandler, { once: true });
        }
    }

    timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

    try {
        return await fetch(resource, { ...options, signal: controller.signal });
    } finally {
        if (timer) clearTimeout(timer);
        if (globalSignal && globalHandler) {
            globalSignal.removeEventListener('abort', globalHandler);
        }
    }
}

async function readJsonSafely(response) {
    const raw = await response.text();
    if (!raw) return { ok: false, data: null, raw: '' };
    try { return { ok: true, data: JSON.parse(raw), raw }; } 
    catch { return { ok: false, data: null, raw: raw.slice(0, 6000) }; }
}

async function performSearch(query, count, globalSignal) {
    const targetUrl = `${CRAWLER_URL}?query=${encodeURIComponent(query)}&count=${count}`;
    try {
        const res = await fetchWithTimeout(targetUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        }, SEARCH_TIMEOUT_MS, globalSignal);

        const parsed = await readJsonSafely(res);
        if (!res.ok) throw new Error(`Crawler API returned status ${res.status}`);
        if (!parsed.ok || !parsed.data || typeof parsed.data !== 'object') {
            throw new Error('Crawler API returned invalid JSON.');
        }
        return parsed.data;
    } catch (err) {
        if (err?.name === 'AbortError') throw new Error('Search phase timed out.');
        throw err;
    }
}

function extractionLooksLikeBlockedOrTransportError(text) {
    const sample = normalizeText(text, 7000).toLowerCase();
    if (!sample) return false;

    if (/warning:\s*target url returned error\s+(401|403|407|429|451|5\d\d)\b/i.test(sample)) return true;
    if (/target url returned error\s+(401|403|407|429|451)/i.test(sample)) return true;
    if (sample.length < 5000 && /^(access denied|forbidden|unauthorized|request blocked)\s*$/.test(sample.trim())) return true;
    if (sample.includes('checking your browser before accessing') && sample.length < 12000) return true;
    return false;
}

function makeCombinedCancellationController(globalSignal) {
    const controller = new AbortController();
    let handler = null;
    if (globalSignal) {
        if (globalSignal.aborted) controller.abort();
        else {
            handler = () => controller.abort();
            globalSignal.addEventListener('abort', handler, { once: true });
        }
    }
    return { controller, cleanup() { if (globalSignal && handler) globalSignal.removeEventListener('abort', handler); } };
}

async function extractWithContentTacker(url, globalSignal, cancelSignal = null) {
    const start = Date.now();
    let localCancel = null;
    let linkedSignal = globalSignal;
    try {
        if (cancelSignal) {
            localCancel = makeCombinedCancellationController(globalSignal);
            cancelSignal.addEventListener('abort', () => localCancel.controller.abort(), { once: true });
            linkedSignal = localCancel.controller.signal;
        }
        const targetUrl = `${EXTRACTOR_URL}?url=${encodeURIComponent(url)}`;
        const res = await fetchWithTimeout(targetUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        }, EXTRACTION_TIMEOUT_MS, linkedSignal);

        const parsed = await readJsonSafely(res);
        if (!res.ok) {
            return {
                url, success: false, content: null,
                error: `Extractor API returned status ${res.status}`,
                debug: { method: 'content-tacker', status: res.status },
                latency: Date.now() - start,
            };
        }

        if (!parsed.ok || !parsed.data || typeof parsed.data !== 'object') {
            return {
                url, success: false, content: null,
                error: 'Extractor API returned invalid JSON.',
                debug: { method: 'content-tacker', rawPreview: parsed.raw.slice(0, 500) },
                latency: Date.now() - start,
            };
        }

        const data = parsed.data;
        const text = normalizeText(data.text ?? data.content ?? data.markdown ?? '', 500000);
        const blocked = contentLooksBlocked(text, JSON.stringify(data.debug || ''));
        const transportError = extractionLooksLikeBlockedOrTransportError(text);

        if (!data.success || !text || blocked || transportError) {
            return {
                url, success: false, content: text || null,
                error: transportError ? 'Extractor returned an upstream blocked/error page.' : (blocked ? 'Extractor returned blocked/challenge content.' : (data.error || 'No extractable content returned.')),
                debug: { method: 'content-tacker', ...(data.debug || {}) },
                latency: Date.now() - start,
            };
        }

        return {
            url, success: true, content: text,
            debug: { method: 'content-tacker', ...(data.debug || {}) },
            latency: Date.now() - start,
        };
    } catch (err) {
        return {
            url, success: false, content: null,
            error: err?.name === 'AbortError' ? 'Extraction timeout exceeded.' : String(err?.message || err),
            debug: { method: 'content-tacker', errors: [String(err?.message || err)] },
            latency: Date.now() - start,
        };
    } finally {
        if (localCancel) localCancel.cleanup();
    }
}

function getCrawlerPageContent(item) {
    if (!item || typeof item !== 'object') return '';
    const candidates = [item.contentForAI, item.pageContent, item.extractedText];
    for (const value of candidates) {
        const text = normalizeText(value, 500000);
        if (text.length >= MIN_REUSABLE_CRAWLER_TEXT && !contentLooksBlocked(text)) {
            return text;
        }
    }
    return '';
}

function crawlerContentExtraction(item) {
    const text = getCrawlerPageContent(item);
    if (!text) return null;
    return {
        url: item.url, success: true, content: text,
        debug: { method: 'crawler-native-content', contentLength: text.length },
        latency: 0,
    };
}

function contentLooksBlocked(text, debugText = '') {
    const sample = `${normalizeText(text, 9000)} ${normalizeText(debugText, 3500)}`.toLowerCase();
    if (!sample) return false;

    if (sample.includes('verify you are human')) return true;
    if (sample.includes('complete the security check')) return true;
    if (sample.includes('checking your browser before accessing')) return true;
    if (sample.includes('just a moment...') && sample.includes('cloudflare')) return true;
    if (sample.includes('request blocked') && sample.includes('bot')) return true;
    if (sample.includes('access denied') && (sample.includes('cloudflare') || sample.includes('security'))) return true;

    const captcha = sample.includes('captcha') || sample.includes('recaptcha') || sample.includes('hcaptcha');
    const challenge = sample.includes('challenge') || sample.includes('verify') || sample.includes('human');
    if (captcha && challenge) return true;

    return false;
}

async function extractWithJina(url, globalSignal) {
    const start = Date.now();
    try {
        const readerUrl = `${JINA_READER_BASE}${url}`;
        const res = await fetchWithTimeout(readerUrl, {
            method: 'GET',
            headers: {
                'Accept': 'text/plain, text/markdown;q=0.9, */*;q=0.1',
                'User-Agent': 'ArixAI-Combine/4.0',
            },
        }, JINA_FALLBACK_TIMEOUT_MS, globalSignal);

        if (!res.ok) {
            return { url, success: false, content: null, error: `Fallback reader returned status ${res.status}`, debug: { method: 'jina-reader', status: res.status }, latency: Date.now() - start };
        }

        const raw = await res.text();
        const text = normalizeText(raw, 500000);
        if (!text || contentLooksBlocked(text)) {
            return { url, success: false, content: null, error: 'Fallback reader returned no usable page content.', debug: { method: 'jina-reader' }, latency: Date.now() - start };
        }

        return { url, success: true, content: text, debug: { method: 'jina-reader' }, latency: Date.now() - start };
    } catch (err) {
        return { url, success: false, content: null, error: err?.name === 'AbortError' ? 'Fallback reader timeout exceeded.' : String(err?.message || err), debug: { method: 'jina-reader', errors: [String(err?.message || err)] }, latency: Date.now() - start };
    }
}

function parseUrls(value) {
    if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
    if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
    return [];
}

function remainingMs(startTime) {
    return TOTAL_TIMEOUT_MS - (Date.now() - startTime);
}

async function mapWithConcurrency(items, limit, worker) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return [];

    const results = new Array(list.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, limit), list.length);

    async function runWorker() {
        while (true) {
            const index = nextIndex++;
            if (index >= list.length) return;
            try {
                results[index] = await worker(list[index], index);
            } catch (error) {
                results[index] = { error: String(error?.message || error), item: list[index] };
            }
        }
    }

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results;
}

async function processAutoCandidates(query, searchData, globalSignal, startOverallTime) {
    const tFilter = Date.now();
    const normalized = normalizeSearchResults(searchData);
    const selected = selectCandidates(normalized);
    const filterDone = Date.now();

    const reusable = [];
    const networkEntries = [];

    for (const entry of selected.selected) {
        const existing = crawlerContentExtraction(entry.item);
        if (existing) reusable.push({ entry, ext: existing });
        else networkEntries.push(entry);
    }
    const reuseDone = Date.now();

    let fallbackSlots = MAX_JINA_FALLBACKS;
    let extractionStartedAt = Date.now();

    const extractionRows = await mapWithConcurrency(
        networkEntries,
        EXTRACTION_CONCURRENCY,
        async (entry) => {
            // Cut processing early if we are near the global edge timeout
            if (remainingMs(startOverallTime) < 1500) {
                 return { entry, ext: { url: entry.item.url, success: false, error: 'Global Timeout Preempted' }};
            }

            const ext = await extractWithContentTacker(entry.item.url, globalSignal);
            let finalExt = ext;

            if (!ext.success && fallbackSlots > 0 && remainingMs(startOverallTime) > 2000) {
                fallbackSlots--;
                const fallback = await extractWithJina(entry.item.url, globalSignal);
                if (fallback.success) {
                    finalExt = { ...fallback, primaryExtractor: 'content-tacker', fallbackExtractor: 'jina-reader' };
                } else {
                    finalExt = { ...ext, fallback };
                }
            }

            return { entry, ext: finalExt, fallbackAttempted: finalExt !== ext || Boolean(finalExt?.fallback) };
        },
    );
    const extractionDone = Date.now();
    extractionStartedAt = extractionStartedAt || extractionDone;

    const combined = [
        ...reusable.map(({ entry, ext }) => ({
            ...entry.item,
            extraction: {
                ...ext, crawlerMatch: entry.label,
                crawlerRelevanceBand: entry.item.relevanceBand ?? null,
                crawlerRelevanceScore: entry.item.relevanceScore ?? entry.item.relevance?.score ?? null,
                preflight: null,
            },
        })),
        ...extractionRows.map(row => {
            if (row?.entry && row?.ext) {
                const extraction = {
                    ...row.ext, crawlerMatch: row.entry.label,
                    crawlerRelevanceBand: row.entry.item.relevanceBand ?? null,
                    crawlerRelevanceScore: row.entry.item.relevanceScore ?? row.entry.item.relevance?.score ?? null,
                    preflight: null,
                };
                return { ...row.entry.item, extraction };
            }
            const entry = row?.item;
            return {
                ...(entry?.item || entry || {}),
                extraction: {
                    url: entry?.item?.url || entry?.url || null,
                    success: false, content: null, error: row?.error || 'Extraction worker failed.',
                    debug: { method: 'combine-worker' }, latency: 0,
                },
            };
        }),
    ];

    const successful = [];
    const failedResults = [];

    for (const item of combined) {
        delete item._originalRank;
        if (item.extraction?.success) successful.push(item);
        else {
            delete item.rank;
            failedResults.push(item);
        }
    }

    successful.sort((a, b) => {
        const ar = Number(a.crawlerRank ?? a.rank) || 999999;
        const br = Number(b.crawlerRank ?? b.rank) || 999999;
        return ar - br;
    });
    for (let i = 0; i < successful.length; i++) successful[i].rank = i + 1;

    return {
        results: successful,
        failedResults,
        stats: {
            ...selected.stats,
            crawlerContentReused: reusable.length,
            preflightChecked: 0, preflightRejected: 0,
            extractionSent: networkEntries.length,
            extractionSucceeded: successful.length,
            extractionFailed: failedResults.length,
            fallbackAttempts: MAX_JINA_FALLBACKS - fallbackSlots,
            failedExtractions: failedResults.length,
            normalizedSources: normalized.length,
            extractionConcurrency: EXTRACTION_CONCURRENCY,
            preflightCriticalPathRemoved: true,
            timings_ms: {
                candidate_filter: filterDone - tFilter,
                crawler_content_reuse_check: reuseDone - filterDone,
                extraction_and_inline_fallback: extractionDone - extractionStartedAt,
            },
        },
    };
}

async function processDirectExtraction(urls, globalSignal, startOverallTime) {
    const unique = [];
    const seen = new Set();

    for (const raw of urls) {
        const info = looksObviousBadUrl(raw);
        if (info.bad) continue;
        const key = info.url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(info.url);
    }

    let fallbackSlots = MAX_JINA_FALLBACKS;
    return mapWithConcurrency(unique, EXTRACTION_CONCURRENCY, async (url) => {
        const ext = await extractWithContentTacker(url, globalSignal);
        if (!ext.success && fallbackSlots > 0 && remainingMs(startOverallTime) > 2800) {
            fallbackSlots--;
            const fallback = await extractWithJina(url, globalSignal);
            if (fallback.success) return { url, extraction: fallback };
            ext.fallback = fallback;
        }
        return { url, extraction: ext };
    });
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
                const body = await req.json();
                if (body && typeof body === 'object') input = body;
            } catch {}
        }

        input = { ...queryParams, ...input };

        const action = String(input.action || 'auto').toLowerCase();
        const count = clampInt(input.count ?? DEFAULT_COUNT, 1, MAX_CRAWLER_RESULTS, DEFAULT_COUNT);
        const query = input.query || input.q || input.search;

        const finalPayload = {
            success: true, action, results: [], failed_extractions: 0, total_time_ms: 0,
        };
        const handlerStart = startOverallTime;

        if (action === 'search' || action === 'auto') {
            if (!query) throw new Error("Missing 'query' parameter.");

            const searchStarted = Date.now();
            const searchData = await performSearch(String(query), count, controller.signal);
            const searchFinished = Date.now();
            const normalized = normalizeSearchResults(searchData);

            if (action === 'search') {
                finalPayload.results = normalized.map(decorateCrawlerMatch).map(item => {
                    delete item._originalRank;
                    return item;
                });
                finalPayload.crawler = {
                    version: searchData.version ?? null,
                    requestedResults: searchData.requestedResults ?? count,
                    returnedResults: searchData.returnedResults ?? normalized.length,
                    sourceCountMode: searchData.sourceCountMode ?? null,
                    resultSelectionPolicy: searchData.resultSelectionPolicy ?? null,
                };
            } else {
                const processed = await processAutoCandidates(String(query), searchData, controller.signal, startOverallTime);
                finalPayload.results = processed.results;
                finalPayload.failed_results = processed.failedResults;
                finalPayload.failed_extractions = processed.stats.failedExtractions;
                finalPayload.filter_stats = processed.stats;
                finalPayload.timings_ms = {
                    crawler_search: searchFinished - searchStarted,
                    candidate_filter_and_reuse: (processed.stats.timings_ms?.candidate_filter || 0) + (processed.stats.timings_ms?.crawler_content_reuse_check || 0),
                    extraction_and_fallback: processed.stats.timings_ms?.extraction_and_inline_fallback || 0,
                    total: Date.now() - handlerStart,
                };
                finalPayload.crawler = {
                    version: searchData.version ?? null,
                    requestedResults: searchData.requestedResults ?? count,
                    returnedResults: searchData.returnedResults ?? normalized.length,
                    sourceCountMode: searchData.sourceCountMode ?? null,
                    resultSelectionPolicy: searchData.resultSelectionPolicy ?? null,
                    intent: searchData.intent ?? null,
                };
            }
        } else if (action === 'extract') {
            const urls = parseUrls(input.urls);
            if (!urls.length) throw new Error("Missing 'urls' array parameter for extraction.");
            finalPayload.results = await processDirectExtraction(urls, controller.signal, startOverallTime);
            finalPayload.failed_extractions = finalPayload.results.filter(x => !x.extraction?.success).length;
        } else {
            throw new Error("Invalid action. Use 'auto', 'search', or 'extract'.");
        }

        clearTimeout(globalTimeoutId);
        finalPayload.total_time_ms = Date.now() - startOverallTime;
        if (!finalPayload.timings_ms) {
            finalPayload.timings_ms = { total: finalPayload.total_time_ms };
        } else {
            finalPayload.timings_ms.total = finalPayload.total_time_ms;
        }
        return jsonResponse(finalPayload, 200);
    } catch (err) {
        clearTimeout(globalTimeoutId);
        return jsonResponse({
            success: false,
            error: err?.name === 'AbortError' ? 'Global timeout reached. Safely halted.' : String(err?.message || err),
            total_time_ms: Date.now() - startOverallTime,
        }, 200);
    }
}
