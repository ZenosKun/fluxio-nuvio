/**
 * Appariement carte sestudio ↔ métadonnées TMDB.
 *
 * Les cartes renvoyées par /api/search portent : title, series_name,
 * season_number, is_film, year, source, page_url. On les note selon la
 * ressemblance du titre, la concordance d'année et de saison, puis on trie.
 */

/**
 * Normalisation tolérante : minuscules, sans accents, sans ponctuation,
 * espaces collapsés. try/catch : normalize() manque sur de vieux Hermes.
 */
export function normalizeTitle(s) {
    let out = String(s || '').toLowerCase();
    try {
        out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    } catch (e) {
        /* normalize indisponible : on garde la version brute */
    }
    out = out.replace(/&/g, ' et ');
    out = out.replace(/[^a-z0-9]+/g, ' ');
    return out.trim().replace(/\s+/g, ' ');
}

const SEASON_WORDS = /(?:\bseason\b|\bsaison\b|\bs\s?(?=\d))/i;

/** Retire un suffixe "Saison X" / "Season X" d'un titre. */
export function stripSeasonSuffix(title) {
    return String(title || '')
        .replace(new RegExp(SEASON_WORDS.source + '\\s*\\d+', 'gi'), '')
        .replace(/\s*[-–:]\s*$/, '')
        .trim();
}

function tokenSet(s) {
    const n = normalizeTitle(s);
    if (!n) return [];
    return n.split(' ');
}

/**
 * Score de ressemblance titre [0..100] : exact > préfixe > inclusion > Jaccard.
 *
 * Prudence homonymes : un préfixe ne vaut 85 qu'à la frontière d'un mot
 * (« one piece » ⊂ « one piece vostfr »). Un préfixe collé au milieu d'un
 * mot est un piège à homonymes — « naza » ⊂ « nazare » a servi un mauvais
 * titre (documentaire NAZA → télénovela Nazaré, cf. bug Gowaru) — il ne
 * compte que si le préfixe est assez long (≥ 6) pour ne pas être un hasard.
 */
export function titleScore(a, b) {
    const na = normalizeTitle(a);
    const nb = normalizeTitle(b);
    if (!na || !nb) return 0;
    if (na === nb) return 100;
    const short = na.length <= nb.length ? na : nb;
    const long = na.length <= nb.length ? nb : na;
    if (short.length >= 4) {
        if (long.startsWith(short)) {
            if (long.charAt(short.length) === ' ') return 85; // frontière de mot
            if (short.length >= 6) return 70; // préfixe collé long (ex. « naruto » ⊂ « narutoshippuden »)
            return 0; // préfixe collé court : trop hasardeux
        }
        if (short.length >= 6 && long.indexOf(short) !== -1) return 70; // inclusion
    }
    const ta = tokenSet(a);
    const tb = tokenSet(b);
    if (!ta.length || !tb.length) return 0;
    const setB = {};
    for (const t of tb) setB[t] = true;
    let inter = 0;
    const seen = {};
    for (const t of ta) {
        if (setB[t] && !seen[t]) {
            inter++;
            seen[t] = true;
        }
    }
    const union = {};
    for (const t of ta) union[t] = true;
    for (const t of tb) union[t] = true;
    const jaccard = inter / Object.keys(union).length;
    return Math.round(jaccard * 60);
}

/**
 * Score global d'une carte contre les métadonnées TMDB.
 * @returns {number} score (peut être négatif ; <= 0 = à écarter)
 */
export function scoreCard(card, meta, mediaType, season) {
    const isMovie = mediaType !== 'tv';
    let best = 0;

    // Noms à comparer : pour les séries, series_name (sans "Saison X")
    // fonctionne mieux que le title brut ; on teste les deux.
    const names = [];
    if (isMovie) {
        names.push(card.title);
    } else {
        if (card.series_name) names.push(card.series_name);
        names.push(stripSeasonSuffix(card.title || ''));
        names.push(card.title);
    }

    for (const t of meta.titles) {
        for (const n of names) {
            const s = titleScore(t, n);
            if (s > best) best = s;
        }
    }
    if (best <= 0) return -1;
    // Score de titre PUR, avant les ajustements saison/année : sert au
    // garde-fou anti-homonyme des séries ci-dessous.
    const titleScoreBest = best;

    // Cohérence film / série — rejet dur en cas de contradiction franche.
    // Nuance : sur les sites anime (is_anime), les films gardent is_film=false
    // et season_number=0 — on ne les rejette donc que si une saison explicite
    // est annoncée.
    if (isMovie && card.is_film === false && (parseInt(card.season_number, 10) || 0) > 0) return -1;
    if (!isMovie && card.is_film === true) return -1;

    // Saison : les cartes DLE (FStream/French-Manga/UniqueStream/Bflix) sont
    // une par saison ; KissKH une par série (season_number peut valoir 0).
    if (!isMovie && Number.isFinite(season) && season > 0) {
        const cs = parseInt(card.season_number, 10) || 0;
        if (cs > 0 && cs !== season) best -= 20;
        else if (cs === season) best += 12;
    }

    // Année : concordance ≈ +15, écart franc ≈ -10.
    const cardYear = parseInt(card.year, 10) || 0;
    if (cardYear > 0 && meta.year > 0) {
        const diff = Math.abs(cardYear - meta.year);
        // FILMS : rejet dur si l'écart dépasse 1 an. Sans cela, un remake ou
        // un homonyme ancien (ex. Dune 1984 au lieu de Dune 2021) passe le
        // seuil sur son score de titre seul et sert le MAUVAIS film.
        if (isMovie && diff > 1) return -1;
        // SÉRIES : garde-fou anti-homonyme. Les séries n'ont pas l'équivalent
        // du filtre dur des films ; un faux ami flou (ex. recherche « NAZA »
        // qui préfixe « Nazaré ») pouvait passer sur son score de titre seul.
        // Si le titre n'est qu'approchant (< 100) et que les années divergent
        // franchement (écart > 2) → rejet. Les titres exacts ou au préfixe de
        // mot avec la bonne année (cas légitimes courants) ne sont pas touchés.
        if (!isMovie && titleScoreBest < 100 && diff > 2) return -1;
        if (diff === 0) best += 15;
        else if (diff === 1) best += 8;
        else if (diff > 3) best -= 10;
    }

    // Bonus léger si la carte est explicitement un film quand on cherche un film.
    if (isMovie && card.is_film === true) best += 5;

    return best;
}

/**
 * Trie les cartes par score décroissant.
 * @returns {Array<{card: object, score: number}>}
 */
export function rankCards(cards, meta, mediaType, season) {
    const ranked = [];
    const seenUrls = {};
    for (const c of cards || []) {
        if (!c || !c.page_url) continue;
        if (seenUrls[c.page_url]) continue;
        seenUrls[c.page_url] = true;
        const score = scoreCard(c, meta, mediaType, season);
        if (score > 0) ranked.push({ card: c, score: score });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
}
