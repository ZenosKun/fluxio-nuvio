/**
 * Extracteurs d'hôtes en direct — portage JS de sestudio/providers/*.py.
 *
 * Chaque extracteur prend une URL d'embed (telle que stockée par le site
 * source) et renvoie un flux jouable { url, referer, ua, subtitles? }.
 * Contrairement au mode « serveur », le plugin renvoie l'URL directe du host
 * avec les en-têtes de lecture (Referer/User-Agent) que Nuvio appliquera au
 * player : aucun proxy intermédiaire.
 *
 * Ordre de préférence :
 *   uqload → premium → netu → luluvid → filmoon → voe → vidzy
 *
 * Écart délibéré avec sestudio (qui met vidzy juste après uqload) : le CDN
 * vidzy exige une empreinte TLS Chrome (IMPERSONATE_PROVIDERS = {"vidzy"}) et
 * refuse en 403 les clients non-Chrome — le player/fetch natif de Nuvio ne
 * l'imitera pas. Placé en dernier pour ne pas occuper un slot de résultats
 * avec un lien probablement mort ; premium (fsvid.lol, même famille) n'a pas
 * cette contrainte TLS.
 */

import { fetchText, fetchJson, fetchJsonSafe, resolveUrl } from '../utils/http.js';
import { base64Decode, base64UrlDecode, utf8Decode } from '../utils/text.js';
import { aesGcmDecryptJson } from '../utils/crypto.js';
import { unpack, findPackedScript } from './unpack.js';
import { deobfuscateSrc, plainSrc, withGateKey } from './vidzyShared.js';
import { extractSubtitles } from './subtitles.js';

const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const PROVIDER_ORDER = ['uqload', 'premium', 'netu', 'luluvid', 'filmoon', 'voe', 'vidzy'];

/** Format jouable : m3u8 → HLS, sinon MP4. */
export function kindOf(url) {
    return /\.m3u8(\?|$)/i.test(String(url || '')) ? 'HLS' : 'MP4';
}

/* ─────────────────────────── helpers internes ──────────────────────────── */

