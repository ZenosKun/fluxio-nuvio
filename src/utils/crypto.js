/**
 * SHA-256 et AES-GCM en JS pur pour le runtime Nuvio.
 *
 * Utilisés par :
 *   - bflix (vidnest) : clé = SHA-256(nonce + "|" + secret), réponse AES-GCM v2 ;
 *   - netu            : config « playback » chiffrée AES-GCM.
 *
 * Le déchiffrement GCM n'a pas besoin de calculer/valider le tag : on
 * déchiffre uniquement le flux CTR (les sources sont de confiance, le tag
 * ne protège que contre la corruption).
 */

import { utf8Encode, utf8Decode } from './text.js';

/* ─────────────────────────────── SHA-256 ───────────────────────────────── */

const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 de bytes (ou d'une chaîne, encodée UTF-8) → Uint8Array(32). */
export function sha256(input) {
    const msg = typeof input === 'string' ? utf8Encode(input) : new Uint8Array(input || 0);
    const len = msg.length;
    const bitLenHi = Math.floor(len / 0x20000000);
    const bitLenLo = (len << 3) >>> 0;

    // message + 0x80 + padding + longueur 64 bits
    const total = (((len + 9 + 63) >> 6) << 6);
    const block = new Uint8Array(total);
    block.set(msg);
    block[len] = 0x80;
    const dv = new DataView(block.buffer);
    dv.setUint32(total - 8, bitLenHi);
    dv.setUint32(total - 4, bitLenLo);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Int32Array(64);

    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const x = w[i - 15];
            const y = w[i - 2];
            const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
            const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + t1) | 0;
            d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }

    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, h0); odv.setUint32(4, h1); odv.setUint32(8, h2); odv.setUint32(12, h3);
    odv.setUint32(16, h4); odv.setUint32(20, h5); odv.setUint32(24, h6); odv.setUint32(28, h7);
    return out;
}

/* ────────────────────────── AES (sens chiffrement) ─────────────────────── */

const SBOX = new Uint8Array([
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);
const RCON = new Uint8Array([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d]);

/** Développe la clé (128/256 bits) → mots 32 bits du rythme. */
function expandKey(key) {
    const nk = key.length / 4; // 4 ou 8
    const nr = nk + 6;        // 10 ou 14 rondes
    const total = 4 * (nr + 1);
    const w = new Uint32Array(total);
    const dv = new DataView(key.buffer, key.byteOffset, key.byteLength);
    for (let i = 0; i < nk; i++) w[i] = dv.getUint32(i * 4);
    for (let i = nk; i < total; i++) {
        let temp = w[i - 1];
        if (i % nk === 0) {
            temp = ((temp << 8) | (temp >>> 24)) >>> 0; // RotWord
            temp =
                ((SBOX[(temp >>> 24) & 0xff] << 24) |
                    (SBOX[(temp >>> 16) & 0xff] << 16) |
                    (SBOX[(temp >>> 8) & 0xff] << 8) |
                    SBOX[temp & 0xff]) >>> 0;
            temp = (temp ^ (RCON[i / nk - 1] << 24)) >>> 0;
        } else if (nk > 6 && i % nk === 4) {
            temp =
                ((SBOX[(temp >>> 24) & 0xff] << 24) |
                    (SBOX[(temp >>> 16) & 0xff] << 16) |
                    (SBOX[(temp >>> 8) & 0xff] << 8) |
                    SBOX[temp & 0xff]) >>> 0;
        }
        w[i] = (w[i - nk] ^ temp) >>> 0;
    }
    return { w: w, nr: nr };
}

const XTIME = (() => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        let v = i << 1;
        if (v & 0x100) v ^= 0x11b;
        t[i] = v & 0xff;
    }
    return t;
})();

