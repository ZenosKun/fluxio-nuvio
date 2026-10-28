/**
 * Test rapide des liens avant affichage (même idée que la sonde de sestudio).
 *
 * Un lien qui renvoie 403/404 ou une playlist invalide fait « buffering » à
 * l'infini dans le lecteur. On le détecte ici et on le range en fin de liste
 * avec un ⚠ au lieu de le proposer en premier.
 *
 * - HLS : GET de la playlist (petite) → doit contenir #EXTM3U.
 * - MP4 : HEAD (jamais de GET : un serveur qui ignore Range enverrait le
 *   fichier entier). 405/501 = HEAD non supporté → on considère « inconnu ».
 * - Les en-têtes du flux (Referer, User-Agent…) sont envoyés tels quels.
 * - Limites : 6 liens max, 4 s par sonde, 8 s au total, jamais au-delà du
 *   budget restant. Sans timer (fetch bloquant) les sondes sont séquentielles.
 * - La sonde passe par la pile HTTP du plugin, pas par celle du lecteur : un
 *   lien « OK » peut encore échouer côté lecteur, mais un lien « KO » est mort.
 */

import { fetchText } from '../utils/http.js';

const PROBE_MS = 4000;
const PROBE_MAX = 6;
const PROBE_BUDGET_MS = 8000;
const MIN_REMAINING_MS = 1500;

export function probeOne(st, timeout) {
    const isHls = /\.m3u8(\?|$)/i.test(String(st.url || ''));
    const headers = Object.assign({ Accept: '*/*' }, st.headers || {});
    return fetchText(st.url, {
        method: isHls ? 'GET' : 'HEAD',
        headers: headers,
        timeout: timeout,
    }).then(
        function (res) {
            if (isHls) {
                return /#EXTM3U/.test(res.text || '')
                    ? { ok: true }
                    : { ok: false, why: 'playlist HLS invalide' };
            }
            return { ok: true };
        },
        function (err) {
            const status = err && err.status ? err.status : 0;
            if (!isHls && (status === 405 || status === 501)) return { ok: null, why: 'HEAD refusé' };
            return { ok: false, why: status ? 'HTTP ' + status : 'injoignable' };
        }
    );
}

/**
 * @param {Array} streams flux Nuvio finaux (name, url, headers…)
 * @param {{remainingMs: number}} opts
 * @returns {Promise<Array>} mêmes flux : vivants/inconnus d'abord, morts en fin avec ⚠
 */
export function verifyStreams(streams, opts) {
    const list = (streams || []).slice(0, PROBE_MAX);
    const budget = Math.min(PROBE_BUDGET_MS, (opts && opts.remainingMs) - MIN_REMAINING_MS);
    if (!list.length || !(budget >= 2000)) return Promise.resolve(streams);

    const perProbe = Math.min(PROBE_MS, budget);
    const deadline = Date.now() + budget;
    let results;

    if (typeof setTimeout === 'function') {
        results = Promise.all(list.map(function (st) { return probeOne(st, perProbe); }));
    } else {
        // fetch bloquant : une sonde après l'autre, jamais au-delà de l'échéance
        results = list.reduce(function (chain, st) {
            return chain.then(function (acc) {
                if (Date.now() + MIN_REMAINING_MS > deadline) {
                    acc.push({ ok: null, why: 'non testé' });
                    return acc;
                }
                return probeOne(st, perProbe).then(function (r) {
                    acc.push(r);
                    return acc;
                });
            });
        }, Promise.resolve([]));
    }

    return results.then(function (res) {
        const good = [];
        const dead = [];
        (streams || []).forEach(function (st, i) {
            const r = i < res.length ? res[i] : { ok: null };
            console.log(
                '[verify] ' + (r.ok === true ? 'OK ' : r.ok === false ? 'KO ' : '?  ') +
                    st.name + ' · ' + (r.why || '') + ' · ' + st.url
            );
            if (r.ok === false) {
                const copy = Object.assign({}, st);
                copy.name = String(st.name || 'Fluxio') + ' ⚠';
                dead.push(copy);
            } else {
                good.push(st);
            }
        });
        return good.concat(dead);
    });
}
