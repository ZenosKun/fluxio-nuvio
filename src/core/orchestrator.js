/**
 * Orchestrateur v3 — extractStreams(tmdbId, mediaType, season, episode).
 *
 * Principes :
 *   1. Chaque source est un module au contrat unique (registry.js) ; le
 *      noyau ne connaît ni leurs sites ni leurs protocoles.
 *   2. Les sources résolues par ID (BFlix, Webflix, Papadustream) démarrent
 *      IMMÉDIATEMENT — jamais en attente de la classification TMDB.
 *   3. Les sources de recherche par titre (FStream, French-Manga) attendent
 *      les métadonnées TMDB (partagées avec la classification : zéro requête
 *      en plus) et suivent le plan de routage par type de contenu
 *      (plan.js : anime → French-Manga, films/séries → FStream).
 *   4. Anti-blocage (stopper.js) : toutes les sources répondantes livrent
 *      TOUS leurs flux (une même source sert souvent plusieurs qualités du
 *      même titre) ; passé l'échéance douce (5 s) avec ≥1 flux, on rend —
 *      les sites bloqués ne pénalisent plus.
 *   5. Filets : seconde vague de recherche (sites écartés par le routage)
 *      si rien du tout, puis pont sestudio optionnel si configuré.
 *   6. Dégradation gracieuse : sur Mobile (setTimeout présent) la course
 *      anti-blocage et le parallélisme s'appliquent ; sur TV (fetch synchrone,
 *      pas de timer garanti) les tâches se sérialisent naturellement et les
 *      stops se font aux frontières de boucles (ctx.shouldStop).
 */

import { readConfig } from '../utils/settings.js';
import { setHttpDeadline } from '../utils/http.js';
import { verifyStreams } from './verify.js';
import { getTmdbMeta } from '../meta/tmdb.js';
import { rankCards } from '../utils/match.js';
import { resolveSources } from './registry.js';
import { buildPlan, kindOf } from './plan.js';
import { createStopper, raceEarlyExit, makeSourceShouldStop } from './stopper.js';
import { finalizeStreams, TEST_STREAMS } from './stream.js';
import * as bridge from '../bridge/sestudio.js';

/** Échéance douce : au-delà, 1 flux pertinent suffit à rendre (tunable
 * SCRAPER_SETTINGS.softMs, défaut 5 s — Nuvio attend la réponse complète
 * avant d'afficher et coupe selon son propre réglage de timeout : rester
 * court garantit que la réponse arrive à temps). */
const SOFT_MS = 5000;

/** Ordre de lancement du tier direct (coût réseau attendu croissant). */
const DIRECT_ORDER = { webflix: 1, bflix: 2, papadustream: 3 };

const LANG_KEY_BY_LABEL = { VF: 'vf', VOSTFR: 'vostfr', VO: 'vo' };

