/**
 * Source Webflix — provider v3 (port du scraper Gowaru webflix.art, voie
 * mesurée la plus rapide : FastFlux direct en ~0,8 s).
 *
 * Périmètre retenu pour la v3 : uniquement les voies résolues par tmdbId —
 * zéro recherche par titre, zéro risque de mauvais matching :
 *
 *   1. FastFlux  : /api/fastflux?type=movie|episode&tmdb_id=… (MP4 direct)
 *   2. Discovery : /api/series-season-discovery?tmdb_id=… (1 appel = tous
 *                  les épisodes, clé exacte « S-E »)
 *   3. Embeds TMDB-only : Frembed (page → iframes → extracteurs d'hôtes
 *      locaux), Zenix/fluxora (flow SID/play dédié), Heiwastream, WWEmbed.
 *
 * La voie « search + fiches » de Gowaru est volontairement abandonnée :
 * elle duplique ce que le tier DLE fait mieux (recherche par titre avec
 * ancrage TMDB et garde-fous de matching).
 */

import { fetchText as coreFetchText, fetchJson, resolveUrl } from '../utils/http.js';
import { resolveEmbeds, providerFromEmbedUrl } from '../hosts/index.js';
import { makeStream, composeTitle } from '../core/stream.js';

const SITE = 'https://webflix.art';

const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    Origin: SITE,
    Referer: SITE + '/',
};

const TIMEOUTS = { FASTFLUX: 10000, DISCOVERY: 12000, EMBED: 10000 };
const MAX_EMBEDS_TO_TRY = 4;
const MAX_STREAMS = 4;

const FLUXORA_ORIGIN = 'https://fluxora.sbs';

export default {
    id: 'webflix',
    label: 'Webflix',
    needsMeta: false, // tout est résolu par tmdbId
    async run(ctx) {
        try {
            await run(ctx);
        } catch (err) {
            console.warn('[webflix] échoué : ' + (err && err.message ? err.message : err));
        }
    },
};

async function run(ctx) {
    const { cfg, signal, push, shouldStop } = ctx;
    const isTv = ctx.mediaType === 'tv';
    const s = parseInt(ctx.season, 10) || 1;
    const e = parseInt(ctx.episode, 10) || 1;

    // 1. FastFlux / Discovery — MP4/HLS direct, le chemin le plus rapide.
    if (isTv) {
        const disc = await discovery(ctx.tmdbId, cfg, signal);
        const entry = disc && disc[s + '-' + e];
        if (entry && entry.url && typeof entry.url === 'string') {
            console.log('[webflix] discovery direct S' + s + 'E' + e);
            const langKey = await langKeyFor(ctx, entry.url, entry.language);
            push(directStream(ctx, entry.url, 'Discovery', langKey, e));
            // Miroir VOSTFR (CDN mongo-loko) : animés uniquement (chemin /animes/).
            if (String(entry.url).indexOf('/animes/VF/') !== -1) {
                const vost = buildVostfrMirror(entry.url);
                if (vost) push(directStream(ctx, vost, 'Discovery', 'vostfr', e));
            }
            return;
        }
        const ff = await fastfluxEpisode(ctx.tmdbId, s, e, cfg, signal);
        if (ff && ff.url) {
            console.log('[webflix] fastflux direct S' + s + 'E' + e);
            const langKey = await langKeyFor(ctx, ff.url, ff.language);
            push(directStream(ctx, ff.url, 'FastFlux', langKey, e));
            if (String(ff.url).indexOf('/animes/VF/') !== -1) {
                const vost = buildVostfrMirror(ff.url);
                if (vost) push(directStream(ctx, vost, 'FastFlux', 'vostfr', e));
            }
            return;
        }
    } else {
        const ff = await fastfluxMovie(ctx.tmdbId, cfg, signal);
        if (ff && ff.url) {
            console.log('[webflix] fastflux direct film');
            const langKey = await langKeyFor(ctx, ff.url, ff.language);
            push(directStream(ctx, ff.url, 'FastFlux', langKey, 0));
            return;
        }
    }

    if (shouldStop()) return;

    // 2. Embeds TMDB-only, résolus séquentiellement (arrêt via shouldStop).
    const embeds = buildTmdbEmbeds(ctx.tmdbId, isTv, s, e);
    let count = 0;
    let attempts = 0;
    for (const emb of embeds) {
        if (shouldStop() || count >= MAX_STREAMS || attempts >= MAX_EMBEDS_TO_TRY) break;
        attempts++;
        try {
            if (emb.url.indexOf('fluxora.sbs/embed/zenix') !== -1) {
                count += await resolveZenix(ctx, emb, push);
            } else {
                count += await resolveEmbedPage(ctx, emb, push);
            }
        } catch (err) {
            console.log(
                '[webflix] ' + emb.source + ' échoué : ' +
                    (err && err.message ? err.message : err)
            );
        }
    }
}

