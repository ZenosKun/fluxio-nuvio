/**
 * BFlix par TMDB id — portage JS de sestudio/sites/bflix.py (partie utile
 * pour Nuvio : résolution directe depuis tmdbId, sans recherche par titre).
 *
 * bflixs.cx n'est qu'une façade TMDB : les streams viennent de vidnest
 * (new.vidnest.fun/<server>/movie/<id> ou /tv/<id>/<s>/<e>) avec un nonce
 * aléatoire. Réponse « v2 » chiffrée AES-GCM sous SHA-256(n + "|" + secret) ;
 * le secret se relit dans le bundle JS de vidnest quand la constante tourne.
 *
 * Audio original uniquement (VOSTFR au mieux) ; sous-titres FR/EN de deux
 * agrégateurs (vdrk, wyzie).
 */

import { fetchText, fetchJson, fetchJsonSafe, resolveUrl } from '../utils/http.js';
import { base64UrlDecode, makeNonce } from '../utils/text.js';
import { sha256, aesGcmDecryptJson } from '../utils/crypto.js';

const VIDNEST = 'https://vidnest.fun';
const API = 'https://new.vidnest.fun';
const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Constante du bundle vidnest au moment du portage ; refresh() la met à jour.
const DEFAULT_SECRET = 'K3p8vQ2mX9rL5wZ0fN7bG1sH4tJ6dC9_y8S3wM1nQ5pL2';
const SECRET_RE = /"([A-Za-z0-9_-]{32,})",\w+="https:\/\/new\.vidnest\.fun"/;
const CHUNK_RE = /\/_next\/static\/chunks\/[\w.-]+\.js/g;

const SERVERS = ['flixhq', 'nextgencloudfabric', 'rpmvid', 'ophim'];
const SUB_LABELS = { fr: 'Français', en: 'English' };
const VDRK_LABELS = { French: 'fr', English: 'en' };

/* ───────────────────────────── secret vidnest ──────────────────────────── */

let secretCache = { secret: '', expires: 0 };

/**
 * Secret courant. PARESSEUX : tant que la constante par défaut déchiffre, le
 * bundle n'est JAMAIS relu (l'original fait pareil). La relecture ne se fait
 * qu'en cas de rotation (échec de déchiffrement/JSON.parse), via force=true.
 */
async function getSecret(timeoutMs, signal, force) {
    if (!force && secretCache.secret && secretCache.expires > Date.now()) return secretCache.secret;
    if (!force) return DEFAULT_SECRET;

    try {
        const page = await fetchText(VIDNEST + '/movie/550', {
            timeout: Math.min(timeoutMs, 15000),
            headers: { 'User-Agent': BROWSER_UA },
            signal: signal,
        });
        const chunks = [];
        let cm;
        CHUNK_RE.lastIndex = 0;
        while ((cm = CHUNK_RE.exec(page.text)) !== null) {
            if (chunks.indexOf(cm[0]) === -1) chunks.push(cm[0]);
            if (chunks.length >= 6) break;
        }
        for (const chunk of chunks) {
            try {
                const js = await fetchText(resolveUrl(VIDNEST, chunk), {
                    timeout: Math.min(timeoutMs, 15000),
                    headers: { 'User-Agent': BROWSER_UA },
                    signal: signal,
                });
                const found = SECRET_RE.exec(js.text);
                if (found) {
                    secretCache = { secret: found[1], expires: Date.now() + 6 * 3600 * 1000 };
                    return secretCache.secret;
                }
            } catch (e) {
                /* chunk suivant */
            }
        }
    } catch (e) {
        /* bundle injoignable : constante par défaut */
    }
    return DEFAULT_SECRET;
}

/** Mémorise un secret qui a effectivement déchiffré une réponse. */
function promoteSecret(secret) {
    if (secret) secretCache = { secret: secret, expires: Date.now() + 6 * 3600 * 1000 };
}

/* ─────────────────────────────── appel API ─────────────────────────────── */

function decryptV2(data, secret) {
    const blob = base64UrlDecode(data.d);
    const key = sha256(String(data.n || '') + '|' + secret);
    // blob = IV(12) + ciphertext + tag(16). Le tag n'est pas vérifié mais
    // doit être tranché : sinon ses octets « déchiffrés » polluent la fin
    // du JSON et le parse échoue.
    if (blob.length <= 12 + 16) throw new Error('payload vidnest trop courte');
    const ct = blob.slice(12, blob.length - 16);
    // Jette (SyntaxError) si la clé est fausse : le JSON parse échoue sur
    // les octets aléatoires — c'est notre détecteur de rotation de secret.
    return aesGcmDecryptJson(key, blob.slice(0, 12), ct);
}

async function vidnestGet(path, timeoutMs, signal, secretBox) {
    const sep = path.indexOf('?') === -1 ? '?' : '&';
    const url = API + '/' + path + sep + '_n=' + makeNonce();
    const data = await fetchJson(url, {
        timeout: Math.min(Math.max(timeoutMs, 20000), 30000),
        headers: { 'User-Agent': BROWSER_UA, Referer: VIDNEST + '/', Origin: VIDNEST },
        signal: signal,
    });

    if (data && data.v === 2 && data.d) {
        try {
            const plain = decryptV2(data, secretBox.secret);
            promoteSecret(secretBox.secret); // ce secret marche : on le retient
            return plain;
        } catch (err) {
            // JSON.parse a échoué → secret probablement tourné : on relit le
            // bundle une fois puis on retente avec le nouveau secret.
            if (secretBox.noRefresh) throw err;
            const fresh = await getSecret(timeoutMs, signal, true);
            if (fresh && fresh !== secretBox.secret) {
                secretBox.secret = fresh;
                const plain2 = decryptV2(data, fresh);
                promoteSecret(fresh);
                return plain2;
            }
            throw err;
        }
    }
    return data;
}

