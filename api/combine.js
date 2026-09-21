/*
 * ArixAI Combined Search + Crawler-Guided Content Extractor
 * v3.2.1 — Moderate filtering, crawler-native relevance, aligned ranks, faster critical path
 *
 * DROP-IN replacement for: api/combine.js
 * Runtime: Vercel Edge
 *
 * IMPORTANT:
 * - The crawler's own relevanceBand/relevanceScore are the source of truth.
 * - This file does NOT calculate a second relevance score.
 * - Weak crawler matches are excluded in `auto` mode.
 * - `usable` and `related` are retained from the example crawler contract.
 * - Friendly matchLabel values are display aliases only; the original
 *   crawler `relevanceBand` is preserved unchanged.
 *
 * Public actions remain unchanged:
 *   ?action=search&query=...
 *   ?action=auto&query=...
 *   ?action=extract&urls=[...]
 */

export const config = {
    runtime: 'edge',
};

const CRAWLER_URL = 'https://web-crawler-pink.vercel.app/api/crawler';
const EXTRACTOR_URL = 'https://content-tacker.vercel.app/api/extract';
const JINA_READER_BASE = 'https://r.jina.ai/';

// Moderate global budget. The old version could spend most of the request on
// a small candidate set. 20s gives the extractor room without becoming slow.
const TOTAL_TIMEOUT_MS = 20000;

// Phase budgets. These are local caps; the global signal always wins.
const SEARCH_TIMEOUT_MS = 6000;
const PREFLIGHT_TIMEOUT_MS = 1100;
const EXTRACTION_TIMEOUT_MS = 9500;
const JINA_FALLBACK_TIMEOUT_MS = 2400;

// Do not slash the result set. Keep a healthy number of positive candidates.
const MAX_AUTO_CANDIDATES = 32;
const MAX_HOSTS_PER_SOURCE = 8;
const MAX_JINA_FALLBACKS = 3;
const MAX_CRAWLER_RESULTS = 40;
const DEFAULT_COUNT = 20;

// A crawler result that already contains trustworthy page text can be reused
// directly instead of making a second network extraction request.
const MIN_REUSABLE_CRAWLER_TEXT = 400;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
};

const SEARCH_SURFACE_HOSTS = new Set([
    'google.com', 'www.google.com',
    'bing.com', 'www.bing.com',
    'search.brave.com',
    'yahoo.com', 'search.yahoo.com',
    'mojeek.com', 'www.mojeek.com',
    'duckduckgo.com', 'www.duckduckgo.com',
    'news.google.com',
    'ecosia.org', 'www.ecosia.org',
    'yandex.com', 'www.yandex.com', 'yandex.ru',
    'qwant.com', 'www.qwant.com',
    'startpage.com', 'www.startpage.com',
    'aol.com', 'search.aol.com',
    'ask.com', 'www.ask.com',
    'baidu.com', 'www.baidu.com',
    'sogou.com', 'www.sogou.com',
    'naver.com', 'search.naver.com',
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

// Only obvious URL-level blockers. Keep this list intentionally narrow so
// legitimate article URLs are not thrown away.
const BAD_URL_MARKERS = [
    '/captcha', 'captcha=', 'recaptcha', 'hcaptcha',
    '/challenge', 'cf-chl-', 'challenge-platform',
    'access-denied', 'access_denied', 'accessdenied',
    '/forbidden', 'forbidden=',
    'bot-check', 'botcheck', 'verify-human', 'verify-you-are-human',
    'security-check', 'ddos-guard',
];

const BAD_CONTENT_MARKERS = [
    'verify you are human',
    'verify that you are human',
    'complete the security check',
    'checking your browser before accessing',
    'just a moment...',
    'attention required',
    'access denied',
    'request blocked',
    'bot detected',
    'automated requests',
    'unusual traffic',
    'captcha',
    'recaptcha',
    'hcaptcha',
    'enable javascript and cookies',
    'enable cookies to continue',
    'cloudflare ray id',
];

const BLOCKED_HTTP_STATUSES = new Set([401, 403, 407, 429, 451]);
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 500, 502, 503, 504, 521, 522, 523, 524]);