/* ─────────────────────────── FastFlux / Discovery ──────────────────────── */

async function fastfluxMovie(tmdbId, cfg, signal) {
    try {
        const data = await fetchJson(
            SITE + '/api/fastflux?type=movie&tmdb_id=' + encodeURIComponent(tmdbId),
            { timeout: TIMEOUTS.FASTFLUX, headers: HEADERS, signal: signal }
        );
        if (!data || data.success !== true || data.available !== true) return null;
        return data.data && data.data.url ? data.data : null;
    } catch (e) {
        return null;
    }
}

async function fastfluxEpisode(tmdbId, season, episode, cfg, signal) {
    try {
        const data = await fetchJson(
            SITE + '/api/fastflux?type=episode&tmdb_id=' + encodeURIComponent(tmdbId) +
                '&season=' + season + '&episode=' + episode,
            { timeout: TIMEOUTS.FASTFLUX, headers: HEADERS, signal: signal }
        );
        if (!data || data.success !== true || data.available !== true) return null;
        return data.data && data.data.url ? data.data : null;
    } catch (e) {
        return null;
    }
}

async function discovery(tmdbId, cfg, signal) {
    try {
        const data = await fetchJson(
            SITE + '/api/series-season-discovery?tmdb_id=' + encodeURIComponent(tmdbId),
            { timeout: TIMEOUTS.DISCOVERY, headers: HEADERS, signal: signal }
        );
        if (!data || data.success !== true || !data.fastflux) return null;
        return data.fastflux;
    } catch (e) {
        return null;
    }
}

/* ────────────────────────── Embeds TMDB-only ───────────────────────────── */

/** Pages embed résolues par tmdbId (Gowaru buildTmdbEmbeds, port épuré).
 *
 * N'ont PAS survécu à l'audit des fixtures (tests/test_fixtures.mjs) :
 *   - Heiwastream : SPA, player construit en JS — non extractible statiquement
 *   - WWEmbed     : méta-page multi-niveaux (chaque candidate exige encore un
 *     fetch + parsing dédié) — ratio coût/résultat nul
 * → Zenix d'abord (flow dédié, le plus fiable), puis Frembed en dernier
 * (frembed.best : DNS mort à la capture ; frembed.cyou vivant). Un embed
 * mort ne doit jamais coûter ses 10 s en début de chaîne. */
function buildTmdbEmbeds(tmdbId, isTv, s, e) {
    const id = encodeURIComponent(tmdbId);
    const out = [];
    if (!isTv) {
        out.push({ url: 'https://fluxora.sbs/embed/zenix?tmdb=' + id + '&type=movie&season=&episode=&lang=vf', lang: 'vf', source: 'Zenix' });
        out.push({ url: 'https://fluxora.sbs/embed/zenix?tmdb=' + id + '&type=movie&season=&episode=&lang=vostfr', lang: 'vostfr', source: 'Zenix' });
        out.push({ url: 'https://frembed.cyou/api/film.php?id=' + id, lang: 'vf', source: 'Frembed' });
    } else {
        out.push({ url: 'https://fluxora.sbs/embed/zenix?tmdb=' + id + '&type=tv&season=' + s + '&episode=' + e + '&lang=vf', lang: 'vf', source: 'Zenix' });
        out.push({ url: 'https://fluxora.sbs/embed/zenix?tmdb=' + id + '&type=tv&season=' + s + '&episode=' + e + '&lang=vostfr', lang: 'vostfr', source: 'Zenix' });
        out.push({ url: 'https://frembed.cyou/api/serie.php?id=' + id + '&sa=' + s + '&ep=' + e, lang: 'vf', source: 'Frembed' });
    }
    return out;
}

