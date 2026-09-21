/*
 * ArixAI Combined Search + Precision Extractor
 * v3.0.0 — Fast Candidate Gate + Fail-Safe Extraction
 *
 * Drop-in replacement for: api/combine.js
 * Runtime: Vercel Edge
 *
 * Keeps the existing public actions:
 *   ?action=search&query=...
 *   ?action=auto&query=...
 *   ?action=extract&urls=[...]
 *
 * Existing frontend architecture is preserved.
 */

export const config = {
    runtime: 'edge',
};

const CRAWLER_URL = 'https://web-crawler-pink.vercel.app/api/crawler';
const EXTRACTOR_URL = 'https://content-tacker.vercel.app/api/extract';

// Optional no-key fallback reader. Used only for a small number of failed top candidates.
// Basic Reader usage is available by prepending r.jina.ai to a target URL.
const JINA_READER_BASE = 'https://r.jina.ai/';

// HARD global budget requested by user.
const TOTAL_TIMEOUT_MS = 15000;

// Tuned so the search phase cannot consume the whole request budget.
const SEARCH_TIMEOUT_MS = 5200;
const PRECHECK_TIMEOUT_MS = 850;
const GET_PROBE_TIMEOUT_MS = 650;
const EXTRACTION_TIMEOUT_MS = 7600;
const JINA_FALLBACK_TIMEOUT_MS = 2600;

const MAX_CRAWLER_RESULTS = 40;
const DEFAULT_COUNT = 20;
const MAX_AUTO_CANDIDATES = 12;
const MAX_PER_HOST = 3;
const MAX_JINA_FALLBACKS = 3;

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
    'yandex.com', 'www.yandex.com',
    'yandex.ru',
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

const BAD_URL_MARKERS = [
    '/captcha', 'captcha=', 'recaptcha', 'hcaptcha',
    '/challenge', 'cf-chl-', 'challenge-platform',
    'access-denied', 'access_denied', 'accessdenied',
    '/forbidden', 'forbidden=',
    'bot-check', 'botcheck', 'verify-human', 'verify-you-are-human',
    'security-check', 'ddos-guard', 'please-wait',
    '/blocked', 'bot-block', 'bot_block',
    '/consent', 'consent.google',
    '/login', '/signin', '/sign-in', '/authenticate',
    'sso.', 'oauth.',
];

const BAD_CONTENT_MARKERS = [
    'verify you are human',
    'verify that you are human',
    'complete the security check',
    'checking your browser',
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
    'cf-chl',
    'cloudflare ray id',
];

// Generic stop words are deliberately small: recall is preserved for technical and Indian queries.
const STOP_WORDS = new Set([
    'a','an','and','are','as','at','be','by','for','from','how','in','is','it','of','on','or',
    'that','the','this','to','was','what','when','where','which','who','with','why','will',
    'latest','new','news','today','current','about','guide','information','page','official',
]);

function clampInt(value, min, max, fallback) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function safeJsonStringify(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return JSON.stringify({ success: false, error: 'SERIALIZATION_FAILED' });
    }
}

function jsonResponse(payload, status = 200) {
    return new Response(safeJsonStringify(payload), {
        status,
        headers: CORS_HEADERS,
    });
}

function normalizeText(value, maxLen = 4000) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen);
}

function getField(obj, keys) {
    if (!obj || typeof obj !== 'object') return '';
    for (const key of keys) {
        if (obj[key] !== undefined && obj[key] !== null) {
            const value = obj[key];
            if (typeof value === 'string' && value.trim()) return value.trim();
            if (typeof value === 'number') return String(value);
        }
    }
    return '';
}

function getResultTitle(item) {
    return getField(item, ['title', 'name', 'headline', 'pageTitle']);
}

function getResultSnippet(item) {
    return getField(item, ['snippet', 'description', 'summary', 'text', 'content', 'excerpt']);
}

function getResultUrl(item) {
    return getField(item, ['url', 'link', 'href', 'sourceUrl', 'source_url']);
}

