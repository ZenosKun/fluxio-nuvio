/**
 * Test rapide des liens avant affichage (même idée que la sonde de sestudio).
 *
 * Un lien qui renvoie 403/404 ou une playlist invalide fait « buffering » à
 * l'infini dans le lecteur. On le détecte ici et on le range en fin de liste
 * avec un ⚠ au lieu de le proposer en premier.
 *
 * - HLS : GET de la playlist → doit contenir #EXTM3U. Sonde approfondie sur
 *   les 3 premiers liens : maître → 1re variante → 1er segment (GET Range
 *   16 Ko, corps JAMAIS lu). C'est là que les CDN à empreinte TLS Chrome
 *   (vidzy…) répondent 403 alors que la playlist passe — et un lien dont les
 *   segments sont refusés bufferise à l'infini malgré une playlist « OK ».
 * - MP4 : HEAD (jamais de GET : un serveur qui ignore Range enverrait le
 *   fichier entier). 405/501 = HEAD non supporté → « inconnu ». Une 200 qui
 *   répond du HTML (content-type ou corps) = redirection proxy → KO.
 * - Redirections détectées : toute réponse HTML là où on attend un flux
 *   (playlist, variante, MP4) est un échec (ex. proxy → page captcha).
 * - Les en-têtes du flux (Referer, User-Agent…) sont envoyés tels quels.
 * - La chaîne profonde est bornée par le timeout de la sonde (chaque étape
 *   reçoit le temps RESTANT) : jamais plus long qu'avant.
 * - Limites : 6 liens max, 4 s par sonde, 8 s au total, jamais au-delà du
 *   budget restant. Sans timer (fetch bloquant) les sondes sont séquentielles.
 * - Neutralité : une sonde interrompue par le budget global ou le disjoncteur
 *   réseau n'est ni OK ni KO (« ? ») — on ne tue pas un lien pour notre faute.
 * - La sonde passe par la pile HTTP du plugin, pas par celle du lecteur : un
 *   lien « OK » peut encore échouer côté lecteur, mais un lien « KO » est mort.
 */

import { fetchText, fetchStatus, resolveUrl } from '../utils/http.js';

const PROBE_MS = 4000;
const PROBE_MAX = 6;
const PROBE_BUDGET_MS = 8000;
const MIN_REMAINING_MS = 1500;
const DEEP_MAX = 3; // sonde approfondie (segment) : 3 premiers liens
const SEGMENT_RANGE = 'bytes=0-16383';

/** Corps qui ressemble à une page HTML plutôt qu'à un flux. */
function looksHtml(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    const head = t.slice(0, 400);
    return t.charAt(0) === '<' || /<html[\s>]/i.test(head) || /<!doctype\s+html/i.test(head);
}

/** URI qui suit un tag HLS : #EXT-X-STREAM-INF → variante, #EXTINF → segment. */
export function nextHlsUri(text, tag) {
    const re = new RegExp('^' + String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const lines = String(text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i].trim())) continue;
        for (let j = i + 1; j < lines.length; j++) {
            const l = lines[j].trim();
            if (!l || l.charAt(0) === '#') continue; // autre tag, pas l'URI
            return l;
        }
    }
    return '';
}

/** Erreur imputable à NOUS (budget global épuisé, disjoncteur) — pas au lien. */
function neutralErr(err) {
    return /budget épuisé|disjoncteur/.test(String((err && err.message) || ''));
}

