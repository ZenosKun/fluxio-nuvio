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
 *                      fstream, french-manga, bflix, papadustream, webflix,
 *                      french-stream, wookafr
 *   - detectAnime    : détection anime TMDB + routage des sources de recherche
 *   - earlyExit      : couper les sources bloquantes (échéance douce 5 s)
 *   - softMs         : échéance douce en ms (3000-15000, SCRAPER_SETTINGS
 *                      uniquement — non exposé dans l'UI, tunable avancé ;
 *                      5 s par défaut : Nuvio a son propre timeout de
 *                      réponse, rester court garantit l'affichage)
 *   - tmdbKey        : clé API TMDB personnelle
 *   - serverUrl      : serveur sestudio optionnel (repli)
 *   - timeoutSec     : budget réseau par requête (8-90 s, défaut 10 s)
 *   - budgetSec      : budget global de l'extraction (10-30 s, SCRAPER_SETTINGS
 *                      uniquement — non exposé dans l'UI, tunable avancé ;
 *                      défaut 25 s — DOIT rester sous le timeout de réponse
 *                      de l'app Nuvio, sinon « impossible de charger les
 *                      streams » au lieu d'une liste propre)
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
    const verifyLinks = boolOr(s.verifyLinks, true);
    // Mode diagnostic = FORCÉ ACTIF (v3.1.7) tant que le débogage n'est pas
    // terminé : l'app Nuvio n'expose AUCUNE UI de réglages pour ce plugin
    // (rien dans Contenu et découverte / Plugins), SCRAPER_SETTINGS n'arrive
    // jamais — un défaut « opt-in » serait donc définitivement inaccessible.
    // Ce mode ajoute 2 flux TEST publics en tête (s'ils ne se lisent pas non
    // plus, le problème vient du lecteur de l'app) et affiche le domaine de
    // chaque lien dans son nom. À repasser en opt-in quand tout est réglé.
    const selfTest = boolOr(s.selfTest, true);

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

    const timeoutSec = parseInt(String(s.timeoutSec || '10'), 10);
    const timeoutMs =
        Number.isFinite(timeoutSec) && timeoutSec >= 8 && timeoutSec <= 90
            ? timeoutSec * 1000
            : 10000;

    // Budget global de l'extraction : v3.1.2 — 25 s max. En production, un
    // budget plus long fait PLUS de mal que de bien : si les domaines sont
    // bloqués (DNS FAI fréquent sur les sites de streaming), toutes les
    // sources pendent, et dépasser le timeout de l'app Nuvio transforme une
    // liste vide exploitable en erreur « impossible de charger les streams ».
    // Sans timer (fetch bloquant), la dernière requête en vol ne peut pas être
    // coupée : budget par défaut plus court (18 s) pour rester sous la limite.
    const budgetSec = parseInt(String(s.budgetSec || ''), 10);
    const budgetMs =
        Number.isFinite(budgetSec) && budgetSec >= 10 && budgetSec <= 30
            ? budgetSec * 1000
            : typeof setTimeout === 'function'
                ? 25000
                : 18000;

    return {
        serverUrl,
        language,
        fallbackLangs,
        allowOtherLang,
        detectAnime,
        earlyExit,
        verifyLinks,
        selfTest,
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
