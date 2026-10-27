/**
 * Client de l'API REST locale de sestudio.
 *
 * Endpoints utilisés (tous préfixés /api sur le serveur de l'utilisateur) :
 *   GET  /api/sites            → santé + liste des sources activées
 *   GET  /api/search?q=&sites= → { cards: [SeasonCard], sources: [...] }
 *   GET  /api/season?url=&lang=&source= → page saison (épisodes + embed_urls)
 *   POST /api/stream/resolve   → flux jouable via le proxy sestudio
 *
 * Le proxy sestudio (/api/stream/proxy?token=…) gère Referer/TLS/Cloudflare des
 * hosts (uqload, vidzy, netu, luluvid, filmoon, premium, voe, kisskh) et
 * réécrit les playlists HLS : le plugin ne renvoie que base + proxy_url.
 */

import { fetchJson, HttpError, createTtlCache } from '../utils/http.js';

const HEALTH_TTL_MS = 5 * 60 * 1000;
const SEARCH_TTL_MS = 10 * 60 * 1000;
const SEASON_TTL_MS = 10 * 60 * 1000;

const healthCache = new Map(); // base → { ok: boolean, expires: number }
const searchCache = createTtlCache(24);
const seasonCache = createTtlCache(40);

export function joinUrl(base, path) {
    return base.replace(/\/+$/, '') + path;
}

/* ────────────────────────────── Santé ──────────────────────────────────── */

export async function checkHealth(base, timeoutMs, signal) {
    const hit = healthCache.get(base);
    const now = Date.now();
    if (hit && hit.expires > now) return hit.ok;

    try {
        await fetchJson(joinUrl(base, '/api/sites'), { timeout: Math.min(timeoutMs, 8000), signal: signal });
        healthCache.set(base, { ok: true, expires: now + HEALTH_TTL_MS });
        return true;
    } catch (err) {
        healthCache.set(base, { ok: false, expires: now + 30 * 1000 });
        return false;
    }
}

export function clearHealthCache() {
    healthCache.clear();
}

/* ───────────────────────────── Recherche ───────────────────────────────── */

/**
 * Recherche multi-sites via sestudio.
 * @returns {Promise<{cards: object[], sources: object[]}>}
 */
export async function search(base, query, sites, timeoutMs, signal) {
    const key = [base, query.toLowerCase(), sites || ''].join('|');
    const cached = searchCache.get(key);
    if (cached) return cached;

    const params = ['q=' + encodeURIComponent(query)];
    if (sites) params.push('sites=' + encodeURIComponent(sites));
    const url = joinUrl(base, '/api/search?' + params.join('&'));

    const data = await fetchJson(url, { timeout: timeoutMs, signal: signal });
    const result = {
        cards: (data && Array.isArray(data.cards) ? data.cards : []).filter(c => c && c.page_url),
        sources: (data && data.sources) || [],
    };
    if (result.cards.length) searchCache.set(key, result, SEARCH_TTL_MS);
    return result;
}

/* ─────────────────────────────── Saison ────────────────────────────────── */

/**
 * Page saison (ou film) d'une carte.
 * @returns {Promise<{season: number, is_film: boolean, available_langs: string[], episodes: object[]}>}
 */
export async function season(base, pageUrl, lang, source, timeoutMs, signal) {
    const key = [base, pageUrl, lang, source || ''].join('|');
    const cached = seasonCache.get(key);
    if (cached) return cached;

    const params = [
        'url=' + encodeURIComponent(pageUrl),
        'lang=' + encodeURIComponent(lang || 'vf'),
    ];
    if (source) params.push('source=' + encodeURIComponent(source));
    const url = joinUrl(base, '/api/season?' + params.join('&'));

    const data = await fetchJson(url, { timeout: timeoutMs, signal: signal });
    const page = {
        season: parseInt(data && data.season, 10) || 0,
        is_film: !!(data && data.is_film),
        available_langs: (data && data.available_langs) || [],
        source: (data && data.source) || source || '',
        episodes: (data && data.episodes) || [],
    };
    if (page.episodes.length) seasonCache.set(key, page, SEASON_TTL_MS);
    return page;
}