export async function probeOne(st, timeout, deep) {
    const isHls = /\.m3u8(\?|$)/i.test(String(st.url || ''));
    const headers = Object.assign({ Accept: '*/*' }, st.headers || {});
    const deadline = Date.now() + Math.max(800, timeout);
    const left = () => Math.max(400, deadline - Date.now());
    const statusOf = err => (err && err.status ? err.status : 0);

    // MP4 : HEAD (jamais de GET : un serveur qui ignore Range enverrait le
    // fichier entier). Une 200 qui répond du HTML = redirection proxy → KO.
    if (!isHls) {
        try {
            const res = await fetchText(st.url, { method: 'HEAD', headers: headers, timeout: timeout });
            if (looksHtml(res.text) || /text\/html/i.test(res.contentType || '')) {
                return { ok: false, why: 'redirection vers page HTML' };
            }
            return { ok: true };
        } catch (err) {
            const status = statusOf(err);
            if (status === 405 || status === 501) return { ok: null, why: 'HEAD refusé' };
            return { ok: false, why: status ? 'HTTP ' + status : 'injoignable' };
        }
    }

    // HLS — étape 1 : playlist.
    let res;
    try {
        res = await fetchText(st.url, { method: 'GET', headers: headers, timeout: left() });
    } catch (err) {
        if (neutralErr(err)) return { ok: null, why: 'sonde interrompue' };
        const status = statusOf(err);
        return { ok: false, why: status ? 'HTTP ' + status : 'playlist injoignable' };
    }
    let text = res.text || '';
    if (looksHtml(text)) return { ok: false, why: 'redirection vers page HTML' };

    // Étape 2 (profonde) : playlist maître → première variante.
    let base = res.finalUrl || st.url;
    const variant = nextHlsUri(text, '#EXT-X-STREAM-INF');
    if (variant) {
        const vUrl = resolveUrl(base, variant);
        let v;
        try {
            v = await fetchText(vUrl, { method: 'GET', headers: headers, timeout: left() });
        } catch (err) {
            if (neutralErr(err)) return { ok: null, why: 'sonde interrompue' };
            const status = statusOf(err);
            if (status >= 400) return { ok: false, why: 'HTTP ' + status + ' (variante)' };
            return { ok: null, why: 'variante non testée' };
        }
        text = v.text || '';
        if (looksHtml(text)) return { ok: false, why: 'variante → page HTML' };
        base = v.finalUrl || vUrl;
    }

    // Étape 3 (profonde) : premier segment — statut seul, corps jamais lu.
    const seg = nextHlsUri(text, '#EXTINF');
    if (!seg || !deep) return { ok: true };

    const segUrl = resolveUrl(base, seg);
    try {
        const sres = await fetchStatus(segUrl, {
            method: 'GET',
            headers: Object.assign({}, headers, { Range: SEGMENT_RANGE }),
            timeout: left(),
            noBody: true,
        });
        if (sres.status >= 400) return { ok: false, why: 'HTTP ' + sres.status + ' (segment)' };
        if (/text\/html/i.test(sres.contentType || '')) return { ok: false, why: 'segment → page HTML' };
        return { ok: true };
    } catch (err) {
        if (neutralErr(err)) return { ok: null, why: 'sonde interrompue' };
        const status = statusOf(err);
        // Hors temps de la sonde : ni OK ni KO (la playlist, elle, est valide).
        if (!status && Date.now() >= deadline) return { ok: null, why: 'segment non testé' };
        return { ok: false, why: status ? 'HTTP ' + status + ' (segment)' : 'segment injoignable' };
    }
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
        results = Promise.all(list.map(function (st, i) { return probeOne(st, perProbe, i < DEEP_MAX); }));
    } else {
        // fetch bloquant : une sonde après l'autre, jamais au-delà de l'échéance
        results = list.reduce(function (chain, st, i) {
            return chain.then(function (acc) {
                if (Date.now() + MIN_REMAINING_MS > deadline) {
                    acc.push({ ok: null, why: 'non testé' });
                    return acc;
                }
                return probeOne(st, perProbe, i < DEEP_MAX).then(function (r) {
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
                // Idempotent : un flux déjà marqué ⚠ (weak player) ne double pas.
                if (!/ ⚠$/.test(String(copy.name || ''))) copy.name = String(copy.name || 'Fluxio') + ' ⚠';
                dead.push(copy);
            } else {
                good.push(st);
            }
        });
        return good.concat(dead);
    });
}