/**
 * Résolution d'une page embed générique (Frembed, Heiwa, WWEmbed) :
 * HTML → URLs directes (.m3u8/.mp4) + iframes → extracteurs d'hôtes locaux.
 * @returns {Promise<number>} flux poussés
 */
async function resolveEmbedPage(ctx, emb, push) {
    const { cfg, signal, shouldStop } = ctx;
    let html;
    try {
        const res = await coreFetchText(emb.url, {
            timeout: TIMEOUTS.EMBED,
            headers: { ...HEADERS, Accept: 'text/html,*/*', Referer: SITE + '/' },
            signal: signal,
        });
        html = res.text;
    } catch (e) {
        return 0;
    }
    if (!html || isCfBlock(html)) return 0;

    const found = extractStreamUrls(html, emb.url);
    if (!found.length) return 0;

    // 1. URLs directes → flux immédiats.
    let count = 0;
    const iframes = [];
    for (const u of found) {
        if (shouldStop() || count >= MAX_STREAMS) break;
        if (/\.m3u8(\?|$)/i.test(u) || /\.mp4(\?|$)/i.test(u)) {
            push(directStream(ctx, u, emb.source, emb.lang, ctx.mediaType === 'tv' ? ctx.episode : 0));
            count++;
        } else if (providerFromEmbedUrl(u)) {
            iframes.push(u);
        }
    }

    // 2. Iframes vers nos hosts connus (uqload, vidzy, voe…) → extracteurs locaux.
    if (iframes.length && count < MAX_STREAMS && !shouldStop()) {
        const map = {};
        for (const u of iframes) {
            const p = providerFromEmbedUrl(u);
            if (p && !map[p]) map[p] = u;
        }
        if (Object.keys(map).length) {
            let resolved = [];
            try {
                resolved = await resolveEmbeds(map, {
                    timeout: 6000, // < échéance douce 9 s : un host qui pend ne mange pas la fenêtre
                    signal: signal,
                    maxResults: 2,
                    maxAttempts: 4,
                });
            } catch (e) {
                resolved = [];
            }
            for (const r of resolved) {
                if (count >= MAX_STREAMS) break;
                push(
                    makeStream({
                        title: composeTitle({
                            site: emb.source,
                            episode: ctx.mediaType === 'tv' ? (parseInt(ctx.episode, 10) || 0) : 0,
                            host: r.provider,
                            url: r.url,
                            lang: langLabel(emb.lang),
                        }),
                        url: r.url,
                        quality: /\.m3u8(\?|$)/i.test(String(r.url || '')) ? 'Auto (HLS)' : 'Direct',
                        language: langLabel(emb.lang),
                        headers: buildHeaders(r.referer, r.ua),
                        subtitles: (r.subtitles || []).map(sub => ({
                            url: sub.url,
                            title: sub.label || String(sub.lang || '').toUpperCase(),
                            lang: sub.lang || 'fre',
                        })),
                        _weakPlayer: r.weakPlayer === true,
                        _langKey: emb.lang,
                        _site: 'webflix',
                    })
                );
                count++;
            }
        }
    }
    return count;
}

/* ─────────────────────── Résolveur Zenix (fluxora) ─────────────────────── */

/**
 * Flow dédié Zenix : la page /embed/zenix expose `const SID = "…"`, puis
 * POST /api/embed-player/play {sid, lang} → {stream_url} → page player →
 * `urls=[…]` ou videoUrl en clair. (Le résolveur générique échoue ici.)
 * @returns {Promise<number>} flux poussés
 */
