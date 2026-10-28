/**
 * Extracteurs d'hôtes en direct — portage JS de sestudio/providers/*.py.
 *
 * Chaque extracteur prend une URL d'embed (telle que stockée par le site
 * source) et renvoie un flux jouable { url, referer, ua, subtitles? }.
 * Contrairement au mode « serveur », le plugin renvoie l'URL directe du host
 * avec les en-têtes de lecture (Referer/User-Agent) que Nuvio appliquera au
 * player : aucun proxy intermédiaire.
 *
 * Ordre de préférence (v3.1.9 — extracteurs des sites FR additionnels) :
 *   uqload → vidmoly → xtremestream → netu → filmoon → voe → veev →
 *   luluvid → premium → vidzy
 *   • vidmoly : TLD tournants (.biz vivant en live 2026-10, .net 301 → .biz),
 *     redirection JWT, port de gowaru resolveVidmoly.
 *   • xtremestream : lecteur n°1 de l'embed lecteurvideo.com (section OD_FR,
 *     ~60-70 % des liens VF, gowaru priority 5) — video_id + m3u8_loader_url,
 *     le loader exige le Referer du player lui-même (403 sinon).
 *   • veev/wishonly/livavid/lulavid/livastream : même player packé
 *     (gowaru resolvePackedPlayer) — fetch + unpack + file/sources.
 *
 * v3.1.8 — calque des références (retour utilisateur : « regardez comment
 * sestudio et gowaru-nuvio-providers font au lieu d'inventer ») :
 *   • gowaru resolvers.js (resolveWithTimeout, french-manga) : le CDN
 *     tnmr.org — là où aboutissent TOUTES les résolutions luluvdo/lulust —
 *     répond 403 en live QUEL QUE SOIT le Referer (luluvdo.com, page embed,
 *     site source, Origin+Referer, sans) → « servir ces URL produit un flux
 *     qui ne lance jamais » → on REJETTE (l'utilisateur bufferisait à
 *     l'infini sur luluvid). Exception cdn-tnmr.org (sous-domaine légitime).
 *   • gowaru resolveFsvidVidzy : le Referer d'embed se dérive du DOMAINE DE
 *     L'EMBED lui-même (fsvid.lol → 403 sans), et le flux résolu exige
 *     Referer https://vidzy.live/ (vidzy) / https://fsvid.lol/ (fsvid) —
 *     vérifié live 200. On ne renvoie plus l'ancien Referer vidzy.org fixe.
 *   • La famille vidzy/luluvid/premium reste weakPlayer (TLS Chrome non
 *     imitable par le lecteur natif) : stream.js la range en dernier ⚠ —
 *     mais un lien que la sonde prouve mort est maintenant RETIRÉ (verify.js,
 *     philosophie gowaru « anti flux-qui-ne-lance-jamais »).
 */

import { fetchText, fetchJson, fetchJsonSafe, resolveUrl } from '../utils/http.js';
import { bestHlsQuality, muxedVariantUrl } from '../core/verify.js';
import { base64Decode, base64UrlDecode, utf8Decode } from '../utils/text.js';
import { aesGcmDecryptJson } from '../utils/crypto.js';
import { unpack, findPackedScript } from './unpack.js';
import { deobfuscateSrc, plainSrc, withGateKey } from './vidzyShared.js';
import { extractSubtitles } from './subtitles.js';

const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const PROVIDER_ORDER = [
    'uqload', 'vidmoly', 'xtremestream', 'netu', 'filmoon', 'voe', 'veev',
    'luluvid', 'premium', 'vidzy',
];

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

/** Stubs d'expiration affichés par uqload sur les liens morts (gowaru :
 * « détection restrictions / expirés ») — on rejette tôt au lieu de produire
 * un « aucune URL de flux » générique ; la sonde retirera le lien. */
const UQLOAD_DEAD_RE =
    /file (?:was|has been) (?:deleted|removed)|file is temporarily unavailable|file not found|this file doesn't exist|deleted because of (?:dmca|copyright)|copyright (?:claim|infringement)/i;

