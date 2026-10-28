/**
 * HTTP minimaliste pour le runtime Nuvio (Hermes / QuickJS).
 *
 * Contraintes runtime :
 *   - pas de Buffer, pas de process, pas de crypto.subtle garanti (TV)
 *   - setTimeout non garanti (QuickJS TV) : s'il existe on coupe chaque
 *     requête par une vraie course Promise.race + AbortController (l'option
 *     `timeout` de fetch n'est pas standard et peut être ignorée) ; sinon on
 *     retombe sur l'option `timeout` du fetch fourni par l'app.
 *   - AbortController utilisé défensivement quand disponible.
 */

const DEFAULT_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
};

export class HttpError extends Error {
    constructor(message, status, url) {
        super(message);
        this.name = 'HttpError';
        this.status = status || 0;
        this.url = url || '';
    }
}

function makeController(externalSignal) {
    try {
        if (typeof AbortController === 'function') {
            const controller = new AbortController();
            if (externalSignal && !externalSignal.aborted && typeof externalSignal.addEventListener === 'function') {
                externalSignal.addEventListener('abort', function () {
                    try {
                        controller.abort();
                    } catch (e) {
                        /* ignore */
                    }
                });
            }
            return controller;
        }
    } catch (e) {
        /* ignore */
    }
    return null;
}

/**
 * Course réelle contre un timer : l'option `timeout` passée à fetch est non
 * standard et peut être ignorée par le runtime — on coupe donc nous-mêmes.
 * Si AbortController existe, on avorte la requête sous-jacente ; sinon la
 * promesse fetch est abandonnée (la course renvoie l'erreur de toute façon).
 */

/* ── Gouverneur de requêtes ───────────────────────────────────────────────
 * Runtimes à fetch BLOQUANT (TV / Desktop) : aucun timer ne peut interrompre
 * une requête en cours, et chaque hôte mort coûte un timeout complet. Sans
 * garde-fou, N miroirs morts × timeout dépassent largement le budget et l'app
 * affiche « impossible de charger les streams ».
 *   1. Budget global : plus AUCUNE requête n'est lancée à moins de 1,5 s de
 *      l'échéance, et le timeout de chaque requête est plafonné au temps restant.
 *   2. Disjoncteur par hôte : après un échec réseau/timeout, l'hôte est écarté
 *      2 minutes — un domaine bloqué ne coûte qu'UN timeout, pas dix.
 */
let govDeadline = 0;
const govDead = {};
const GOV_DEAD_MS = 120000;
const GOV_MIN_SLICE_MS = 1500;

export function setHttpDeadline(ts) {
    govDeadline = ts > 0 ? ts : 0;
}

