/**
 * Source FrenchStream — provider v3.1.9 (french-stream.net).
 *
 * Portage de la voie mesurée la plus rentable du provider gowaru
 * `frenchstream` (src/frenchstream/extractor.js), adaptée au contrat v3.
 * Site DLE-CMS comme FStream/French-Manga — MÊME structure de données que
 * notre dle-common (eps_<newsid>.txt) — mais résolution DIRECTE par l'ID
 * TMDB : le site tague chaque fiche via xfsearch `tagz` →
 *   film  → /index.php?do=xfsearch&xfname=tagz&xf=f-{tmdbId}
 *   série → /index.php?do=xfsearch&xfname=tagz&xf=s-{tmdbId}
 * → ZÉRO recherche par titre, ZÉRO matching flou : needsMeta = false, la
 * source démarre immédiatement (tier direct).
 *
 * Vérifié en live (2026-10-28) :
 *   - xf=f-27205 → newsId 1022 (Inception), page de tag avec data-id /
 *     openModal('…') / ratig-layer-… ;
 *   - /engine/ajax/film_api.php?id=1022 → {players:{uqload:{vff,vfq},
 *     premium:{… fsvid.lol}, vidzy:{… vidzy.cc}, …}, meta:{tagz:'f-27205'}}
 *     (netu peut renvoyer un ID brut non-URL → filtré) ;
 *   - /engine/ajax/get_seasons.php?serie_tag=s-1396&news_id=0 →
 *     [{id, title:"Breaking Bad - Saison 1", full_url, affiche}] ;
 *   - /data/eps_9561.txt → {vf:{1:{premium,vidzy,uqload,netu,voe}}, …}
 *     (identique à french-manga : même parseur).
 * Les embeds servies (fsvid/premium, vidzy, uqload) sont toutes couvertes
 * par nos extracteurs d'hôtes. Les wrappers trakx.lol (dood/voe) et les
 * ID bruts n'ont pas de hint → écartés automatiquement.
 *
 * vitesse mesurée depuis la sandbox : TTFB 0,29 s (site FR le plus rapide
 * de l'étude frenchCS) ; la chaîne complète = 2-3 requêtes.
 */

import { fetchText, fetchJson, createTtlCache } from '../utils/http.js';
import { resolveEmbeds } from '../hosts/index.js';
import { makeStream, composeTitle } from '../core/stream.js';

const BASE = 'https://french-stream.net';

const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    Accept: 'text/html,application/json,*/*',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
};

/* 6 s par host : sous l'échéance douce, les hosts vivants répondent en
 * 2-4 s, un host qui pend libère la fenêtre (même réglage que dle-runner). */
const HOST_TIMEOUT_MS = 6000;
const MAX_STREAMS = 3;
const MAX_NEWS_IDS = 2;

// Ordre hosts film_api/eps : même logique que dle-common (vidzy en dernier).
const HOST_ORDER = [
    'uqload', 'vidmoly', 'xtremestream', 'premium', 'filmoon', 'voe', 'veev',
    'luluvid', 'netu', 'vidzy',
];

const LANG_LABELS = { vf: 'VF', vostfr: 'VOSTFR', vo: 'VO' };

/* Clés de langue du site → clé interne, dans l'ordre de préférence.
 * Live : 'default' est un doublon exact de 'vff' (même URL) ; vfq = Québec.
 *Notre modèle VF/VOSTFR/VO n'a pas de variante Québec : vff d'abord. */
const LANG_KEYS = {
    vf: ['vff', 'vfq', 'default', 'vf'],
    vostfr: ['vostfr'],
    vo: ['vo', 'vostfr'],
};

// Caches : xfsearch/tag (10 min, binge-watching) + saisons (10 min).
const tagCache = createTtlCache(40);
const seasonsCache = createTtlCache(20);
const TAG_TTL_MS = 10 * 60 * 1000;

export default {
    id: 'french-stream',
    label: 'FrenchStream',
    needsMeta: false, // résolution directe par tmdbId (xfsearch tagz)
    async run(ctx) {
        try {
            await runFs(ctx);
        } catch (err) {
            console.warn('[french-stream] échoué : ' + (err && err.message ? err.message : err));
        }
    },
};

