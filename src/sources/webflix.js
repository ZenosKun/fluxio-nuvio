/**
 * Source Webflix — provider v3 (port du scraper Gowaru webflix.art, voie
 * mesurée la plus rapide : FastFlux direct en ~0,8 s).
 *
 * Périmètre : uniquement les voies résolues par tmdbId — zéro recherche par
 * titre, zéro risque de mauvais matching :
 *
 *   1. FastFlux  : /api/fastflux?type=movie|episode&tmdb_id=… (MP4 direct)
 *   2. Discovery : /api/series-season-discovery?tmdb_id=… (1 appel = tous
 *                  les épisodes, clé exacte « S-E »)
 *   3. Nexus     : lecteur « Nexus » du site (v3.1.15, api.moviez.ac) —
 *                  master HLS multi-variantes jusqu'à 1080p AVC ; la voie
 *                  qualité là où FastFlux plafonne souvent au 720p
 *   4. Embeds TMDB-only : Frembed (page → iframes → extracteurs d'hôtes
 *      locaux), Zenix/fluxora (flow SID/play dédié), Heiwastream, WWEmbed.
 *
 * La voie « search + fiches » de Gowaru est volontairement abandonnée :
 * elle duplique ce que le tier DLE fait mieux (recherche par titre avec
 * ancrage TMDB et garde-fous de matching).
 */

import { fetchText as coreFetchText, fetchJson, fetchBytes, resolveUrl } from '../utils/http.js';
import { resolveEmbeds, providerFromEmbedUrl } from '../hosts/index.js';
import { makeStream, composeTitle, qualityFromUrl } from '../core/stream.js';
import { bestHlsQuality, muxedVariantUrl } from '../core/verify.js';
import { mp4MaxHeight, mp4QualityLabel, bytesLookHtml, mp4MoovStartOffset } from '../utils/mp4.js';

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
const MAX_EMBEDS_TO_TRY = 5;
const MAX_STREAMS = 4;

const FLUXORA_ORIGIN = 'https://fluxora.sbs';

/** Lecteur « Nexus » du site (v3.1.15) : api.moviez.ac sert une HLS uqload-
 * family MULTI-VARIANTES (vérifié live Fall 2 : 664x360 / 1328x720 /
 * 1920x1040, tout en avc1 — la meilleure qualité du site, là où FastFlux
 * plafonne au 720p du MP4 direct). Le master VF déclare en plus des pistes
 * audio SÉPARÉES (EXT-X-MEDIA fr/en, mêmes symptômes écran-noir que les
 * embeds uqload) → même remède v3.1.14 : variante muxée française servie
 * dès la résolution. Le master VOSTFR (autre upload) est muxé simple. */
const MOVIEZ_ORIGIN = 'https://api.moviez.ac';

/* Frembed multi-domaines (v3.1.9) : l'API film.php/serie.php est vivante sur
 * plusieurs domaines (sonde live 2026-10-28 : .cyou 0,9 s / .bond 0,9 s /
 * .site 0,8 s — .best DNS mort, retiré). Le premier qui répond suffit : la
 * boucle d'embeds s'arrête dès MAX_STREAMS ; un domaine mort coûte son
 * timeout mais seulement si les précédents n'ont rien donné. */