function govHost(url) {
    const m = /^https?:\/\/([^\/?#]+)/i.exec(String(url));
    return m ? m[1].toLowerCase() : '';
}

function govGate(url, timeout) {
    const host = govHost(url);
    const until = govDead[host];
    if (until && Date.now() < until) {
        throw new HttpError('hôte injoignable (disjoncteur) : ' + host, 0, url);
    }
    if (govDeadline) {
        const remaining = govDeadline - Date.now();
        if (remaining < GOV_MIN_SLICE_MS) throw new HttpError('budget épuisé avant : ' + url, 0, url);
        return Math.min(timeout, remaining);
    }
    return timeout;
}

function govNoteFailure(url, err) {
    if (err && err.status !== undefined && err.status !== 0) return;
    if (err && /disjoncteur|budget épuisé/.test(String(err.message))) return;
    govDead[govHost(url)] = Date.now() + GOV_DEAD_MS;
}

async function raceFetch(url, fetchOptions, timeout, action) {
    const clamped = govGate(url, timeout);
    try {
        return await raceFetchInner(url, { ...fetchOptions, timeout: clamped }, clamped, action);
    } catch (err) {
        govNoteFailure(url, err);
        throw err;
    }
}

async function raceFetchInner(url, fetchOptions, timeout, action) {
    // _noBody : ne PAS lire le corps (sonde de segment : un .ts binaire peut
    // être lourd ; seuls statut et content-type nous intéressent).
    // _binary : lire le corps en OCTETS (res.arrayBuffer) et non en texte —
    // le décodage UTF-8 corromprait un MP4 (octets invalides → U+FFFD) et
    // rendrait le parsing moov/tkhd impossible (v3.1.10).
    const noBody = fetchOptions._noBody === true;
    const binary = fetchOptions._binary === true;
    const rest = { ...fetchOptions };
    delete rest._noBody;
    delete rest._binary;
    const controller = makeController(rest.signal);
    const opts = { ...rest, signal: controller ? controller.signal : undefined };

    const work = (async () => {
        const res = await fetch(url, opts);
        if (!res || typeof res.status !== 'number') {
            throw new HttpError('réponse invalide du runtime fetch', 0, url);
        }
        let text = '';
        let bytes = null;
        if (!noBody) {
            try {
                if (binary && res && typeof res.arrayBuffer === 'function') {
                    bytes = new Uint8Array(await res.arrayBuffer());
                } else {
                    text = await res.text();
                    if (binary) {
                        // Runtime sans arrayBuffer : encodage charCodeAt & 0xFF
                        // (perte des octets > 0xFF — acceptable en repli, le
                        // parsing moov échouera proprement sur un corps mangled).
                        bytes = new Uint8Array(text.length);
                        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
                    }
                }
            } catch (e) {
                text = '';
                bytes = null;
            }
        }
        let contentType = '';
        try {
            const h = res.headers;
            if (h) {
                if (typeof h.get === 'function') contentType = String(h.get('content-type') || '');
                else if (h['content-type']) contentType = String(h['content-type']);
            }
        } catch (e) {
            /* certains runtimes n'exposent pas res.headers */
        }
        let finalUrl = url;
        try {
            if (res.url && typeof res.url === 'string') finalUrl = res.url;
        } catch (e) {
            /* certains runtimes exposent res.url en getter coûteux */
        }
        return { res: res, text: text, bytes: bytes, finalUrl: finalUrl, contentType: contentType };
    })();

    if (typeof setTimeout !== 'function') {
        // Runtime sans timer : on s'en remet au timeout interne de fetch.
        return action(await work);
    }

    let timer = null;
    try {
        const won = await Promise.race([
            work,
            new Promise((_, reject) => {
                timer = setTimeout(function () {
                    try {
                        if (controller) controller.abort();
                    } catch (e) {
                        /* ignore */
                    }
                    reject(new HttpError('timeout réseau (' + timeout + ' ms) : ' + url, 0, url));
                }, timeout);
            }),
        ]);
        return action(won);
    } finally {
        try {
            clearTimeout(timer);
        } catch (e) {
            /* ignore */
        }
    }
}

/**
 * fetch texte avec timeout réel. Renvoie { text, status, finalUrl }.
 * finalUrl = URL après redirections (utile : vidzy/voe décodent selon le
 * domaine qui a réellement servi la page).
 * @returns {Promise<{text: string, status: number, finalUrl: string}>}
 */
export async function fetchText(url, options = {}) {
    const timeout = options.timeout || 20000;
    let out;
    try {
        out = await raceFetch(
            url,
            {
                method: options.method || 'GET',
                headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) },
                body: options.body !== undefined ? options.body : undefined,
                timeout: timeout,
            },
            timeout,
            won => won
        );
    } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError('réseau injoignable: ' + (err && err.message ? err.message : String(err)), 0, url);
    }

    if (out.res.status < 200 || out.res.status >= 300) {
        const detail = out.text ? out.text.slice(0, 200) : '';
        throw new HttpError('HTTP ' + out.res.status + (detail ? ' — ' + detail : ''), out.res.status, url);
    }
    return {
        text: out.text,
        status: out.res.status,
        finalUrl: out.finalUrl,
        contentType: out.contentType || '',
    };
}

/**
 * fetch BINAIRE avec timeout réel. Renvoie { bytes: Uint8Array, status,
 * finalUrl, contentType, text }. Pour lire l'en-tête d'un MP4 (moov/tkhd →
 * dimensions réelles) sans que le décodage UTF-8 ne corrompe les octets :
 * res.arrayBuffer quand le runtime l'expose, sinon encodage charCodeAt.
 * Un Range: bytes=0-131071 dans options.headers borne le téléchargement.
 * @returns {Promise<{bytes: Uint8Array, text: string, status: number, finalUrl: string, contentType: string}>}
 */