async function runFs(ctx) {
    const { cfg, signal, push, shouldStop } = ctx;
    const isTv = ctx.mediaType === 'tv';
    const tag = (isTv ? 's-' : 'f-') + ctx.tmdbId;

    // 1. Page de tag xfsearch → newsIds de la fiche exacte (zéro fuzzy).
    const newsIds = await findNewsIds(tag, cfg, signal);
    if (!newsIds.length) {
        console.log('[french-stream] aucune fiche taguée ' + tag);
        return;
    }

    if (isTv) {
        await runTv(ctx, newsIds[0], push, shouldStop);
    } else {
        await runMovie(ctx, newsIds, push, shouldStop);
    }
}

/* ────────────────────────────── films ──────────────────────────────────── */

async function runMovie(ctx, newsIds, push, shouldStop) {
    for (const newsId of newsIds) {
        if (shouldStop()) return;
        // film_api : {players:{host:{lang:url}}, meta:{tagz}} — le tagz de la
        // RÉPONSE fait foi (gowaru verifyAndExtractMovieStreams) : protège
        // contre un newsId périmé recroisé par le cache.
        let api;
        try {
            api = await fetchJson(BASE + '/engine/ajax/film_api.php?id=' + newsId, {
                timeout: ctx.cfg.timeoutMs,
                headers: { ...HEADERS, Referer: BASE + '/', 'X-Requested-With': 'XMLHttpRequest' },
                signal: ctx.signal,
            });
        } catch (e) {
            continue;
        }
        if (!api || api.error || !api.players) continue;
        if (api.meta && api.meta.tagz && api.meta.tagz !== 'f-' + ctx.tmdbId) {
            console.log('[french-stream] tagz mismatch (' + api.meta.tagz + ') — newsId ignoré');
            continue;
        }

        // Une chaîne de langues à la fois (préférée d'abord) — la première
        // qui résout suffit (comme resolveCard dle-runner).
        for (const lang of ctx.cfg.fallbackLangs.slice(0, ctx.cfg.allowOtherLang ? 3 : 1)) {
            if (shouldStop()) return;
            const map = buildHostMap(api.players, lang);
            if (!Object.keys(map).length) continue;
            const got = await resolveMap(ctx, map, lang, 0);
            for (const st of got) push(st);
            if (got.length) return;
        }
        if (ctx.cfg.allowOtherLang) continue; // newsId suivant si rien résolu
        return;
    }
}

/* ────────────────────────────── séries ─────────────────────────────────── */