// Crawler-native positive/negative aliases.
// The attached crawler sample uses `usable`, `related`, and `weak`.
const POSITIVE_BANDS = new Set([
    'strong',
    'strong_match',
    'strong-match',
    'usable',
    'highly_relevant',
    'highly-relevant',
    'likely',
    'likely_relevant',
    'likely-relevant',
    'relevant',
    'related',
    'partial',
    'partial_match',
    'partial-match',
]);

const NEGATIVE_BANDS = new Set([
    'weak',
    'irrelevant',
    'unusable',
    'none',
    'no_match',
    'no-match',
]);

function jsonResponse(payload, status = 200) {
    return new Response(safeJsonStringify(payload), {
        status,
        headers: CORS_HEADERS,
    });
}

function safeJsonStringify(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return JSON.stringify({ success: false, error: 'SERIALIZATION_FAILED' });
    }
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

function getResultTitle(item) {
    return getField(item, ['title', 'name', 'headline', 'pageTitle']);
}

function getResultSnippet(item) {
    return getField(item, ['snippet', 'description', 'summary', 'excerpt', 'text']);
}

function getResultUrl(item) {
    return getField(item, ['url', 'link', 'href', 'sourceUrl', 'source_url']);
}

function canonicalizeUrl(rawUrl) {
    try {
        const u = new URL(String(rawUrl));
        if (!/^https?:$/.test(u.protocol)) return null;
        u.hash = '';
        u.hostname = u.hostname.toLowerCase();

        // Remove only common tracking parameters. Keep content-bearing query params.
        const trackingExact = new Set([
            'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid',
        ]);
        for (const key of [...u.searchParams.keys()]) {
            const lower = key.toLowerCase();
            if (lower.startsWith('utm_') || trackingExact.has(lower)) {
                u.searchParams.delete(key);
            }
        }

        if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
        return u.toString();
    } catch {
        return null;
    }
}

function getHost(rawUrl) {
    try {
        return new URL(rawUrl).hostname.toLowerCase();
    } catch {
        return '';
    }
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
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_');
}

function matchLabelFromCrawlerBand(band) {
    const b = String(band || '').toLowerCase().trim().replace(/\s+/g, '_');
    // These are display aliases only; no second relevance calculation occurs.
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

    // Unknown future crawler bands are kept rather than rejected. This is the
    // fail-safe, non-aggressive behavior: unknown != weak.
    return { allowed: true, band, label: matchLabelFromCrawlerBand(band), reason: 'crawler-band-unknown-kept' };
}

function titleOrSnippetLooksBlocked(item) {
    const title = normalizeText(getResultTitle(item), 1200).toLowerCase();
    const snippet = normalizeText(getResultSnippet(item), 3500).toLowerCase();
    const sample = `${title} ${snippet}`;

    if (!sample) return false;

    if (title === 'access denied' || title === 'forbidden' || title === 'request blocked') return true;
    if (sample.includes('verify you are human')) return true;
    if (sample.includes('complete the security check')) return true;
    if (sample.includes('checking your browser before accessing')) return true;
    if (sample.includes('recaptcha') && sample.includes('captcha')) return true;
    if (sample.includes('access denied') && (sample.includes('cloudflare') || sample.includes('bot'))) return true;

    return false;
}

