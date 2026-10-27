/**
 * Source Papadustream — provider v3 (port du scraper Gowaru mesuré le plus
 * rentable : 8 flux en ~3 s, HLS signé multi-qualité/multi-audio).
 *
 * Architecture du site (vérifiée en live 10/2026) :
 * - Films  : /films/{imdbId}   → URL HLS /hls/p/{ts}/{token}/sN/movie/…
 * - Séries : /series/{imdbId}  → JSON `EPISODES=[{url,title,season,episode}]`
 * - Les tokens HLS sont SIGNÉS (valides ≥ 8 min) : jamais réutilisés après
 *   échec — la page est re-fetchée (bypass cache) pour des URLs fraîches.
 * - Master playlist : pistes audio fr/en → émettre VF et/ou VO.
 *
 * Indexation par IMDb (résolu via TMDB external_ids) : zéro matching de
 * titre hasardeux, la source démarre sans attendre la classification.
 */

import { fetchText as coreFetchText, createTtlCache } from '../utils/http.js';
import { getImdbId } from '../meta/tmdb.js';
import { makeStream, composeTitle } from '../core/stream.js';

// .club/www : actifs (catalogue complet) ; .living : miroir derrière un
// challenge Cloudflare JS (inaccessible au runtime, dernier recours seulement).
const DOMAINS = ['papadustream.club', 'www.papadustream.club', 'papadustreami.living'];
// Les playlists émises redirigent (301) vers www : émettre directement sur
// www évite une redirection par requête player.
const BASE_URL_WWW = 'https://www.papadustream.club';

const PAGE_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
};

// Ancien format : /hls/s5/serial/tt…/{S}/{E}/playlist.m3u8
// Nouveau signé : /hls/p/{ts}/{token}/s5/serial/tt…/{S}/{E}/playlist.m3u8
const HLS_SERIAL_RE =
    /\/hls\/(?:p\/\d+\/[A-Za-z0-9_-]+\/)?s\d+\/serial\/tt\d+\/(\d+)\/(\d+)\/playlist\.m3u8/g;
const HLS_MOVIE_RE =
    /\/hls\/(?:p\/\d+\/[A-Za-z0-9_-]+\/)?s\d+\/movie\/tt\d+\/playlist\.m3u8/g;

// Page : TTL court — les tokens signés vivent ≥ 8 min, la page change à
// chaque génération. Le bypass refresh gère les tokens expirés.
const pageCache = createTtlCache(20);
const PAGE_TTL_MS = 5 * 60 * 1000;

export default {
    id: 'papadustream',
    label: 'Papadustream',
    needsMeta: false, // IMDb résolu par tmdbId ; fallback titre utilise meta si dispo
    async run(ctx) {
        try {
            await run(ctx);
        } catch (err) {
            console.warn('[papa] échoué : ' + (err && err.message ? err.message : err));
        }
    },
};

async function run(ctx) {
    const { cfg, signal, push, shouldStop } = ctx;
    const isTv = ctx.mediaType === 'tv';

    // 1. TMDB → IMDb (identité fiable, sans matching de titre).
    let imdbId = await getImdbId(ctx.tmdbId, ctx.mediaType, {
        timeout: cfg.timeoutMs,
        signal: signal,
    });
    if (!imdbId) {
        imdbId = await resolveByTitle(ctx);
    }
    if (!imdbId) {
        console.log('[papa] IMDb introuvable pour TMDB ' + ctx.tmdbId);
        return;
    }

    // 2. Page du titre (cache 5 min).
    const pagePath = isTv ? '/series/' + imdbId : '/films/' + imdbId;
    const cacheKey = 'page_' + imdbId + (isTv ? '_tv' : '_mv');
    let html = await cachedPage(cacheKey, pagePath, cfg, signal, false);
    if (!html) {
        console.log('[papa] page inaccessible : ' + pagePath);
        return;
    }

    // 3. Sélection de l'épisode / film et émission des flux.
    if (isTv) {
        let candidates = parseEpisodesJson(html);
        if (!candidates.length) candidates = extractHlsUrls(html);
        const targetSeason = parseInt(ctx.season, 10) || 1;
        const targetEp = parseInt(ctx.episode, 10) || 1;
        const selected = candidates.filter(
            c => c.season === targetSeason && c.episode === targetEp
        );
        if (!selected.length) {
            const avail = candidates
                .filter(c => c.season === targetSeason)
                .map(c => 'E' + c.episode)
                .slice(0, 20)
                .join(' ');
            console.log(
                `[papa] pas de S${targetSeason}E${targetEp} — dispos sur le site : ${avail || 'aucun'}`
            );
            return;
        }

        for (const ep of selected) {
            if (shouldStop()) break;
            const title = await emitForUrl(ctx, ep.url, ep, imdbId, cacheKey, pagePath);
            if (title) push(title);
        }
    } else {
        const movieUrl = extractMovieHlsUrl(html, imdbId);
        if (!movieUrl) {
            console.log('[papa] pas de HLS film pour ' + imdbId);
            return;
        }
        const st = await emitForUrl(ctx, movieUrl, null, imdbId, cacheKey, pagePath);
        if (st) push(st);
    }
}