/* ───────────────────────── résolution par TMDB id ──────────────────────── */

/**
 * Flux vidnest pour un titre TMDB.
 * @param {string|number} tmdbId
 * @param {string} mediaType 'movie' | 'tv'
 * @param {number} season   requis pour tv
 * @param {number} episode  requis pour tv
 * @returns {Promise<Array<{provider: string, url: string, referer: string, ua: string}>>}
 */
export async function resolveBflix(tmdbId, mediaType, season, episode, opts = {}) {
    const timeoutMs = opts.timeout || 25000;
    // Secret immédiat : cache → défaut, SANS aucune lecture du bundle. La
    // relecture ne survient qu'à la rotation (échec JSON dans vidnestGet).
    const secretBox = {
        secret: opts.noSecretRefresh
            ? DEFAULT_SECRET
            : (await getSecret(timeoutMs, opts.signal, false)),
        noRefresh: !!opts.noSecretRefresh,
    };
    const isTv = mediaType === 'tv';
    const path = isTv
        ? 'tv/' + tmdbId + '/' + (parseInt(season, 10) || 1) + '/' + (parseInt(episode, 10) || 1)
        : 'movie/' + tmdbId;

    const results = [];
    const errors = [];
    for (const server of SERVERS) {
        try {
            const got = await vidnestGet(server + '/' + path, timeoutMs, opts.signal, secretBox);
            if (!got || typeof got !== 'object') throw new Error('réponse inattendue');

            const streams = Array.isArray(got.streams) ? got.streams : [got];
            let picked = null;
            for (const s of streams) {
                if (s && String(s.url || '').indexOf('http') === 0) { picked = s; break; }
            }
            if (!picked) throw new Error('aucun flux absolu pour ' + path);

            const headers = picked.headers || got.headers || {};
            results.push({
                provider: server,
                url: picked.url,
                referer: headers.Referer || VIDNEST + '/',
                ua: BROWSER_UA,
            });
            if (results.length >= (opts.maxServers || 2)) break;
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            errors.push(server + ' : ' + msg);
        }
    }
    if (!results.length) {
        throw new Error('vidnest irresolvable pour ' + path + ' — ' + errors.join(' | '));
    }
    return results;
}

/* ──────────────────────────────── sous-titres ──────────────────────────── */

/**
 * Sous-titres FR puis EN pour un chemin vidnest (« movie/<id »> ou
 * « tv/<id>/<s>/<e> »). vdrk (WebVTT) d'abord, wyzie (SRT) en complément.
 */
export async function bflixSubtitles(path, opts = {}) {
    const timeoutMs = Math.min(opts.timeout || 12000, 12000);
    const parts = String(path || '').split('/');
    const wyzieParams = ['id=' + encodeURIComponent(parts[1] || '')];
    if (parts[0] === 'tv') {
        wyzieParams.push('season=' + encodeURIComponent(parts[2] || ''));
        wyzieParams.push('episode=' + encodeURIComponent(parts[3] || ''));
    }

    const found = [];
    const jobs = [
        (async () => {
            const listed = await fetchJsonSafe('https://sub.vdrk.site/v2/' + path, {
                timeout: timeoutMs,
                headers: { 'User-Agent': BROWSER_UA },
                signal: opts.signal,
            });
            if (!Array.isArray(listed)) return;
            for (const s of listed) {
                const code = VDRK_LABELS[s && s.label] || '';
                if (code && s.file) found.push({ url: s.file, lang: code, label: SUB_LABELS[code] });
            }
        })(),
        (async () => {
            const listed = await fetchJsonSafe('https://vidcore.io/wyzie?' + wyzieParams.join('&'), {
                timeout: timeoutMs,
                headers: { 'User-Agent': BROWSER_UA },
                signal: opts.signal,
            });
            if (!Array.isArray(listed)) return;
            const sorted = listed.slice().sort((a, b) => (a && a.isHearingImpaired ? 1 : 0) - (b && b.isHearingImpaired ? 1 : 0));
            for (const s of sorted) {
                if (s && s.language && SUB_LABELS[s.language] && s.url) {
                    found.push({ url: s.url + '#srt', lang: s.language, label: SUB_LABELS[s.language] });
                }
            }
        })(),
    ];
    await Promise.all(jobs.map(p => p.catch(() => null)));

    // Une piste par langue, vdrk (d'abord déclarée) gagne ; FR en tête.
    const byLang = {};
    for (const s of found) {
        if (!byLang[s.lang]) byLang[s.lang] = s;
    }
    const kept = Object.keys(byLang).map(l => byLang[l]);
    kept.sort((a, b) => (a.lang === 'fr' ? -1 : 1) - (b.lang === 'fr' ? -1 : 1));
    return kept;
}
