/**
 * Anti-blocage : « quand arrêter d'attendre ? »
 *
 * Principe v3.1 : une même source livre souvent PLUSIEURS qualités/hosts du
 * même titre — couper dès qu'un quota de flux est atteint (comportement v3.0 :
 * 2 flux langue préférée = assez) priverait l'utilisateur de choix.
 * On laisse donc toutes les sources répondantes livrer TOUT ce qu'elles ont.
 * Le stopper ne coupe alors que pour deux raisons :
 *
 *   - échéance douce (10 s) atteinte avec au moins 1 flux pertinent déjà
 *     collecté : un site bloqué ou très lent ne retarde plus le rendu ;
 *   - budget dur (25 s, 18 s sans timers) épuisé : rendre ce qui existe, quoi qu'il arrive.
 *
 * earlyExit=false (réglage) : tout attendre jusqu'au budget (comportement v2).
 * Runtimes sans setTimeout (TV) : pas de course possible, le stopper sert
 * alors de frontière d'arrêt aux boucles internes des sources.
 */

const SOFT_MS = 10000;     // échéance douce : au-delà, ≥1 flux pertinent suffit
                           // (v3.1.11 : à 5 s seule webflix ≈0,8 s répondait —
                           // french-stream ≈2-3 s et french-manga ≈4-6 s étaient
                           // coupées avant de livrer ; Nuvio attend la réponse
                           // COMPLÈTE et l'app a son propre timeout — 10 s reste
                           // sous la limite et laisse plusieurs sources livrer)

export function createStopper({ startedAt, hardMs, softMs }) {
    const hard = hardMs > 0 ? hardMs : 25000;
    const soft = softMs > 0 ? softMs : SOFT_MS;
    const softAt = startedAt + soft;
    const hardAt = startedAt + hard;

    function elapsedMs() {
        return Date.now() - startedAt;
    }

    /** Budget dur épuisé → rendre ce qui existe, immédiatement. */
    function shouldStop() {
        return Date.now() >= hardAt;
    }

    /** Échéance douce atteinte (les flux lents ne bloquent plus). */
    function softElapsed() {
        return Date.now() >= softAt;
    }

    /**
     * Les résultats déjà collectés suffisent-ils à rendre ?
     * v3.1 : plus AUCUN quota de flux — une source peut servir plusieurs
     * qualités du même titre, les compter serait en perdre. On ne rend en
     * avance QUE si l'échéance douce est atteinte avec ≥ 1 flux pertinent.
     * @param {Array} streams flux internes annotés (_langKey)
     * @param {{fallbackLangs: string[], allowOtherLang: boolean}} cfg
     */
    function goodEnough(streams, cfg) {
        if (!softElapsed()) return false;
        const relevantLangs = cfg.allowOtherLang ? cfg.fallbackLangs : cfg.fallbackLangs.slice(0, 1);
        for (const s of streams || []) {
            if (s && s.url && relevantLangs.indexOf(s._langKey) !== -1) return true;
        }
        return false;
    }

    return {
        elapsedMs,
        shouldStop,
        softElapsed,
        goodEnough,
        softMs: soft,
        hardMs: hard,
    };
}

/**
 * Course côté orchestrateur (runtimes AVEC setTimeout, Nuvio Mobile) :
 * résolue 'enough' seulement à l'échéance douce avec ≥1 flux pertinent
 * (poll léger par setTimeout chaîné — setInterval n'est pas garanti) —
 * sinon laisse allDone gagner ('done') pour livrer tous les flux.
 * @returns {Promise<'enough'|'done'|'budget'>}
 */
export function raceEarlyExit({ stopper, collected, cfg, allDone, onEnough }) {
    if (typeof setTimeout !== 'function') {
        return allDone.then(() => 'done');
    }
    return new Promise(resolve => {
        let settled = false;
        let timer = null;
        const settle = value => {
            if (settled) return;
            settled = true;
            try { clearTimeout(timer); } catch (e) { /* ignore */ }
            resolve(value);
        };
        const poll = () => {
            if (stopper.shouldStop()) return settle('budget');
            if (stopper.goodEnough(collected, cfg)) {
                if (typeof onEnough === 'function') {
                    try { onEnough(); } catch (e) { /* ignore */ }
                }
                return settle('enough');
            }
            try {
                timer = setTimeout(poll, 250);
            } catch (e) {
                settle('done'); // runtime devenu capricieux : on n'attend plus
            }
        };
        poll();
        allDone.then(() => settle('done')).catch(() => settle('done'));
    });
}

/**
 * shouldStop destiné AUX SOURCES (ctx.shouldStop) : vrai au budget dur, ou
 * dès que l'échéance douce est atteinte ALORS QUE les résultats déjà
 * collectés suffisent au joueur (goodEnough). Les chaînes internes des
 * sources (variantes de titre, cartes, chaînes de langues) abandonnent alors
 * à leur prochaine frontière de boucle — comportement IDENTIQUE sur TV
 * (pas de course possible) et sur Mobile (course 250 ms du raceEarlyExit).
 *
 * Si l'utilisateur n'a encore RIEN de pertinent, on ne coupe pas : cette
 * chaîne est peut-être sa seule chance (elle reste bornée par le budget dur).
 *
 * @param {ReturnType<typeof createStopper>} stopper
 * @param {Array} collected flux internes déjà poussés (partagé)
 * @param {{fallbackLangs: string[], allowOtherLang: boolean}} cfg
 */
export function makeSourceShouldStop(stopper, collected, cfg) {
    return function sourceShouldStop() {
        if (stopper.shouldStop()) return true;
        try {
            return stopper.softElapsed() && stopper.goodEnough(collected, cfg);
        } catch (e) {
            return false;
        }
    };
}