const FREMBED_HOSTS = ['frembed.cyou', 'frembed.bond', 'frembed.site'];

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
    //    La langue vient du champ API + marqueurs d'URL (gowaru detectLangRaw).
    //    PAS de miroir VOSTFR en dur : gowaru substitue /animes/VF/→/VOSTFR/
    //    pour les animés, mais le CDN ne l'expose pas systématiquement
    //    (404 vérifié en live = panneau « lien ne fonctionne pas » chez
    //    l'utilisateur). La VOSTFR passe par le flow ZENIX réel ci-dessous
    //    (endpoints sources + play avec lang=vostfr — la voie du site).
    let directPushed = false; // un flux direct (VF/VO…) est déjà poussé
    if (isTv) {
        const disc = await discovery(ctx.tmdbId, cfg, signal);
        const entry = disc && disc[s + '-' + e];
        if (entry && entry.url && typeof entry.url === 'string') {
            console.log('[webflix] discovery direct S' + s + 'E' + e);
            const langKey = await langKeyFor(ctx, entry.url, entry.language);
            push(await directStream(ctx, entry.url, 'Discovery', langKey, e, entry.quality));
            directPushed = true;
        }
        if (!directPushed) {
            const ff = await fastfluxEpisode(ctx.tmdbId, s, e, cfg, signal);
            if (ff && ff.url) {
                console.log('[webflix] fastflux direct S' + s + 'E' + e);
                const langKey = await langKeyFor(ctx, ff.url, ff.language);
                push(await directStream(ctx, ff.url, 'FastFlux', langKey, e, ff.quality));
                directPushed = true;
            }
        }
    } else {
        const ff = await fastfluxMovie(ctx.tmdbId, cfg, signal);
        if (ff && ff.url) {
            console.log('[webflix] fastflux direct film');
            const langKey = await langKeyFor(ctx, ff.url, ff.language);
            push(await directStream(ctx, ff.url, 'FastFlux', langKey, 0, ff.quality));
            directPushed = true;
        }
    }

    // 2. Nexus VF (v3.1.15) — le meilleur lecteur du site, résolu par
    //    tmdbId : master multi-variantes jusqu'à 1080p AVC (FastFlux plafonne
    //    souvent au 720p). FinalizeStreams classe ensuite 1080p devant 720p.
    if (!shouldStop()) {
        const nx = await resolveNexus(ctx, 'vf');
        if (nx) {
            console.log('[webflix] nexus VF direct (' + (nx.quality || 'Auto (HLS)') + ')');
            push(nexusStream(ctx, nx, 'vf'));
            directPushed = true;
        }
    }

    // 3. Profil non-VF (préférence VOSTFR/VO) : les flux VF directs sont
    //    filtrés par finalizeStreams — sans Nexus VOSTFR la source resterait
    //    VIDE pour ce profil (bug latent du retour précoce film). La langue
    //    affichée reste celle que la page moviez a réellement servie.
    const prefIsVf = cfg.fallbackLangs[0] === 'vf';
    if (!prefIsVf && !shouldStop()) {
        const nx = await resolveNexus(ctx, 'vostfr');
        if (nx) {
            console.log('[webflix] nexus ' + nx.lang + ' direct (' + (nx.quality || 'Auto (HLS)') + ')');
            push(nexusStream(ctx, nx, nx.lang === 'vostfr' ? 'vostfr' : 'vf'));
        }
    }

    // Chemin rapide (film) : VF direct déjà poussé ET préférence VF → les
    // embeds VF n'apportent rien (Zenix : page Livewire non extractible +
    // H.265 à risque écran-noir ; Frembed : redirigé vers une SPA Next.js) —
    // on garde la voie mesurée la plus rapide. Tout autre profil (VOSTFR,
    // échec du direct) passe par les embeds ci-dessous comme avant.
    if (directPushed && prefIsVf && !isTv) return;

    if (shouldStop()) return;

    // 4. Embeds TMDB-only, résolus séquentiellement (arrêt via shouldStop).
    //    Un VF direct est déjà poussé (série) → ne chercher QUE du VOSTFR
    //    via Zenix lang=vostfr (la vraie voie du site, pas une route en dur).
    const vostfrOnly = directPushed;
    const embeds = buildTmdbEmbeds(ctx.tmdbId, isTv, s, e).filter(
        emb => (vostfrOnly ? emb.lang === 'vostfr' : true)
    );
    if (vostfrOnly) console.log('[webflix] direct VF poussé → embeds VOSTFR uniquement (Zenix lang=vostfr)');
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

/* ──────────────────────────── Nexus (moviez) ───────────────────────────── */

