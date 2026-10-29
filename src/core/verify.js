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
 *   v3.1.12 : si la tête ne donne rien (moov en FIN de fichier — non
 *   faststart, surtout 4K HEVC), sonde de QUEUE par suffix range (256 Ko
 *   puis 1 Mo) : le lecteur voyait 3840×2160 là où on affichait « Direct ».
 * - Anti-écran-noir uqload/vidhide (v3.1.13) : leurs masters déclarent des
 *   pistes audio SÉPARÉES (EXT-X-MEDIA, AAC Mono) alors que les variantes
 *   vidéo index-v1-aN.m3u8 sont MUXÉES avec UNE langue figée (a2 = anglais
 *   vérifié live — Fall 2 : écran noir + son qui avance chez l'utilisateur ;
 *   le français n'existait que dans la rendition séparée). On sert alors
 *   DIRECTEMENT la variante muxée de la langue du flux (vf → a1 français),
 *   validée par un fetch avant de remplacer l'URL : playlist média triviale
 *   vidéo+audio, plus aucun groupe audio à négocier côté lecteur.
 * - Redirections détectées : toute réponse HTML là où on attend un flux
 *   (playlist, variante, MP4) est un échec (ex. proxy → page captcha).
 * - v3.1.17 — chaîne de redirections payée UNE fois : fastflux/webflix est
 *   une chaîne 3 sauts (cdn80.zen-blk.store → proxy falzey.lol → URL signée
 *   ?ff=), 0,7 à 3,5 s mesurés live. Le goûtage qualité et les requêtes
 *   suivantes (ciblage moov, suffix ranges de queue) partent de l'URL
 *   FINALE de la première réponse (res.finalUrl) : 1 saut au lieu de 3 —
 *   avant, le sniff repartait de l'URL d'origine, dépassait le budget de
 *   sonde sur device et la qualité restait « Direct ». Un timeout de NOTRE
 *   sonde (« timeout réseau ») devient neutre (« ? ») : ce n'est pas une
 *   preuve de mort du lien.
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
import { mp4MaxHeight, mp4QualityLabel, bytesLookHtml, standardHeight, mp4MoovStartOffset } from '../utils/mp4.js';

const PROBE_MS = 4000;
const PROBE_MAX = 10;
const PROBE_BUDGET_MS = 8000;
const MIN_REMAINING_MS = 1500;
const DEEP_MAX = 8; // sonde approfondie (segment) : 8 premiers liens
const SEGMENT_RANGE = 'bytes=0-16383';
/** Plages lues pour la qualité MP4 (moov/tkhd) :
 *  - TÊTE 128 Ko : moov des fichiers faststart (ftyp + moov avant mdat) ;
 *  - QUEUE 256 Ko puis 1 Mo (v3.1.12) : moov des fichiers NON faststart —
 *    surtout 4K HEVC — où le moov est en fin de fichier. Escalade car le
 *    moov d'un long métrage (tables stsz/stco) dépasse souvent 256 Ko, et le
 *    tkhd vit au DÉBUT du moov : le chunk doit remonter jusqu'à son début.
 *  Borné : 2 requêtes max, timeout 2,5 s chacune, jamais au-delà du temps
 *  restant de la sonde ; un serveur qui ignore le Range (200) est parsé tel
 *  quel sans escalade (le corps est déjà le fichier entier). */
const MOOV_RANGE = 'bytes=0-131071';
const MOOV_RANGE_BYTES = 131072;
const MOOV_TAIL_RANGES = ['bytes=-262144', 'bytes=-1048576'];
const MOOV_MS = 2500;

/**
 * Qualité réelle d'un MP4 direct, en 3 étapes bornées (v3.1.16) — remplace
 * la chaîne tête + queue aveugle de v3.1.12 :
 *   1. TÊTE 128 Ko : moov faststart (tkhd dans les premiers octets du moov)
 *      — le cas Fall 2 fastflux (Fall-2-HD-2026.mp4 : ftyp 32 o, moov 6,6 Mo
 *      dès l'offset 32, tkhd 1280×720 → « 720p »).
 *   2. CIBLAGE chirurgical : le chunk de tête annonce ftyp/mdat… l'en-tête
 *      du mdat (offset + taille déclarée) donne le début PILE du moov non
 *      faststart — un Range à cet offset tombe sur le tkhd au premier essai,
 *      là où les suffix ranges de queue échouent (moov > 1 Mo d'un long
 *      métrage : la queue n'atteint jamais le début du moov).
 *   3. Repli v3.1.12 : suffix ranges de queue (256 Ko puis 1 Mo) pour les
 *      layouts exotiques — un serveur qui ignore le Range (200) est parsé
 *      tel quel sans escalade, HTML réel → '' (média mensonger).
 * Échec silencieux → '' (on n'invente rien). `headRes` = réponse déjà
 * lue par le goûtage content-type mensonger (une requête de moins).
 */
async function mp4FileQuality(st, headers, left, headRes) {
    let head = headRes || null;
    if (!head) {
        try {
            head = await fetchBytes(st.url, {
                method: 'GET',
                headers: Object.assign({}, headers, { Range: MOOV_RANGE, Accept: '*/*' }),
                timeout: Math.min(MOOV_MS, left()),
            });
        } catch (e) {
            return ''; // goûtage impossible : qualité inconnue, le lien reste « ? »/OK
        }
    }
    const hb = head && head.bytes;
    if (!hb || !hb.length || bytesLookHtml(hb)) return '';
    let q = mp4QualityLabel(mp4MaxHeight(hb));
    if (q) return q;
    // v3.1.17 : les requêtes suivantes partent de l'URL FINALE (redirections
    // déjà suivies par la 1re requête). Chaîne fastflux mesurée live : 3 sauts
    // (cdn80.zen-blk.store → proxy falzey.lol → URL signée ?ff=) pour 0,7 à
    // 3,5 s — repayer la chaîne à chaque étape dépassait le budget de sonde
    // sur device et laissait le flux étiqueté « Direct » malgré un tkhd lisible.
    const signed = (head && head.finalUrl) || st.url;
    // Étape 2 : le moov non faststart commence pile après le mdat annoncé.
    const moovStart = mp4MoovStartOffset(hb);
    if (moovStart >= 0) {
        try {
            const res = await fetchBytes(signed, {
                method: 'GET',
                headers: Object.assign({}, headers, {
                    Range: 'bytes=' + moovStart + '-' + (moovStart + MOOV_RANGE_BYTES - 1),
                    Accept: '*/*',
                }),
                timeout: Math.min(MOOV_MS, left()),
            });
            const u8 = res.bytes;
            if (u8 && u8.length && !bytesLookHtml(u8)) {
                // Chunk aligné sur le début du moov : le parcours strict lit
                // le tkhd (mvhd + trak/tkhd dans les ~300 premiers octets).
                q = mp4QualityLabel(mp4MaxHeight(u8));
                if (q) return q;
            }
        } catch (e) {
            /* repli queue (étape 3) */
        }
    }
    // Étape 3 : suffix ranges de queue (v3.1.12, layouts non canoniques).
    return mp4TailQuality(st, headers, left, signed);
}

/**
 * Sonde de QUEUE (v3.1.12) : moov en fin de fichier (non faststart — surtout
 * 4K HEVC, cf. retour utilisateur : fastflux webflix affiché « Direct » alors
 * que le lecteur montre 3840×2160 HEVC). Suffix range 256 Ko puis 1 Mo —
 * mp4MaxHeight retrouve le tkhd par signature même si le chunk démarre au
 * milieu d'une boîte. Un serveur qui ignore le Range (200 au lieu de 206)
 * envoie le fichier ENTIER : on le parse tel quel et on n'escalade pas (un
 * second suffix range donnerait le même corps). HTML réel → '' (média
 * mensonger, déjà tranché par le chemin « content-type »). Échec silencieux
 * → '' (on n'invente rien).
 */
async function mp4TailQuality(st, headers, left, baseUrl) {
    const target = baseUrl || st.url; // v3.1.17 : URL finale si connue (1 saut)
    for (let i = 0; i < MOOV_TAIL_RANGES.length; i++) {
        try {
            const res = await fetchBytes(target, {
                method: 'GET',
                headers: Object.assign({}, headers, { Range: MOOV_TAIL_RANGES[i], Accept: '*/*' }),
                timeout: Math.min(MOOV_MS, left()),
            });
            const u8 = res.bytes;
            if (!u8 || !u8.length || bytesLookHtml(u8)) return '';
            const q = mp4QualityLabel(mp4MaxHeight(u8));
            if (q) return q;
            if (res.status === 200) return ''; // Range ignoré : corps = fichier entier
        } catch (e) {
            return ''; // goûtage impossible : qualité inconnue, le lien reste OK
        }
    }
    return '';
}

/** Meilleure résolution annoncée par une playlist maître HLS → « 1080p », « 4K »…
 *  Bucket standard par largeur (v3.1.12) : une variante 1920×800 (crop scope)
 *  vaut « 1080p » comme chez le lecteur — la hauteur seule donnait « 800p ».
 *  Une playlist média (sans #EXT-X-STREAM-INF) ne annonce pas de RESOLUTION
 *  multi-variantes : on ignore alors (chaîne vide). */
export function bestHlsQuality(text) {
    let best = 0;
    const re = /RESOLUTION=(\d+)x(\d+)/gi;
    let m;
    const t = String(text || '');
    while ((m = re.exec(t)) !== null) {
        const tier = standardHeight(parseInt(m[1], 10), parseInt(m[2], 10));
        if (tier > best) best = tier;
    }
    return best ? resolutionLabel(best) : '';
}

/**
 * Variante muxée de la bonne langue (v3.1.13, anti-écran-noir uqload/vidhide).
 *
 * Retour utilisateur : uqload Fall 2 — « 1080p • VF » mais écran noir, l'audio
 * avance (AAC Mono FR). Diagnostic live : le master déclare des renditions
 * audio SÉPARÉES (EXT-X-MEDIA Français/English, Mono) ET des variantes vidéo
 * index-v1-aN.m3u8 qui sont MUXÉES avec UNE seule langue figée — ici a2
 * (anglais) pour TOUTES les variantes. Certains lecteurs (ExoPlayer) rendent
 * alors la rendition audio séparée… et n'affichent jamais la vidéo. Le
 * français muxé existe pourtant : index-v1-a1.m3u8 (PMT 0x1b AVC + 0xf AAC,
 * vérifié live). On choisit donc nous-mêmes la variante : le lecteur reçoit
 * une playlist média triviale (vidéo+audio muxés, zéro groupe, zéro
 * variante) — le format que TOUS les lecteurs savent jouer.
 *
 * Règles (conservateur) :
 *  - seulement si le master déclare EXT-X-MEDIA (pistes séparées) ;
 *  - seulement pour une langue FR du flux (vf/vfq/vff — la VF doublée ;
 *    VOSTFR et VO gardent le master : le muxé fixerait l'audio français) ;
 *  - suffixe aN mappé par l'attribut LANGUAGE= des MEDIA (jamais déduit du
 *    hasard : a1 = la langue que le master appelle « fr ») ;
 *  - toutes les variantes doivent porter le motif index-vN-aN.m3u8 (famille
 *    vidhide) — sinon on ne touche à rien ;
 *  - la plus haute BANDWIDTH est choisie (meilleure qualité), query token
 *    préservée ; le caller valide la playlist avant de remplacer l'URL.
 * @returns {string} URI de la variante muxée ('' = pas de remplacement)
 */
export function muxedVariantUrl(masterText, language) {
    const t = String(masterText || '');
    const lang = String(language || '').toUpperCase();
    if (!/#EXT-X-MEDIA/i.test(t)) return ''; // master simple : rien à régler
    if (lang.indexOf('VF') !== 0 || lang.indexOf('VOST') === 0) return ''; // VF/VFQ/VFF seulement
    const lang2suffix = {};
    const reMedia = /#EXT-X-MEDIA:[^\r\n]*/gi;
    let m;
    while ((m = reMedia.exec(t)) !== null) {
        const line = m[0];
        const um = /URI="([^"]+)"/i.exec(line);
        const sm = um ? /index-(a\d+)\.m3u8/i.exec(um[1]) : null;
        if (!sm) continue;
        // v3.1.14 : l'attribut LANGUAGE peut être régional (« fr-FR », « fr-CA »
        // — VFQ) et certains masters n'écrivent QUE NAME (« Français », «
        // French »). On normalise : premier mot avant espace/parenthèse/tiret.
        const lm = /LANGUAGE="([^"]*)"/i.exec(line);
        const raw = lm ? lm[1] : ((/NAME="([^"]*)"/i.exec(line) || [])[1] || '');
        const key = String(raw).trim().toLowerCase().split(/[\s(-]/)[0];
        if (/^(fr|fra|fre|français|francais|french)$/.test(key)) lang2suffix.fr = sm[1];
        else if (key) lang2suffix[key] = sm[1];
    }
    const suffix = lang2suffix.fr || lang2suffix.fra || lang2suffix.fre;
    if (!suffix) return '';
    const reVar = /#EXT-X-STREAM-INF:([^\r\n]*)\r?\n([^\r\n#][^\r\n]*)/gi;
    let best = '';
    let bestBw = -1;
    while ((m = reVar.exec(t)) !== null) {
        const url = m[2].trim();
        if (!/index-v\d+-a\d+\.m3u8/i.test(url)) return ''; // motif inattendu : on n'invente rien
        const bw = parseInt((/BANDWIDTH=(\d+)/i.exec(m[1]) || [0, '0'])[1], 10) || 0;
        if (bw > bestBw) { bestBw = bw; best = url; }
    }
    if (!best) return '';
    return best.replace(/-a\d+\.m3u8/i, '-' + suffix + '.m3u8');
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