/* ───────────────────────────── Résolution ──────────────────────────────── */

/**
 * Résout les embeds d'un épisode côté sestudio (avec fallback multi-hosts) et
 * renvoie un flux relatif au proxy. Ne jette pas sur un échec de résolution :
 * renvoie null (sestudio répond 502 quand aucun host ne répond).
 */
export async function resolve(base, embedUrls, source, timeoutMs, signal, preferKind) {
    if (!embedUrls || !Object.keys(embedUrls).length) return null;
    const body = {
        embed_urls: embedUrls,
        source: source || 'fstream',
    };
    if (preferKind) body.prefer_kind = preferKind;

    try {
        const data = await fetchJson(joinUrl(base, '/api/stream/resolve'), {
            method: 'POST',
            body: body,
            timeout: Math.max(timeoutMs, 30000),
            signal: signal,
            headers: { 'Content-Type': 'application/json' },
        });
        return data || null;
    } catch (err) {
        // 502 = "aucun host n'a répondu" : cas nominal quand un épisode est mort.
        if (err instanceof HttpError && err.status === 502) return null;
        throw err;
    }
}

/* ────────────────────── Construction du Stream Nuvio ───────────────────── */

/**
 * Transforme la réponse de résolution sestudio en Stream Nuvio.
 *
 * Format attendu par l'app :
 *   { name, title, url, quality, language, headers?, subtitles? }
 *
 * @param {object} resolved  réponse /api/stream/resolve
 * @param {object} card      carte sestudio d'origine
 * @param {object} ep        épisode choisi (peut être null pour un film)
 * @param {string} base      URL du serveur sestudio
 * @param {object} ctx       { useTranscode, lang, sourceName }
 */
export function toNuvioStream(resolved, card, ep, base, ctx) {
    if (!resolved || !resolved.proxy_url) return null;

    // En mode transcodé, on renvoie le flux HLS ré-encodé par sestudio
    // (plus compatible avec les TV, moins piqué en bande passante source).
    const relUrl = ctx.useTranscode && resolved.transcode_url ? resolved.transcode_url : resolved.proxy_url;
    const url = joinUrl(base, relUrl);
    const kind = resolved.kind === 'hls' ? 'HLS' : 'MP4';
    const quality = ctx.useTranscode ? 'Auto (transcodé)' : kind === 'HLS' ? 'Auto (HLS)' : 'Direct';
    const langTag = String(ctx.lang || '').toUpperCase();

    const epLabel =
        !ctx.isFilm && ep && Number.isFinite(ep.number) && ep.number > 0
            ? ` · E${String(ep.number).padStart(2, '0')}`
            : '';
    const siteLabel = (ctx.sourceName || card.source || 'sestudio').replace(/-/g, ' ');

    const stream = {
        name: 'sestudio',
        title: `${siteLabel}${epLabel} · ${resolved.provider || 'host'} · ${quality} · ${langTag}`,
        url: url,
        quality: quality,
        language: langTag,
        headers: {},
    };

    // Sous-titres sidecar (converties en VTT par sestudio au besoin).
    if (Array.isArray(resolved.subtitles) && resolved.subtitles.length) {
        stream.subtitles = resolved.subtitles
            .filter(s => s && s.proxy_url)
            .map(s => ({
                url: joinUrl(base, s.proxy_url),
                title: s.label || String(s.lang || '').toUpperCase(),
                lang: String(s.lang || 'fre'),
            }));
    }

    return stream;
}

/** Déduplique des streams par URL. */
export function dedupeStreams(streams) {
    const seen = {};
    const out = [];
    for (const s of streams || []) {
        if (!s || !s.url || seen[s.url]) continue;
        seen[s.url] = true;
        out.push(s);
    }
    return out;
}