/**
 * v3.1.14 — anti-écran-noir uqload NIVEAU RÉSOLVEUR.
 *
 * La v3.1.13 faisait l'échange master → variante muxée dans la sonde
 * (verify.js probeOne étape 1.5) : correct en sandbox, mais sur le device la
 * sonde est souvent coupée AVANT (budget global épuisé par les autres flux,
 * 10 premiers liens seulement, fetch de validation sans temps restant) → le
 * master multi-pistes (EXT-X-MEDIA) partait tel quel au lecteur → l'audio
 * séparé se joue, la vidéo jamais (Fall 2 : écran noir revenu chez
 * l'utilisateur). L'échange se fait donc DÈS LA RÉSOLUTION : 2 fetch courts,
 * indépendants du budget de la sonde, avec la langue du flux passée dans
 * opts.language par les sources.
 *
 * Conservateur : master conservé au moindre doute (pas de #EXTM3U, pas de
 * EXT-X-MEDIA, langue non VF/VFQ/VFF, motif de variante inattendu, variante
 * injoignable depuis ici) — dans ces cas la sonde v3.1.13 reste le filet.
 * @returns {Promise<{url: string, quality: string}|null>} null = master conservé
 */
async function uqloadMuxedSwap(masterUrl, referer, opts) {
    const readHeaders = { Referer: referer, 'User-Agent': BROWSER_UA, Accept: '*/*' };
    let masterText = '';
    let finalUrl = masterUrl;
    try {
        const m = await fetchText(masterUrl, {
            timeout: Math.min(opts.timeout || 6000, 3500),
            headers: readHeaders,
            signal: opts.signal,
        });
        masterText = String((m && m.text) || '');
        finalUrl = (m && m.finalUrl) || masterUrl;
    } catch (e) {
        return null; // master injoignable ici : la sonde tranchera sur le lien
    }
    if (masterText.indexOf('#EXTM3U') === -1) return null;
    const swapUri = muxedVariantUrl(masterText, opts.language);
    if (!swapUri) return null;
    const muxUrl = resolveUrl(finalUrl, swapUri);
    try {
        const v = await fetchText(muxUrl, {
            timeout: Math.min(opts.timeout || 6000, 2500),
            headers: readHeaders,
            signal: opts.signal,
        });
        // La variante doit être une playlist média triviale (segments) — pas
        // une page HTML ni un master : c'est TOUT le but de l'échange.
        if (!/#EXTINF/i.test(String((v && v.text) || ''))) return null;
    } catch (e) {
        return null; // variante injoignable ici : master conservé
    }
    console.log('[uqload] variante muxée servie dès la résolution (anti écran-noir, ' +
        String(opts.language || '').toUpperCase() + ') : ' + muxUrl);
    return { url: muxUrl, quality: bestHlsQuality(masterText) };
}

async function resolveUqload(embedUrl, opts) {
    // v3.1.13 (gowaru « Referer self ») : les TLD uqload tournent (.is/.vc/
    // .co/…) — le Referer est dérivé du domaine de l'embed LUI-MÊME, avec
    // repli sur l'ancien https://uqload.is/ fixe si la page ne répond pas.
    const selfRef = originOf(embedUrl) + '/';
    const referers = [selfRef, 'https://uqload.is/'];
    let res = null;
    let referer = referers[0];
    for (const ref of referers) {
        try {
            const r = await fetchText(embedUrl, {
                timeout: opts.timeout,
                headers: {
                    Referer: ref,
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Sec-Fetch-Dest': 'iframe',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'cross-site',
                },
                signal: opts.signal,
            });
            if (r && r.text && r.text.length > 400) { res = r; referer = ref; break; }
        } catch (e) {
            /* TLD suivant */
        }
    }
    if (!res) throw new Error('embed uqload injoignable (' + selfRef + ')');
    if (UQLOAD_DEAD_RE.test(res.text)) throw new Error('uqload : lien expiré/supprimé');

    let url = '';
    const packed = findPackedScript(res.text);
    if (packed) {
        const m = FILE_RE.exec(unpack(packed));
        if (m) url = m[1];
    }
    if (!url) {
        const mp4 = MP4_RE.exec(res.text);
        if (mp4) url = mp4[1];
    }
    if (!url) throw new Error('aucune URL de flux dans l embed uqload');

    // v3.1.14 : master HLS multi-pistes → variante muxée de la langue DÈS la
    // résolution (l'échange dans la sonde dépend du budget global — sur TV il
    // partait souvent avant → écran noir). Langue du flux = opts.language.
    if (/\.m3u8(\?|$)/i.test(url)) {
        const swap = await uqloadMuxedSwap(url, referer, opts);
        if (swap) return { url: swap.url, referer: referer, ua: BROWSER_UA, quality: swap.quality };
    }
    return { url: url, referer: referer, ua: BROWSER_UA };
}

/* ───────────────────────────── vidzy / premium ─────────────────────────── */

async function resolveVidzyFamily(embedUrl, opts, variant) {
    // Gowaru resolveFsvidVidzy : le Referer d'embed est le domaine de l'embed
    // LUI-MÊME (fsvid.lol → 403 sans ; vidzy.* tolérant mais non cassé par).
    const embedRef = originOf(embedUrl) + '/';
    const res = await fetchText(embedUrl, {
        timeout: opts.timeout,
        headers: {
            Referer: embedRef,
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
    // Leurre anti-scraper (gowaru isKnownFakeDirectUrl) : s1.fsvid.lol/troll/
    // master.m3u8 est IDENTIQUE pour tous les embeds et ne joue jamais.
    if (streamUrl.indexOf('/troll/') !== -1) {
        throw new Error('leurre troll/master.m3u8 détecté (' + variant + ') — embed pivoté');
    }

    // Referer de LECTURE (gowaru : vérifié live 200) : vidzy.* → vidzy.live,
    // fsvid/autres → fsvid.lol. Le Referer d'embed ne marche PAS sur le CDN.
    const playRef = variant === 'vidzy' ? 'https://vidzy.live/' : 'https://fsvid.lol/';

    let finalUrl = streamUrl;
    if (variant === 'vidzy') {
        finalUrl = await withGateKey(res.text, streamUrl, embedRef, opts.timeout);
    }

    return {
        url: finalUrl,
        referer: playRef,
        ua: BROWSER_UA,
        subtitles: extractSubtitles(res.text, res.finalUrl),
        // Famille vidzy (TLS Chrome + gk=) : segments refusés au player
        // natif même quand la playlist passe — stream.js range ces flux en
        // dernier ⚠. variant n'est ici que 'vidzy' ou 'premium' (RESOLVERS) ;
        // luluvid a son propre résolveur resolveLuluvid, qui renvoie aussi
        // weakPlayer: true (buffering infini confirmé par l'utilisateur).
        weakPlayer: true,
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
        // Gowaru (resolvers.js, vérifié live 2026-10-10) : TOUTES les
        // résolutions luluvdo/lulust aboutissent sur le CDN tnmr.org, qui
        // répond 403 quel que soit le Referer (page embed, site source,
        // Origin+Referer, sans) → servir = « flux qui ne lance jamais »
        // (buffering infini confirmé par l'utilisateur). Rejet ici : le
        // caller resolveEmbeds logue l'échec et tente le host suivant.
        if (/tnmr\.org/i.test(m[1]) && !/cdn-tnmr\.org/i.test(m[1])) {
            throw new Error('CDN tnmr.org : 403 vérifié en live (gowaru) — flux non jouable, rejet');
        }
        // Famille vidzy (même infra TLS Chrome + gk=) : même quand la
        // playlist passe, les segments peuvent refuser le lecteur natif →
        // weakPlayer, stream.js range ces flux en dernier ⚠. (Correction
        // audit v3.1.8 : resolveLuluvid n'était PAS flaggé — la condition
        // variant === 'luluvid' de resolveVidzyFamily était du code mort,
        // RESOLVERS ne l'appelle qu'en 'vidzy'/'premium'.)
        return { url: m[1], referer: 'https://luluvdo.com/', ua: BROWSER_UA, weakPlayer: true };
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

/* ──────────────────────────────── vidmoly ──────────────────────────────── */

/* TLD connus (gowaru, live 2026-10) : .biz servi dans les iframes, .net 301
 * → .biz ; .to/.ru/.is replis ; .me mort. L'ordre respecte le domaine
 * d'abord (la page peut être servie depuis un TLD encore inconnu). */
const VIDMOLY_TLDS = ['biz', 'net', 'ru', 'is', 'to'];

const VIDMOLY_FILE_RE =
    /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i;
const VIDMOLY_SOURCES_RE =
    /sources\s*:\s*\[["']([^"']+\.(?:m3u8|mp4)[^"']*)["']\]/i;
const VIDMOLY_LOOSE_RE = /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i;
const VIDMOLY_JS_REDIRECT_RE =
    /window\.location\.(?:replace\(['"]|href\s*=\s*['"])([^'"]+)['"]/;

function vidmolyMatch(html) {
    return (
        VIDMOLY_FILE_RE.exec(html) ||
        VIDMOLY_SOURCES_RE.exec(html) ||
        VIDMOLY_LOOSE_RE.exec(html)
    );
}

async function fetchVidmolyPage(url, opts) {
    const fetchDomain = hostnameOf(url);
    const ref = fetchDomain ? 'https://' + fetchDomain + '/' : 'https://vidmoly.biz/';
    const res = await fetchText(url, {
        timeout: opts.timeout,
        headers: { Referer: ref, Origin: ref.replace(/\/$/, ''), Accept: 'text/html,*/*' },
        signal: opts.signal,
    });
    let html = res.text;
    // Page pub / 404 (courte sans redirection JS) ou marker ad
    // (gowaru 'finisheddaysflamboyant' — domaine pub du réseau).
    const hasJsRedirect = /window\.location\.replace/.test(html);
    if ((html.length < 500 && !hasJsRedirect) || html.indexOf('finisheddaysflamboyant') !== -1) {
        throw new Error('page pub/404 vidmoly : ' + url);
    }
    const packed = findPackedScript(html);
    if (packed) html = unpack(packed);
    return { html: html, finalUrl: res.finalUrl, ref: ref };
}

async function resolveVidmoly(embedUrl, opts) {
    // Domaines à tenter : le domaine d'origine d'abord, puis les TLD connus.
    const domains = [embedUrl];
    for (const tld of VIDMOLY_TLDS) {
        const alt = embedUrl.replace(/vidmoly\.(net|to|ru|is|biz|me)/i, 'vidmoly.' + tld);
        if (alt !== embedUrl && domains.indexOf(alt) === -1) domains.push(alt);
    }

    let lastError = 'aucun domaine vidmoly n a répondu';
    for (const fetchUrl of domains.slice(0, 4)) {
        let page;
        try {
            page = await fetchVidmolyPage(fetchUrl, opts);
        } catch (err) {
            lastError = hostnameOf(fetchUrl) + ' : ' + (err && err.message ? err.message : err);
            continue;
        }

        let m = vidmolyMatch(page.html);
        if (!m) {
            // Redirection JWT (window.location.replace('URL?ch=1&js=…')) :
            // suivre UNE fois puis re-extraire (gowaru).
            const jr = VIDMOLY_JS_REDIRECT_RE.exec(page.html);
            if (jr && jr[1] !== fetchUrl) {
                try {
                    const page2 = await fetchVidmolyPage(resolveUrl(page.finalUrl, jr[1]), opts);
                    m = vidmolyMatch(page2.html);
                    if (m) page = page2;
                } catch (err) {
                    /* re-tomber sur l'erreur du domaine courant */
                }
            }
        }
        if (!m) {
            lastError = hostnameOf(fetchUrl) + ' : pas de source m3u8/mp4';
            continue;
        }
        // Referer de lecture = domaine qui a RÉELLEMENT servi la page
        // (après 301 éventuelle) — gowaru serveRefOf.
        const serveDomain = hostnameOf(page.finalUrl) || hostnameOf(fetchUrl);
        return {
            url: m[1],
            referer: 'https://' + serveDomain + '/',
            ua: BROWSER_UA,
        };
    }
    throw new Error('vidmoly irresolvable (' + lastError + ')');
}

/* ────────────────────── xtremestream (lecteurvideo) ───────────────────── */

/**
 * lecteur2.xtremestream.xyz — lecteur principal de l'embed lecteurvideo.com
 * (section OD_FR, ~60-70 % des liens VF — gowaru priority 5, AVANT uqload
 * « souvent expiré »). Structure vérifiée en live par gowaru (2026-10) :
 *   player/index.php?data=…   → page HTML avec
 *     var video_id = `…`  et  var m3u8_loader_url = `…/xs1.php?data=`
 *   {m3u8_loader_url}{video_id} → le CORPS EST le master.m3u8 direct.
 * Referer : la page player exige lecteurvideo.com ; le loader exige le
 * domaine du player LUI-MÊME (403 anti-hotlink avec lecteurvideo).
 */
async function resolveXtremestream(embedUrl, opts) {
    const origin = originOf(embedUrl) || 'https://lecteur2.xtremestream.xyz';
    const res = await fetchText(embedUrl, {
        timeout: opts.timeout,
        headers: { Referer: 'https://lecteurvideo.com/', Accept: 'text/html,*/*' },
        signal: opts.signal,
    });
    const html = res.text;
    const videoId = (/(?:var|const|let)\s+video_id\s*=\s*[`"']([A-Za-z0-9_-]+)[`"']/).exec(html);
    const loaderUrl = (/(?:var|const|let)\s+m3u8_loader_url\s*=\s*[`"']([^`"']+)[`"']/).exec(html);
    if (!videoId || !loaderUrl) {
        throw new Error('xtremestream : video_id/loader introuvables (' + origin + ')');
    }
    const loaderFull = loaderUrl[1] + videoId[1];
    const manifest = await fetchText(loaderFull, {
        timeout: opts.timeout,
        headers: { Referer: origin + '/', Accept: '*/*' },
        signal: opts.signal,
    });
    if (!manifest.text || manifest.text.indexOf('#EXTM3U') === -1) {
        throw new Error('xtremestream : le loader ne sert pas de manifest');
    }
    return { url: loaderFull, referer: origin + '/', ua: BROWSER_UA };
}

/* ─────────────── veev / wishonly / miroirs lulu (player packé) ─────────── */

/**
 * Player packé générique (gowaru resolvePackedPlayer) : veev.to,
 * wishonly.site, livavid/lulavid/livastream — même logiciel de player
 * (Dean-Edwards packer + file:/sources:) que la famille luluvid, mais
 * servie depuis ses propres CDN (pas de rejet tnmr ici : la sonde verify
 * tranchera les liens morts).
 */
async function resolvePackedHost(embedUrl, opts) {
    const origin = originOf(embedUrl);
    const res = await fetchText(embedUrl, {
        timeout: opts.timeout,
        headers: { Referer: origin + '/', Accept: 'text/html,*/*' },
        signal: opts.signal,
    });
    let html = res.text;
    const packed = findPackedScript(html);
    if (packed) html = unpack(packed);

    const m =
        /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i.exec(html) ||
        /sources\s*:\s*\[[^\]]*?["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i.exec(html) ||
        /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i.exec(html);
    if (!m) throw new Error('player packé sans source (' + hostnameOf(embedUrl) + ')');
    return { url: m[1], referer: origin + '/', ua: BROWSER_UA };
}

/* ───────────────────────────── dispatch général ────────────────────────── */

const RESOLVERS = {
    uqload: resolveUqload,
    vidmoly: resolveVidmoly,
    xtremestream: resolveXtremestream,
    vidzy: (u, o) => resolveVidzyFamily(u, o, 'vidzy'),
    premium: (u, o) => resolveVidzyFamily(u, o, 'premium'),
    netu: resolveNetu,
    luluvid: resolveLuluvid,
    filmoon: resolveFilmoon,
    voe: resolveVoe,
    veev: resolvePackedHost,
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
        ['lulust', 'luluvid'], // gowaru : 'lulust.com'.includes('lulu.') === false — hint dédié
        ['lulustream', 'luluvid'],
        ['vidhsareup', 'luluvid'],
        // vidmoly + variantes (voembed/ansembed = même player) — AVANT le hint
        // générique 'voe' : 'voembed'.indexOf('voe') === 0 sinon match voe.
        ['vidmoly', 'vidmoly'],
        ['voembed', 'vidmoly'],
        ['ansembed', 'vidmoly'],
        ['xtremestream', 'xtremestream'],
        ['veev', 'veev'],
        ['wishonly', 'veev'],
        ['livavid', 'veev'],
        ['lulavid', 'veev'],
        ['livastream', 'veev'],
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
 * @returns {Promise<{provider: string, url: string, referer: string, ua: string, subtitles: Array, weakPlayer: boolean}>}
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
        weakPlayer: out.weakPlayer === true,
        // v3.1.14 : qualité lue dans le master au moment du swap muxé (uqload)
        // — les sources l'utilisent telle quelle, sinon « Auto (HLS) ».
        quality: out.quality || '',
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
