/**
 * Runner DLE : logique de recherche + résolution partagée par les deux
 * sources DLE-CMS (FStream, French-Manga). Chaque provider v3 appelle
 * runDleSite(ctx, siteId) — un site par provider, donc chaque site est
 * traité indépendamment avec sa propre meilleure carte (équivalent et plus
 * isolé que l'agrégation v2).
 *
 * Porté de sestudio-nuvio v2 (directDle + resolveCardDirect), éprouvé par
 * les suites e2e v2.x ; adaptations v3 : collecte immédiate via ctx.push
 * (anti-blocage), stops aux frontières de boucles (ctx.shouldStop), logs [dle].
 */

import { searchDle, fetchDlePage, DLE_SITES } from './dle-common.js';
import { rankCards } from '../utils/match.js';
import { resolveEmbeds } from '../hosts/index.js';
import { makeStream, composeTitle } from '../core/stream.js';

const MAX_CARDS_PER_SITE = 2;
const MIN_CARD_SCORE = 40;
/* 6 s par requête host : nettement sous l'échéance douce (9 s). Un host qui
 * pend (netu…) échoue vite et libère la fenêtre utile ; les hosts vivants
 * répondent en 2-4 s. Les hosts partent en parallèle de toute façon. */
const HOST_TIMEOUT_MS = 6000;
const MAX_STREAMS_PER_SITE = 3;

const LANG_LABELS = { vf: 'VF', vostfr: 'VOSTFR', vo: 'VO' };

/**
 * Recherche et résolution pour UN site DLE.
 * @param {object} ctx contexte orchestrateur (meta, cfg, signal, push…)
 * @param {string} siteId 'fstream' | 'french-manga'
 */
