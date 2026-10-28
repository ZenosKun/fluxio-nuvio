/**
 * Routage des sources selon le type de contenu (port v3 de routeDleSites).
 *
 * Chaque source déclare une affinité par type de contenu :
 *   3 = spécialiste (la meilleure voie pour ce type)
 *   2 = généraliste actif (à lancer en première vague)
 *   1 = secours (seulement si la première vague n'a rien donné)
 *
 * C'est la généralisation du routage v2 (anime → French-Manga, films/séries
 * → FStream) à l'échelle de toutes les sources :
 *
 *   anime  : French-Manga (3) > Bflix/Webflix (2) > FStream/Papadustream (1)
 *   film   : FStream (3)      > Bflix/Webflix/Papa (2) > French-Manga (1)
 *   série  : FStream (3)      > Bflix/Webflix/Papa (2) > French-Manga (1)
 *
 * detectAnime désactivé → type « generic » : tout en première vague
 * (comportement v2), aucun site n'est écarté.
 */

export const CONTENT_KINDS = ['anime', 'movie', 'tv', 'generic'];

/** kind déduit de mediaType + classification TMDB. */
export function kindOf(mediaType, isAnimeHint) {
    if (isAnimeHint && mediaType === 'tv') return 'anime';
    return mediaType === 'tv' ? 'tv' : 'movie';
}

const AFFINITY = {
    'french-manga': { anime: 3, movie: 1, tv: 1, generic: 2 },
    fstream: { anime: 1, movie: 3, tv: 3, generic: 2 },
    bflix: { anime: 2, movie: 2, tv: 2, generic: 2 },
    papadustream: { anime: 1, movie: 2, tv: 2, generic: 2 },
    webflix: { anime: 2, movie: 2, tv: 2, generic: 2 },
    // v3.1.9 — FrenchStream : généraliste résolu par tmdbId (tier direct,
    // TTFB 0,29 s + xfsearch tagz exact → coûte 2-3 requêtes). WookaFR :
    // généraliste de recherche par titre (wave1 partout).
    'french-stream': { anime: 2, movie: 2, tv: 2, generic: 2 },
    wookafr: { anime: 2, movie: 2, tv: 2, generic: 2 },
};

/** Affinité d'une source pour un type (0 si inconnue). */
export function affinityOf(sourceId, kind) {
    const a = AFFINITY[sourceId];
    if (!a) return 2; // source inconnue du plan : active partout
    return a[kind] !== undefined ? a[kind] : 2;
}

/**
 * Plan de course pour un type de contenu.
 *
 * @param {string[]} sourceIds sources activées (après filtre utilisateur)
 * @param {string} kind 'anime' | 'movie' | 'tv' | 'generic'
 * @returns {{wave1: string[], wave2: string[]}}
 *   wave1 : à lancer dès que possible (parallèle sur Mobile, séquentiel TV)
 *   wave2 : secours — lancé seulement si la vague 1 n'a rien produit
 */
export function buildPlan(sourceIds, kind) {
    const ids = Array.isArray(sourceIds) ? sourceIds.slice() : [];
    if (!ids.length) return { wave1: [], wave2: [] };

    const scored = ids.map(id => ({ id, a: affinityOf(id, kind) }));
    scored.sort((x, y) => y.a - x.a); // stable pour les ids de même affinité

    const wave1 = scored.filter(x => x.a >= 2).map(x => x.id);
    const wave2 = scored.filter(x => x.a === 1).map(x => x.id);
    return { wave1, wave2 };
}
