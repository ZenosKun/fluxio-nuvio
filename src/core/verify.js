/**
 * Test rapide des liens avant affichage (même idée que la sonde de sestudio,
 * philosophie de gowaru-nuvio-providers : « anti flux-qui-ne-lance-jamais »).
 *
 * Un lien qui renvoie 403/404 ou une playlist invalide fait « buffering » à
 * l'infini dans le lecteur. v3.1.8 : un lien que la sonde prouve mort est
 * RETIRÉ de la liste (avant : rangé en fin avec un ⚠ — l'utilisateur le
 * choisissait quand même et tombait sur le panneau « lien ne fonctionne
 * pas »). Les liens « ? » (sonde interrompue, HEAD refusé…) sont conservés :
 * on ne tue pas un lien pour notre faute.
 *
 * - HLS : GET de la playlist → doit contenir #EXTM3U. Sonde approfondie sur
 *   les 8 premiers liens : maître → 1re variante → 1er segment (GET Range
 *   16 Ko, corps JAMAIS lu). C'est là que les CDN à empreinte TLS Chrome
 *   (vidzy…) répondent 403 alors que la playlist passe — et un lien dont les
 *   segments sont refusés bufferise à l'infini malgré une playlist « OK ».
 * - MP4 : HEAD (jamais de GET : un serveur qui ignore Range enverrait le
 *   fichier entier). 405/501 = HEAD non supporté → « inconnu ». Une 200 qui
 *   répond du HTML (content-type ou corps) = redirection proxy → KO.
 * - Qualité réelle (v3.1.8) : la RESOLUTION max de la playlist maître HLS
 *   (« 1080p », « 4K »…) ou le motif de l'URL MP4 remplace les libellés
 *   génériques (« Direct », « Auto (HLS) ») — Nuvio affiche ce champ tel quel.
 * - Redirections détectées : toute réponse HTML là où on attend un flux
 *   (playlist, variante, MP4) est un échec (ex. proxy → page captcha).
 * - Les en-têtes du flux (Referer, User-Agent…) sont envoyés tels quels.
 * - La chaîne profonde est bornée par le timeout de la sonde (chaque étape
 *   reçoit le temps RESTANT) : jamais plus long qu'avant.
 * - Limites : 10 liens max, 4 s par sonde, 8 s au total, jamais au-delà du
 *   budget restant. Sans timer (fetch bloquant) les sondes sont séquentielles.
 * - Neutralité : une sonde interrompue par le budget global ou le disjoncteur
 *   réseau n'est ni OK ni KO (« ? ») — on ne tue pas un lien pour notre faute.
 * - La sonde passe par la pile HTTP du plugin, pas par celle du lecteur : un
 *   lien « OK » peut encore échouer côté lecteur, mais un lien « KO » est mort.
 */

import { fetchText, fetchBytes, fetchStatus, resolveUrl } from '../utils/http.js';
import { qualityFromUrl, resolutionLabel } from './stream.js';
import { mp4MaxHeight, mp4QualityLabel, bytesLookHtml } from '../utils/mp4.js';

const PROBE_MS = 4000;
const PROBE_MAX = 10;
const PROBE_BUDGET_MS = 8000;
const MIN_REMAINING_MS = 1500;
const DEEP_MAX = 8; // sonde approfondie (segment) : 8 premiers liens
const SEGMENT_RANGE = 'bytes=0-16383';
/** Plage lue pour l'en-tête MP4 (moov/tkhd) : 128 Ko couvrent le moov des
 * fichiers faststart (ftyp + moov avant mdat). Au-delà (moov en fin de
 * fichier) : inatteignable avec un Range tête seule → pas de libellé, aucun
 * coût supplémentaire. */
const MOOV_RANGE = 'bytes=0-131071';
const MOOV_MS = 2500;

/**
 * Qualité réelle d'un MP4 direct : si l'URL ne porte aucun motif de
 * résolution (fastflux webflix : Lupin-S01-E01.mp4, l'API répond elle-même
 * quality=Unknown), on lit la hauteur annoncée par le moov/tkhd du
 * conteneur (GET Range 128 Ko, octets bruts — jamais le décodage UTF-8 qui
 * corromprait le binaire). Échec silencieux → '' (on n'invente rien).
 */
async function mp4HeadQuality(st, headers, left) {
    try {
        const res = await fetchBytes(st.url, {
            method: 'GET',
            headers: Object.assign({}, headers, { Range: MOOV_RANGE, Accept: '*/*' }),
            timeout: Math.min(MOOV_MS, left()),
        });
        const u8 = res.bytes;
        if (!u8 || !u8.length || bytesLookHtml(u8)) return '';
        const h = mp4MaxHeight(u8);
        return h ? mp4QualityLabel(h) : '';
    } catch (e) {
        return ''; // goûtage impossible : qualité inconnue, le lien reste « ? »/OK
    }
}