/** Query de l'API nexus-path (pur, testé) : kind=film|serie, tmdbId, lang,
 * season/episode seulement en série — exactement les paramètres du site. */
export function nexusQuery(kind, tmdbId, lang, season, episode) {
    let q =
        'kind=' + encodeURIComponent(kind) +
        '&tmdbId=' + encodeURIComponent(tmdbId) +
        '&lang=' + encodeURIComponent(lang);
    if (kind === 'serie') {
        q += '&season=' + (parseInt(season, 10) || 1) + '&episode=' + (parseInt(episode, 10) || 1);
    }
    return q;
}

/** Token lecture 15 min dans window.P2 = {"lang":…, "t":"…"} (pur, testé).
 *  Le payload décodé confirme le contexte : movie|tmdb|0|0|vf|horodatage. */
export function moviezToken(html) {
    const m = /window\.P2\s*=\s*\{[^}]*?"t"\s*:\s*"([A-Za-z0-9._-]{40,300})"/.exec(String(html || ''));
    return m ? m[1] : '';
}

/** Langue réellement servie par la page moviez (champ lang de window.P2) —
 *  la réponse fait foi, comme zenixLangTag. */
export function moviezLang(html) {
    const m = /window\.P2\s*=\s*\{[^}]*?"lang"\s*:\s*"([a-zA-Z]{1,10})"/.exec(String(html || ''));
    const l = String((m && m[1]) || '').toLowerCase();
    if (l.indexOf('vostfr') !== -1) return 'vostfr';
    return 'vf';
}

/**
 * Lecteur « Nexus » du site (v3.1.15) — la voie qualité, là où FastFlux
 * plafonne souvent au 720p du MP4 direct :
 *
 *   1. GET /api/player-embed/nexus-path?kind=film|serie&tmdbId=…&lang=…
 *      → {url:"/api/v/n/<jeton>"} (le site valide ^\/api\/v\/[a-z]\/[A-Za-z0-9_-]+$)
 *   2. GET webflix.art/api/v/n/<jeton> → 302 vers api.moviez.ac/{tmdb}
 *      (série : /serie/{tmdb}/{s}/{e}) — le fetch suit la redirection.
 *   3. La page player embarque window.P2 = {lang, subs, t} : jeton POST
 *      valable 15 min.
 *   4. POST api.moviez.ac/api/v2/stream {t} → {hls:"…master.m3u8?…"}.
 *
 * Le master est une HLS uqload-family : VF → variante muxée française servie
 * dès la résolution (remède anti écran-noir v3.1.14, cf. uqloadMuxedSwap) ;
 * VOSTFR → master muxé simple conservé.
 * @returns {Promise<{url: string, quality: string, lang: string}|null>}
 */
