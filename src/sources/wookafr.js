/**
 * Source WookaFR — provider v3.1.9 (wookafr.boston).
 *
 * Portage du provider gowaru `wookafr` (src/wookafr/{config,extractor}.js),
 * adapté au contrat v3 (collecte immédiate ctx.push, stops ctx.shouldStop,
 * extracteurs d'hôtes locaux). Thème WordPress « somosmovies » :
 *
 *   1. Recherche   GET  /?s={titre}            → article.moviecard
 *                  (liens /streaming/{cat}/{slug}/ ; /streaming/category|,
 *                   production|, slider|, calidad| = navigation → écartés)
 *   2. Série       boutons button.btgy[data-season] ; saison inactive →
 *                  POST /wp-admin/admin-ajax.php {action:'getepisodes',
 *                  season_id, nonce} (nonce = var sm_Public = {url,nonce} —
 *                  JSON strict vérifié live, regex gowaru tolérante aux 2
 *                  formats) ; épisodes div.lpep > div.itlep > a[href]
 *                  /episodes/…-saison-N-episode-M(-X)/ (suffixe -2 toléré)
 *   3. Embed       iframe lecteurvideo.com/embed.php?id=…&tp=…&url={site}
 *                  → sections de langue div.OD OD_{FR|VFF|VFQ|VOSTFR|EN}
 *                  → onclick="showVideo('BASE64'[,prio])" → URL décodée
 *   4. Résolution  priorité gowaru : xtremestream (5) > uqload (10) >
 *                  vidmoly (12) > veev (15) > waaw (16) > filemoon (20) >
 *                  voe (22) — interleave par langue VF d'abord.
 *
 * ⚠ Referer de l'embed lecteurvideo : TOUJOURS le domaine actuel du site
 * (wookafr.boston) — le param url= (wookafr.tel) est périmé et déclenche
 * le 403 anti-hotlink « Ne volez pas notre travail » (fix gowaru 2026-10).
 *
 * Anti-homonymes : la garde rankCards (utils/match.js) + slug exact.
 * Saison absente du site → abandon propre (jamais d'autre saison à la place).
 */

import { fetchText, fetchJson, createTtlCache } from '../utils/http.js';
import { resolveEmbed, providerFromEmbedUrl } from '../hosts/index.js';
import { rankCards } from '../utils/match.js';
import { makeStream, composeTitle } from '../core/stream.js';

const DOMAINS = ['https://wookafr.boston', 'https://wookafr.center'];

const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
};

const TIMEOUTS = { SEARCH: 10000, PAGE: 12000, HOST: 6000 };
const MAX_CARDS = 2;
const MAX_HOST_CANDIDATES = 6;
const MAX_STREAMS = 3;

/** Origine d'une URL (schéma + hôte) — v3.1.14 : la fonction était UTILISÉE
 * (episodePageUrl, page_url des cartes) mais jamais définie ici → chaque
 * résolution de carte wookafr échouait avec « originOf is not defined »
 * (bug latent depuis v3.1.9, visible dans les logs e2e). Implémentation
 * identique à hosts/index.js. */