export async function runDleSite(ctx, siteId) {
    const { cfg, signal, push, shouldStop } = ctx;
    const site = DLE_SITES[siteId];
    if (!site) return;

    let meta;
    try {
        meta = await ctx.meta;
    } catch (e) {
        meta = null;
    }
    if (!meta || !meta.titles.length) {
        console.error(`[dle] ${siteId} : TMDB n'a fourni aucun titre, recherche impossible.`);
        return;
    }

    // 1. Recherche par variantes de titre, avec confiance croissante.
    let confident = null;
    const allCards = [];
    for (const query of meta.titles.slice(0, 2)) {
        if (shouldStop()) break;
        let cards = [];
        try {
            cards = await searchDle(siteId, query, { timeout: cfg.timeoutMs, signal: signal });
        } catch (err) {
            console.warn(
                `[dle] Recherche ${siteId} « ${query} » échouée : ` +
                    (err && err.message ? err.message : err)
            );
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
        console.log(`[dle] ${siteId} : aucune carte pour « ${meta.titles[0]} »`);
        return;
    }

    /* Numérotation absolue (animes) : les sites DLE découpent les longues
     * séries en « saisons » éditoriales portant une PLAGE d'épisodes
     * (« Saison 6 : Skypiea (144-195) »). Pour E1, ces cartes sont hors
     * sujet même à score de titre élevé : on les déclasse si l'épisode
     * demandé n'est pas dans la plage. Sans plage → neutre. */
    const wantedEp = parseInt(ctx.episode, 10) || 0;
    if (ctx.mediaType === 'tv' && wantedEp > 0) {
        confident = confident
            .map(r => {
                const range = /(\d{1,4})\s*[-–]\s*(\d{1,4})/.exec(r.card.title || '');
                if (range) {
                    const lo = parseInt(range[1], 10);
                    const hi = parseInt(range[2], 10);
                    if (wantedEp < lo || wantedEp > hi) {
                        return { card: r.card, score: r.score - 40 };
                    }
                }
                return r;
            })
            .sort((a, b) => b.score - a.score);
    }

    // 2. Les meilleures cartes de CE site (seuil relatif au top).
    const threshold = Math.max(MIN_CARD_SCORE, confident[0].score - 30);
    const bestCards = confident
        .filter(r => r.score >= threshold && r.card.source)
        .slice(0, MAX_CARDS_PER_SITE);
    if (!bestCards.length) return;

    console.log(
        `[dle] ${siteId} : « ${meta.titles[0]} » → ` +
            bestCards.map(r => `"${r.card.title}" (${r.score})`).join(', ')
    );

    // 3. Résolution des cartes (la première qui donne suffit à arrêter).
    const isMovie = ctx.mediaType !== 'tv';
    let streams = 0;
    for (const cand of bestCards) {
        if (shouldStop() || streams >= MAX_STREAMS_PER_SITE) break;
        try {
            const got = await resolveCard(ctx, siteId, cand.card, isMovie);
            streams += got.length;
        } catch (err) {
            console.warn(
                `[dle] Carte ${siteId} "${cand.card.title}" échouée : ` +
                    (err && err.message ? err.message : err)
            );
        }
    }
}

/**
 * Résolution d'une carte : page saison/film → épisode → extracteurs d'hôtes.
 * Chaîne de langues : préférée d'abord, secours si allowOtherLang.
 * @returns {Promise<number>} nombre de flux poussés
 */
async function resolveCard(ctx, siteId, card, isMovie) {
    const { cfg, signal, push, shouldStop } = ctx;
    const site = DLE_SITES[siteId] || { label: siteId };
    const langsToTry = cfg.fallbackLangs.slice(0, cfg.allowOtherLang ? 3 : 1);
    const tried = [];
    let count = 0;

    for (const lang of langsToTry) {
        if (shouldStop() || count >= MAX_STREAMS_PER_SITE) break;
        if (tried.indexOf(lang) !== -1) continue;
        tried.push(lang);

        let page;
        try {
            page = await fetchDlePage(siteId, card.page_url, lang, {
                timeout: cfg.timeoutMs,
                signal: signal,
            });
        } catch (err) {
            console.warn(
                `[dle] Page injoignable (${siteId}, lang=${lang}) : ` +
                    (err && err.message ? err.message : err)
            );
            continue;
        }

        const ep = pickEpisode(page, isMovie, ctx.episode);
        if (!ep || !ep.embed_urls || !Object.keys(ep.embed_urls).length) {
            // L'épisode existe sur le site mais pas dans cette langue (il est
            // listé sans embed) → on tente la langue suivante. S'il n'existe
            // pas du tout, inutile d'insister sur cette carte.
            if (episodeExistsInPage(page, isMovie, ctx.episode)) {
                const others = (pickAnyEpisode(page, isMovie, ctx.episode, true) || { langs: [] }).langs || [];
                for (const o of others) {
                    const l = String(o || '').toLowerCase();
                    if (l && langsToTry.indexOf(l) !== -1 && tried.indexOf(l) === -1) tried.push(l);
                }
                continue;
            }
            if (!isMovie && page.episodes && page.episodes.length) break;
            continue; // film : page vide dans cette langue
        }

        let resolved;
        try {
            resolved = await resolveEmbeds(ep.embed_urls, {
                timeout: HOST_TIMEOUT_MS,
                signal: signal,
                maxResults: 2,
                maxAttempts: 4,
            });
        } catch (err) {
            console.warn(
                `[dle] Résolution hosts échouée (${siteId} E${ep.number}) : ` +
                    (err && err.message ? err.message : err)
            );
            resolved = [];
        }
        if (!resolved.length) {
            // Langue suivante si l'épisode en annonce une autre.
            const others = (ep.langs || []).filter(
                l => langsToTry.indexOf(l) !== -1 && tried.indexOf(l) === -1
            );
            for (const o of others) tried.push(o);
            continue;
        }

        const epNumber = isMovie || !(ep.number > 0) ? 0 : ep.number;
        for (const r of resolved) {
            const langLabel = LANG_LABELS[lang] || String(lang).toUpperCase();
            push(
                makeStream({
                    title: composeTitle({ site: site.label || siteId, episode: epNumber, host: r.provider, url: r.url, lang: langLabel }),
                    url: r.url,
                    quality: /\.m3u8(\?|$)/i.test(String(r.url || '')) ? 'Auto (HLS)' : 'Direct',
                    language: langLabel,
                    headers: buildHeaders(r.referer, r.ua),
                    subtitles: (r.subtitles || []).map(sub => ({
                        url: sub.url,
                        title: sub.label || String(sub.lang || '').toUpperCase(),
                        lang: sub.lang || 'fre',
                    })),
                    _weakPlayer: r.weakPlayer === true,
                    _langKey: lang,
                    _site: siteId,
                })
            );
            count++;
        }
        if (count) break; // cette carte a donné : les autres langues inutiles
    }
    return count;
}

function buildHeaders(referer, ua) {
    const headers = {};
    if (referer) headers.Referer = referer;
    if (ua) headers['User-Agent'] = ua;
    return headers;
}

function pickEpisode(page, isMovie, episode) {
    const eps = (page.episodes || []).filter(
        e => e && e.embed_urls && Object.keys(e.embed_urls).length
    );
    if (!eps.length) return null;
    if (isMovie || page.is_film) return eps[0];

    const wanted = parseInt(episode, 10) || 0;
    if (wanted > 0) {
        const exact = eps.find(e => parseInt(e.number, 10) === wanted);
        if (exact) return exact;
        const loose = eps.find(e => {
            const n = parseFloat(e.number);
            return Number.isFinite(n) && Math.round(n) === wanted && Math.abs(n - wanted) < 1;
        });
        if (loose) return loose;
    }
    return null;
}

/** L'épisode demandé existe-t-il dans la page, même sans embed (autre langue) ? */
function episodeExistsInPage(page, isMovie, episode) {
    return pickAnyEpisode(page, isMovie, episode, false) !== null;
}

/**
 * Épisode correspondant, avec ou sans embeds.
 * @param {boolean} embedsOnly true = uniquement ceux qui ont des embeds
 */
function pickAnyEpisode(page, isMovie, episode, embedsOnly) {
    const eps = (page.episodes || []).filter(e => {
        if (!e) return false;
        if (embedsOnly) return e.embed_urls && Object.keys(e.embed_urls).length;
        return true;
    });
    if (!eps.length) return null;
    if (isMovie || page.is_film) return eps[0];
    const wanted = parseInt(episode, 10) || 0;
    if (wanted > 0) {
        const exact = eps.find(e => parseInt(e.number, 10) === wanted);
        if (exact) return exact;
        const loose = eps.find(e => {
            const n = parseFloat(e.number);
            return Number.isFinite(n) && Math.round(n) === wanted && Math.abs(n - wanted) < 1;
        });
        if (loose) return loose;
    }
    return null;
}