export async function extractStreams(tmdbId, mediaType, season, episode, options = {}) {
    const cfg = readConfig();
    const signal = options && options.signal ? options.signal : null;
    const started = Date.now();

    // Budget interne : à l'échéance on rend ce qui est déjà trouvé au lieu
    // de tout jeter (le provider garde en plus son filet de sécurité).
    // Le budget du réglage plafonne celui du provider (avant : le 60 s du
    // provider écrasait silencieusement le 25 s annoncé).
    const budgetMs =
        Number(options.budgetMs) > 0 ? Math.min(Number(options.budgetMs), cfg.budgetMs) : cfg.budgetMs;
    setHttpDeadline(started + budgetMs);
    const stopper = createStopper({
        startedAt: started,
        hardMs: budgetMs,
        softMs: Number(cfg.softMs) > 0 ? Number(cfg.softMs) : SOFT_MS,
    });

    // Collecte partagée : chaque flux y est poussé dès qu'il est disponible.
    const collected = options && Array.isArray(options.partial) ? options.partial : [];
    const push = st => {
        if (st && st.url) collected.push(st);
    };

    const sources = resolveSources(cfg);
    if (!sources.length) return [];

    const directSources = sources
        .filter(s => !s.needsMeta)
        .sort((a, b) => (DIRECT_ORDER[a.id] || 9) - (DIRECT_ORDER[b.id] || 9));
    const searchSources = sources.filter(s => s.needsMeta);

    /* Métadonnées TMDB partagées : titres (recherche) + classification
     * (routage). Une seule requête pour tout le monde. */
    const metaPromise = getTmdbMeta(tmdbId, mediaType, {
        timeout: cfg.timeoutMs,
        signal: signal,
    }).catch(() => null);

    const ctx = {
        tmdbId: tmdbId,
        mediaType: mediaType === 'tv' ? 'tv' : 'movie',
        season: season,
        episode: episode,
        cfg: cfg,
        signal: signal,
        push: push,
        // shouldStop vu des sources : budget dur, OU échéance douce atteinte
        // avec des résultats déjà suffisants (anti-blocage identique TV/Mobile).
        shouldStop: makeSourceShouldStop(stopper, collected, cfg),
        stopper: stopper,
        meta: metaPromise,
        started: started,
    };

    /* ── Tier direct : immédiat ──────────────────────────────────────────── */
    const directTask = launchAll(directSources, ctx, 'direct');

    /* ── Tier recherche : plan par type de contenu dès meta disponible ───── */
    let kind = cfg.detectAnime ? null : 'generic'; // null = attendre meta
    let plan = null;

    const searchTask = (async () => {
        if (!searchSources.length) return;
        if (kind === null) {
            const meta = await metaPromise;
            kind = kindOf(ctx.mediaType, !!(meta && meta.isAnimeHint));
        }
        plan = buildPlan(searchSources.map(s => s.id), kind);
        if (plan.wave1.length) {
            const label =
                kind === 'anime'
                    ? 'Animé'
                    : kind === 'generic'
                        ? 'Type inconnu (détection désactivée)'
                        : 'Film/série';
            console.log(
                '[core] ' + label + ' → recherche : ' +
                    plan.wave1.join(', ') +
                    (plan.wave2.length ? ' (secours : ' + plan.wave2.join(', ') + ')' : '')
            );
        }
        await launchAll(idsToSources(searchSources, plan.wave1), ctx, 'recherche');
    })();

    /* ── Course : anti-blocage (échéance douce), sinon tout attendre ─────── */
    const allDone = Promise.all([directTask, searchTask]).catch(() => null);
    let outcome = 'done';
    if (cfg.earlyExit) {
        outcome = await raceEarlyExit({
            stopper: stopper,
            collected: collected,
            cfg: cfg,
            allDone: allDone,
            onEnough: () =>
                console.log(
                    '[core] échéance douce atteinte → rendu à ' +
                        stopper.elapsedMs() +
                        'ms (les sources bloquantes ne retardent plus)'
                ),
        });
        if (outcome === 'budget') {
            console.warn('[core] budget atteint, rendu des résultats disponibles');
        }
    } else {
        await allDone;
    }

    /* ── Filet : rien du tout → seconde vague (sites écartés du routage) ─── */
    if (!collected.length && !stopper.shouldStop() && searchSources.length) {
        const meta = await metaPromise;
        if (meta) {
            if (!plan) {
                kind = cfg.detectAnime ? kindOf(ctx.mediaType, !!meta.isAnimeHint) : 'generic';
                plan = buildPlan(searchSources.map(s => s.id), kind);
            }
            if (plan.wave2.length) {
                console.log('[core] première vague sans résultat → secours : ' + plan.wave2.join(', '));
                await launchAll(idsToSources(searchSources, plan.wave2), ctx, 'secours');
            }
        }
    }

    /* ── Repli : pont sestudio si configuré, rien en direct, budget restant ─ */
    if (!collected.length && cfg.serverUrl && !stopper.shouldStop()) {
        console.log('[core] rien en direct → repli sur le serveur sestudio configuré');
        try {
            const got = await bridgeStreams(ctx);
            for (const st of got) push(st);
        } catch (err) {
            console.warn('[core] pont sestudio échoué : ' + (err && err.message ? err.message : err));
        }
    }

    let streams = finalizeStreams(collected, cfg);
    if (cfg.verifyLinks && streams.length) {
        try {
            streams = await verifyStreams(streams, { remainingMs: budgetMs - (Date.now() - started) });
        } catch (err) {
            console.warn('[verify] ignoré : ' + (err && err.message ? err.message : err));
        }
    }
    if (cfg.selfTest) {
        // Mode diagnostic : domaine du lien dans le nom + 2 flux publics de test en tête.
        streams = TEST_STREAMS.map(t => Object.assign({}, t)).concat(
            streams.map(st => {
                const m = /^https?:\/\/([^\/?#]+)/i.exec(String(st.url || ''));
                return Object.assign({}, st, { name: st.name + (m ? ' @' + m[1] : '') });
            })
        );
    }
    for (const st of streams) {
        // Diagnostic : visible dans la console de l'app (lancée depuis un terminal).
        console.log(
            '[stream] ' + st.name + ' | ' + st.quality + ' | ' + st.language + ' | ' + st.url +
                ' | headers=' + JSON.stringify(st.headers || {})
        );
    }
    console.log(
        '[core] Terminé : ' + streams.length + ' stream(s) en ' +
            (Date.now() - started) + 'ms' +
            (outcome === 'enough' ? ' (anti-blocage : échéance douce)' : '')
    );
    return streams;
}

/* ────────────────────────── lancement des sources ──────────────────────── */

/**
 * Lance des sources en parallèle (Mobile) — sur TV, les fetchs synchrones
 * sérialisent naturellement les tâches, l'ordre du tableau devient l'ordre
 * d'exécution. Chaque source est isolée : son échec n'affecte jamais les
 * autres.
 */
async function launchAll(providers, ctx, label) {
    const tasks = providers.map(p =>
        Promise.resolve()
            .then(() => p.run(ctx))
            .catch(err => {
                console.warn(
                    '[core] source ' + p.label + ' (' + label + ') échouée : ' +
                        (err && err.message ? err.message : err)
                );
            })
    );
    await Promise.all(tasks);
}

function idsToSources(sources, ids) {
    const byId = {};
    for (const s of sources) byId[s.id] = s;
    return ids.map(id => byId[id]).filter(Boolean);
}

/* ─────────────────────────── pont sestudio (repli) ─────────────────────── */

/**
 * Recherche + résolution via un serveur sestudio auto-hébergé (port v2).
 * Renvoie des flux internes annotés (_langKey déduit du libellé de langue).
 */
async function bridgeStreams(ctx) {
    const { cfg, signal } = ctx;
    const alive = await bridge.checkHealth(cfg.serverUrl, cfg.timeoutMs, signal);
    if (!alive) {
        console.error('[core] serveur sestudio injoignable sur ' + cfg.serverUrl);
        return [];
    }

    let meta;
    try {
        meta = await ctx.meta;
    } catch (e) {
        meta = null;
    }
    if (!meta || !meta.titles.length) return [];

    const isMovie = ctx.mediaType !== 'tv';
    const allCards = [];
    let confident = null;
    for (const query of meta.titles.slice(0, 3)) {
        let res;
        try {
            res = await bridge.search(cfg.serverUrl, query, cfg.sources, cfg.timeoutMs, signal);
        } catch (err) {
            continue;
        }
        for (const c of res.cards) allCards.push(c);
        const ranked = bridgeRank(allCards, meta, ctx.mediaType, ctx.season);
        if (ranked.length) {
            confident = ranked;
            if (ranked[0].score >= 95) break;
        }
    }
    if (!confident) return [];
    const threshold = Math.max(40, confident[0].score - 30);
    const ranked = confident.filter(r => r.score >= threshold);

    const streams = [];
    for (const cand of ranked.slice(0, 4)) {
        if (streams.length >= 2) break;
        try {
            const st = await resolveBridgeCard(ctx, cand.card, meta, isMovie);
            if (st) streams.push(st);
        } catch (err) {
            /* carte suivante */
        }
    }
    return streams;
}

function bridgeRank(cards, meta, mediaType, season) {
    // Même scoring que le mode direct (utils/match.js).
    return rankCards(cards, meta, mediaType, season);
}

async function resolveBridgeCard(ctx, card, meta, isMovie) {
    const { cfg, signal } = ctx;
    const triedLangs = [];
    const langsToTry = cfg.fallbackLangs.slice(0, cfg.allowOtherLang ? 3 : 1);

    for (const lang of langsToTry) {
        if (triedLangs.indexOf(lang) !== -1) continue;
        triedLangs.push(lang);

        let page;
        try {
            page = await bridge.season(cfg.serverUrl, card.page_url, lang, card.source, cfg.timeoutMs, signal);
        } catch (err) {
            continue;
        }
        const ep = bridgePickEpisode(page, isMovie, ctx.episode);
        if (!ep) {
            if (!isMovie) break;
            continue;
        }
        try {
            const resolved = await bridge.resolve(
                cfg.serverUrl, ep.embed_urls, card.source, cfg.timeoutMs, signal
            );
            if (!resolved) continue;
            const stream = bridge.toNuvioStream(resolved, card, ep, cfg.serverUrl, {
                useTranscode: cfg.useTranscode,
                lang: lang,
                sourceName: card.source,
                isFilm: isMovie || page.is_film,
            });
            if (!stream) continue;
            return {
                name: stream.name,
                title: stream.title,
                url: stream.url,
                quality: stream.quality,
                language: stream.language,
                headers: stream.headers,
                subtitles: stream.subtitles,
                _langKey: LANG_KEY_BY_LABEL[String(stream.language || '').toUpperCase()] || 'vo',
                _site: card.source,
            };
        } catch (err) {
            return null;
        }
    }
    return null;
}

function bridgePickEpisode(page, isMovie, episode) {
    const eps = (page.episodes || []).filter(
        e => e && e.embed_urls && Object.keys(e.embed_urls).length
    );
    if (!eps.length) return null;
    if (isMovie || page.is_film) return eps[0];
    const wanted = parseInt(episode, 10) || 0;
    if (wanted > 0) {
        const exact = eps.find(e => parseInt(e.number, 10) === wanted);
        if (exact) return exact;
    }
    return null;
}
