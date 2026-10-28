/**
 * Sites DLE-CMS : FStream (https://fstream.top) et French-Manga
 * (https://french-manga.net) — portage JS de sestudio/scraper.py +
 * sestudio/sites/fstream.py.
 *
 * Particularités :
 *   - chaque page est précédée d'un interstitiel JS qui pose le cookie
 *     fsschal=1 ; l'envoyer d'entrée saute l'épreuve ;
 *   - les données d'épisodes vivent dans /data/eps_<newsid>.txt (JSON, toutes
 *     langues), repli anime sur /engine/ajax/manga_episodes_api.php ;
 *   - les films passent par /engine/ajax/film_api.php (vff/vfq/vostfr).
 */

import { fetchText, fetchJson, createTtlCache } from '../utils/http.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';

const HEADERS = {
    'User-Agent': UA,
    'Accept-Language': 'fr-FR,fr;q=0.9',
    Cookie: 'fsschal=1',
};

export const DLE_SITES = {
    fstream: { id: 'fstream', label: 'FStream', base: 'https://fstream.top', isAnime: false },
    'french-manga': { id: 'french-manga', label: 'French-Manga', base: 'https://french-manga.net', isAnime: true },
};

// Ordre des hosts tel que le plugin les préfère (vidzy en dernier : CDN
// exigeant une empreinte TLS Chrome, voir src/hosts/index.js). v3.1.9 :
// vidmoly/xtremestream/veev ajoutés (sites FR additionnels).
const PROVIDER_ORDER = [
    'uqload', 'vidmoly', 'xtremestream', 'premium', 'netu', 'luluvid',
    'filmoon', 'voe', 'veev', 'vidzy',
];

const SEASON_RE = /[Ss]aison\s+(\d+)/i;
const ONCLICK_RE = /location\.href=['"]([^'"]+)['"]/;
const NEWSID_RE = /\/(\d+)-/;
const YEAR_RE = /\s*\((\d{4})\)\s*$/;

// « vf » préfère vff (France) : c'est ce que le site sert en `default`.
const FILM_LANG_KEYS = {
    vf: ['vff', 'vfq'],
    vff: ['vff', 'vfq'],
    vfq: ['vfq', 'vff'],
    vostfr: ['vostfr'],
    vo: ['vostfr'],
};

/* ──────────────────── origine réelle (redirects + landing) ─────────────── */

const originCache = new Map(); // base → { origin, expires }

// Un domaine est « DLE » si sa page d'accueil porte ces marqueurs.
const DLE_MARKERS = /dle-content|engine\/ajax|short-poster|serie-config|templates\//;

// Hôtes qui ne sont jamais le site de streaming lui-même.
const FOREIGN_HOSTS =
    /googleapis|gstatic|cdnjs|google\.|brave\.com|cloudflare|w3\.org|play\.google|apple\.com|fonts\.|microsoft|twitter|facebook|instagram|telegram|discord|reddit|wikipedia|youtube|mozilla|github|schema\.org|yahoo|bing\.|email-protection/;

/**
 * Résout les origines DLE candidates d'un site, validées par ordre de
 * fiabilité. Certains domaines (fstream.top) sont devenus des pages « Accès
 * au site » vers un domaine tournant (fs26.lol, fs27.lol…) qui change parfois
 * vers un host vide : on sonde plusieurs candidats et searchDle réessaie.
 *
 * @returns {Promise<string[]>} origines candidates (DLE validées d'abord)
 */
async function resolveOrigins(base, timeoutMs, signal, forceRefresh) {
    const hit = originCache.get(base);
    if (hit && !forceRefresh && hit.expires > Date.now()) return hit.origins;

    const t = Math.min(timeoutMs, 12000);
    const first = await fetchText(base, { timeout: t, headers: HEADERS, signal: signal });
    const firstOrigin = originOf(first.finalUrl) || base;

    const validated = [];
    if (DLE_MARKERS.test(first.text)) {
        validated.push(firstOrigin);
    } else {
        for (const candidate of await probeLanding(first.text, firstOrigin, t, signal)) {
            try {
                const probe = await fetchText(candidate, {
                    timeout: Math.min(t, 10000),
                    headers: HEADERS,
                    signal: signal,
                });
                if (DLE_MARKERS.test(probe.text)) {
                    const origin = originOf(probe.finalUrl) || candidate;
                    if (validated.indexOf(origin) === -1) validated.push(origin);
                    if (validated.length >= 2) break;
                }
            } catch (e) {
                /* candidat suivant */
            }
        }
    }
    if (!validated.length) validated.push(firstOrigin);

    originCache.set(base, { origins: validated, expires: Date.now() + 60 * 60 * 1000 });
    return validated;
}