export async function fetchBytes(url, options = {}) {
    const timeout = options.timeout || 20000;
    let out;
    try {
        out = await raceFetch(
            url,
            {
                method: options.method || 'GET',
                headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) },
                body: options.body !== undefined ? options.body : undefined,
                timeout: timeout,
                _binary: true,
            },
            timeout,
            won => won
        );
    } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError('réseau injoignable: ' + (err && err.message ? err.message : String(err)), 0, url);
    }

    if (out.res.status < 200 || out.res.status >= 300) {
        const detail = out.text ? out.text.slice(0, 200) : '';
        throw new HttpError('HTTP ' + out.res.status + (detail ? ' — ' + detail : ''), out.res.status, url);
    }
    return {
        bytes: out.bytes || new Uint8Array(0),
        text: out.text || '',
        status: out.res.status,
        finalUrl: out.finalUrl,
        contentType: out.contentType || '',
    };
}

/**
 * Statut sans corps : { status, contentType, finalUrl } — pour la sonde de
 * segment (GET Range borné, corps binaire JAMAIS lu). Jette HttpError sur
 * erreur réseau ; le statut HTTP est renvoyé tel quel (pas d'exception 4xx/5xx).
 */
export async function fetchStatus(url, options = {}) {
    const timeout = options.timeout || 20000;
    let out;
    try {
        out = await raceFetch(
            url,
            {
                method: options.method || 'GET',
                headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) },
                body: options.body !== undefined ? options.body : undefined,
                timeout: timeout,
                _noBody: options.noBody === true,
            },
            timeout,
            won => won
        );
    } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError('réseau injoignable: ' + (err && err.message ? err.message : String(err)), 0, url);
    }
    return {
        status: out.res.status,
        contentType: out.contentType || '',
        finalUrl: out.finalUrl,
    };
}

/**
 * fetch JSON avec timeout réel. Jette HttpError sur statut != 2xx ou JSON invalide.
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options = {}) {
    const timeout = options.timeout || 20000;
    let out;
    try {
        out = await raceFetch(
            url,
            {
                method: options.method || 'GET',
                headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) },
                body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
                timeout: timeout,
            },
            timeout,
            won => won
        );
    } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError('réseau injoignable: ' + (err && err.message ? err.message : String(err)), 0, url);
    }

    if (out.res.status < 200 || out.res.status >= 300) {
        const detail = out.text ? out.text.slice(0, 200) : '';
        throw new HttpError('HTTP ' + out.res.status + (detail ? ' — ' + detail : ''), out.res.status, url);
    }
    try {
        return JSON.parse(out.text);
    } catch (e) {
        throw new HttpError('JSON invalide (' + out.text.slice(0, 80) + '…)', out.res.status, url);
    }
}

/** fetch JSON qui tolère un statut d'erreur (renvoie null au lieu de jeter). */
export async function fetchJsonSafe(url, options = {}) {
    try {
        return await fetchJson(url, options);
    } catch (err) {
        if (err instanceof HttpError && err.status >= 400) return null;
        throw err;
    }
}

/**
 * Résolution d'une URL relative (mini urljoin, sans new URL garanti… mais new URL
 * existe partout où fetch existe ; on l'utilise avec repli manuel).
 */
export function resolveUrl(base, rel) {
    const r = String(rel || '').trim();
    if (!r) return base || '';
    if (/^https?:\/\//i.test(r)) return r;
    try {
        return new URL(r, base).href;
    } catch (e) {
        /* repli manuel */
    }
    if (r.startsWith('//')) return 'https:' + r;
    const b = String(base || '');
    if (!b) return r;
    if (r.startsWith('/')) return (b.split('/').slice(0, 3).join('/')) + r;
    return b.replace(/\/[^/]*$/, '/') + r;
}

/**
 * Cache mémoire simple avec TTL (et taille plafonnée).
 * Sert à éviter de re-télécharger la même saison entre deux épisodes.
 */
export function createTtlCache(maxEntries) {
    const store = new Map();
    const limit = maxEntries || 40;

    function prune() {
        if (store.size <= limit) return;
        const now = Date.now();
        for (const [k, v] of store) {
            if (v.expires <= now) store.delete(k);
            if (store.size <= limit) break;
        }
        while (store.size > limit) {
            const first = store.keys().next();
            if (first.done) break;
            store.delete(first.value);
        }
    }

    return {
        get(key) {
            const hit = store.get(key);
            if (!hit) return null;
            if (hit.expires <= Date.now()) {
                store.delete(key);
                return null;
            }
            return hit.value;
        },
        set(key, value, ttlMs) {
            store.set(key, { value: value, expires: Date.now() + ttlMs });
            prune();
        },
        clear() {
            store.clear();
        },
    };
}