function canonicalizeUrl(rawUrl) {
    try {
        const u = new URL(String(rawUrl));
        if (!/^https?:$/.test(u.protocol)) return null;
        u.hash = '';

        // Remove tracking parameters while keeping content-bearing parameters.
        const removePrefixes = ['utm_', 'mc_', 'vero_', 'ga_', 'ref_', 'fbclid', 'gclid', 'dclid', 'msclkid'];
        const keys = [...u.searchParams.keys()];
        for (const key of keys) {
            const lower = key.toLowerCase();
            if (removePrefixes.some(p => lower === p || lower.startsWith(p))) {
                u.searchParams.delete(key);
            }
        }

        // Normalize host casing and a harmless trailing slash.
        u.hostname = u.hostname.toLowerCase();
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
    return SEARCH_SURFACE_HOSTS.has(host) || [...SEARCH_SURFACE_HOSTS].some(h => host.endsWith('.' + h));
}

function looksBlockedUrl(rawUrl) {
    if (!rawUrl) return true;
    const url = canonicalizeUrl(rawUrl);
    if (!url) return true;
    const lower = url.toLowerCase();
    const host = getHost(url);

    if (isSearchSurface(host) || SHORTENER_HOSTS.has(host) || HARD_BLOCK_HOSTS.has(host)) return true;
    if (BAD_URL_MARKERS.some(marker => lower.includes(marker))) return true;
    return false;
}

function tokenize(text) {
    const cleaned = normalizeText(text, 5000).toLowerCase();
    const words = cleaned
        .normalize('NFKC')
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .filter(w => w.length > 1 && !STOP_WORDS.has(w));
    return [...new Set(words)];
}

function phraseNormalize(text) {
    return normalizeText(text, 6000)
        .toLowerCase()
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenCoverage(queryTokens, text) {
    if (!queryTokens.length) return 0;
    const t = phraseNormalize(text);
    let hits = 0;
    for (const token of queryTokens) {
        if (new RegExp(`(^|\\s)${escapeRegex(token)}(?=\\s|$)`, 'u').test(t)) hits++;
    }
    return hits / queryTokens.length;
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scoreCandidate(query, item, originalRank) {
    const title = phraseNormalize(getResultTitle(item));
    const snippet = phraseNormalize(getResultSnippet(item));
    const url = phraseNormalize(getResultUrl(item));
    const combined = `${title} ${snippet}`.trim();
    const qPhrase = phraseNormalize(query);
    const qTokens = tokenize(query);

    const titleCoverage = tokenCoverage(qTokens, title);
    const snippetCoverage = tokenCoverage(qTokens, snippet);
    const combinedCoverage = tokenCoverage(qTokens, combined);
    const urlCoverage = tokenCoverage(qTokens, url);

    let score = 0;
    let reasons = [];

    if (qPhrase && combined.includes(qPhrase)) {
        score += 0.42;
        reasons.push('exact-query-phrase');
    }

    score += Math.min(0.30, titleCoverage * 0.30);
    score += Math.min(0.20, snippetCoverage * 0.20);
    score += Math.min(0.07, combinedCoverage * 0.07);
    score += Math.min(0.04, urlCoverage * 0.04);

    if (titleCoverage >= 0.80) {
        score += 0.10;
        reasons.push('high-title-overlap');
    } else if (titleCoverage >= 0.50) {
        score += 0.05;
        reasons.push('title-overlap');
    }

    if (snippetCoverage >= 0.70) {
        score += 0.08;
        reasons.push('high-snippet-overlap');
    }

    // Preserve some of the crawler's original ranking signal without allowing rank alone to pass a weak match.
    const rank = Math.max(1, Number(originalRank) || 99);
    const rankBonus = Math.max(0, 0.08 - Math.min(0.08, (rank - 1) * 0.004));
    score += rankBonus;

    const host = getHost(getResultUrl(item));
    if (/\.gov\.in$|\.nic\.in$|\.mygov\.in$|\.pib\.gov\.in$/i.test(host)) {
        score += 0.05;
        reasons.push('india-government-domain');
    } else if (/\.(edu|ac\.[a-z]{2,3})$/i.test(host)) {
        score += 0.03;
        reasons.push('education-domain');
    }

    score = Math.max(0, Math.min(1, score));

    let match = 'WEAK';
    if (score >= 0.72) match = 'STRONG_MATCH';
    else if (score >= 0.52) match = 'LIKELY_RELEVANT';
    else if (score >= 0.34) match = 'PARTIAL_MATCH';

    return {
        score: Number(score.toFixed(4)),
        match,
        reasons,
        signals: {
            titleCoverage: Number(titleCoverage.toFixed(3)),
            snippetCoverage: Number(snippetCoverage.toFixed(3)),
            combinedCoverage: Number(combinedCoverage.toFixed(3)),
        },
    };
}

function contentLooksBlocked(text, headersText = '') {
    const sample = `${normalizeText(text, 7000)} ${normalizeText(headersText, 2500)}`.toLowerCase();
    if (!sample) return false;

    let hits = 0;
    for (const marker of BAD_CONTENT_MARKERS) {
        if (sample.includes(marker)) hits++;
    }

    // One highly characteristic marker is enough; generic CAPTCHA wording requires a second signal.
    if (sample.includes('verify you are human') || sample.includes('checking your browser')) return true;
    if (sample.includes('access denied') && sample.includes('cloudflare')) return true;
    return hits >= 2;
}

function classifyHttpStatus(status) {
    if (status >= 200 && status < 300) return 'ok';
    if (status >= 300 && status < 400) return 'redirect';
    if (status === 401 || status === 403 || status === 407 || status === 429 || status === 451) return 'blocked';
    if (status >= 500 && status <= 599) return 'server-error';
    return 'unavailable';
}

async function fetchWithTimeout(resource, options = {}, timeoutMs, globalSignal) {
    const controller = new AbortController();
    let timeoutId = null;
    let globalAbortHandler = null;

    const abortFromGlobal = () => controller.abort();
    if (globalSignal) {
        if (globalSignal.aborted) controller.abort();
        else {
            globalAbortHandler = abortFromGlobal;
            globalSignal.addEventListener('abort', globalAbortHandler, { once: true });
        }
    }

    timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(resource, { ...options, signal: controller.signal });
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (globalSignal && globalAbortHandler) {
            globalSignal.removeEventListener('abort', globalAbortHandler);
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

async function performSearch(query, count, signal) {
    const targetUrl = `${CRAWLER_URL}?query=${encodeURIComponent(query)}&count=${count}`;

    try {
        const res = await fetchWithTimeout(targetUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        }, SEARCH_TIMEOUT_MS, signal);

        const parsed = await readJsonSafely(res);
        if (!res.ok) {
            throw new Error(`Crawler API returned status ${res.status}`);
        }
        if (!parsed.ok || !parsed.data || typeof parsed.data !== 'object') {
            throw new Error('Crawler API returned invalid JSON.');
        }
        return parsed.data;
    } catch (err) {
        if (err?.name === 'AbortError') throw new Error('Search phase timed out.');
        throw err;
    }
}

function normalizeSearchResults(searchData) {
    const raw = Array.isArray(searchData?.results) ? searchData.results : [];
    const seen = new Set();
    const out = [];

    for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (!item || typeof item !== 'object') continue;
        const url = canonicalizeUrl(getResultUrl(item));
        if (!url) continue;
        const key = url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            ...item,
            url,
            _originalRank: Number(item.rank) || i + 1,
        });
    }
    return out;
}

function selectCandidates(query, searchResults) {
    const scored = [];
    let weakDropped = 0;
    let badUrlDropped = 0;

    for (const item of searchResults) {
        if (looksBlockedUrl(item.url)) {
            badUrlDropped++;
            continue;
        }

        const relevance = scoreCandidate(query, item, item._originalRank);
        if (relevance.match === 'WEAK') {
            weakDropped++;
            continue;
        }

        scored.push({
            item,
            relevance,
        });
    }

    scored.sort((a, b) => {
        if (b.relevance.score !== a.relevance.score) return b.relevance.score - a.relevance.score;
        return (a.item._originalRank || 999) - (b.item._originalRank || 999);
    });

    const hostCounts = new Map();
    const selected = [];
    let duplicateHostDropped = 0;

    for (const entry of scored) {
        if (selected.length >= MAX_AUTO_CANDIDATES) break;
        const host = getHost(entry.item.url);
        const count = hostCounts.get(host) || 0;
        if (count >= MAX_PER_HOST) {
            duplicateHostDropped++;
            continue;
        }
        hostCounts.set(host, count + 1);
        selected.push(entry);
    }

    return {
        selected,
        stats: {
            received: searchResults.length,
            weakDropped,
            badUrlDropped,
            duplicateHostDropped,
            selected: selected.length,
        },
    };
}

async function preflightUrl(url, globalSignal) {
    const start = Date.now();
    const canonicalUrl = canonicalizeUrl(url);
    if (!canonicalUrl || looksBlockedUrl(canonicalUrl)) {
        return { ok: false, reason: 'url-filtered', latency: Date.now() - start };
    }

    try {
        let response = await fetchWithTimeout(canonicalUrl, {
            method: 'HEAD',
            redirect: 'manual',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/pdf;q=0.8,*/*;q=0.1',
                'User-Agent': 'ArixAI-Combine/3.0 (+https://arixai.com)',
            },
        }, PRECHECK_TIMEOUT_MS, globalSignal);

        const statusType = classifyHttpStatus(response.status);
        const location = response.headers.get('location') || '';

        if (statusType === 'redirect') {
            return {
                ok: false,
                reason: 'redirect',
                status: response.status,
                location: location.slice(0, 1000),
                latency: Date.now() - start,
            };
        }

        if (statusType === 'blocked') {
            // A small GET probe catches servers that intentionally reject HEAD but serve GET.
            if (response.status === 405 || response.status === 406) {
                // continue to GET probe below
            } else {
                return {
                    ok: false,
                    reason: 'blocked-status',
                    status: response.status,
                    latency: Date.now() - start,
                };
            }
        }

        if (statusType === 'ok') {
            const ct = (response.headers.get('content-type') || '').toLowerCase();
            if (ct.includes('text/html') || ct.includes('application/xhtml+xml') || ct.includes('application/pdf') || !ct) {
                return { ok: true, method: 'HEAD', status: response.status, contentType: ct, latency: Date.now() - start };
            }
        }

        // HEAD can legitimately return 405, 406, or a poor content-type. Probe only a tiny range.
        response = await fetchWithTimeout(canonicalUrl, {
            method: 'GET',
            redirect: 'manual',
            headers: {
                'Range': 'bytes=0-2047',
                'Accept': 'text/html,application/xhtml+xml,application/pdf;q=0.8,text/plain;q=0.5,*/*;q=0.1',
                'User-Agent': 'ArixAI-Combine/3.0 (+https://arixai.com)',
            },
        }, GET_PROBE_TIMEOUT_MS, globalSignal);

        const probeType = classifyHttpStatus(response.status);
        const probeContentType = (response.headers.get('content-type') || '').toLowerCase();
        const location2 = response.headers.get('location') || '';

        if (probeType === 'redirect') {
            return { ok: false, reason: 'redirect', status: response.status, location: location2.slice(0, 1000), latency: Date.now() - start };
        }
        if (probeType === 'blocked') {
            return { ok: false, reason: 'blocked-status', status: response.status, latency: Date.now() - start };
        }
        if (probeType === 'server-error' || probeType === 'unavailable') {
            return { ok: false, reason: probeType, status: response.status, latency: Date.now() - start };
        }

        const body = await response.text();
        if (contentLooksBlocked(body, `${response.status} ${probeContentType}`)) {
            return { ok: false, reason: 'blocked-content', status: response.status, latency: Date.now() - start };
        }

        // Empty probe bodies are allowed when status/type are healthy: the extractor may still be able to read it.
        return { ok: true, method: 'GET_PROBE', status: response.status, contentType: probeContentType, latency: Date.now() - start };
    } catch (err) {
        if (err?.name === 'AbortError') {
            return { ok: false, reason: 'preflight-timeout', latency: Date.now() - start };
        }
        return { ok: false, reason: 'preflight-error', error: String(err?.message || err), latency: Date.now() - start };
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
        if (!data.success || !text || contentLooksBlocked(text, JSON.stringify(data.debug || ''))) {
            return {
                url,
                success: false,
                content: null,
                error: data.error || 'No usable page content returned.',
                debug: data.debug || { method: 'content-tacker', reason: 'empty-or-blocked-content' },
                latency: Date.now() - start,
            };
        }

        return {
            url,
            success: true,
            content: text,
            debug: data.debug,
            latency: Date.now() - start,
            extractor: 'content-tacker',
        };
    } catch (err) {
        return {
            url,
            success: false,
            content: null,
            error: err?.name === 'AbortError' ? 'Extraction timeout exceeded.' : String(err?.message || err),
            debug: { method: 'content-tacker', error: String(err?.message || err) },
            latency: Date.now() - start,
        };
    }
}

