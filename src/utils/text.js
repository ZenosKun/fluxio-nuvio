/**
 * Primitives texte/bytes pour le runtime Nuvio (Hermes / QuickJS).
 *
 * Ces runtimes n'ont ni Buffer, ni atob/btoa, ni TextEncoder/TextDecoder
 * garantis (surtout sur TV). Tout est donc réimplémenté en JS pur — les
 * fonctions natives sont utilisées seulement si elles existent.
 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/* ─────────────────────────────── UTF-8 ─────────────────────────────────── */

/** Chaîne JS → tableau d'octets UTF-8. */
export function utf8Encode(str) {
    const s = String(str || '');
    if (typeof TextEncoder === 'function') {
        try {
            return new TextEncoder().encode(s);
        } catch (e) {
            /* repli JS pur */
        }
    }
    const out = [];
    for (let i = 0; i < s.length; i++) {
        let code = s.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
            const lo = s.charCodeAt(i + 1);
            if (lo >= 0xdc00 && lo <= 0xdfff) {
                code = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00);
                i++;
            }
        }
        if (code < 0x80) {
            out.push(code);
        } else if (code < 0x800) {
            out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
            out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        } else {
            out.push(
                0xf0 | (code >> 18),
                0x80 | ((code >> 12) & 0x3f),
                0x80 | ((code >> 6) & 0x3f),
                0x80 | (code & 0x3f)
            );
        }
    }
    return new Uint8Array(out);
}

/** Tableau d'octets UTF-8 → chaîne JS (séquences invalides remplacées). */
export function utf8Decode(bytes) {
    if (!bytes || !bytes.length) return '';
    if (typeof TextDecoder === 'function') {
        try {
            return new TextDecoder('utf-8').decode(bytes);
        } catch (e) {
            /* repli JS pur */
        }
    }
    let out = '';
    let i = 0;
    const n = bytes.length;
    while (i < n) {
        const b = bytes[i];
        let code;
        if (b < 0x80) {
            code = b;
            i += 1;
        } else if (b >= 0xc2 && b < 0xe0 && i + 1 < n) {
            code = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
            i += 2;
        } else if (b >= 0xe0 && b < 0xf0 && i + 2 < n) {
            code = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
            i += 3;
        } else if (b >= 0xf0 && b < 0xf5 && i + 3 < n) {
            code =
                ((b & 0x07) << 18) |
                ((bytes[i + 1] & 0x3f) << 12) |
                ((bytes[i + 2] & 0x3f) << 6) |
                (bytes[i + 3] & 0x3f);
            i += 4;
        } else {
            code = 0xfffd; // U+FFFD replacement character
            i += 1;
        }
        if (code > 0xffff) {
            code -= 0x10000;
            out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
        } else {
            out += String.fromCharCode(code);
        }
    }
    return out;
}

/* ─────────────────────────────── Base64 ────────────────────────────────── */

function base64DecodeInternal(input, alphabet) {
    const lookup = {};
    for (let i = 0; i < alphabet.length; i++) lookup[alphabet[i]] = i;
    const clean = String(input || '').replace(/[^A-Za-z0-9+/=\-_]/g, '');
    const out = [];
    let bits = 0;
    let acc = 0;
    for (let i = 0; i < clean.length; i++) {
        const c = clean[i];
        if (c === '=') break;
        const v = lookup[c];
        if (v === undefined) continue;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((acc >> bits) & 0xff);
        }
    }
    return new Uint8Array(out);
}

/** Base64 → bytes. Tolérant : espaces/retours ignorés, alphabet URL accepté, padding facultatif. */
export function base64Decode(input) {
    return base64DecodeInternal(input, B64_ALPHABET);
}

/** Base64-URL → bytes (padding facultatif). */
export function base64UrlDecode(input) {
    return base64DecodeInternal(input, B64_URL_ALPHABET);
}

function base64EncodeInternal(bytes, alphabet, pad) {
    const out = [];
    const len = bytes.length;
    for (let i = 0; i < len; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < len ? bytes[i + 1] : 0;
        const b2 = i + 2 < len ? bytes[i + 2] : 0;
        out.push(alphabet[b0 >> 2]);
        out.push(alphabet[((b0 & 3) << 4) | (b1 >> 4)]);
        out.push(i + 1 < len ? alphabet[((b1 & 15) << 2) | (b2 >> 6)] : pad ? '=' : '');
        out.push(i + 2 < len ? alphabet[b2 & 63] : pad ? '=' : '');
    }
    return out.join('');
}

/** bytes → Base64 standard. */
export function base64Encode(bytes) {
    return base64EncodeInternal(bytes, B64_ALPHABET, true);
}

/** bytes → Base64-URL sans padding. */
export function base64UrlEncode(bytes) {
    return base64EncodeInternal(bytes, B64_URL_ALPHABET, false);
}

/** Hex → bytes. */
export function hexDecode(hex) {
    const s = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
    const out = new Uint8Array(s.length >> 1);
    for (let i = 0; i + 1 < s.length; i += 2) {
        out[i >> 1] = parseInt(s.substr(i, 2), 16);
    }
    return out;
}

/** bytes → hex minuscule. */
export function hexEncode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return out;
}

/**
 * Nonce aléatoire base64-URL (16 octets). crypto.getRandomValues s'il existe,
 * sinon Math.random (suffisant pour un nonce anti-cache).
 */
export function makeNonce() {
    const bytes = new Uint8Array(16);
    try {
        if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
            crypto.getRandomValues(bytes);
            return base64UrlEncode(bytes);
        }
    } catch (e) {
        /* repli Math.random */
    }
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return base64UrlEncode(bytes);
}
