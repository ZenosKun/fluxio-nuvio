/**
 * Lecture des réglages du plugin v3.
 *
 * Les apps Nuvio (Mobile + TV) injectent globalThis.SCRAPER_SETTINGS avec les
 * valeurs sauvegardées depuis l'UI de réglages du plugin (hook onSettings).
 * Tout est optionnel : sans réglages, on retombe sur des valeurs par défaut
 * raisonnables.
 *
 * Clés onSettings correspondantes :
 *   - language       : 'vf' | 'vostfr' | 'all'  (langue préférée)
 *   - allowOtherLang : basculer de site/langue si absente
 *   - sources        : ids séparés par des virgules ('' = tous) —
 *                      fstream, french-manga, bflix, papadustream, webflix
 *   - detectAnime    : détection anime TMDB + routage des sources de recherche
 *   - earlyExit      : couper les sources bloquantes (échéance douce 5 s)
 *   - softMs         : échéance douce en ms (3000-15000, SCRAPER_SETTINGS
 *                      uniquement — non exposé dans l'UI, tunable avancé ;
 *                      5 s par défaut : Nuvio a son propre timeout de
 *                      réponse, rester court garantit l'affichage)
 *   - tmdbKey        : clé API TMDB personnelle
 *   - serverUrl      : serveur sestudio optionnel (repli)
 *   - timeoutSec     : budget réseau par requête (8-90 s)
 *   - budgetSec      : budget global de l'extraction (10-55 s, SCRAPER_SETTINGS
 *                      uniquement — non exposé dans l'UI, tunable avancé)
 */

export function getSettingsRaw() {
    try {
        if (
            typeof globalThis !== 'undefined' &&
            globalThis.SCRAPER_SETTINGS &&
            typeof globalThis.SCRAPER_SETTINGS === 'object'
        ) {
            return globalThis.SCRAPER_SETTINGS;
        }
    } catch (e) {
        /* runtime sans SCRAPER_SETTINGS */
    }
    return {};
}

export const LANGUAGES = ['vf', 'vostfr', 'vo'];

/** Tolérance booléen natif (Nuvio stocke parfois true/false) ou chaîne. */
function boolOr(value, def) {
    if (value === undefined || value === null || value === '') return def;
    return String(value).toLowerCase() !== 'false';
}

/**
 * Configuration résolue (réglages utilisateur + défauts).
 */
export function readConfig() {
    const s = getSettingsRaw();

    let serverUrl = String(s.serverUrl || '').trim();
    if (serverUrl && !/^https?:\/\//i.test(serverUrl)) {
        serverUrl = 'http://' + serverUrl;
    }
    serverUrl = serverUrl.replace(/\/+$/, '');

    const languageRaw = String(s.language || 'vf').toLowerCase();
    const language = languageRaw === 'all' || languageRaw === '' ? 'vf' : languageRaw;
    const fallbackLangs = languageRaw === 'all' ? ['vf', 'vostfr', 'vo'] : buildLangChain(language);

    const allowOtherLang = boolOr(s.allowOtherLang, true);
    const detectAnime = boolOr(s.detectAnime, true);

    // earlyExit (anti-blocage) : dès que l'échéance douce est atteinte avec
    // ≥ 1 flux pertinent, l'orchestrateur rend au lieu d'attendre les sources
    // bloquées. Désactivable pour retrouver le comportement v2 (tout attendre,
    // budget complet).
    const earlyExit = boolOr(s.earlyExit, true);

    // Échéance douce (tunable avancé, SCRAPER_SETTINGS uniquement) : Nuvio
    // attend la réponse COMPLÈTE du plugin puis l'affiche — si notre rendu
    // dépasse le timeout de l'app, l'utilisateur voit une erreur et ZÉRO
    // flux. Défaut 5 s : les sources réactives livrent l'essentiel de leurs
    // qualités en 1-4 s, seuls les sites bloqués sont coupés.
    const softSec = parseInt(String(s.softMs || ''), 10);
    const softMs =
        Number.isFinite(softSec) && softSec >= 3000 && softSec <= 15000
            ? softSec
            : 5000;

    const useTranscode =
        s.useTranscode === undefined || s.useTranscode === null || s.useTranscode === ''
            ? false
            : String(s.useTranscode).toLowerCase() === 'true';

    const sources = String(s.sources || s.sites || '')
        .split(',')
        .map(x => x.trim().toLowerCase())
        .filter(Boolean)
        .join(',');

    const timeoutSec = parseInt(String(s.timeoutSec || '30'), 10);
    const timeoutMs =
        Number.isFinite(timeoutSec) && timeoutSec >= 8 && timeoutSec <= 90
            ? timeoutSec * 1000
            : 30000;

    // Budget global de l'extraction : Nuvio coupe le plugin à 60 s de toute
    // façon ; on garde une marge de sécurité pour rendre des résultats propres.
    const budgetSec = parseInt(String(s.budgetSec || '50'), 10);
    const budgetMs =
        Number.isFinite(budgetSec) && budgetSec >= 10 && budgetSec <= 55
            ? budgetSec * 1000
            : 50000;

    return {
        serverUrl,
        language,
        fallbackLangs,
        allowOtherLang,
        detectAnime,
        earlyExit,
        softMs,
        useTranscode,
        sources,
        timeoutMs,
        budgetMs,
    };
}

/**
 * Chaîne de langues à essayer, langue préférée en tête.
 * vf → [vf, vostfr, vo] ; vostfr → [vostfr, vf, vo] ; vo → [vo, vostfr, vf].
 */
function buildLangChain(preferred) {
    const rest = LANGUAGES.filter(l => l !== preferred);
    return [preferred, ...rest];
}