async function resolveZenix(ctx, emb, push) {
    const { cfg, signal, shouldStop } = ctx;
    try {
        const res = await coreFetchText(emb.url, {
            timeout: TIMEOUTS.EMBED,
            headers: { ...HEADERS, Accept: 'text/html,*/*', Referer: SITE + '/' },
            signal: signal,
        });
        const html = res.text;
        if (!html || isCfBlock(html)) return 0;
        const sid = (String(html).match(/const SID\s*=\s*"([^"]{4,80})"/) || [])[1];
        if (!sid) return 0;
        if (shouldStop()) return 0;

        const langParam = emb.lang === 'vostfr' ? 'vostfr' : 'vf';
        let play = null;
        try {
            play = await fetchJson(FLUXORA_ORIGIN + '/api/embed-player/play', {
                method: 'POST',
                timeout: 10000,
                headers: {
                    ...HEADERS,
                    Referer: emb.url,
                    Origin: FLUXORA_ORIGIN,
                    'Content-Type': 'application/json',
                },
                body: { sid: sid, lang: langParam, embed_mobile: 0 },
                signal: signal,
            });
        } catch (e) {
            play = null;
        }
        if (!play || play.ok !== true || !play.stream_url) return 0;
        if (shouldStop()) return 0;

        const pageRes = await coreFetchText(play.stream_url, {
            timeout: TIMEOUTS.EMBED,
            headers: { ...HEADERS, Accept: 'text/html,*/*', Referer: emb.url },
            signal: signal,
        });
        const playerHtml = pageRes.text;
        if (!playerHtml || isCfBlock(playerHtml)) return 0;

        const urls = extractStreamUrls(playerHtml, play.stream_url);
        let count = 0;
        for (const u of urls) {
            if (count >= MAX_STREAMS || shouldStop()) break;
            if (/\.m3u8(\?|$)/i.test(u) || /\.mp4(\?|$)/i.test(u)) {
                push(directStream(ctx, u, 'Zenix', emb.lang, ctx.mediaType === 'tv' ? ctx.episode : 0));
                count++;
            }
            // Les iframes Zenix pointent des hosts hors de notre gamme : skip.
        }
        return count;
    } catch (e) {
        return 0;
    }
}

/* ─────────────────────────────── helpers ───────────────────────────────── */

/**
 * Extraction des URLs de flux d'une page embed (port Gowaru
 * extractEmbedStreamUrls) : videoUrl JS, tableaux urls=[…], iframes, MP4/HLS
 * en clair.
 */
