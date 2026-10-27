/**
 * Décodeurs partagés vidzy / premium (fsvid.lol) — portage de
 * sestudio/providers/vidzy.py.
 *
 * Les embeds récents obfusquent la source : le src est produit par une
 * fonction inline qui décode du base64 puis XOR chaque octet avec une clé
 * tournante (tableau littéral, rampe arithmétique, offset domaine, offset
 * layout…). Les URLs .m3u8 en clair laissées dans la page sont des leurres.
 *
 * Stratégie : générer *chaque* keystream que le corps décrit et valider le
 * résultat — une clé fausse ne peut pas produire « .m3u8 », donc deviner
 * est sans risque.
 */

import { base64Decode, utf8Decode } from '../utils/text.js';
import { fetchJsonSafe } from '../utils/http.js';

const INLINE_SRC_RE =
    /src\s*:\s*\(function\(s\)\{([\s\S]{0,4000}?)\}\)\("([A-Za-z0-9+/=]+)"\)/;
const ARRAY_KEY_RE = /k=\[([\d,]+)\]/g;
const RAMP_KEY_RE =
    /\(\s*(0x[0-9a-fA-F]+|\d+)\s*\+\s*i\s*\*\s*(\d+)\s*(?:\+\s*[A-Za-z_$][\w$]*\s*)*\)\s*&\s*255/g;
const LAYOUT_RE =
    /calc\(\s*1in\s*\+\s*(\d+)px\s*\)[\s\S]*?calc\(\s*100%\s*-\s*(\d+)px\s*\)/;
const SRC_RE = /src\s*:\s*["']([^"']+\.m3u8[^"']*)["']/;

// La gate remet une clé ajoutée à l'URL (gk=) ; sans elle ~90 s seulement jouent.
const GATE_RE = /https:\/\/[\w.-]+\/gate\.php/;
const GATE_PARAMS = {
    v: 'p1',
    cw: '141.48',
    cw2: '155.03',
    wg: '1',
    dpr: '1',
    sw: '1920',
    hw: '8',
    ft: 'https://fstream.top',
    rf: 'fstream.top',
};

/** Somme des char codes du hostname, mod 256 (le « H » de l'embed). */
function hostOffset(hostname) {
    let total = 0;
    const h = String(hostname || '');
    for (let i = 0; i < h.length; i++) {
        total = (total + h.charCodeAt(i)) & 255;
    }
    return total;
}

/** Tous les keystreams plausibles que le corps décrit (tableaux + rampes). */
function keystreams(body, length, hostname) {
    const streams = [];
    let am;
    ARRAY_KEY_RE.lastIndex = 0;
    while ((am = ARRAY_KEY_RE.exec(body)) !== null) {
        const key = am[1].split(',').map(x => parseInt(x, 10)).filter(Number.isFinite);
        if (key.length) {
            const ks = new Array(length);
            for (let i = 0; i < length; i++) ks[i] = key[i % key.length];
            streams.push(ks);
        }
    }

    const host = hostOffset(hostname);
    const layout = LAYOUT_RE.exec(body);
    const layoutOffset = layout ? 96 + parseInt(layout[1], 10) - parseInt(layout[2], 10) : 0;
    const offsets = {};
    [0, host, layoutOffset, host + layoutOffset].forEach(o => { offsets[o] = true; });

    let rm;
    RAMP_KEY_RE.lastIndex = 0;
    while ((rm = RAMP_KEY_RE.exec(body)) !== null) {
        const seed = rm[1].toLowerCase().indexOf('0x') === 0 ? parseInt(rm[1], 16) : parseInt(rm[1], 10);
        const step = parseInt(rm[2], 10);
        if (!Number.isFinite(seed) || !Number.isFinite(step)) continue;
        for (const offStr of Object.keys(offsets)) {
            const off = parseInt(offStr, 10) || 0;
            const ks = new Array(length);
            for (let i = 0; i < length; i++) ks[i] = (seed + i * step + off) & 255;
            streams.push(ks);
        }
    }
    return streams;
}

function reverse(s) {
    return s.split('').reverse().join('');
}

/**
 * Retrouve la vraie URL m3u8 depuis le corps du décodeur + sa payload base64.
 * @returns {string} l'URL décodée
 * @throws Error si aucun schéma connu ne décode
 */
export function deobfuscateSrc(body, payloadB64, hostname) {
    const raw = base64Decode(payloadB64);
    let tried = 0;

    for (const ks of keystreams(body, raw.length, hostname)) {
        for (let srcFlip = 0; srcFlip < 2; srcFlip++) {
            const source = srcFlip === 0 ? raw : reverseBytes(raw);
            let decoded = '';
            for (let i = 0; i < source.length; i++) {
                decoded += String.fromCharCode(source[i] ^ ks[i]);
            }
            for (let flip = 0; flip < 2; flip++) {
                const candidate = flip === 0 ? decoded : reverse(decoded);
                tried++;
                if (candidate.indexOf('.m3u8') !== -1 && candidate.indexOf('/troll/') === -1) {
                    return candidate;
                }
            }
        }
    }
    throw new Error(
        'aucun schéma d obfuscation connu n a décodé le src (' + tried +
        ' combinaisons testées) — l embed a probablement pivoté vers un nouveau'
    );
}

function reverseBytes(arr) {
    const out = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[arr.length - 1 - i];
    return out;
}

/** Ancien format « src: "….m3u8" » en clair, ou null. */
export function plainSrc(unpacked) {
    const m = SRC_RE.exec(unpacked);
    return m ? m[1] : null;
}

/**
 * Ajoute la clé gate à l'URL si la page en déclare une. Sans réponse de la
 * gate, on renvoie l'URL telle quelle (le début de la vidéo joue quand même).
 */
export async function withGateKey(page, streamUrl, referer, timeoutMs) {
    const gate = GATE_RE.exec(page);
    if (!gate) return streamUrl;

    const qs = Object.keys(GATE_PARAMS)
        .map(k => k + '=' + encodeURIComponent(GATE_PARAMS[k]))
        .join('&');
    try {
        const data = await fetchJsonSafe(gate[0] + '?' + qs, {
            timeout: Math.min(timeoutMs || 10000, 10000),
            headers: { Origin: String(referer || '').replace(/\/$/, ''), Referer: referer || '' },
        });
        const key = data && data.gk ? String(data.gk) : '';
        if (!key) return streamUrl;
        return streamUrl + (streamUrl.indexOf('?') !== -1 ? '&' : '?') + 'gk=' + encodeURIComponent(key);
    } catch (e) {
        console.warn('[sestudio] gate vidzy muette (≈90 s jouables) : ' + (e && e.message ? e.message : e));
        return streamUrl;
    }
}

/** Décode base64 → chaîne (utilisé par les tests). */
export function b64ToString(b64) {
    return utf8Decode(base64Decode(b64));
}