/**
 * Probe + émission pour une URL HLS. Si le token est expiré, la page est
 * re-fetchée (bypass cache) et l'URL fraîche re-probée.
 * @returns {object|null} flux interne prêt pour ctx.push
 */
async function emitForUrl(ctx, hlsUrl, epInfo, imdbId, cacheKey, pagePath) {
    const { cfg, signal, shouldStop } = ctx;

    const probe = await probeMaster(hlsUrl, cfg, signal);
    let finalUrl = hlsUrl;
    let langs = probe.langs;
    let ok = probe.ok;

    if (!ok && !shouldStop()) {
        // Token expiré → re-fetch de la page (bypass cache) pour des URLs fraîches.
        console.log('[papa] token HLS expiré, refresh de la page');
        const freshHtml = await cachedPage(cacheKey, pagePath, cfg, signal, true);
        let freshList = freshHtml ? parseEpisodesJson(freshHtml) : [];
        if (!freshList.length && freshHtml) freshList = extractHlsUrls(freshHtml);

        let freshUrl = null;
        if (epInfo) {
            const freshEp = freshList.find(
                c => c.season === epInfo.season && c.episode === epInfo.episode
            );
            freshUrl = freshEp ? freshEp.url : null;
        } else {
            freshUrl = extractMovieHlsUrl(freshHtml || '', imdbId);
        }
        if (!freshUrl) return null;
        const probe2 = await probeMaster(freshUrl, cfg, signal);
        if (!probe2.ok) return null;
        finalUrl = freshUrl;
        langs = probe2.langs;
        ok = true;
    }
    if (!ok) return null;

    // Multi-audio : VF si piste fr (ou manifest atypique — site FR), VO si en.
    const hasFr = langs.size === 0 || langs.has('fr');
    const hasEn = langs.size > 0 && langs.has('en');
    let absUrl = finalUrl.startsWith('http') ? finalUrl : BASE_URL_WWW + finalUrl;
    absUrl = absUrl.replace('https://papadustream.club', BASE_URL_WWW);

    const label = {
        site: 'Papadustream',
        episode: epInfo ? epInfo.episode : 0,
        host: 'HLS',
        url: absUrl,
    };

    if (hasFr) {
        return makeStream({
            title: composeTitle({ ...label, lang: 'VF' }),
            url: absUrl,
            quality: 'Auto (HLS)',
            language: 'VF',
            _langKey: 'vf',
            _site: 'papadustream',
        });
    }
    if (hasEn) {
        return makeStream({
            title: composeTitle({ ...label, lang: 'VO' }),
            url: absUrl,
            quality: 'Auto (HLS)',
            language: 'VO',
            _langKey: 'vo',
            _site: 'papadustream',
        });
    }
    return null;
}

/* ───────────────────────────── HTTP local ──────────────────────────────── */

async function cachedPage(cacheKey, path, cfg, signal, bypass) {
    if (!bypass) {
        const hit = pageCache.get(cacheKey);
        if (hit) return hit;
    } else {
        pageCache.set(cacheKey, null, 1); // invalide l'ancienne entrée
    }
    for (const domain of DOMAINS) {
        if (signal && signal.aborted) return null;
        try {
            const res = await coreFetchText('https://' + domain + path, {
                timeout: Math.min(cfg.timeoutMs, 12000),
                headers: { ...PAGE_HEADERS, Referer: 'https://' + domain + '/', Origin: 'https://' + domain },
                signal: signal,
            });
            pageCache.set(cacheKey, res.text, PAGE_TTL_MS);
            return res.text;
        } catch (err) {
            const status = err && err.status ? err.status : 0;
            if (status === 404) return null; // page absente : les miroirs la serviront pas mieux
            // 403 (Cloudflare), timeout, réseau → domaine suivant.
            continue;
        }
    }
    return null;
}

