/**
 * Enveloppe standard d'un provider Nuvio (version allégée, adaptée du modèle
 * officiel tapframe/nuvio-providers et des conventions Gowaru).
 *
 * - createProvider(name, extractFn) : gère timeout global, logs, erreurs → [].
 * - createSettingsLayout(items)     : hook onSettings pour l'UI NuvioMobile.
 */

const PROVIDER_BUDGET_MS = 60000;

export function safeConfig(key, defaultVal) {
    try {
        if (typeof globalThis !== 'undefined' && globalThis.SCRAPER_SETTINGS) {
            const v = globalThis.SCRAPER_SETTINGS[key];
            if (v !== undefined && v !== null && v !== '') return v;
        }
    } catch (e) {
        /* ignore */
    }
    return defaultVal;
}

export function createProvider(name, extractFn, opts = {}) {
    const budgetMs = parseInt(safeConfig('NUVIO_TIMEOUT_' + name.toUpperCase(), opts.timeout || PROVIDER_BUDGET_MS), 10) || PROVIDER_BUDGET_MS;

    return async function getStreams(tmdbId, mediaType, season, episode, options = {}) {
        const label = `${name} ${mediaType} ${tmdbId}${mediaType === 'tv' ? ` S${season}E${episode}` : ''}`;
        const started = Date.now();

        // Tableau partagé avec l'extraction : chaque flux y est poussé dès sa
        // résolution. Si le budget saute, on rend ce qui existe au lieu de [].
        const partial = [];
        try {
            const result = await raceTimeout(
                extractFn(tmdbId, mediaType, season, episode, {
                    signal: options && options.signal ? options.signal : null,
                    budgetMs: Math.max(2000, budgetMs - 1500),
                    partial: partial,
                }),
                budgetMs
            );
            const list = Array.isArray(result) ? result : [];
            console.log(`[${name}] ${label}: ${list.length} stream(s) en ${Date.now() - started}ms`);
            return list;
        } catch (err) {
            const salvaged = sanitizePartial(partial);
            if (salvaged.length) {
                console.warn(
                    `[${name}] ${label} budget dépassé — ${salvaged.length} flux partiel(s) conservés`
                );
                return salvaged;
            }
            console.error(
                `[${name}] ${label} erreur: ` + (err && err.message ? err.message : String(err))
            );
            return [];
        }
    };
}

/** Déduplique par URL et retire les champs internes (_langKey…). */
function sanitizePartial(list) {
    const seen = {};
    const out = [];
    for (const s of list || []) {
        if (!s || !s.url || seen[s.url]) continue;
        seen[s.url] = true;
        const clean = {};
        for (const k of Object.keys(s)) {
            if (k.charAt(0) !== '_') clean[k] = s[k];
        }
        out.push(clean);
    }
    return out;
}

/**
 * Course contre une deadline sans setTimeout garanti :
 * on refuse seulement si le budget est dépassé au moment où la promesse
 * se résout ; les requêtes réseau portent de toute façon leur propre timeout
 * réel (src/utils/http.js). L'extraction rend elle-même ses résultats
 * partiels à sa propre échéance (budgetMs) — cette course n'est qu'un filet
 * si elle se fige au-delà, et dans ce cas createProvider récupère le tableau
 * partagé `partial`.
 */
function raceTimeout(promise, budgetMs) {
    const deadline = Date.now() + budgetMs;

    const check = promise.then(value => {
        if (Date.now() > deadline) {
            throw new Error(`[Timeout] budget ${budgetMs}ms dépassé`);
        }
        return value;
    });

    const timerAvailable = typeof setTimeout === 'function';
    if (!timerAvailable) return check;

    return new Promise((resolve, reject) => {
        let done = false;
        const t = setTimeout(() => {
            if (!done) {
                done = true;
                reject(new Error(`[Timeout] budget ${budgetMs}ms dépassé`));
            }
        }, budgetMs);
        check.then(
            v => {
                if (!done) {
                    done = true;
                    clearTimeout(t);
                    resolve(v);
                }
            },
            e => {
                if (!done) {
                    done = true;
                    clearTimeout(t);
                    reject(e);
                }
            }
        );
    });
}

export function createSettingsLayout(items) {
    const layout = Array.isArray(items) ? items : [];
    return async function onSettings() {
        return layout;
    };
}