export function extractStreamUrls(html, baseUrl) {
    const out = [];
    const push2 = u => {
        if (!u || typeof u !== 'string') return;
        const clean = u.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
        if (/^https?:\/\//i.test(clean) && out.indexOf(clean) === -1) out.push(clean);
    };
    const raw = String(html || '');

    try {
        const m = raw.match(/videoUrl\s*=\s*(?:window\.ZenixCdnDirect\s*\?\s*window\.ZenixCdnDirect\.prepare\s*\(\s*)?"([^"]{20,600})"/i);
        if (m && /^https?:\/\//i.test(m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/'))) {
            push2(m[1]);
        }
    } catch (e) { /* ignore */ }
    try {
        const marker = 'stream.fluxora.sbs/v1/';
        let idx = raw.indexOf(marker);
        while (idx !== -1) {
            const start = raw.lastIndexOf('"', idx);
            const end = raw.indexOf('"', idx);
            if (start !== -1 && end !== -1 && end > idx + marker.length && end - start < 600) {
                const cleaned = raw
                    .slice(start + 1, end)
                    .replace(/\\u0026/g, '&')
                    .replace(/\\\//g, '/');
                if (/^https:\/\/stream\.fluxora\.sbs\/v1\/[^\s"]+$/.test(cleaned)) push2(cleaned);
            }
            idx = raw.indexOf(marker, idx + 1);
        }
    } catch (e) { /* ignore */ }
    try {
        const arrRe = /urls\s*=\s*\[([^\]]{0,4000})\]/g;
        let m;
        while ((m = arrRe.exec(raw)) !== null) {
            const qRe = /"((?:[^"\\]|\\.)*)"/g;
            let q;
            while ((q = qRe.exec(m[1])) !== null) push2(q[1]);
        }
    } catch (e) { /* ignore */ }
    try {
        const ifrRe = /<iframe[^>]+src=["']([^"']+)["']/gi;
        let m;
        while ((m = ifrRe.exec(raw)) !== null) {
            const src = m[1];
            if (src && !/^about:blank/i.test(src) && !/^javascript:/i.test(src) && !/^data:/i.test(src)) {
                try {
                    push2(resolveUrl(baseUrl, src));
                } catch (e) {
                    push2(src);
                }
            }
        }
    } catch (e) { /* ignore */ }
    try {
        const loose = raw.match(/https?:\/\/[^"'\\\s]+\.(?:m3u8|mp4)[^"'\\\s]*/gi) || [];
        for (const u of loose) push2(u);
    } catch (e) { /* ignore */ }
    return out;
}

function isCfBlock(text) {
    if (!text || typeof text !== 'string') return false;
    return (
        text.indexOf('Just a moment') !== -1 ||
        text.indexOf('challenge-platform') !== -1 ||
        text.indexOf('cf-browser-verification') !== -1 ||
        text.indexOf('error code: 1010') !== -1
    );
}

/**
 * Langue d'un flux FastFlux/Discovery : champ API explicite d'abord, sinon
 * chemins connus (/animes/VF/ → VF), sinon contenu original non-fr → VO
 * (le doublage d'un original non-fr est incertain), sinon VF.
 */
async function langKeyFor(ctx, url, apiLang) {
    const raw = String(apiLang || '').toUpperCase();
    if (raw.indexOf('VOSTFR') !== -1) return 'vostfr';
    if (raw === 'VF' || raw === 'FR') return 'vf';
    if (raw === 'VO' || raw === 'EN' || raw === 'ENGLISH') return 'vo';
    if (String(url).indexOf('/animes/VF/') !== -1) return 'vf';
    if (String(url).indexOf('/animes/VOSTFR/') !== -1) return 'vostfr';

    let meta = null;
    try {
        meta = await ctx.meta;
    } catch (e) {
        meta = null;
    }
    const orig = meta && meta.originalLanguage ? meta.originalLanguage : '';
    return orig && orig !== 'fr' ? 'vo' : 'vf';
}

/** Miroir VOSTFR du CDN (animés uniquement) — port Gowaru buildVostfrMirror. */
function buildVostfrMirror(url) {
    const vost = String(url || '').replace('/animes/VF/', '/animes/VOSTFR/');
    return vost !== url ? vost : null;
}

function langLabel(key) {
    return key === 'vostfr' ? 'VOSTFR' : key === 'vo' ? 'VO' : 'VF';
}

function buildHeaders(referer, ua) {
    const headers = {};
    if (referer) headers.Referer = referer;
    if (ua) headers['User-Agent'] = ua;
    return headers;
}

/** Flux direct FastFlux/Discovery/Zenix (mp4 ou HLS servi pré-tokenisé).
 *
 * Headers de lecture OBLIGATOIRES (v3.1.7, diagnostic buffering infini) : le
 * proxy FastFlux (falzey.lol/api/video_proxy.php) renvoie une 302 vers
 * Telegram/HTML sans Referer webflix.art — avec, il sert le vrai MP4 signé
 * (?ff=…). Le lecteur natif Nuvio applique ces en-têtes tels quels. */
function directStream(ctx, url, source, langKey, episode) {
    const kind = /\.m3u8(\?|$)/i.test(String(url || '')) ? 'HLS' : 'MP4';
    return makeStream({
        title: composeTitle({
            site: 'Webflix',
            episode: parseInt(episode, 10) || 0,
            host: source,
            url: url,
            lang: langLabel(langKey),
        }),
        url: url,
        quality: kind === 'HLS' ? 'Auto (HLS)' : 'Direct',
        language: langLabel(langKey),
        headers: {
            'User-Agent': HEADERS['User-Agent'],
            Accept: '*/*',
            'Accept-Language': HEADERS['Accept-Language'],
            Referer: SITE + '/',
        },
        _langKey: langKey,
        _site: 'webflix',
    });
}