/** Meilleure résolution annoncée par une playlist maître HLS → « 1080p », « 4K »…
 *  Une playlist média (sans #EXT-X-STREAM-INF) ne annonce pas de RESOLUTION
 *  multi-variantes : on ignore alors (chaîne vide). */
export function bestHlsQuality(text) {
    let best = 0;
    const re = /RESOLUTION=(\d+)x(\d+)/gi;
    let m;
    const t = String(text || '');
    while ((m = re.exec(t)) !== null) {
        const h = parseInt(m[2], 10);
        if (h > best) best = h;
    }
    return best ? resolutionLabel(best) : '';
}

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
                // ⚠ v3.1.9 : certains CDN servent le VRAI média avec un
                // content-type mensonger text/html (vérifié live : fastflux
                // webflix → cdn80.zen-blk.store répond 200 + text/html et
                // délivre 1,4 Go de MP4). Avant de tuer le lien, on goûte les
                // premiers octets (GET Range 128 Ko, timeout court) :
                //   HTML réel → mort ; binaire non-HTML → vivant ;
                //   goûtage impossible → « ? » (on ne tue pas un lien pour
                //   notre faute).
                // ⚠ v3.1.10 : le goûtage lit des OCTETS (fetchBytes, jamais le
                // décodage UTF-8 qui corromprait le binaire) et parse le
                // moov/tkhd du même buffer → qualité réelle (« 1080p », « 4K »)
                // même quand l'URL ne porte aucun motif de résolution.
                try {
                    const sniff = await fetchBytes(st.url, {
                        method: 'GET',
                        headers: Object.assign({}, headers, { Range: MOOV_RANGE, Accept: '*/*' }),
                        timeout: Math.min(MOOV_MS, left()),
                    });
                    const u8 = sniff.bytes;
                    if (!u8 || !u8.length) return { ok: null, why: 'corps vide (content-type mensonger)' };
                    if (bytesLookHtml(u8)) return { ok: false, why: 'corps HTML (content-type mensonger)' };
                    // Binaire non-HTML accepté (signature ftyp probable mais
                    // non exigée : certains conteneurs démarrent autrement).
                    let q = qualityFromUrl(res.finalUrl || st.url);
                    if (!q) q = mp4QualityLabel(mp4MaxHeight(u8));
                    return { ok: true, quality: q, why: 'content-type mensonger, média confirmé' };
                } catch (err2) {
                    if (neutralErr(err2)) return { ok: null, why: 'sonde interrompue' };
                    return { ok: null, why: 'goûtage impossible (content-type mensonger)' };
                }
            }
            // v3.1.10 : qualité réelle du MP4 quand l'URL n'en dit rien.
            let q = qualityFromUrl(res.finalUrl || st.url);
            if (!q) q = await mp4HeadQuality(st, headers, left);
            return { ok: true, quality: q };
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
    const masterQ = bestHlsQuality(text);

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
    if (!seg || !deep) return { ok: true, quality: masterQ };

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
        return { ok: true, quality: masterQ };
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
 * @returns {Promise<Array>} flux sans les liens prouvés morts (vivant/inconnu)
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
        let dropped = 0;
        (streams || []).forEach(function (st, i) {
            const r = i < res.length ? res[i] : { ok: null };
            console.log(
                '[verify] ' + (r.ok === true ? 'OK ' : r.ok === false ? 'KO ' : '?  ') +
                    st.name + ' · ' + (r.why || '') + ' · ' + st.url
            );
            // Qualité réelle détectée par la sonde (RESOLUTION HLS / motif URL)
            // : remplace le libellé générique « Direct » / « Auto (HLS) » —
            // Nuvio affiche ce champ tel quel dans la liste.
            if (r.quality) st.quality = r.quality;
            if (r.ok === false) {
                // Gowaru, « anti flux-qui-ne-lance-jamais » : un lien prouvé
                // mort (403/404, page HTML là où on attend un flux, segment
                // refusé) n'est PAS affiché — servir produirait le panneau
                // « lien ne fonctionne pas » ou un buffering infini.
                dropped++;
                return;
            }
            good.push(st);
        });
        if (dropped) {
            console.log('[verify] ' + dropped + ' lien(s) mort(s) retiré(s) de la liste');
        }
        return good;
    });
}
