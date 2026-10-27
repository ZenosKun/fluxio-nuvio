/**
 * Métadonnées TMDB (v3) : titres + année + classification, et identifiants
 * externes (IMDb) pour les sources qui indexent par IMDb (Papadustream).
 *
 * Nuvio ne transmet que le tmdbId ; la plupart des sources cherchent par
 * titre. On interroge TMDB (détails FR puis titres alternatifs) pour
 * construire une liste de variantes de titres à tester, la plus pertinente
 * en premier.
 *
 * La clé publique TMDB est la même que celle utilisée par l'écosystème
 * Nuvio/Stremio (8265bd…, clé de démonstration themoviedb.org).
 */

import { fetchJson, createTtlCache } from '../utils/http.js';
import { getSettingsRaw } from '../utils/settings.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';

// Clé publique de l'écosystème Nuvio/Stremio (démo themoviedb.org) : très
// répandue donc révocable. L'utilisateur peut en fournir une personnelle via
// le réglage tmdbKey (onSettings).
const TMDB_FALLBACK_KEY = '8265bd1679663a7ea12ac168da84d2e8';

function tmdbKey() {
    try {
        const s = getSettingsRaw();
        const k = String((s && s.tmdbKey) || '').trim();
        if (k) return k;
    } catch (e) {
        /* ignore */
    }
    return TMDB_FALLBACK_KEY;
}

// 2 h : une session de visionnage est bien plus courte ; les fiches TMDB sont
// stables, mais une fenêtre courte limite le coût mémoire et les staleness.
const META_TTL_MS = 2 * 60 * 60 * 1000;
const IMDB_TTL_MS = 24 * 60 * 60 * 1000;

const metaCache = createTtlCache(120);
const imdbCache = createTtlCache(120);

/**
 * @param {string|number} tmdbId
 * @param {string} mediaType 'movie' | 'tv'
 * @param {{timeout?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<{titles: string[], year: number, originalLanguage: string, isAnimeHint: boolean}>}
 */
export async function getTmdbMeta(tmdbId, mediaType, opts = {}) {
    const type = mediaType === 'tv' ? 'tv' : 'movie';
    const key = `tmdb:${type}:${tmdbId}`;

    const cached = metaCache.get(key);
    if (cached) return cached;

    const meta = { titles: [], year: 0, originalLanguage: '', isAnimeHint: false };
    const timeout = opts.timeout || 12000;

    const url =
        `${TMDB_BASE}/${type}/${encodeURIComponent(String(tmdbId))}` +
        `?api_key=${tmdbKey()}&language=fr-FR`;

    let details = null;
    try {
        details = await fetchJson(url, { timeout: timeout, signal: opts.signal });
    } catch (err) {
        // Le FR peut échouer (réseau, clé) : retente en langue par défaut.
        try {
            details = await fetchJson(
                `${TMDB_BASE}/${type}/${encodeURIComponent(String(tmdbId))}?api_key=${tmdbKey()}`,
                { timeout: timeout, signal: opts.signal }
            );
        } catch (err2) {
            console.error('[v3] TMDB injoignable: ' + (err2 && err2.message ? err2.message : err2));
            throw err2;
        }
    }

    if (!details) throw new Error('TMDB: aucune donnée pour ' + tmdbId);

    const frTitle = String(details.title || details.name || '').trim();
    const originalTitle = String(details.original_title || details.original_name || '').trim();
    const date = String(details.release_date || details.first_air_date || '');
    const year = parseInt(date.slice(0, 4), 10);
    meta.year = Number.isFinite(year) ? year : 0;
    meta.originalLanguage = String(details.original_language || '');

    // Heuristique anime : animation (id 16) + origine japonaise.
    // NB : l'endpoint détails expose `genres` ([{id, name}]) — `genre_ids`
    // n'existe que sur /discover.
    {
        const isAnim =
            Array.isArray(details.genres) && details.genres.some(g => g && g.id === 16);
        meta.isAnimeHint = isAnim && meta.originalLanguage === 'ja';
    }

    const titles = [];
    pushUnique(titles, frTitle);
    pushUnique(titles, originalTitle);

    // Titres alternatifs (utile : titres FR différents du title TMDB).
    try {
        const alt = await fetchJson(
            `${TMDB_BASE}/${type}/${encodeURIComponent(String(tmdbId))}/alternative_titles?api_key=${tmdbKey()}`,
            { timeout: timeout, signal: opts.signal }
        );
        const list = (alt && alt.results) || (alt && alt.titles) || [];
        for (const t of list.slice(0, 12)) {
            const iso = String(t.iso_3166_1 || '').toLowerCase();
            const title = String(t.title || '').trim();
            if (title && (iso === 'fr' || titles.length < 2)) pushUnique(titles, title);
        }
    } catch (e) {
        // Facultatif : on continue avec les titres déjà collectés.
    }

    meta.titles = titles.filter(Boolean);
    metaCache.set(key, meta, META_TTL_MS);
    return meta;
}

/**
 * Identifiant IMDb d'un contenu TMDB (external_ids) — Papadustream indexe
 * par IMDb. Renvoie '' si introuvable (jamais de throw : facultatif).
 */
export async function getImdbId(tmdbId, mediaType, opts = {}) {
    const type = mediaType === 'tv' ? 'tv' : 'movie';
    const key = `imdb:${type}:${tmdbId}`;
    const cached = imdbCache.get(key);
    if (cached !== null) return cached;

    const id = String(tmdbId || '');
    if (!id || !/^\d+$/.test(id)) {
        imdbCache.set(key, '', IMDB_TTL_MS);
        return '';
    }
    try {
        const data = await fetchJson(
            `${TMDB_BASE}/${type}/${id}/external_ids?api_key=${tmdbKey()}`,
            { timeout: opts.timeout || 12000, signal: opts.signal }
        );
        const imdb = data && typeof data.imdb_id === 'string' && /^tt\d+$/.test(data.imdb_id)
            ? data.imdb_id
            : '';
        imdbCache.set(key, imdb, IMDB_TTL_MS);
        return imdb;
    } catch (e) {
        imdbCache.set(key, '', IMDB_TTL_MS);
        return '';
    }
}

function pushUnique(arr, value) {
    const v = String(value || '').trim();
    if (v && arr.map(x => x.toLowerCase()).indexOf(v.toLowerCase()) === -1) arr.push(v);
}