/** Vérifie un master playlist (token vivant) et détecte les pistes audio. */
async function probeMaster(url, cfg, signal) {
    const langs = new Set();
    try {
        const res = await coreFetchText(url, {
            timeout: 8000,
            headers: { ...PAGE_HEADERS },
            signal: signal,
        });
        if (!res.text || res.text.indexOf('#EXTM3U') === -1) return { ok: false, langs };
        // Une EXT-X-MEDIA = une ligne : détection ligne par ligne (un regex
        // multi-lignes attribuerait le LANGUAGE des subs à une piste audio).
        const langRe = /LANGUAGE="([A-Za-z-]+)"/;
        const lines = res.text.split('\n');
        for (const line of lines) {
            if (line.indexOf('TYPE=AUDIO') === -1) continue;
            const m = langRe.exec(line);
            if (m) langs.add(m[1].toLowerCase().split('-')[0]);
        }
        return { ok: true, langs };
    } catch (e) {
        return { ok: false, langs };
    }
}

/* ─────────────────────────── parsing (port Gowaru) ─────────────────────── */

/** Tableau JSON `EPISODES=[{url,title,season,episode},…]` embarqué dans la page. */
export function parseEpisodesJson(html) {
    if (!html) return [];
    const marker = 'EPISODES=[';
    const start = html.indexOf(marker);
    if (start === -1) return [];
    const slice = html.slice(start + marker.length - 1);
    const end = slice.indexOf('];');
    const raw = end !== -1 ? slice.slice(0, end + 1) : null;
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        const out = [];
        for (const e of arr) {
            if (
                e &&
                typeof e.url === 'string' &&
                e.url.indexOf('/hls/') !== -1 &&
                Number.isFinite(Number(e.season)) &&
                Number.isFinite(Number(e.episode))
            ) {
                out.push({
                    url: e.url,
                    title: typeof e.title === 'string' ? e.title : '',
                    season: Number(e.season),
                    episode: Number(e.episode),
                });
            }
        }
        return out;
    } catch (e) {
        console.warn('[papa] JSON EPISODES invalide : ' + (e && e.message ? e.message : e));
        return [];
    }
}

/** Fallback regex sur le HTML brut (ancien format non signé + signé). */
export function extractHlsUrls(html) {
    if (!html) return [];
    const results = [];
    const re = new RegExp(HLS_SERIAL_RE.source, 'g');
    let match;
    while ((match = re.exec(html)) !== null) {
        results.push({
            url: match[0],
            title: '',
            season: parseInt(match[1], 10),
            episode: parseInt(match[2], 10),
        });
    }
    return results;
}

/** URL HLS d'un film, ciblant exactement cet IMDb (anti-autre-film). */
export function extractMovieHlsUrl(html, imdbId) {
    if (!html) return null;
    const re = new RegExp(HLS_MOVIE_RE.source, 'g');
    let match;
    while ((match = re.exec(html)) !== null) {
        if (!imdbId || match[0].indexOf('/' + imdbId + '/') !== -1) return match[0];
    }
    return null;
}

/* ─────────────────────── fallback IMDb par titre ───────────────────────── */

/** Dernier recours : /search?q={titre} → /films|/series/tt… (Gowaru). */
async function resolveByTitle(ctx) {
    const { cfg, signal } = ctx;
    let meta = null;
    try {
        meta = await ctx.meta;
    } catch (e) {
        meta = null;
    }
    if (!meta || !meta.titles.length) return '';
    const kindSeg = ctx.mediaType === 'tv' ? 'series' : 'films';
    const re = new RegExp('/(?:' + kindSeg + ')\\/(tt\\d+)', 'g');
    for (const title of meta.titles.slice(0, 2)) {
        for (const domain of DOMAINS) {
            if (signal && signal.aborted) return '';
            try {
                const r = await coreFetchText(
                    'https://' + domain + '/search?q=' + encodeURIComponent(title),
                    {
                        timeout: Math.min(cfg.timeoutMs, 12000),
                        headers: { ...PAGE_HEADERS, Referer: 'https://' + domain + '/' },
                        signal: signal,
                    }
                );
                const m = re.exec(r.text);
                re.lastIndex = 0;
                if (m) {
                    console.log('[papa] recherche titre « ' + title + ' » → ' + m[1]);
                    return m[1];
                }
                break; // ce domaine a répondu sans résultat : pas la peine d'essayer les miroirs
            } catch (e) {
                continue; // 403/timeout/réseau → domaine suivant
            }
        }
    }
    return '';
}