function sourceHttpDecision(item) {
    const status = Number(item?.httpStatus);
    if (!Number.isFinite(status) || status <= 0) {
        return { bad: false, reason: null, hard: false };
    }
    if (BLOCKED_HTTP_STATUSES.has(status)) {
        return { bad: true, reason: `http-${status}`, hard: true };
    }
    if (status >= 300 && status < 400) {
        return { bad: true, reason: `redirect-${status}`, hard: true };
    }
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

    if (titleOrSnippetLooksBlocked(item)) {
        return { allowed: false, reason: 'blocked-page-signature', band: band.band, label: band.label };
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
    const accepted = [];

    // Do not compute or invent relevance. The crawler's band decides eligibility.
    // We retain all non-weak candidates first, then apply only a light source-
    // diversity cap so a single domain cannot consume the entire extraction set.
    for (const item of searchResults) {
        const decision = candidateReason(item);

        if (!decision.allowed) {
            if (decision.reason === 'crawler-weak-band') weakDropped++;
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
    const deferred = [];
    const hostCounts = new Map();

    // First pass: one-to-eight-per-host while preserving crawler order.
    for (const entry of accepted) {
        if (selected.length >= MAX_AUTO_CANDIDATES) {
            deferred.push(entry);
            continue;
        }
        const host = getHost(entry.item.url);
        const count = hostCounts.get(host) || 0;
        if (count < MAX_HOSTS_PER_SOURCE) {
            hostCounts.set(host, count + 1);
            selected.push(entry);
        } else {
            deferred.push(entry);
        }
    }

    // If diversity filtering created empty slots, fill them with deferred items
    // in the crawler's original order. This is intentionally permissive.
    if (selected.length < MAX_AUTO_CANDIDATES) {
        for (const entry of deferred) {
            if (selected.length >= MAX_AUTO_CANDIDATES) break;
            const host = getHost(entry.item.url);
            const count = hostCounts.get(host) || 0;
            if (count < MAX_HOSTS_PER_SOURCE) {
                hostCounts.set(host, count + 1);
                selected.push(entry);
            }
        }
    }

    // Last fail-safe fill: if a query has many results from one host only,
    // do not aggressively reduce the result count; allow them after the soft cap.
    if (selected.length < Math.min(MAX_AUTO_CANDIDATES, accepted.length)) {
        for (const entry of accepted) {
            if (selected.length >= MAX_AUTO_CANDIDATES) break;
            if (selected.includes(entry)) continue;
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
    try {
        return { ok: true, data: JSON.parse(raw), raw };
    } catch {
        return { ok: false, data: null, raw: raw.slice(0, 6000) };
    }
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

async function preflightUrl(url, globalSignal) {
    const start = Date.now();
    const info = looksObviousBadUrl(url);
    if (info.bad) return { ok: false, reason: info.reason, latency: Date.now() - start };

    try {
        const res = await fetchWithTimeout(info.url, {
            method: 'HEAD',
            redirect: 'manual',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/pdf;q=0.8,*/*;q=0.1',
                'User-Agent': 'ArixAI-Combine/3.1 (+https://lexis-ai-chatini.vercel.app/)',
            },
        }, PREFLIGHT_TIMEOUT_MS, globalSignal);

        const status = res.status;
        const location = res.headers.get('location') || '';
        const contentType = (res.headers.get('content-type') || '').toLowerCase();

        if ((status >= 300 && status < 400) || BLOCKED_HTTP_STATUSES.has(status)) {
            return {
                ok: false,
                reason: status >= 300 && status < 400 ? 'redirect' : `blocked-${status}`,
                status,
                location: location.slice(0, 1000),
                latency: Date.now() - start,
            };
        }

        // 405/406 commonly means HEAD is unsupported. Do not punish the page.
        if (status === 405 || status === 406) {
            return { ok: true, soft: true, reason: 'head-not-supported', status, latency: Date.now() - start };
        }

        if (status >= 200 && status < 300) {
            if (contentType && !/(text\/html|application\/xhtml\+xml|application\/pdf|text\/plain)/i.test(contentType)) {
                // Unknown binary/media types are not automatically blocked. The extractor may know them.
                return { ok: true, soft: true, reason: 'non-html-content-type', status, contentType, latency: Date.now() - start };
            }
            return { ok: true, status, contentType, latency: Date.now() - start };
        }

        // 4xx/5xx not in the hard list are treated as soft failures so a transient
        // or unusual site does not get aggressively excluded.
        if (TRANSIENT_HTTP_STATUSES.has(status)) {
            return { ok: true, soft: true, reason: 'transient-status', status, latency: Date.now() - start };
        }

        return { ok: true, soft: true, reason: 'unclassified-http', status, latency: Date.now() - start };
    } catch (err) {
        // A preflight timeout is NOT a reason to discard a result. That would be
        // over-aggressive and could reduce source count on slow sites.
        if (err?.name === 'AbortError') {
            return { ok: true, soft: true, reason: 'preflight-timeout', latency: Date.now() - start };
        }
        return { ok: true, soft: true, reason: 'preflight-error', error: String(err?.message || err), latency: Date.now() - start };
    }
}

async function extractWithContentTacker(url, globalSignal) {
    const start = Date.now();
    try {
        const targetUrl = `${EXTRACTOR_URL}?url=${encodeURIComponent(url)}`;
        const res = await fetchWithTimeout(targetUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        }, EXTRACTION_TIMEOUT_MS, globalSignal);

        const parsed = await readJsonSafely(res);
        if (!res.ok) {
            return {
                url,
                success: false,
                content: null,
                error: `Extractor API returned status ${res.status}`,
                debug: { method: 'content-tacker', status: res.status },
                latency: Date.now() - start,
            };
        }

        if (!parsed.ok || !parsed.data || typeof parsed.data !== 'object') {
            return {
                url,
                success: false,
                content: null,
                error: 'Extractor API returned invalid JSON.',
                debug: { method: 'content-tacker', rawPreview: parsed.raw.slice(0, 500) },
                latency: Date.now() - start,
            };
        }

        const data = parsed.data;
        const text = normalizeText(data.text ?? data.content ?? data.markdown ?? '', 500000);
        const blocked = contentLooksBlocked(text, JSON.stringify(data.debug || ''));

        if (!data.success || !text || blocked) {
            return {
                url,
                success: false,
                content: text || null,
                error: blocked ? 'Extractor returned blocked/challenge content.' : (data.error || 'No extractable content returned.'),
                debug: { method: 'content-tacker', ...(data.debug || {}) },
                latency: Date.now() - start,
            };
        }

        return {
            url,
            success: true,
            content: text,
            debug: { method: 'content-tacker', ...(data.debug || {}) },
            latency: Date.now() - start,
        };
    } catch (err) {
        return {
            url,
            success: false,
            content: null,
            error: err?.name === 'AbortError' ? 'Extraction timeout exceeded.' : String(err?.message || err),
            debug: { method: 'content-tacker', errors: [String(err?.message || err)] },
            latency: Date.now() - start,
        };
    }
}

function getCrawlerPageContent(item) {
    if (!item || typeof item !== 'object') return '';
    const candidates = [
        item.contentForAI,
        item.pageContent,
        item.extractedText,
    ];
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
        url: item.url,
        success: true,
        content: text,
        debug: {
            method: 'crawler-native-content',
            contentLength: text.length,
        },
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

    // Generic CAPTCHA is only a blocker when accompanied by a second challenge signal.
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
                'User-Agent': 'ArixAI-Combine/3.1',
            },
        }, JINA_FALLBACK_TIMEOUT_MS, globalSignal);

        if (!res.ok) {
            return {
                url,
                success: false,
                content: null,
                error: `Fallback reader returned status ${res.status}`,
                debug: { method: 'jina-reader', status: res.status },
                latency: Date.now() - start,
            };
        }

        const raw = await res.text();
        const text = normalizeText(raw, 500000);
        if (!text || contentLooksBlocked(text)) {
            return {
                url,
                success: false,
                content: null,
                error: 'Fallback reader returned no usable page content.',
                debug: { method: 'jina-reader' },
                latency: Date.now() - start,
            };
        }

        return {
            url,
            success: true,
            content: text,
            debug: { method: 'jina-reader' },
            latency: Date.now() - start,
        };
    } catch (err) {
        return {
            url,
            success: false,
            content: null,
            error: err?.name === 'AbortError' ? 'Fallback reader timeout exceeded.' : String(err?.message || err),
            debug: { method: 'jina-reader', errors: [String(err?.message || err)] },
            latency: Date.now() - start,
        };
    }
}

function parseUrls(value) {
    if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
    if (typeof value === 'string') {
        return value.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [];
}

function remainingMs(startTime) {
    return TOTAL_TIMEOUT_MS - (Date.now() - startTime);
}

async function processAutoCandidates(query, searchData, globalSignal, startOverallTime) {
    const normalized = normalizeSearchResults(searchData);
    const selected = selectCandidates(normalized);

    // Reuse content already extracted by the crawler when it is substantial and
    // not obviously a challenge page. This removes an unnecessary network hop.
    const reusable = [];
    const networkEntries = [];
    for (const entry of selected.selected) {
        const existing = crawlerContentExtraction(entry.item);
        if (existing) reusable.push({ entry, ext: existing });
        else networkEntries.push(entry);
    }

    // Only candidates with no crawler HTTP status need a soft preflight. Start
    // extraction of known-good pages immediately instead of waiting for every
    // preflight to finish. This shortens the critical path without relaxing the
    // crawler's relevance decisions.
    const preflightEligible = networkEntries.filter(entry => {
        const status = Number(entry.item.httpStatus);
        return !Number.isFinite(status) || status <= 0;
    });

    const preflightPromise = (remainingMs(startOverallTime) > 2800 && preflightEligible.length)
        ? Promise.all(preflightEligible.map(async entry => {
            const result = await preflightUrl(entry.item.url, globalSignal);
            return [entry.item.url, result];
        }))
        : Promise.resolve([]);

    const directEntries = networkEntries.filter(entry => {
        const status = Number(entry.item.httpStatus);
        return Number.isFinite(status) && status > 0;
    });

    // Start known-status extraction now; it runs concurrently with preflight.
    const directExtractionPromise = Promise.all(directEntries.map(async entry => {
        const ext = await extractWithContentTacker(entry.item.url, globalSignal);
        return { entry, ext };
    }));

    const preflightPairs = await preflightPromise;
    const preflightMap = new Map(preflightPairs);

    const unknownEligible = preflightEligible.filter(entry => {
        const pf = preflightMap.get(entry.item.url);
        // A positive blocker/redirect is excluded. Timeout/network uncertainty is
        // intentionally retained, preserving the moderate behavior.
        return !pf || pf.ok !== false;
    });

    const unknownExtractionPromise = Promise.all(unknownEligible.map(async entry => {
        const ext = await extractWithContentTacker(entry.item.url, globalSignal);
        return { entry, ext };
    }));

    const [directResults, unknownResults] = await Promise.all([
        directExtractionPromise,
        unknownExtractionPromise,
    ]);

    const extractionResults = [
        ...reusable,
        ...directResults,
        ...unknownResults,
    ];

    const combined = extractionResults.map(({ entry, ext }) => ({
        ...entry.item,
        extraction: {
            ...ext,
            crawlerMatch: entry.label,
            crawlerRelevanceBand: entry.item.relevanceBand ?? null,
            crawlerRelevanceScore: entry.item.relevanceScore ?? entry.item.relevance?.score ?? null,
            preflight: preflightMap.get(entry.item.url) || null,
        },
    }));

    // Limited fallback for failed primary extractions. Preserve crawler order;
    // fallback is only for extraction resilience, never for relevance ranking.
    let fallbackUsed = 0;
    const fallbacksAllowed = remainingMs(startOverallTime) > 3000 ? MAX_JINA_FALLBACKS : 0;

    if (fallbacksAllowed > 0) {
        const failedIndexes = [];
        for (let i = 0; i < combined.length && failedIndexes.length < fallbacksAllowed; i++) {
            if (!combined[i]?.extraction?.success) failedIndexes.push(i);
        }

        const fallbackResults = await Promise.all(failedIndexes.map(async index => {
            const item = combined[index];
            const ext = await extractWithJina(item.url, globalSignal);
            return { index, ext };
        }));

        for (const { index, ext } of fallbackResults) {
            fallbackUsed++;
            if (ext.success) {
                combined[index].extraction = {
                    ...ext,
                    crawlerMatch: combined[index].matchLabel,
                    crawlerRelevanceBand: combined[index].relevanceBand ?? null,
                    crawlerRelevanceScore: combined[index].relevanceScore ?? combined[index].relevance?.score ?? null,
                    preflight: preflightMap.get(combined[index].url) || null,
                    primaryExtractor: 'content-tacker',
                    fallbackExtractor: 'jina-reader',
                };
            } else {
                combined[index].extraction.fallback = ext;
            }
        }
    }

    // IMPORTANT: `rank` is now assigned only after extraction succeeds. This
    // makes JSON rank exactly match the frontend's displayed 1..N source order.
    // Failed pages are removed from `results`; diagnostics are kept separately.
    const successful = [];
    const failedResults = [];
    for (const item of combined) {
        delete item._originalRank;
        if (item.extraction?.success) {
            successful.push(item);
        } else {
            // Failed pages are diagnostics only and must never carry a display rank.
            delete item.rank;
            failedResults.push(item);
        }
    }

    successful.sort((a, b) => {
        const ar = Number(a.rank) || 999999;
        const br = Number(b.rank) || 999999;
        return ar - br;
    });
    for (let i = 0; i < successful.length; i++) {
        successful[i].rank = i + 1;
    }

    return {
        results: successful,
        failedResults,
        stats: {
            ...selected.stats,
            crawlerContentReused: reusable.length,
            preflightChecked: preflightEligible.length,
            preflightRejected: [...preflightMap.values()].filter(v => v && v.ok === false).length,
            extractionSent: directEntries.length + unknownEligible.length,
            extractionSucceeded: successful.length,
            extractionFailed: failedResults.length,
            fallbackAttempts: fallbackUsed,
            failedExtractions: failedResults.length,
            normalizedSources: normalized.length,
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

    const results = await Promise.all(unique.map(async url => {
        const ext = await extractWithContentTacker(url, globalSignal);
        return { url, extraction: ext };
    }));

    // Same limited fallback behavior for direct extraction, kept parallel so
    // one slow fallback does not serialize the rest of the request.
    if (remainingMs(startOverallTime) > 4000 && results.length) {
        const indexes = [];
        for (let i = 0; i < results.length && indexes.length < MAX_JINA_FALLBACKS; i++) {
            if (!results[i].extraction?.success) indexes.push(i);
        }
        const fallbackResults = await Promise.all(indexes.map(async index => ({
            index,
            fallback: await extractWithJina(results[index].url, globalSignal),
        })));
        for (const { index, fallback } of fallbackResults) {
            results[index].extraction.fallback = fallback;
            if (fallback.success) results[index].extraction = fallback;
        }
    }

    return results;
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
            } catch {
                // Empty/malformed JSON body is safely ignored in favor of URL params.
            }
        }

        input = { ...queryParams, ...input };

        const action = String(input.action || 'auto').toLowerCase();
        const count = clampInt(input.count ?? DEFAULT_COUNT, 1, MAX_CRAWLER_RESULTS, DEFAULT_COUNT);
        const query = input.query || input.q || input.search;

        const finalPayload = {
            success: true,
            action,
            results: [],
            failed_extractions: 0,
            total_time_ms: 0,
        };

        if (action === 'search' || action === 'auto') {
            if (!query) throw new Error("Missing 'query' parameter. Please pass ?query=YOUR_SEARCH in the URL.");

            const searchData = await performSearch(String(query), count, controller.signal);
            const normalized = normalizeSearchResults(searchData);

            if (action === 'search') {
                // Search mode remains a faithful crawler pass-through (aside from
                // URL canonicalization/deduplication used by this combined endpoint).
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