/** Compat : première origine candidate. */
async function resolveOrigin(base, timeoutMs, signal) {
    const list = await resolveOrigins(base, timeoutMs, signal, false);
    return list[0];
}

/** Cherche les vrais domaines DLE derrière une landing page (triés). */
async function probeLanding(html, landingOrigin, timeoutMs, signal) {
    void timeoutMs;
    void signal;
    const candidates = [];
    const seen = {};
    const linkRe = /(?:href=["']|https?:\/\/)(https?:\/\/[a-z0-9.-]+[a-z0-9])/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
        const url = m[1];
        const host = url.replace(/^https?:\/\//i, '').toLowerCase();
        if (!host || seen[url]) continue;
        seen[url] = true;
        if (FOREIGN_HOSTS.test(host)) continue;
        if (host.indexOf(landingOrigin.replace(/^https?:\/\//i, '')) !== -1) continue;
        candidates.push(url);
    }
    // Le domaine de stream est souvent « fsNN.lol » : ces candidats d'abord.
    candidates.sort((a, b) => {
        const pa = /^https?:\/\/fs\d+\./i.test(a) ? 0 : 1;
        const pb = /^https?:\/\/fs\d+\./i.test(b) ? 0 : 1;
        return pa - pb;
    });
    return candidates.slice(0, 4);
}

function originOf(url) {
    const m = /^(https?:\/\/[^/?#]+)/i.exec(String(url || ''));
    return m ? m[1] : '';
}

function unslash(text) {
    return String(text || '').replace(/\\'/g, "'").replace(/\\"/g, '"');
}

/* ──────────────────────────────── recherche ────────────────────────────── */

function formEncode(obj) {
    const parts = [];
    for (const k of Object.keys(obj)) {
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
    }
    return parts.join('&');
}

// Cache recherche par (site, requête) : le 2e épisode d'une série saute la
// recherche (binge-watching). TTL 10 min, identique au pont v2.
const searchCache = createTtlCache(60);
const SEARCH_TTL_MS = 10 * 60 * 1000;

/** Cartes de recherche d'un site DLE (mêmes champs que sestudio.SeasonCard). */
export async function searchDle(siteId, query, opts = {}) {
    const site = DLE_SITES[siteId];
    const timeoutMs = opts.timeout || 20000;

    const cacheKey = 'search:' + siteId + ':' + String(query || '').toLowerCase().trim();
    if (!opts.noCache) {
        const hit = searchCache.get(cacheKey);
        if (hit) return hit;
    }

    // Le domaine tournant (fsNN) sert parfois un host vide : on essaie chaque
    // origine validée, puis un re-sondage forcé en dernier recours.
    let attempts = await resolveOrigins(site.base, timeoutMs, opts.signal, false);
    let cards = [];
    for (let pass = 0; pass < 2 && !cards.length; pass++) {
        if (pass === 1) {
            attempts = await resolveOrigins(site.base, timeoutMs, opts.signal, true);
        }
        for (const origin of attempts.slice(0, 2)) {
            try {
                const res = await fetchText(origin + '/engine/ajax/search.php', {
                    method: 'POST',
                    body: formEncode({ query: query, search_start: '0', full_search: '0', result_from: '1' }),
                    timeout: timeoutMs,
                    headers: {
                        Referer: origin + '/',
                        Origin: origin,
                        'X-Requested-With': 'XMLHttpRequest',
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    signal: opts.signal,
                });
                cards = parseSearchResponse(origin, site, res.text);
            } catch (err) {
                console.warn(
                    `[dle] Recherche ${siteId} sur ${origin} échouée : ` +
                        (err && err.message ? err.message : err)
                );
            }
            if (cards.length) break;
        }
    }
    if (cards.length) searchCache.set(cacheKey, cards, SEARCH_TTL_MS);
    return cards;
}

/**
 * Parseur pur de la réponse de recherche DLE (testé offline sur fixtures).
 */
export function parseSearchResponse(origin, site, html) {
    if (!html || /fsschal|Verification/i.test(html.slice(0, 2000))) {
        return []; // interstitiel : cette origine ne sert pas la recherche
    }

    const cards = [];
    const markers = [];
    const markerRe = /<div[^>]*class=['"][^'"]*search-item[^'"]*['"][^>]*>/g;
    let m;
    while ((m = markerRe.exec(html)) !== null) markers.push(m);

    for (let i = 0; i < markers.length; i++) {
        const start = markers[i].index;
        const end = i + 1 < markers.length ? markers[i + 1].index : html.length;
        const seg = html.slice(start, end);
        const isSeriesBlock = /class=['"][^'"]*search-series/.test(seg);

        // Bloc « search-series » : une série avec TOUTES ses saisons en JSON
        // (data-seasons). Une carte par saison, sans requête supplémentaire.
        if (isSeriesBlock) {
            const seasonsAttr = /data-seasons=['"]([^'"]*)['"]/.exec(seg);
            const tmS = /class=['"]search-title['"][^>]*>([\s\S]*?)<\/div>/.exec(seg);
            if (seasonsAttr && tmS) {
                const seriesName = unslash(stripTags(tmS[1]))
                    .replace(/\s*-\s*s[eé]rie\s*$/i, '')
                    .trim();
                let seasons = [];
                try {
                    seasons = JSON.parse(htmlUnescape(seasonsAttr[1]));
                } catch (e) {
                    seasons = [];
                }
                for (const s of Array.isArray(seasons) ? seasons : []) {
                    const link = String(s.l || '');
                    if (!link) continue;
                    const pageUrl = /^https?:\/\//i.test(link) ? link : origin + link;
                    const num = parseInt(s.n, 10) || 0;
                    const ym2 = /-(\d{4})\.html?$/i.exec(link);
                    cards.push({
                        newsid: (NEWSID_RE.exec(link) || [])[1] || '',
                        title: num > 1 ? seriesName + ' - Saison ' + num : seriesName,
                        series_name: seriesName,
                        season_number: num,
                        poster_url: String(s.p || ''),
                        page_url: pageUrl,
                        is_film: false,
                        is_anime: site.isAnime,
                        year: ym2 ? parseInt(ym2[1], 10) : 0,
                        source: site.id,
                    });
                }
            }
            continue;
        }

        const om = ONCLICK_RE.exec(seg);
        if (!om) continue;
        const rel = om[1];
        const pageUrl = /^https?:\/\//i.test(rel) ? rel : origin + rel;

        const im = /<img[^>]*\ssrc=["']([^"']+)["']/i.exec(seg);
        const poster = im ? im[1] : '';

        const tm = /class=['"]search-title['"][^>]*>([\s\S]*?)<\/div>/.exec(seg);
        const rawTitle = tm ? unslash(stripTags(tm[1])) : '';
        if (!rawTitle) continue;

        const ym = YEAR_RE.exec(rawTitle);
        const year = ym ? parseInt(ym[1], 10) : 0;
        const title = rawTitle.replace(YEAR_RE, '').trim();

        const sm = SEASON_RE.exec(title);
        const seasonNumber = sm ? parseInt(sm[1], 10) : 0;
        const seriesName = sm ? title.split(SEASON_RE)[0].replace(/[\s-]+$/, '').trim() : title;
        const isFilm = !sm && !site.isAnime;

        const idm = NEWSID_RE.exec(rel);
        cards.push({
            newsid: idm ? idm[1] : '',
            title: title,
            series_name: seriesName,
            season_number: seasonNumber,
            poster_url: poster,
            page_url: pageUrl,
            is_film: isFilm,
            is_anime: site.isAnime,
            year: year,
            source: site.id,
        });
    }
    return cards;
}

function stripTags(s) {
    return String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
}

function htmlUnescape(s) {
    return String(s || '')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/* ───────────────────────── page saison / film ──────────────────────────── */

/**
 * Page d'un titre DLE : série (avec #serie-config) ou film.
 * @returns {{season: number, is_film: boolean, available_langs: string[], episodes: Array}}
 */
export async function fetchDlePage(siteId, pageUrl, lang, opts = {}) {
    const timeoutMs = opts.timeout || 20000;
    try {
        return await fetchDleSeason(siteId, pageUrl, lang, timeoutMs, opts.signal);
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (String(msg).indexOf('news ID') === -1 && String(msg).indexOf('serie-config') === -1) {
            throw err;
        }
        return await fetchDleFilm(siteId, pageUrl, lang, timeoutMs, opts.signal);
    }
}

async function fetchDleSeason(siteId, pageUrl, lang, timeoutMs, signal) {
    const page = await fetchText(pageUrl, { timeout: timeoutMs, headers: HEADERS, signal: signal });
    const html = page.text;
    const origin = originOf(page.finalUrl) || originOf(pageUrl);

    const newsId = parseNewsId(html);
    if (!newsId) throw new Error('news ID introuvable (pas de #serie-config) : ' + pageUrl);
    const season = parseSeasonNumber(html);

    let epsRes;
    try {
        epsRes = await fetchText(origin + '/data/eps_' + newsId + '.txt', {
            timeout: timeoutMs,
            headers: { Referer: pageUrl, Cookie: 'fsschal=1', 'User-Agent': UA },
            signal: signal,
        });
    } catch (err) {
        const st = err && err.status ? err.status : 0;
        if (st !== 404) throw err;
        epsRes = await fetchText(origin + '/engine/ajax/manga_episodes_api.php?id=' + newsId, {
            timeout: timeoutMs,
            headers: { Referer: pageUrl, 'X-Requested-With': 'XMLHttpRequest', Cookie: 'fsschal=1', 'User-Agent': UA },
            signal: signal,
        });
    }

    let data;
    try {
        data = JSON.parse(epsRes.text);
    } catch (e) {
        throw new Error('données d épisodes invalides (site ' + siteId + ', id ' + newsId + ')');
    }

    const langData = data && typeof data[lang] === 'object' && data[lang] ? data[lang] : {};
    const info = data && typeof data.info === 'object' && data.info ? data.info : {};

    // Langues réellement pourvues d'épisodes.
    const availableLangs = Object.keys(data || {})
        .filter(k => k !== 'info' && k !== 'alt_titles' && data[k] && typeof data[k] === 'object' && Object.keys(data[k]).length)
        .sort();

    // Disponibilité par épisode (une saison est rarement uniforme).
    const langsByEpisode = {};
    for (const key of Object.keys(data || {})) {
        if (key === 'info' || key === 'alt_titles') continue;
        const block = data[key];
        if (!block || typeof block !== 'object') continue;
        for (const epKey of Object.keys(block)) {
            const providers = block[epKey];
            if (!providers || typeof providers !== 'object') continue;
            const has = Object.keys(providers).some(p => providers[p]);
            if (!has) continue;
            const num = parseInt(epKey, 10);
            if (!Number.isFinite(num)) continue;
            if (!langsByEpisode[num]) langsByEpisode[num] = [];
            if (langsByEpisode[num].indexOf(key) === -1) langsByEpisode[num].push(key);
        }
    }

    function titleOf(num) {
        const inf = info[String(num)];
        if (inf && typeof inf === 'object' && inf.title) return String(inf.title);
        return 'Episode ' + num;
    }

    const episodes = [];
    for (const key of Object.keys(langData)) {
        const num = parseInt(key, 10);
        if (!Number.isFinite(num)) continue;
        const providers = langData[key];
        const embedUrls = {};
        if (providers && typeof providers === 'object') {
            for (const p of Object.keys(providers)) {
                if (providers[p]) embedUrls[p] = providers[p];
            }
        }
        episodes.push({
            number: num,
            title: titleOf(num),
            season: season,
            embed_urls: embedUrls,
            langs: langsByEpisode[num] || [],
        });
    }
    // Épisodes absents de cette langue mais présents ailleurs : listés sans embed.
    for (const numStr of Object.keys(langsByEpisode)) {
        const num = parseInt(numStr, 10);
        if (episodes.some(e => e.number === num)) continue;
        episodes.push({ number: num, title: titleOf(num), season: season, embed_urls: {}, langs: langsByEpisode[num] });
    }
    episodes.sort((a, b) => a.number - b.number);

    return { season: season, is_film: false, available_langs: availableLangs, episodes: episodes };
}

async function fetchDleFilm(siteId, pageUrl, lang, timeoutMs, signal) {
    const idm = NEWSID_RE.exec(pageUrl);
    if (!idm) throw new Error('news ID introuvable dans l URL film : ' + pageUrl);
    const newsId = idm[1];

    const page = await fetchText(pageUrl, { timeout: timeoutMs, headers: HEADERS, signal: signal });
    const html = page.text;
    const origin = originOf(page.finalUrl) || originOf(pageUrl);

    let embedUrls = {};
    let available = [];

    try {
        const api = await fetchJson(origin + '/engine/ajax/film_api.php?id=' + newsId, {
            timeout: timeoutMs,
            headers: { Referer: pageUrl, 'X-Requested-With': 'XMLHttpRequest', Cookie: 'fsschal=1', 'User-Agent': UA },
            signal: signal,
        });
        if (api && api.error) throw new Error('film_api : ' + api.error);

        const players = (api && api.players) || {};
        const langKeys = FILM_LANG_KEYS[lang] || ['vff', 'vfq'];

        for (const provider of PROVIDER_ORDER) {
            const variants = players[provider];
            if (!variants || typeof variants !== 'object') continue;
            let url = '';
            for (const k of langKeys) {
                if (variants[k]) { url = variants[k]; break; }
            }
            if (!url) url = variants['default'] || '';
            if (url) embedUrls[provider] = url;
        }

        const set = {};
        for (const provider of Object.keys(players)) {
            const v = players[provider];
            if (!v || typeof v !== 'object') continue;
            if (v.vfq || v.vff) set.vf = true;
            if (v.vostfr) set.vostfr = true;
        }
        available = Object.keys(set).sort();
        if (!available.length && Object.keys(players).length) available = ['vf'];
    } catch (e) {
        // film_api indisponible : repli iframes plus bas.
    }

    if (!Object.keys(embedUrls).length) {
        const iframeRe = /<iframe\b[^>]*>/gi;
        let im;
        while ((im = iframeRe.exec(html)) !== null) {
            const tag = im[0];
            const sm = /\ssrc=["']([^"']+)["']/.exec(tag);
            const dm = /\sdata-src=["']([^"']+)["']/.exec(tag);
            const src = (sm && sm[1]) || (dm && dm[1]) || '';
            if (!src) continue;
            const provider = guessProvider(src);
            if (provider && !embedUrls[provider]) embedUrls[provider] = src;
        }
    }

    const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
    let filmTitle = titleMatch ? stripTags(titleMatch[1]) : '';
    filmTitle = filmTitle.replace(/\s+[-–|]\s+[\s\S]*$/, '').trim();
    filmTitle = filmTitle.replace(/^(?:Film|Movie)\s+/i, '').trim() || 'film_' + newsId;

    return {
        season: 0,
        is_film: true,
        available_langs: available,
        episodes: [
            {
                number: 1,
                title: filmTitle,
                season: 0,
                embed_urls: embedUrls,
                langs: available.slice(),
            },
        ],
    };
}

const EMBED_HINTS = [
    ['uqload', 'uqload'],
    ['vidzy', 'vidzy'],
    ['fsvid', 'premium'],
    ['premium', 'premium'],
    ['luluvdo', 'luluvid'],
    ['luluvid', 'luluvid'],
    ['lulustream', 'luluvid'],
    ['vidhsareup', 'luluvid'],
    // v3.1.9 — mêmes indices que hosts/index.js (vidmoly/voembed AVANT 'voe',
    // sinon 'voembed' matcherait le hint générique 'voe').
    ['vidmoly', 'vidmoly'],
    ['voembed', 'vidmoly'],
    ['ansembed', 'vidmoly'],
    ['xtremestream', 'xtremestream'],
    ['veev', 'veev'],
    ['wishonly', 'veev'],
    ['livavid', 'veev'],
    ['lulavid', 'veev'],
    ['livastream', 'veev'],
    ['voe', 'voe'],
    ['vidaraa', 'filmoon'],
    ['filmoon', 'filmoon'],
    ['/viper', 'filmoon'],
    ['chamber_go', 'filmoon'],
    ['netu', 'netu'],
    ['/moon', 'netu'],
    ['byse', 'netu'],
];

function guessProvider(src) {
    const low = String(src || '').toLowerCase();
    for (const [hint, provider] of EMBED_HINTS) {
        if (low.indexOf(hint) !== -1) return provider;
    }
    return null;
}

export function parseNewsId(html) {
    let m = /<[^>]*\bid=["']serie-config["'][^>]*>/.exec(html);
    if (m) {
        const idm = /data-news-id=["']([^"']+)["']/.exec(m[0]);
        if (idm) return idm[1];
        // id et data-* peuvent être séparés par d'autres balises : fenêtre large.
        const start = m.index;
        const window = html.slice(start, start + 800);
        const idm2 = /data-news-id=["']([^"']+)["']/.exec(window);
        if (idm2) return idm2[1];
    }
    // Repli : n'importe quelle balise porteuse de data-news-id + serie-config.
    const dm = /data-news-id=["'](\d+)["']/.exec(html);
    if (dm && html.indexOf('serie-config') !== -1) return dm[1];
    return '';
}

export function parseSeasonNumber(html) {
    const cm = /<[^>]*\bid=["']serie-config["'][^>]*>/.exec(html);
    if (cm) {
        const tm = /data-title=["']([^"']*)["']/.exec(cm[0]);
        if (tm) {
            const sm = SEASON_RE.exec(unslash(tm[1]));
            if (sm) return parseInt(sm[1], 10);
        }
    }
    const tt = /<title>([\s\S]*?)<\/title>/i.exec(html);
    if (tt) {
        const sm = SEASON_RE.exec(stripTags(tt[1]));
        if (sm) return parseInt(sm[1], 10);
    }
    return 0;
}