async function runTv(ctx, newsId, push, shouldStop) {
    const season = parseInt(ctx.season, 10) || 1;
    const episode = parseInt(ctx.episode, 10) || 1;

    // 1. Saisons du tag s-{tmdbId} : [{id, title:"… - Saison N", …}].
    let seasons;
    try {
        seasons = await fetchJson(
            BASE + '/engine/ajax/get_seasons.php?serie_tag=s-' + ctx.tmdbId + '&news_id=0',
            {
                timeout: ctx.cfg.timeoutMs,
                headers: { ...HEADERS, Referer: BASE + '/', 'X-Requested-With': 'XMLHttpRequest' },
                signal: ctx.signal,
            }
        );
    } catch (e) {
        console.warn('[french-stream] get_seasons échoué : ' + (e && e.message ? e.message : e));
        return;
    }
    if (!Array.isArray(seasons) || !seasons.length) {
        console.log('[french-stream] aucune saison pour s-' + ctx.tmdbId);
        return;
    }
    const cacheKey = 'seasons_' + ctx.tmdbId;
    seasonsCache.set(cacheKey, seasons, TAG_TTL_MS);

    // Saison EXACTE uniquement (jamais de repli sur une autre saison : les
    // épisodes ne correspondraient pas — même règle que gowaru/wookafr).
    const target = seasons.find(s => /saison\s+(\d+)/i.exec(String(s.title || '')) &&
        parseInt(/saison\s+(\d+)/i.exec(String(s.title || ''))[1], 10) === season);
    if (!target || !target.id) {
        const avail = seasons
            .map(s => (/(\d+)/.exec(String(s.title || '')) || [])[1])
            .filter(Boolean)
            .slice(0, 20)
            .join(' ');
        console.log('[french-stream] saison ' + season + ' absente — dispos : ' + (avail || '?'));
        return;
    }

    // 2. Fichier eps (structure identique à french-manga : {vf:{ep:{host:url}}}).
    let data;
    try {
        data = await fetchJson(BASE + '/data/eps_' + target.id + '.txt', {
            timeout: ctx.cfg.timeoutMs,
            headers: { ...HEADERS, Referer: BASE + '/' },
            signal: ctx.signal,
        });
    } catch (e) {
        console.warn('[french-stream] eps_' + target.id + ' illisible : ' + (e && e.message ? e.message : e));
        return;
    }
    if (!data || typeof data !== 'object') return;

    for (const lang of ctx.cfg.fallbackLangs.slice(0, ctx.cfg.allowOtherLang ? 3 : 1)) {
        if (shouldStop()) return;
        const byEp = data[lang] && typeof data[lang] === 'object' ? data[lang] : null;
        if (!byEp) continue;
        const players = byEp[String(episode)] || byEp[episode];
        if (!players || typeof players !== 'object') {
            // L'épisode existe peut-être dans une autre langue : continuer la chaîne.
            continue;
        }
        const map = buildHostMap(players, lang);
        if (!Object.keys(map).length) {
            console.log('[french-stream] E' + episode + ' ' + lang + ' : hosts non couverts (' +
                Object.keys(players).join(',') + ')');
            continue;
        }
        const got = await resolveMap(ctx, map, lang, episode);
        for (const st of got) push(st);
        if (got.length) return;
    }
}

/* ─────────────────────────── helpers partagés ──────────────────────────── */

/** Page de tag → newsIds distincts (data-id / openModal / ratig-layer). */
async function findNewsIds(tag, cfg, signal) {
    const cacheKey = 'tag_' + tag;
    const hit = tagCache.get(cacheKey);
    if (hit) return hit;
    try {
        const res = await fetchText(
            BASE + '/index.php?do=xfsearch&xfname=tagz&xf=' + encodeURIComponent(tag),
            {
                timeout: Math.min(cfg.timeoutMs, 12000),
                headers: { ...HEADERS, Referer: BASE + '/' },
                signal: signal,
            }
        );
        const ids = parseTagNewsIds(res.text).slice(0, MAX_NEWS_IDS);
        if (ids.length) tagCache.set(cacheKey, ids, TAG_TTL_MS);
        return ids;
    } catch (e) {
        console.warn('[french-stream] xfsearch échoué : ' + (e && e.message ? e.message : e));
        return [];
    }
}

/** Parseur pur (testé offline) : newsIds présents sur une page de tag. */
export function parseTagNewsIds(html) {
    if (!html) return [];
    const out = [];
    const seen = {};
    const res = [
        /openModal\('(\d+)'\)/g,
        /data-id="(\d+)"/g,
        /ratig-layer-(\d+)/g,
    ];
    for (const re of res) {
        let m;
        while ((m = re.exec(html)) !== null) {
            const id = m[1];
            if (!seen[id]) {
                seen[id] = true;
                out.push(id);
            }
        }
        if (out.length >= 4) break; // les 3 regex décrivent les mêmes IDs
    }
    return out;
}

/**
 * players → map {provider:embedUrl} : un host = une entrée (résolution en
 * parallèle par resolveEmbeds). Deux formes selon l'endpoint (vérifiées
 * live) :
 *   - film_api : {host:{vff:url, vfq:url, default:url, vostfr:url}} (imbriqué)
 *   - eps_N.txt : {host:url} (URL string DIRECTE, pas d'imbrication langue —
 *     la langue est le niveau au-dessus : data.vf[ep][host])
 * Les hosts sans hint (wrappers trakx, ID brut netu) sont écartés ici pour
 * ne pas brûler des tentatives de résolution.
 */