async function resolveNexus(ctx, langKey) {
    const { signal, shouldStop } = ctx;
    const isTv = ctx.mediaType === 'tv';
    try {
        // 1. Chemin du lecteur Nexus pour ce titre/langue.
        const np = await fetchJson(
            SITE + '/api/player-embed/nexus-path?' +
                nexusQuery(isTv ? 'serie' : 'film', ctx.tmdbId, langKey, ctx.season, ctx.episode),
            { timeout: 6000, headers: HEADERS, signal: signal }
        );
        const path = np && typeof np.url === 'string' ? np.url : '';
        if (!/^\/api\/v\/[a-z]\/[A-Za-z0-9_-]+$/.test(path)) return null;
        if (shouldStop()) return null;

        // 2. Page du player (302 Location: api.moviez.ac/…, suivie par fetch).
        const page = await coreFetchText(SITE + path, {
            timeout: 7000,
            headers: { ...HEADERS, Accept: 'text/html,*/*', Referer: SITE + '/' },
            signal: signal,
        });
        const html = String((page && page.text) || '');
        const token = moviezToken(html);
        if (!token) return null;
        const servedLang = moviezLang(html);
        if (shouldStop()) return null;

        // 3. Lien HLS (valable 15 min — consommé immédiatement).
        const play = await fetchJson(MOVIEZ_ORIGIN + '/api/v2/stream', {
            method: 'POST',
            timeout: 6000,
            headers: {
                ...HEADERS,
                Referer: (page && page.finalUrl) || MOVIEZ_ORIGIN + '/',
                Origin: MOVIEZ_ORIGIN,
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: { t: token },
            signal: signal,
        });
        const hls = play && typeof play.hls === 'string' ? play.hls : '';
        if (!/^https:\/\//i.test(hls) || !/\.m3u8(\?|$)|\.mp4(\?|$)/i.test(hls)) return null;
        if (shouldStop()) return null;

        // 4. VF : le master déclare des pistes audio séparées (EXT-X-MEDIA) →
        //    variante muxée française DÈS la résolution (anti écran-noir).
        let url = hls;
        let quality = '';
        if (/\.m3u8(\?|$)/i.test(hls)) {
            const swap = await nexusMuxedSwap(hls, servedLang, signal);
            if (swap) {
                url = swap.url;
                quality = swap.quality;
            }
        }
        return { url: url, quality: quality, lang: servedLang };
    } catch (e) {
        return null; // lecteur indisponible pour ce titre : FastFlux/embeds suffisent
    }
}

/** Échange master → variante muxée de la langue (même contrat que
 *  uqloadMuxedSwap, hosts/index.js — le master Nexus est de la même famille
 *  uqload : EXT-X-MEDIA fr/en + variantes index-vN-aN.m3u8). Conservateur :
 *  master conservé au moindre doute. @returns {Promise<{url,quality}|null>} */
async function nexusMuxedSwap(masterUrl, language, signal) {
    const readHeaders = {
        Referer: MOVIEZ_ORIGIN + '/',
        'User-Agent': HEADERS['User-Agent'],
        Accept: '*/*',
    };
    let masterText = '';
    let finalUrl = masterUrl;
    try {
        const m = await coreFetchText(masterUrl, {
            timeout: 3500,
            headers: readHeaders,
            signal: signal,
        });
        masterText = String((m && m.text) || '');
        finalUrl = (m && m.finalUrl) || masterUrl;
    } catch (e) {
        return null; // master injoignable ici : la sonde tranchera sur le lien
    }
    if (masterText.indexOf('#EXTM3U') === -1) return null;
    const swapUri = muxedVariantUrl(masterText, String(language || '').toUpperCase());
    if (!swapUri) return null;
    const muxUrl = resolveUrl(finalUrl, swapUri);
    try {
        const v = await coreFetchText(muxUrl, {
            timeout: 2500,
            headers: readHeaders,
            signal: signal,
        });
        // La variante doit être une playlist média triviale (segments) — pas
        // une page HTML ni un master : c'est TOUT le but de l'échange.
        if (!/#EXTINF/i.test(String((v && v.text) || ''))) return null;
    } catch (e) {
        return null; // variante injoignable ici : master conservé
    }
    console.log('[webflix] nexus : variante muxée servie dès la résolution (anti écran-noir, ' +
        String(language || '').toUpperCase() + ') : ' + muxUrl);
    return { url: muxUrl, quality: bestHlsQuality(masterText) };
}

/** Flux direct Nexus (HLS uqload-family). Referer moviez : contexte exact du
 *  player du site (le CDN le tolère aussi absent — vérifié live). */
function nexusStream(ctx, nx, langKey) {
    return makeStream({
        title: composeTitle({
            site: 'Webflix',
            episode: ctx.mediaType === 'tv' ? (parseInt(ctx.episode, 10) || 0) : 0,
            host: 'Nexus',
            url: nx.url,
            lang: langLabel(nx.lang === 'vostfr' ? 'vostfr' : langKey),
        }),
        url: nx.url,
        quality: nx.quality || 'Auto (HLS)',
        language: langLabel(nx.lang === 'vostfr' ? 'vostfr' : langKey),
        headers: {
            'User-Agent': HEADERS['User-Agent'],
            Accept: '*/*',
            Referer: MOVIEZ_ORIGIN + '/',
        },
        _langKey: nx.lang === 'vostfr' ? 'vostfr' : langKey,
        _site: 'webflix',
    });
}

/* ────────────────────────── Embeds TMDB-only ───────────────────────────── */

/** Pages embed résolues par tmdbId (Gowaru buildTmdbEmbeds, port épuré).
 *
 * N'ont PAS survécu à l'audit des fixtures (tests/test_fixtures.mjs) :
 *   - Heiwastream : SPA, player construit en JS — non extractible statiquement
 *   - WWEmbed     : méta-page multi-niveaux (chaque candidate exige encore un
 *     fetch + parsing dédié) — ratio coût/résultat nul
 * → Zenix d'abord (flow dédié, le plus fiable), puis Frembed (multi-domaines
 * v3.1.9 : .cyou principal, .bond/.site replis — voir FREMBED_HOSTS). Un
 * embed mort ne doit jamais coûter ses 10 s en début de chaîne. */
function buildTmdbEmbeds(tmdbId, isTv, s, e) {
    const id = encodeURIComponent(tmdbId);
    const out = [];
    if (!isTv) {
        out.push({ url: 'https://fluxora.sbs/embed/zenix?tmdb=' + id + '&type=movie&season=&episode=&lang=vf', lang: 'vf', source: 'Zenix' });
        out.push({ url: 'https://fluxora.sbs/embed/zenix?tmdb=' + id + '&type=movie&season=&episode=&lang=vostfr', lang: 'vostfr', source: 'Zenix' });
        for (const host of FREMBED_HOSTS) {
            out.push({ url: 'https://' + host + '/api/film.php?id=' + id, lang: 'vf', source: 'Frembed' });
        }
    } else {
        out.push({ url: 'https://fluxora.sbs/embed/zenix?tmdb=' + id + '&type=tv&season=' + s + '&episode=' + e + '&lang=vf', lang: 'vf', source: 'Zenix' });
        out.push({ url: 'https://fluxora.sbs/embed/zenix?tmdb=' + id + '&type=tv&season=' + s + '&episode=' + e + '&lang=vostfr', lang: 'vostfr', source: 'Zenix' });
        for (const host of FREMBED_HOSTS) {
            out.push({ url: 'https://' + host + '/api/serie.php?id=' + id + '&sa=' + s + '&ep=' + e, lang: 'vf', source: 'Frembed' });
        }
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
            push(await directStream(ctx, u, emb.source, emb.lang, ctx.mediaType === 'tv' ? ctx.episode : 0));
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
                    language: emb.lang, // v3.1.14 : anti-écran-noir uqload au niveau résolveur
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
                        // v3.1.14 : qualité lue dans le master au swap muxé uqload
                        quality: r.quality || (/\.m3u8(\?|$)/i.test(String(r.url || '')) ? 'Auto (HLS)' : 'Direct'),
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
        // Gowaru zenixSources : l'API expose les sources DISPONIBLES par
        // langue (s2 absent, s3 à tester…). Sans elle, un play « meilleur
        // choix » peut viser une source absente → stream_url mort. On liste
        // les IDs sélectionnables et on tente le meilleur + 2e (early-exit
        // gowaru : selectable !== false && available !== false).
        const attempts = [undefined]; // undefined = choix par défaut de l'API
        try {
            const src = await fetchJson(
                FLUXORA_ORIGIN + '/api/embed-player/sources?sid=' + encodeURIComponent(sid) +
                    '&lang=' + encodeURIComponent(langParam),
                {
                    timeout: 10000,
                    headers: { ...HEADERS, Referer: emb.url, Origin: FLUXORA_ORIGIN, Accept: 'application/json' },
                    signal: signal,
                }
            );
            const choices = src && Array.isArray(src.sources)
                ? src.sources
                : src && Array.isArray(src.choices)
                    ? src.choices
                    : [];
            for (const c of choices) {
                if (c && c.id && c.selectable !== false && c.available !== false && c.status !== 'absent') {
                    if (attempts.indexOf(String(c.id)) === -1 && attempts.length < 3) attempts.push(String(c.id));
                }
            }
        } catch (e) { /* liste indisponible → tentatives par défaut */ }

        let count = 0;
        for (const sourceId of attempts) {
            if (shouldStop() || count >= MAX_STREAMS) break;
            let play = null;
            try {
                const body = { sid: sid, lang: langParam, embed_mobile: 0 };
                if (sourceId) body.source = sourceId;
                play = await fetchJson(FLUXORA_ORIGIN + '/api/embed-player/play', {
                    method: 'POST',
                    timeout: 10000,
                    headers: {
                        ...HEADERS,
                        Referer: emb.url,
                        Origin: FLUXORA_ORIGIN,
                        'Content-Type': 'application/json',
                    },
                    body: body,
                    signal: signal,
                });
            } catch (e) {
                play = null;
            }
            if (!play || play.ok !== true || !play.stream_url) continue;
            if (shouldStop()) break;

            // Gowaru zenixLangTag : la RÉPONSE fait foi (play.lang) — ne pas
            // afficher « VOSTFR » pour un flux que l'API a servi en VF.
            const langTag = zenixLangTag(play.lang, langParam);

            // stream_url parfois directement jouable (HLS /v1/ pré-tokenisé).
            if (/\.m3u8(\?|$)/i.test(play.stream_url) || /\.mp4(\?|$)/i.test(play.stream_url) ||
                /^https:\/\/stream\.fluxora\.sbs\/v1\//i.test(play.stream_url)) {
                push(await directStream(ctx, play.stream_url, 'Zenix', langTag, ctx.mediaType === 'tv' ? ctx.episode : 0));
                count++;
                continue;
            }

            const pageRes = await coreFetchText(play.stream_url, {
                timeout: TIMEOUTS.EMBED,
                headers: { ...HEADERS, Accept: 'text/html,*/*', Referer: emb.url },
                signal: signal,
            });
            const playerHtml = pageRes.text;
            if (!playerHtml || isCfBlock(playerHtml)) continue;

            const urls = extractStreamUrls(playerHtml, play.stream_url);
            for (const u of urls) {
                if (count >= MAX_STREAMS || shouldStop()) break;
                if (/\.m3u8(\?|$)/i.test(u) || /\.mp4(\?|$)/i.test(u) ||
                    /^https:\/\/stream\.fluxora\.sbs\/v1\//i.test(u)) {
                    push(await directStream(ctx, u, 'Zenix', langTag, ctx.mediaType === 'tv' ? ctx.episode : 0));
                    count++;
                }
                // Les iframes Zenix pointent des hosts hors de notre gamme : skip.
            }
        }
        return count;
    } catch (e) {
        return 0;
    }
}

/** Gowaru zenixLangTag : la langue renvoyée par l'API play fait foi. */
function zenixLangTag(playLang, requested) {
    const l = String(playLang || requested || '').toLowerCase();
    if (l.indexOf('vostfr') !== -1) return 'vostfr';
    if (l === 'vf' || l === 'fr') return 'vf';
    if (l === 'vo') return 'vo';
    return String(requested || 'vf').toLowerCase();
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

function langLabel(key) {
    return key === 'vostfr' ? 'VOSTFR' : key === 'vo' ? 'VO' : 'VF';
}

function buildHeaders(referer, ua) {
    const headers = {};
    if (referer) headers.Referer = referer;
    if (ua) headers['User-Agent'] = ua;
    return headers;
}

/** Qualité réelle d'un MP4 direct, lue à la RÉSOLUTION (v3.1.16) : moov/tkhd
 * du conteneur via GET Range 128 Ko — Fall 2 : Fall-2-HD-2026.mp4 annonce
 * 1280×720 alors que l'API répond quality=Unknown et que l'URL ne porte
 * aucun motif.
 *
 * Pourquoi ICI et pas seulement dans la sonde de vérification : uqload et
 * Nexus fixent leur qualité à la résolution (bestHlsQuality) — le MP4
 * FastFlux dépendait à 100 % de la sonde (best-effort, budget partagé 8 s,
 * échéance 4 s/flux) : sur le device elle est parfois coupée avant d'avoir
 * sniffé → le flux restait étiqueté « Direct ». 2,5 s max, échec silencieux
 * → '' (on n'invente jamais de libellé). Exportée pour les tests (fetch mocké). */
export async function directMp4Quality(url) {
    const PROBE_MS = 2500;
    try {
        const res = await fetchBytes(url, {
            method: 'GET',
            headers: { Accept: '*/*', Referer: SITE + '/', Range: 'bytes=0-131071' },
            timeout: PROBE_MS,
        });
        const u8 = res.bytes;
        if (!u8 || !u8.length || bytesLookHtml(u8)) return '';
        const direct = mp4QualityLabel(mp4MaxHeight(u8));
        if (direct) return direct;
        // Moov non faststart : son début PILE après le mdat (v3.1.16) — le
        // moov d'un long métrage dépasse 1 Mo, la queue seule n'y arriverait pas.
        const moovStart = mp4MoovStartOffset(u8);
        if (moovStart >= 0) {
            try {
                const far = await fetchBytes(url, {
                    method: 'GET',
                    headers: {
                        Accept: '*/*',
                        Referer: SITE + '/',
                        Range: 'bytes=' + moovStart + '-' + (moovStart + 131071),
                    },
                    timeout: PROBE_MS,
                });
                const f8 = far.bytes;
                if (f8 && f8.length && !bytesLookHtml(f8)) {
                    return mp4QualityLabel(mp4MaxHeight(f8)) || '';
                }
            } catch (e) {
                /* silencieux : pas de libellé */
            }
        }
        return '';
    } catch (e) {
        return '';
    }
}

/** Flux direct FastFlux/Discovery/Zenix (mp4 ou HLS servi pré-tokenisé).
 *
 * Headers de lecture OBLIGATOIRES (v3.1.7, diagnostic buffering infini) : le
 * proxy FastFlux (falzey.lol/api/video_proxy.php) renvoie une 302 vers
 * Telegram/HTML sans Referer webflix.art — avec, il sert le vrai MP4 signé
 * (?ff=…). Le lecteur natif Nuvio applique ces en-têtes tels quels.
 *
 * Qualité (v3.1.8) : champ API du payload Discovery/FastFlux s'il est parlant
 * (« Unknown » ignoré), sinon motif dans l'URL, sinon libellé technique —
 * v3.1.16 : un libellé générique sur un MP4 direct déclenche la lecture du
 * moov/tkhd (directMp4Quality) AVANT de retomber sur « Direct ».
 * @param {string} apiQuality champ « quality » de l'API (peut être Unknown)
 */
async function directStream(ctx, url, source, langKey, episode, apiQuality) {
    const kind = /\.m3u8(\?|$)/i.test(String(url || '')) ? 'HLS' : 'MP4';
    let quality = realQuality(apiQuality, url, kind);
    if (quality === 'Direct') {
        const q = await directMp4Quality(url);
        if (q) quality = q;
    }
    return makeStream({
        title: composeTitle({
            site: 'Webflix',
            episode: parseInt(episode, 10) || 0,
            host: source,
            url: url,
            lang: langLabel(langKey),
        }),
        url: url,
        quality: quality,
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

/** Qualité affichée : champ API parlant d'abord, sinon motif URL, sinon défaut. */
function realQuality(apiQuality, url, kind) {
    const api = String(apiQuality || '').trim();
    if (api && !/^unknown$/i.test(api)) return api;
    const q = qualityFromUrl(url);
    if (q) return q;
    return kind === 'HLS' ? 'Auto (HLS)' : 'Direct';
}