function originOf(url) {
    const m = /^(https?:\/\/[^/?#]+)/i.exec(String(url || ''));
    return m ? m[1] : '';
}

/* Priorité serveurs de l'embed lecteurvideo (gowaru parseLecteurVideoServers,
 * fix 2026-10 : xtremestream = 1er host VF, ~60-70 % des liens, AVANT uqload
 * « souvent expiré »). */
const HOST_PRIORITY = [
    ['xtremestream', 5],
    ['uqload', 10],
    ['vidmoly', 12],
    ['veev', 15],
    ['waaw', 16],
    ['filemoon', 20],
    ['voe', 22],
    ['emmmmbed', 25],
    ['upn.one', 30],
    ['wishonly', 40],
];
const DEFAULT_PRIORITY = 50;

/* Sections de langue de l'embed → clé interne (gowaru config.js).
 * OD_down = onglet Télécharger (megaup/1fichier morts) → ignoré. */
const LANG_SECTIONS = {
    FR: 'vf',
    VFF: 'vf',
    VFQ: 'vf',
    VFI: 'vf',
    VOSTFR: 'vostfr',
    VOST: 'vostfr',
    EN: 'vo',
    VO: 'vo',
};

const EPISODE_URL_RE = /\/episodes\/.*-saison-(\d+)-episode-(\d+)(?:-\d+)?\/?$/i;
/* nonce sm_Public : JSON strict (live 2026-10) OU bare key JS (ancien). */
const SM_PUBLIC_RE =
    /sm_Public\s*=\s*\{[^}]*?["']?url["']?\s*:\s*["']([^"']+)["'][^}]*?["']?nonce["']?\s*:\s*["']([^"']+)["']/;

const LANG_LABELS = { vf: 'VF', vostfr: 'VOSTFR', vo: 'VO' };

const searchCache = createTtlCache(30);
const SEARCH_TTL_MS = 10 * 60 * 1000;

export default {
    id: 'wookafr',
    label: 'WookaFR',
    needsMeta: true, // recherche par titre TMDB (cartes /streaming/)
    async run(ctx) {
        try {
            await run(ctx);
        } catch (err) {
            console.warn('[wookafr] échoué : ' + (err && err.message ? err.message : err));
        }
    },
};

async function run(ctx) {
    const { cfg, signal, push, shouldStop } = ctx;

    let meta;
    try {
        meta = await ctx.meta;
    } catch (e) {
        meta = null;
    }
    if (!meta || !meta.titles.length) {
        console.error('[wookafr] TMDB n a fourni aucun titre, recherche impossible.');
        return;
    }

    // 1. Recherche (1re variante de titre, 2e si score faible) sur chaque
    //    domaine — la première carte confian­ce gagne.
    let confident = null;
    const allCards = [];
    for (const query of meta.titles.slice(0, 2)) {
        if (shouldStop()) break;
        let cards = [];
        try {
            cards = await searchWooka(query, cfg, signal);
        } catch (err) {
            console.warn('[wookafr] recherche « ' + query + ' » échouée : ' +
                (err && err.message ? err.message : err));
            continue;
        }
        if (!cards.length) continue;
        for (const c of cards) allCards.push(c);
        const ranked = rankCards(allCards, meta, ctx.mediaType, ctx.season);
        if (ranked.length) {
            confident = ranked;
            if (ranked[0].score >= 95) break;
        }
    }
    if (!confident) {
        console.log('[wookafr] aucune carte pour « ' + meta.titles[0] + ' »');
        return;
    }

    const threshold = Math.max(40, confident[0].score - 30);
    const bestCards = confident
        .filter(r => r.score >= threshold && r.card.page_url)
        .slice(0, MAX_CARDS);
    if (!bestCards.length) return;

    console.log(
        '[wookafr] « ' + meta.titles[0] + ' » → ' +
            bestCards.map(r => '"' + r.card.title + '" (' + r.score + ')').join(', ')
    );

    // 2. Résolution des cartes (la première qui donne suffit).
    const isMovie = ctx.mediaType !== 'tv';
    let streams = 0;
    for (const cand of bestCards) {
        if (shouldStop() || streams >= MAX_STREAMS) break;
        try {
            const got = await resolveCard(ctx, cand.card, isMovie);
            streams += got.length;
        } catch (err) {
            console.warn('[wookafr] carte "' + cand.card.title + '" échouée : ' +
                (err && err.message ? err.message : err));
        }
    }
}

/* ─────────────────────────────── recherche ─────────────────────────────── */

/** Cartes /streaming/{cat}/{slug}/ d'une recherche ?s= (parseur pur). */
export function parseSearchCards(html, domain) {
    if (!html) return [];
    const out = [];
    const seen = {};
    const markerRe = /<article[^>]*class="[^"]*moviecard[^"]*"[^>]*>/g;
    const markers = [];
    let m;
    while ((m = markerRe.exec(html)) !== null) markers.push(m);
    for (let i = 0; i < markers.length; i++) {
        const start = markers[i].index;
        const end = i + 1 < markers.length ? markers[i + 1].index : html.length;
        const seg = html.slice(start, end);

        const lm = /<a[^>]+href=["'](https?:\/\/[^"']*\/streaming\/[^"']+)["']/.exec(seg);
        if (!lm) continue;
        const url = lm[1];
        // Navigation (category/production/slider/calidad/news) : pas un titre.
        if (/\/streaming\/(?:category|production|slider|calidad|news)\//i.test(url)) continue;

        // Titre : span.text-dark du h2 (propre) → h2 → alt de l'image
        // (gowaru : l'alt reste VIDE quand le lazyload n'a pas rempli).
        let title = '';
        const tm = /<h2[^>]*>(?:[\s\S]*?<span[^>]*class="[^"]*text-dark[^"]*"[^>]*>([\s\S]*?)<\/span>)?[\s\S]*?<\/h2>/.exec(seg);
        if (tm && tm[1]) title = stripTags(tm[1]);
        if (!title) {
            const tm2 = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(seg);
            if (tm2) title = stripTags(tm2[1]);
        }
        if (!title) {
            const im = /<img[^>]*\salt=["']([^"']+)["']/i.exec(seg);
            if (im) title = im[1].trim();
        }
        if (!title) continue;

        const key = url.replace(/\/+$/, '');
        if (seen[key]) continue;
        seen[key] = true;
        const isSeries = /\/streaming\/(?:series|serie)\//i.test(url);
        const sm = /saison-(\d+)/i.exec(url);
        out.push({
            title: title,
            series_name: sm ? title.replace(/[\s\-]*[Ss]aison\s+\d+.*$/, '').trim() : title,
            season_number: sm ? parseInt(sm[1], 10) : 0,
            page_url: url,
            is_film: !isSeries,
            year: 0,
            source: 'wookafr',
            _domain: domain,
        });
    }
    return out;
}

async function searchWooka(query, cfg, signal) {
    const cacheKey = 'search:' + String(query || '').toLowerCase().trim();
    const hit = searchCache.get(cacheKey);
    if (hit) return hit;

    for (const domain of DOMAINS) {
        try {
            const res = await fetchText(domain + '/?s=' + encodeURIComponent(query), {
                timeout: TIMEOUTS.SEARCH,
                headers: { ...HEADERS, Referer: domain + '/' },
                signal: signal,
            });
            const cards = parseSearchCards(res.text, domain);
            if (cards.length) {
                searchCache.set(cacheKey, cards, SEARCH_TTL_MS);
                return cards;
            }
            // Page servie sans carte : domaine vivant mais sans résultat →
            // pas la peine d'essayer le miroir (même catalogue).
            return [];
        } catch (e) {
            continue; // 403/timeout → domaine suivant
        }
    }
    return [];
}

/* ─────────────────────── page série / film ─────────────────────────────── */

async function resolveCard(ctx, card, isMovie) {
    const page = await fetchText(card.page_url, {
        timeout: TIMEOUTS.PAGE,
        headers: { ...HEADERS, Referer: card._domain + '/' },
        signal: ctx.signal,
    });
    const html = page.text;
    if (!html || isCfBlock(html)) return [];

    let episodePageUrl = card.page_url;
    if (!isMovie) {
        const found = await findEpisodePageUrl(ctx, card, html);
        if (!found) return [];
        episodePageUrl = found;
    }

    const epHtml = episodePageUrl === card.page_url
        ? html
        : (await fetchText(episodePageUrl, {
              timeout: TIMEOUTS.PAGE,
              headers: { ...HEADERS, Referer: card.page_url },
              signal: ctx.signal,
          })).text;
    if (!epHtml || isCfBlock(epHtml)) return [];

    // 3. Embed lecteurvideo → candidats par langue/host.
    const origin = originOf(episodePageUrl) || card._domain;
    const candidates = await collectEmbedCandidates(ctx, epHtml, origin);
    if (!candidates.length) {
        console.log('[wookafr] aucun serveur dans l embed de ' + episodePageUrl);
        return [];
    }
    console.log('[wookafr] ' + candidates.length + ' serveur(s) trouvé(s)');

    // 4. Interleave par langue (VF d'abord) puis priorité host, résolution
    //    séquentielle avec early-exit budget (gowaru resolveCandidates).
    const ordered = interleaveByLang(candidates);
    const pushed = [];
    const seen = {};
    let count = 0;
    for (const cand of ordered) {
        if (count >= MAX_STREAMS || ctx.shouldStop()) break;
        if (seen[cand.url]) continue;
        seen[cand.url] = true;
        const provider = providerFromEmbedUrl(cand.url);
        if (!provider) continue;
        if (count >= MAX_HOST_CANDIDATES) break;
        let r;
        try {
            r = await resolveEmbed(provider, cand.url, {
                timeout: TIMEOUTS.HOST,
                signal: ctx.signal,
                language: cand.lang, // v3.1.14 : anti-écran-noir uqload au niveau résolveur
            });
        } catch (err) {
            console.log('[wookafr] host ' + provider + ' échoué : ' +
                (err && err.message ? err.message : err));
            continue;
        }
        const langLabel = LANG_LABELS[cand.lang] || 'VF';
        ctx.push(
            makeStream({
                title: composeTitle({
                    site: 'WookaFR',
                    episode: isMovie ? 0 : parseInt(ctx.episode, 10) || 0,
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
                _langKey: cand.lang,
                _site: 'wookafr',
            })
        );
        pushed.push(r.url);
        count++;
    }
    return pushed;
}

/** URL de la page épisode (saison active → DOM, inactive → AJAX nonce). */
async function findEpisodePageUrl(ctx, card, seriesHtml) {
    const season = parseInt(ctx.season, 10) || 1;
    const episode = parseInt(ctx.episode, 10) || 1;
    const origin = originOf(card.page_url) || card._domain;

    // Boutons de saison : <button class="btgy …" data-season="12345">Saison N</button>
    const seasons = [];
    const btnRe = /<button[^>]*class="[^"]*btgy[^"]*"[^>]*data-season=["'](\d+)["'][^>]*>([\s\S]*?)<\/button>/g;
    let m;
    while ((m = btnRe.exec(seriesHtml)) !== null) {
        seasons.push({ id: m[1], title: stripTags(m[2]) });
    }

    let seasonId = null;
    if (seasons.length) {
        const target = seasons.find(s => {
            const n = /(\d+)/.exec(s.title);
            return n && parseInt(n[1], 10) === season;
        });
        if (!target) {
            console.log('[wookafr] saison ' + season + ' absente du site (dispos : ' +
                seasons.map(s => s.title).join(', ').slice(0, 120) + ')');
            return null;
        }
        seasonId = target.id;
        // Saison ACTIVE : les épisodes sont dans la page elle-même.
        const eps = parseEpisodes(seriesHtml);
        const ep = pickEpisode(eps, season, episode);
        if (ep) return ep.link;
    }

    // Saison inactive (ou épisode absent du DOM) → AJAX getepisodes + nonce.
    const ajax = extractAjaxConfig(seriesHtml);
    if (!seasonId || !ajax || !ajax.nonce) {
        console.log('[wookafr] ni épisodes en page, ni AJAX complet (nonce/season_id)');
        return null;
    }
    let data;
    try {
        data = await fetchJson(origin + '/wp-admin/admin-ajax.php', {
            method: 'POST',
            body: { action: 'getepisodes', season_id: seasonId, nonce: ajax.nonce },
            timeout: TIMEOUTS.PAGE,
            headers: {
                ...HEADERS,
                Referer: card.page_url,
                Origin: origin,
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
            },
            signal: ctx.signal,
        });
    } catch (e) {
        console.warn('[wookafr] AJAX getepisodes échoué : ' + (e && e.message ? e.message : e));
        return null;
    }
    const ajaxHtml = data && data.data && data.data.html ? data.data.html : '';
    if (!ajaxHtml) {
        console.log('[wookafr] AJAX sans html (saison ' + season + ')');
        return null;
    }
    const eps = parseEpisodes(ajaxHtml);
    const ep = pickEpisode(eps, season, episode);
    if (!ep) {
        console.log('[wookafr] épisode ' + episode + ' absent (saison ' + season + ', ' +
            eps.length + ' épisodes servis)');
        return null;
    }
    return ep.link;
}

/** Épisodes d'une page/AJAX : div.itlep > a[href] (parseur pur). */
export function parseEpisodes(html) {
    if (!html) return [];
    const out = [];
    const seen = {};
    const markerRe = /class="[^"]*itlep[^"]*"/g;
    const markers = [];
    let m;
    while ((m = markerRe.exec(html)) !== null) markers.push(m);
    const chunks = [];
    for (let i = 0; i < markers.length; i++) {
        const start = markers[i].index;
        const end = i + 1 < markers.length ? markers[i + 1].index : Math.min(html.length, start + 4000);
        chunks.push(html.slice(start, end));
    }
    for (const chunk of chunks) {
        const lm = /<a[^>]+href=["']([^"']+)["']/.exec(chunk);
        if (!lm) continue;
        const href = lm[1];
        const em = EPISODE_URL_RE.exec(href);
        if (!em) continue;
        const key = href.replace(/\/+$/, '');
        if (seen[key]) continue;
        seen[key] = true;
        out.push({
            season: parseInt(em[1], 10),
            episode: parseInt(em[2], 10),
            link: /^https?:\/\//i.test(href) ? href : resolveHref(href, ''),
        });
    }
    return out;
}

function resolveHref(href, base) {
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('//')) return 'https:' + href;
    return href;
}

function pickEpisode(eps, season, episode) {
    for (const e of eps) {
        if (e.season === season && e.episode === episode) return e;
    }
    return null;
}

/** Config AJAX du thème : var sm_Public = {url, nonce} (JSON ou JS bare). */
export function extractAjaxConfig(html) {
    const m = SM_PUBLIC_RE.exec(String(html || ''));
    if (!m) return null;
    return { url: m[1], nonce: m[2] };
}

/* ───────────────────── embed lecteurvideo (sections OD) ────────────────── */

/**
 * Page (film ou épisode) → iframe lecteurvideo → TOUS les serveurs de
 * toutes les sections de langue. Retourne [{url, lang, host, priority}].
 */
export async function collectEmbedCandidates(ctx, pageHtml, siteOrigin) {
    const iframe = extractLecteurvideoIframe(pageHtml);
    if (!iframe) return [];
    const referer = siteOrigin + '/';
    let res;
    try {
        res = await fetchText(iframe, {
            timeout: TIMEOUTS.PAGE,
            headers: { ...HEADERS, Referer: referer, Origin: siteOrigin },
            signal: ctx.signal,
        });
    } catch (e) {
        console.warn('[wookafr] embed lecteurvideo injoignable : ' + (e && e.message ? e.message : e));
        return [];
    }
    if (!res.text || isCfBlock(res.text)) return [];
    return parseLecteurvideoServers(res.text);
}

function extractLecteurvideoIframe(html) {
    // 1) iframe lecteurvideo explicite ; 2) n'importe quelle iframe embed.
    const m1 = /<iframe[^>]+src=["'](https?:\/\/[^"']*lecteurvideo[^"']*)["']/i.exec(html);
    if (m1) return m1[1];
    const m2 = /<iframe[^>]+src=["'](https?:\/\/[^"']*\/embed[^"']*)["']/i.exec(html);
    if (m2 && !/youtube|youtu\.be|dailymotion/i.test(m2[1])) return m2[1];
    return null;
}

/** Décodage base64/-url (token showVideo) → URL http(s) ou null. */
export function decodeB64Url(token) {
    if (!token) return null;
    try {
        let s = String(token).trim().replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '=';
        const bin = base64Decode(s);
        let out = '';
        for (let i = 0; i < bin.length; i++) out += String.fromCharCode(bin[i]);
        // Décodage UTF-8 tolérant (encodeURIComponent trick, sans TextDecoder
        // garanti sur TV) — suffisant pour des URLs ASCII.
        try {
            out = decodeURIComponent(escape(out));
        } catch (e) {
            /* ASCII pur : garder out */
        }
        if (!/^https?:\/\//i.test(out)) return null;
        return out;
    } catch (e) {
        return null;
    }
}

function base64Decode(input) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const clean = String(input).replace(/[^A-Za-z0-9+/=]/g, '');
    const bytes = [];
    let buffer = 0, bits = 0;
    for (let i = 0; i < clean.length; i++) {
        const c = clean[i];
        if (c === '=') break;
        const v = chars.indexOf(c);
        if (v === -1) continue;
        buffer = (buffer << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((buffer >> bits) & 0xff);
        }
    }
    return bytes;
}

/**
 * Parseur pur (testé offline) : sections OD_* → candidats dédupliqués
 * triés par priorité host (gowaru parseLecteurVideoServers).
 */
export function parseLecteurvideoServers(embedHtml) {
    const html = String(embedHtml || '');
    if (!html) return [];

    const sections = [];
    const sectionRe = /class="OD\s+OD_([A-Za-z]+)[^"]*"/g;
    let m;
    while ((m = sectionRe.exec(html)) !== null) {
        sections.push({ lang: m[1].toUpperCase(), start: m.index });
    }
    for (let i = 0; i < sections.length; i++) {
        sections[i].end = i + 1 < sections.length ? sections[i + 1].start : html.length;
    }

    const candidates = [];
    for (const sec of sections) {
        const lang = LANG_SECTIONS[sec.lang];
        if (!lang) continue; // OD_down etc.
        const chunk = html.slice(sec.start, sec.end);
        const svRe = /showVideo\(\s*['"]([A-Za-z0-9+/=_-]+)['"]\s*(?:,\s*['"]?(\d+)['"]?)?\s*\)/g;
        let sm;
        while ((sm = svRe.exec(chunk)) !== null) {
            const url = decodeB64Url(sm[1]);
            if (!url) continue;
            const lower = url.toLowerCase();
            if (/\.(png|jpe?g|gif|webp|css|js)(\?|$)/i.test(lower)) continue;
            let priority = DEFAULT_PRIORITY;
            for (const [hint, p] of HOST_PRIORITY) {
                if (lower.indexOf(hint) !== -1) {
                    priority = p;
                    break;
                }
            }
            candidates.push({
                url: url,
                lang: lang,
                host: (url.match(/^https?:\/\/([^/]+)/) || [])[1] || 'lecteurvideo',
                priority: priority,
            });
        }
    }

    const seen = {};
    const deduped = [];
    for (const c of candidates.sort((a, b) => a.priority - b.priority)) {
        if (seen[c.url]) continue;
        seen[c.url] = true;
        deduped.push(c);
    }
    return deduped;
}

/** Interleave par langue VF > VOSTFR > VO puis priorité (gowaru). */
function interleaveByLang(candidates) {
    const byLang = { vf: [], vostfr: [], vo: [] };
    for (const c of candidates) {
        (byLang[c.lang] || byLang.vf).push(c);
    }
    const keys = ['vf', 'vostfr', 'vo'].filter(k => byLang[k].length);
    const ordered = [];
    let added = true;
    for (let i = 0; added; i++) {
        added = false;
        for (const k of keys) {
            if (byLang[k][i]) {
                ordered.push(byLang[k][i]);
                added = true;
            }
        }
    }
    return ordered;
}

/* ─────────────────────────────── helpers ───────────────────────────────── */

function stripTags(s) {
    return String(s || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
}

function isCfBlock(text) {
    if (!text || typeof text !== 'string') return false;
    return (
        text.indexOf('Just a moment') !== -1 ||
        text.indexOf('challenge-platform') !== -1 ||
        text.indexOf('cf-browser-verification') !== -1 ||
        text.indexOf('error code: 1010') !== -1 ||
        text.indexOf('error code: 1005') !== -1
    );
}

function buildHeaders(referer, ua) {
    const headers = {};
    if (referer) headers.Referer = referer;
    if (ua) headers['User-Agent'] = ua;
    return headers;
}