function originOf(url) {
    const m = /^(https?:\/\/[^/?#]+)/i.exec(String(url || ''));
    return m ? m[1] : '';
}

function hostnameOf(url) {
    const m = /^https?:\/\/([^/?#]+)/i.exec(String(url || ''));
    if (!m) return '';
    return m[1].split(':')[0].toLowerCase();
}

const FILE_RE = /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/;
const MP4_RE = /(https:\/\/strm[^"'<>\s]+\/v\.mp4)/;

/* ──────────────────────────────── uqload ───────────────────────────────── */

async function resolveUqload(embedUrl, opts) {
    const referer = 'https://uqload.is/';
    const res = await fetchText(embedUrl, {
        timeout: opts.timeout,
        headers: {
            Referer: referer,
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'cross-site',
        },
        signal: opts.signal,
    });

    const packed = findPackedScript(res.text);
    if (packed) {
        const m = FILE_RE.exec(unpack(packed));
        if (m) return { url: m[1], referer: referer, ua: BROWSER_UA };
    }
    const mp4 = MP4_RE.exec(res.text);
    if (mp4) return { url: mp4[1], referer: referer, ua: BROWSER_UA };
    throw new Error('aucune URL de flux dans l embed uqload');
}

/* ───────────────────────────── vidzy / premium ─────────────────────────── */

async function resolveVidzyFamily(embedUrl, opts, variant) {
    const referer = variant === 'premium' ? 'https://fsvid.lol/' : 'https://vidzy.org/';
    const res = await fetchText(embedUrl, {
        timeout: opts.timeout,
        headers: {
            Referer: referer,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'cross-site',
        },
        signal: opts.signal,
    });

    const packed = findPackedScript(res.text);
    const unpacked = packed ? unpack(packed) : res.text;

    let streamUrl = null;
    const obf = INLINE_SRC_LOCAL.exec(unpacked);
    if (obf) {
        // La clé dépend du domaine qui a réellement servi la page (redirections).
        streamUrl = deobfuscateSrc(obf[1], obf[2], hostnameOf(res.finalUrl));
    } else {
        streamUrl = plainSrc(unpacked);
    }
    if (!streamUrl || streamUrl.indexOf('.m3u8') === -1) {
        throw new Error('source m3u8 introuvable dans l embed ' + variant);
    }

    let finalUrl = streamUrl;
    if (variant === 'vidzy') {
        finalUrl = await withGateKey(res.text, streamUrl, referer, opts.timeout);
    }

    return {
        url: finalUrl,
        referer: referer,
        ua: BROWSER_UA,
        subtitles: extractSubtitles(res.text, res.finalUrl),
    };
}

// Copy locale : même motif que vidzyShared.deobfuscateSrc sans réexport circulaire.
const INLINE_SRC_LOCAL =
    /src\s*:\s*\(function\(s\)\{([\s\S]{0,4000}?)\}\)\("([A-Za-z0-9+/=]+)"\)/;

/* ──────────────────────────────── netu ─────────────────────────────────── */

async function resolveNetu(embedUrl, opts) {
    const first = await fetchText(embedUrl, {
        timeout: opts.timeout,
        headers: { Referer: embedUrl },
        signal: opts.signal,
    });
    const finalUrl = first.finalUrl;

    const cm = /\/e\/([a-zA-Z0-9]+)/.exec(finalUrl);
    if (!cm) throw new Error('code vidéo introuvable dans la redirection netu : ' + finalUrl);
    const code = cm[1];
    const apiBase = originOf(finalUrl);
    const referer = apiBase + '/e/' + code;

    const data = await fetchJson(apiBase + '/api/videos/' + code + '/', {
        timeout: opts.timeout,
        headers: { Referer: referer, Accept: 'application/json' },
        signal: opts.signal,
    });

    const pb = data && data.playback;
    if (!pb || !pb.key_parts) throw new Error('config playback absente (netu ' + code + ')');

    let sources;
    try {
        const key = concatBytes(pb.key_parts.map(p => base64UrlDecode(p)));
        const iv = base64UrlDecode(pb.iv);
        // payload = ciphertext + tag(16) : le tag est tranché (non vérifié).
        let payload = base64UrlDecode(pb.payload);
        if (payload.length > 16) payload = payload.slice(0, payload.length - 16);
        sources = aesGcmDecryptJson(key, iv, payload).sources || [];
    } catch (e) {
        throw new Error('déchiffrement playback netu impossible (' + code + ')');
    }
    if (!sources.length) throw new Error('aucune source dans la config netu (' + code + ')');

    let best = sources[0];
    for (const s of sources) {
        if (s && s.quality === 'h') { best = s; break; }
    }
    return { url: best.url, referer: referer, ua: BROWSER_UA };
}

function concatBytes(list) {
    let total = 0;
    for (const a of list) total += a.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of list) { out.set(a, off); off += a.length; }
    return out;
}

/* ─────────────────────────────── luluvid ───────────────────────────────── */

const LULU_HOSTS = ['luluvdo.com', 'luluvid.com'];
const LULU_CODE_RE = /(?:embed[-/]|\/e\/|\/d\/|\/f\/)([A-Za-z0-9]+)/;

async function resolveLuluvid(embedUrl, opts) {
    const cm = LULU_CODE_RE.exec(embedUrl);
    if (!cm) throw new Error('code luluvid introuvable dans : ' + embedUrl);
    const code = cm[1];

    let lastError = 'aucun host candidat n a répondu';
    for (const host of LULU_HOSTS) {
        const url = 'https://' + host + '/e/' + code;
        let text;
        try {
            const res = await fetchText(url, {
                timeout: opts.timeout,
                headers: {
                    Referer: 'https://luluvdo.com/',
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Sec-Fetch-Dest': 'iframe',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'cross-site',
                },
                signal: opts.signal,
            });
            text = res.text;
        } catch (err) {
            lastError = host + ' : ' + (err && err.message ? err.message : err);
            continue;
        }

        const low = text.toLowerCase();
        if (text.indexOf('no longer available') !== -1 || low.indexOf('expired') !== -1) {
            throw new Error('fichier luluvid expiré ou supprimé (' + code + ')');
        }
        const packed = findPackedScript(text);
        if (!packed) { lastError = host + ' : pas de player packé'; continue; }
        const m = /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/.exec(unpack(packed));
        if (!m) { lastError = host + ' : pas de source m3u8'; continue; }
        return { url: m[1], referer: 'https://luluvdo.com/', ua: BROWSER_UA };
    }
    throw new Error('luluvid irresolvable (' + lastError + ')');
}

/* ──────────────────────────────── filmoon ──────────────────────────────── */

const FILMOON_CODE_RE = /\/(?:[edf]\/|embed[-/])([A-Za-z0-9]+)/;

async function resolveFilmoon(embedUrl, opts) {
    let resolved = embedUrl;
    let cm = FILMOON_CODE_RE.exec(embedUrl);

    if (!cm) {
        // Lien « wrapper » de fstream : suivre la chaîne de redirections.
        const res = await fetchText(embedUrl, {
            timeout: Math.min(opts.timeout || 15000, 10000),
            headers: { Referer: embedUrl },
            signal: opts.signal,
        });
        resolved = res.finalUrl;
        cm = FILMOON_CODE_RE.exec(resolved);
        if (!cm) {
            throw new Error('wrapper filmoon sans filecode : ' + embedUrl + ' → ' + resolved);
        }
    }

    const code = cm[1];
    const data = await fetchJson(originOf(resolved) + '/api/stream', {
        method: 'POST',
        body: { filecode: code, device: 'web' },
        timeout: opts.timeout,
        headers: {
            Referer: resolved,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
        },
        signal: opts.signal,
    });

    const streamUrl = (data && data.streaming_url) || '';
    if (!streamUrl) throw new Error('streaming_url absente de la réponse filmoon (' + code + ')');
    return { url: streamUrl, referer: resolved, ua: BROWSER_UA };
}

/* ────────────────────────────────── voe ────────────────────────────────── */

const JSON_BLOB_RE = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/;
const JS_LOCATION_RE = /window\.location\.href\s*=\s*['"]([^'"]+)['"]/;
const JUNK_DIGRAPHS = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'];
const LULU_HANDOFF = ['luluvdo.com', 'luluvid.com', 'lulustream.com'];

function rot13(s) {
    return String(s || '').replace(/[a-zA-Z]/g, c => {
        const base = c <= 'Z' ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });
}

function b64Loose(text) {
    const cleaned = String(text || '').replace(/[^A-Za-z0-9+/=]/g, '');
    return utf8Decode(base64Decode(cleaned));
}

function decodeVoeConfig(payload) {
    let stage = rot13(payload);
    for (const junk of JUNK_DIGRAPHS) stage = stage.split(junk).join('_');
    stage = b64Loose(stage);
    let shifted = '';
    for (let i = 0; i < stage.length; i++) shifted += String.fromCharCode(stage.charCodeAt(i) - 3);
    shifted = shifted.split('').reverse().join('');
    const config = JSON.parse(b64Loose(shifted));
    if (!config || typeof config !== 'object') throw new Error('config voe non objet');
    return config;
}

function extractVoePayload(html) {
    const m = JSON_BLOB_RE.exec(html);
    if (!m) return null;
    const blob = m[1].trim();
    try {
        const parsed = JSON.parse(blob);
        if (Array.isArray(parsed) && parsed.length && typeof parsed[0] === 'string') return parsed[0];
        if (typeof parsed === 'string') return parsed;
    } catch (e) {
        return blob || null;
    }
    return null;
}

async function resolveVoe(embedUrl, opts) {
    let url = embedUrl;
    let payload = null;
    let finalUrl = embedUrl;
    const MAX_JS_HOPS = 6;

    let reached = false;
    for (let hop = 0; hop < MAX_JS_HOPS; hop++) {
        const res = await fetchText(url, {
            timeout: opts.timeout,
            headers: { Referer: url, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
            signal: opts.signal,
        });
        finalUrl = res.finalUrl;

        payload = extractVoePayload(res.text);
        if (payload) { reached = true; break; }

        const low = finalUrl.toLowerCase();
        if (LULU_HANDOFF.some(h => low.indexOf(h) !== -1)) {
            return resolveLuluvid(finalUrl, opts);
        }
        const next = JS_LOCATION_RE.exec(res.text);
        if (!next) {
            throw new Error('chaîne voe bloquée à ' + finalUrl + ' (ni config, ni redirection)');
        }
        url = resolveUrl(finalUrl, next[1]);
    }
    if (!reached) throw new Error('chaîne voe : trop de sauts JS depuis ' + embedUrl);

    let config;
    try {
        config = decodeVoeConfig(payload);
    } catch (e) {
        throw new Error('décodage config voe impossible depuis ' + finalUrl);
    }
    const streamUrl = config.source || config.direct_access_url || '';
    if (!streamUrl) throw new Error('source absente de la config voe (' + finalUrl + ')');
    return { url: streamUrl, referer: finalUrl, ua: BROWSER_UA };
}

/* ───────────────────────────── dispatch général ────────────────────────── */

const RESOLVERS = {
    uqload: resolveUqload,
    vidzy: (u, o) => resolveVidzyFamily(u, o, 'vidzy'),
    premium: (u, o) => resolveVidzyFamily(u, o, 'premium'),
    netu: resolveNetu,
    luluvid: resolveLuluvid,
    filmoon: resolveFilmoon,
    voe: resolveVoe,
};

/** Devine l'extracteur d'après l'URL d'embed (indices de sestudio/scraper.py). */
export function providerFromEmbedUrl(src) {
    const low = String(src || '').toLowerCase();
    const hints = [
        ['uqload', 'uqload'],
        ['vidzy', 'vidzy'],
        ['fsvid', 'premium'],
        ['premium', 'premium'],
        ['luluvdo', 'luluvid'],
        ['luluvid', 'luluvid'],
        ['lulustream', 'luluvid'],
        ['vidhsareup', 'luluvid'],
        ['voe', 'voe'],
        ['vidaraa', 'filmoon'],
        ['filmoon', 'filmoon'],
        ['/viper', 'filmoon'],
        ['chamber_go', 'filmoon'],
        ['netu', 'netu'],
        ['/moon', 'netu'],
        ['byse', 'netu'],
    ];
    for (const [hint, provider] of hints) {
        if (low.indexOf(hint) !== -1) return provider;
    }
    return null;
}

/**
 * Résout un embed avec l'extracteur demandé (ou deviné).
 * @returns {Promise<{provider: string, url: string, referer: string, ua: string, subtitles: Array}>}
 */
export async function resolveEmbed(provider, embedUrl, opts = {}) {
    const name = provider || providerFromEmbedUrl(embedUrl);
    if (!name || !RESOLVERS[name]) {
        throw new Error('pas d extracteur pour cet embed : ' + embedUrl);
    }
    const out = await RESOLVERS[name](embedUrl, opts);
    if (!out || !out.url) throw new Error('résolution vide (' + name + ')');
    return {
        provider: name,
        url: out.url,
        referer: out.referer || '',
        ua: out.ua || BROWSER_UA,
        subtitles: out.subtitles || [],
    };
}

/**
 * Résout une liste {provider: embedUrl} dans l'ordre de préférence.
 * Les candidats partent EN PARALLÈLE (chaque requête est bornée par le
 * timeout des appelants — 6 s : un host qui pend n'entraîne pas les autres).
 * Renvoie les réussites triées par préférence (max *maxResults*), les échecs
 * sont loggés.
 */
export async function resolveEmbeds(embedUrls, opts = {}) {
    const max = opts.maxResults || 2;
    const errors = [];

    const ordered = [];
    const seen = {};
    for (const p of PROVIDER_ORDER) {
        if (embedUrls[p] && !seen[p]) { ordered.push([p, embedUrls[p]]); seen[p] = true; }
    }
    for (const p of Object.keys(embedUrls)) {
        if (!seen[p] && embedUrls[p]) {
            const guessed = providerFromEmbedUrl(embedUrls[p]);
            ordered.push([guessed || p, embedUrls[p]]);
            seen[p] = true;
        }
    }

    const attempts = ordered.slice(0, opts.maxAttempts || 4);
    const settled = await Promise.all(
        attempts.map(([provider, embedUrl]) =>
            resolveEmbed(provider, embedUrl, opts).then(
                got => ({ ok: true, provider: provider, got: got }),
                err => {
                    const msg = err && err.message ? err.message : String(err);
                    return { ok: false, provider: provider, msg: msg };
                }
            )
        )
    );

    const out = [];
    for (const s of settled) {
        if (s.ok) {
            if (out.length < max) out.push(s.got);
        } else {
            errors.push(s.provider + ': ' + s.msg);
            console.warn('[sestudio] host ' + s.provider + ' échoué : ' + s.msg);
        }
    }
    if (!out.length && errors.length) {
        throw new Error('tous les hosts ont échoué — ' + errors.join(' | '));
    }
    return out;
}