/** Chiffre un bloc de 16 octets (AES-CTR côté réception : on chiffre les compteurs). */
function encryptBlock(ctx, blockIn, blockOut) {
    const { w, nr } = ctx;
    const s = new Uint8Array(16);

    // AddRoundKey(0) — w[] est un Uint32Array : on lit les mots par indice JS
    // (un DataView big-endian sur le buffer inverserait les octets).
    for (let c = 0; c < 4; c++) {
        const k = w[c];
        s[c * 4] = blockIn[c * 4] ^ (k >>> 24);
        s[c * 4 + 1] = blockIn[c * 4 + 1] ^ ((k >>> 16) & 0xff);
        s[c * 4 + 2] = blockIn[c * 4 + 2] ^ ((k >>> 8) & 0xff);
        s[c * 4 + 3] = blockIn[c * 4 + 3] ^ (k & 0xff);
    }

    for (let round = 1; round <= nr; round++) {
        // SubBytes + ShiftRows
        const t = new Uint8Array(16);
        for (let i = 0; i < 16; i++) t[i] = SBOX[s[i]];
        let tmp;
        // rangée 1 : décalage 1
        tmp = t[1]; t[1] = t[5]; t[5] = t[9]; t[9] = t[13]; t[13] = tmp;
        // rangée 2 : décalage 2
        tmp = t[2]; t[2] = t[10]; t[10] = tmp; tmp = t[6]; t[6] = t[14]; t[14] = tmp;
        // rangée 3 : décalage 3 (inverse du décalage 1)
        tmp = t[15]; t[15] = t[11]; t[11] = t[7]; t[7] = t[3]; t[3] = tmp;
        // MixColumns (sauf dernière ronde)
        if (round < nr) {
            for (let c = 0; c < 4; c++) {
                const o = c * 4;
                const a0 = t[o], a1 = t[o + 1], a2 = t[o + 2], a3 = t[o + 3];
                const x = a0 ^ a1 ^ a2 ^ a3;
                t[o] = a0 ^ x ^ XTIME[a0 ^ a1];
                t[o + 1] = a1 ^ x ^ XTIME[a1 ^ a2];
                t[o + 2] = a2 ^ x ^ XTIME[a2 ^ a3];
                t[o + 3] = a3 ^ x ^ XTIME[a3 ^ a0];
            }
        }
        // AddRoundKey(round)
        for (let c = 0; c < 4; c++) {
            const k = w[round * 4 + c];
            s[c * 4] = t[c * 4] ^ (k >>> 24);
            s[c * 4 + 1] = t[c * 4 + 1] ^ ((k >>> 16) & 0xff);
            s[c * 4 + 2] = t[c * 4 + 2] ^ ((k >>> 8) & 0xff);
            s[c * 4 + 3] = t[c * 4 + 3] ^ (k & 0xff);
        }
    }
    blockOut.set(s);
}

/* ─────────────────────────────── AES-GCM ───────────────────────────────── */

/**
 * Chiffrement ECB d'un bloc (exposé pour les tests vectoriels du cœur AES ;
 * AES-GCM l'utilise en interne pour les compteurs CTR).
 */
export function aesEcbEncryptBlock(key, block16) {
    const ctx = expandKey(key);
    const out = new Uint8Array(16);
    encryptBlock(ctx, block16, out);
    return out;
}

/**
 * Déchiffre une payload AES-GCM (IV 96 bits standard, tag ignoré).
 * @param {Uint8Array} key    16 ou 32 octets
 * @param {Uint8Array} iv     12 octets (IV 96 bits ; GCM des sources visées)
 * @param {Uint8Array} data   ciphertext + tag éventuel (tag ignoré)
 * @returns {Uint8Array} plaintext
 */
export function aesGcmDecrypt(key, iv, data) {
    if (iv.length !== 12) throw new Error('AES-GCM: IV de 12 octets requis (reçu ' + iv.length + ')');
    const ctx = expandKey(key);

    // J0 = IV || 0x00000001 ; premier compteur de données = J0 + 1
    const counter = new Uint8Array(16);
    counter.set(iv);
    counter[15] = 2;

    const out = new Uint8Array(data.length);
    const ks = new Uint8Array(16);
    const n = data.length;
    for (let off = 0; off < n; off += 16) {
        encryptBlock(ctx, counter, ks);
        const chunk = Math.min(16, n - off);
        for (let i = 0; i < chunk; i++) out[off + i] = data[off + i] ^ ks[i];
        // inc32
        for (let i = 15; i >= 12; i--) {
            counter[i] = (counter[i] + 1) & 0xff;
            if (counter[i]) break;
        }
    }
    return out;
}

/** Déchiffre et décode en JSON (cas vidnest / netu). */
export function aesGcmDecryptJson(key, iv, data) {
    const plain = aesGcmDecrypt(key, iv, data);
    return JSON.parse(utf8Decode(plain));
}