function buildHostMap(players, lang) {
    const keys = LANG_KEYS[lang] || LANG_KEYS.vf;
    const map = {};
    for (const host of HOST_ORDER) {
        const variants = players[host];
        if (!variants) continue;
        let url = '';
        if (typeof variants === 'string') {
            url = variants;
        } else if (typeof variants === 'object') {
            for (const k of keys) {
                if (typeof variants[k] === 'string' && variants[k]) {
                    url = variants[k];
                    break;
                }
            }
            if (!url && typeof variants['default'] === 'string') url = variants['default'];
        }
        if (!url || url.indexOf('http') !== 0) continue; // ID brut netu → écarté
        const provider = guessProvider(url, host);
        if (!provider || map[provider]) continue; // un seul embed par extracteur
        map[provider] = url;
    }
    return map;
}

// Mêmes indices que hosts/index.js (source unique de vérité côté extraction) ;
// la clé film_api ('premium' = fsvid) existe déjà comme provider ici.
const HINTS = [
    ['uqload', 'uqload'],
    ['vidzy', 'vidzy'],
    ['fsvid', 'premium'],
    ['vidmoly', 'vidmoly'],
    ['voembed', 'vidmoly'],
    ['ansembed', 'vidmoly'],
    ['xtremestream', 'xtremestream'],
    ['veev', 'veev'],
    ['wishonly', 'veev'],
    ['luluvdo', 'luluvid'],
    ['luluvid', 'luluvid'],
    ['lulust', 'luluvid'],
    ['lulustream', 'luluvid'],
    ['voe', 'voe'],
    ['filmoon', 'filmoon'],
    ['/viper', 'filmoon'],
    ['netu', 'netu'],
    ['/moon', 'netu'],
];

function guessProvider(url, hostKey) {
    const low = String(url || '').toLowerCase();
    for (const [hint, provider] of HINTS) {
        if (low.indexOf(hint) !== -1) return provider;
    }
    // Clé du site sans hint dans l'URL (rare) : acceptée si c'est un provider connu.
    const k = String(hostKey || '').toLowerCase();
    if (HOST_ORDER.indexOf(k) !== -1 && k !== 'netu') return k;
    return null;
}

/** Résolution d'une map {provider:url} → flux internes prêts à pousser. */
async function resolveMap(ctx, map, lang, episode) {
    let resolved = [];
    try {
        resolved = await resolveEmbeds(map, {
            timeout: HOST_TIMEOUT_MS,
            signal: ctx.signal,
            maxResults: 2,
            maxAttempts: 4,
            language: lang, // v3.1.14 : anti-écran-noir uqload au niveau résolveur
        });
    } catch (err) {
        console.warn(
            '[french-stream] résolution hosts échouée (' + lang + ') : ' +
                (err && err.message ? err.message : err)
        );
        return [];
    }
    const langLabel = LANG_LABELS[lang] || String(lang).toUpperCase();
    const out = [];
    for (const r of resolved) {
        out.push(
            makeStream({
                title: composeTitle({
                    site: 'FrenchStream',
                    episode: episode,
                    host: r.provider,
                    url: r.url,
                    lang: langLabel,
                }),
                url: r.url,
                // v3.1.14 : qualité lue dans le master au swap muxé uqload
                quality: r.quality || (/\.m3u8(\?|$)/i.test(String(r.url || '')) ? 'Auto (HLS)' : 'Direct'),
                language: langLabel,
                headers: buildHeaders(r.referer, r.ua),
                subtitles: (r.subtitles || []).map(sub => ({
                    url: sub.url,
                    title: sub.label || String(sub.lang || '').toUpperCase(),
                    lang: sub.lang || 'fre',
                })),
                _weakPlayer: r.weakPlayer === true,
                _langKey: lang,
                _site: 'french-stream',
            })
        );
    }
    return out;
}

function buildHeaders(referer, ua) {
    const headers = {};
    if (referer) headers.Referer = referer;
    if (ua) headers['User-Agent'] = ua;
    return headers;
}