/** Erreur imputable à NOUS (budget global épuisé, disjoncteur, timeout de
 *  notre sonde) — pas au lien. v3.1.17 ajoute « timeout réseau » : notre
 *  échéance de course n'est pas une preuve de mort — la chaîne fastflux
 *  mesure 0,7 à 3,5 s depuis un datacenter (3 sauts : CDN → proxy → URL
 *  signée) et dépasse régulièrement nos 4 s sur device mobile, alors que le
 *  lecteur, lui, finit par suivre la chaîne. Bug live constaté : FastFlux
 *  retiré de la liste après un simple HEAD trop lent. */
function neutralErr(err) {
    return /budget épuisé|disjoncteur|timeout réseau/.test(String((err && err.message) || ''));
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
                    // v3.1.17 : goûtage sur l'URL FINALE du HEAD (res.finalUrl
                    // = URL signée après la chaîne 3 sauts déjà payée) — 1 saut
                    // au lieu de 3, le sniff rentre dans le budget restant de
                    // la sonde même sur device mobile.
                    const sniffUrl = res.finalUrl || st.url;
                    const sniff = await fetchBytes(sniffUrl, {
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
                    if (!q) q = await mp4FileQuality(st, headers, left, sniff); // réutilise le goûtage
                    return { ok: true, quality: q, why: 'content-type mensonger, média confirmé' };
                } catch (err2) {
                    if (neutralErr(err2)) return { ok: null, why: 'sonde interrompue' };
                    return { ok: null, why: 'goûtage impossible (content-type mensonger)' };
                }
            }
            // v3.1.10 : qualité réelle du MP4 quand l'URL n'en dit rien.
            let q = qualityFromUrl(res.finalUrl || st.url);
            if (!q) q = await mp4FileQuality(st, headers, left, null); // tête → ciblage moov → queue
            return { ok: true, quality: q };
        } catch (err) {
            // Neutralité (v3.1.16) : une sonde arrêtée par NOTRE disjoncteur
            // (hôte mis en quarantaine 2 min — ex. sniff de qualité trop lent
            // sous charge) ou par le budget global n'est pas une preuve de
            // mort du lien — « ? » conservé, jamais « KO ».
            if (neutralErr(err)) return { ok: null, why: 'sonde interrompue (disjoncteur/budget)' };
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

    // Étape 1.5 (v3.1.13) : anti-écran-noir uqload/vidhide — remplacer le
    // master multi-pistes par la variante MUXÉE de la langue du flux
    // (vf → pistes « fr » du master). La playlist candidate est VALIDÉE par
    // un fetch (200 + #EXTINF) : en cas d'échec on garde le master.
    const swapUri = muxedVariantUrl(text, st.language);
    if (swapUri) {
        const muxUrl = resolveUrl(res.finalUrl || st.url, swapUri);
        try {
            const muxRes = await fetchText(muxUrl, { method: 'GET', headers: headers, timeout: left() });
            const muxText = String((muxRes && muxRes.text) || '');
            if (!looksHtml(muxText) && /#EXTINF/i.test(muxText)) {
                st.url = muxRes.finalUrl || muxUrl;
                text = muxText;
                console.log('[verify] variante muxée langue servie directement (anti écran-noir) : ' + st.url);
            }
        } catch (e) {
            /* master conservé */
        }
    }

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