async function extractWithJina(url, globalSignal) {
    const start = Date.now();
    try {
        const targetUrl = `${JINA_READER_BASE}${url}`;
        const res = await fetchWithTimeout(targetUrl, {
            method: 'GET',
            redirect: 'follow',
            headers: {
                'Accept': 'text/plain, text/markdown;q=0.9, */*;q=0.1',
                'X-Engine': 'direct',
                'User-Agent': 'ArixAI-Combine/3.0',
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

        const text = normalizeText(await res.text(), 500000);
        if (!text || contentLooksBlocked(text)) {
            return {
                url,
                success: false,
                content: null,
                error: 'Fallback reader returned empty or blocked content.',
                debug: { method: 'jina-reader', reason: 'empty-or-blocked-content' },
                latency: Date.now() - start,
            };
        }

        return {
            url,
            success: true,
            content: text,
            debug: { method: 'jina-reader', engine: 'direct' },
            latency: Date.now() - start,
            extractor: 'jina-reader-fallback',
        };
    } catch (err) {
        return {
            url,
            success: false,
            content: null,
            error: err?.name === 'AbortError' ? 'Fallback reader timeout exceeded.' : String(err?.message || err),
            debug: { method: 'jina-reader', error: String(err?.message || err) },
            latency: Date.now() - start,
        };
    }
}

async function extractCandidate(candidate, globalSignal) {
    const preflight = await preflightUrl(candidate.item.url, globalSignal);
    if (!preflight.ok) {
        return {
            ...candidate.item,
            relevance: candidate.relevance,
            preflight,
            extraction: {
                url: candidate.item.url,
                success: false,
                content: null,
                error: `Skipped before extraction: ${preflight.reason}`,
                debug: preflight,
                latency: preflight.latency,
            },
        };
    }

    const extraction = await extractWithContentTacker(candidate.item.url, globalSignal);
    return {
        ...candidate.item,
        relevance: candidate.relevance,
        preflight,
        extraction,
    };
}

function hasTimeLeft(startOverallTime, minimumMs = 0) {
    return (Date.now() - startOverallTime) < (TOTAL_TIMEOUT_MS - minimumMs);
}

async function runAuto(query, searchResults, controller, startOverallTime) {
    const selection = selectCandidates(query, searchResults);
    const selected = selection.selected;

    // Preflight all selected URLs together. This avoids serial health checks.
    const preflightResults = await Promise.all(selected.map(entry => preflightUrl(entry.item.url, controller.signal)));

    const ready = [];
    const skipped = [];
    for (let i = 0; i < selected.length; i++) {
        const entry = selected[i];
        const preflight = preflightResults[i];
        if (preflight.ok) ready.push({ ...entry, preflight });
        else skipped.push({
            ...entry.item,
            relevance: entry.relevance,
            preflight,
            extraction: {
                url: entry.item.url,
                success: false,
                content: null,
                error: `Skipped before extraction: ${preflight.reason}`,
                debug: preflight,
                latency: preflight.latency,
            },
        });
    }

    // Start content extraction only after the fast candidate/health gate.
    const extractionResults = await Promise.all(ready.map(async entry => ({
        ...entry.item,
        relevance: entry.relevance,
        preflight: entry.preflight,
        extraction: await extractWithContentTacker(entry.item.url, controller.signal),
    })));

    let results = [...skipped, ...extractionResults];

    // One small fallback wave can rescue the highest-value failures without turning the endpoint into a slow proxy farm.
    if (hasTimeLeft(startOverallTime, 3200)) {
        const fallbackTargets = results
            .filter(r => r.extraction && !r.extraction.success)
            .sort((a, b) => (b.relevance?.score || 0) - (a.relevance?.score || 0))
            .slice(0, MAX_JINA_FALLBACKS);

        if (fallbackTargets.length) {
            const fallbackResults = await Promise.all(fallbackTargets.map(r => extractWithJina(r.url, controller.signal)));
            const byUrl = new Map(fallbackResults.map(x => [x.url, x]));
            results = results.map(r => {
                const fallback = byUrl.get(r.url);
                if (fallback?.success) {
                    return {
                        ...r,
                        extraction: fallback,
                    };
                }
                return r;
            });
        }
    }

    // Return in relevance order; weak results never reach extraction or output in auto mode.
    results.sort((a, b) => {
        const scoreA = a.relevance?.score || 0;
        const scoreB = b.relevance?.score || 0;
        if (scoreB !== scoreA) return scoreB - scoreA;
        return (a._originalRank || 999) - (b._originalRank || 999);
    });

    const failed = results.filter(r => !r.extraction?.success).length;
    const successful = results.filter(r => r.extraction?.success).length;

    return {
        results,
        stats: {
            ...selection.stats,
            preflightPassed: ready.length,
            preflightSkipped: skipped.length,
            extractionAttempted: ready.length,
            extractionSucceeded: successful,
            extractionFailed: failed,
            fallbackReader: results.filter(r => r.extraction?.extractor === 'jina-reader-fallback').length,
        },
    };
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
                // Empty/malformed JSON body: URL parameters still work.
            }
        }

        // POST body has priority, preserving the old architecture.
        input = { ...queryParams, ...input };

        const action = String(input.action || 'auto').toLowerCase();
        const count = clampInt(input.count || DEFAULT_COUNT, 1, MAX_CRAWLER_RESULTS, DEFAULT_COUNT);
        const query = normalizeText(input.query || input.q || input.search, 1600);

        const finalPayload = {
            success: true,
            action,
            results: [],
            failed_extractions: 0,
            total_time_ms: 0,
            version: 'arix-combine-3.0.0',
        };

        if (action === 'search' || action === 'auto') {
            if (!query) {
                throw new Error("Missing 'query' parameter. Please pass ?query=YOUR_SEARCH in the URL.");
            }

            const searchData = await performSearch(query, count, controller.signal);
            const searchResults = normalizeSearchResults(searchData);

            if (action === 'search') {
                // Search mode remains a transparent crawler passthrough for frontend compatibility.
                finalPayload.results = searchResults.map(({ _originalRank, ...item }) => item);
            } else {
                const auto = await runAuto(query, searchResults, controller, startOverallTime);
                finalPayload.results = auto.results.map(({ _originalRank, ...item }) => item);
                finalPayload.failed_extractions = auto.stats.extractionFailed;
                finalPayload.filter = auto.stats;
            }
        } else if (action === 'extract') {
            let urls = input.urls;
            if (typeof urls === 'string') {
                urls = urls.split(',').map(s => s.trim()).filter(Boolean);
            }
            if (!Array.isArray(urls) || !urls.length) {
                throw new Error("Missing 'urls' array parameter for extraction.");
            }

            // Keep explicit extraction useful while removing obvious junk URLs first.
            const uniqueUrls = [];
            const seen = new Set();
            for (const raw of urls.slice(0, MAX_AUTO_CANDIDATES)) {
                const canonical = canonicalizeUrl(raw);
                if (!canonical || seen.has(canonical)) continue;
                seen.add(canonical);
                if (!looksBlockedUrl(canonical)) uniqueUrls.push(canonical);
            }

            const prepared = await Promise.all(uniqueUrls.map(async url => {
                const preflight = await preflightUrl(url, controller.signal);
                if (!preflight.ok) {
                    return {
                        url,
                        preflight,
                        extraction: {
                            url,
                            success: false,
                            content: null,
                            error: `Skipped before extraction: ${preflight.reason}`,
                            debug: preflight,
                            latency: preflight.latency,
                        },
                    };
                }
                return {
                    url,
                    preflight,
                    extraction: await extractWithContentTacker(url, controller.signal),
                };
            }));

            finalPayload.results = prepared;
            finalPayload.failed_extractions = prepared.filter(x => !x.extraction?.success).length;
            finalPayload.filter = {
                received: urls.length,
                usable: uniqueUrls.length,
                preflightPassed: prepared.filter(x => x.preflight?.ok).length,
                preflightSkipped: prepared.filter(x => !x.preflight?.ok).length,
            };
        } else {
            throw new Error("Invalid action. Use 'auto', 'search', or 'extract'.");
        }

        clearTimeout(globalTimeoutId);
        finalPayload.total_time_ms = Date.now() - startOverallTime;
        return jsonResponse(finalPayload, 200);
    } catch (err) {
        clearTimeout(globalTimeoutId);
        const timedOut = err?.name === 'AbortError' || !hasTimeLeft(startOverallTime, 0);
        return jsonResponse({
            success: false,
            error: timedOut ? 'Global timeout reached. Safely halted.' : String(err?.message || err || 'Unknown error'),
            results: [],
            failed_extractions: 0,
            total_time_ms: Math.min(TOTAL_TIMEOUT_MS, Date.now() - startOverallTime),
            version: 'arix-combine-3.0.0',
        }, 200);
    } finally {
        clearTimeout(globalTimeoutId);
    }
}
