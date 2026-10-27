/**
 * Extraction des sous-titres sidecar des embeds famille vidzy
 * (vidzy.org, fsvid.lol) — portage de sestudio/providers/subtitles.py.
 *
 * Deux déclarations possibles :
 *   - <track kind="captions" src="…" srclang="…" label="…">, ou
 *   - player.loadTracks([{kind:'subtitles', srclang:'fre', …, src: (IIFE)(url)}])
 *
 * Pour loadTracks on garde l'URL *argument* de l'IIFE (absolue, atteignable),
 * pas son résultat réécrit same-origin. La piste « Upload SRT » (empty.vtt)
 * est écartée : elle n'a aucune ligne de sous-titre.
 */

import { resolveUrl } from '../utils/http.js';

const LOAD_TRACKS_RE = /loadTracks\s*\(\s*\[([\s\S]{0,4000}?)\]\s*\)/g;
const HTML_TRACK_RE = /<track\b([^>]*)>/gi;
const ATTR_RE = /(\w[\w-]*)\s*=\s*["']([^"']*)["']/g;
const KEY_RE = /\b(kind|srclang|label|default)\s*:\s*(?:["']([^"']*)["']|(\w+))/g;
const SUB_URL_RE = /["']([^"']+\.(?:vtt|srt)(?:\?[^"']*)?)["']/gi;

const TEXT_KINDS = { subtitles: true, captions: true };

function isPlaceholder(url) {
    const path = String(url || '').split('?')[0];
    const file = path.split('/').pop().toLowerCase();
    return file === 'empty.vtt' || file === 'empty.srt';
}

function htmlUnescape(s) {
    return String(s || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;|&apos;/g, "'");
}

function build(url, attrs, baseUrl) {
    const kind = String(attrs.kind || 'subtitles').toLowerCase();
    if (!TEXT_KINDS[kind]) return null;
    const absolute = resolveUrl(baseUrl, htmlUnescape(url));
    if (isPlaceholder(absolute)) return null;
    const lang = attrs.srclang || '';
    const isDefault = 'default' in attrs && String(attrs['default']).toLowerCase() !== 'false';
    return {
        url: absolute,
        lang: lang,
        label: attrs.label || lang || 'Subtitles',
        default: isDefault,
    };
}

function fromLoadTracks(page, baseUrl) {
    const found = [];
    let call;
    LOAD_TRACKS_RE.lastIndex = 0;
    while ((call = LOAD_TRACKS_RE.exec(page)) !== null) {
        const body = call[1];
        let start = 0;
        let urlMatch;
        SUB_URL_RE.lastIndex = 0;
        while ((urlMatch = SUB_URL_RE.exec(body)) !== null) {
            const close = body.indexOf('}', urlMatch.index + urlMatch[0].length);
            const end = close < 0 ? body.length : close;
            const segment = body.slice(start, end);
            const attrs = {};
            let km;
            KEY_RE.lastIndex = 0;
            while ((km = KEY_RE.exec(segment)) !== null) {
                attrs[km[1]] = km[2] !== undefined ? km[2] : km[3];
            }
            const sub = build(urlMatch[1], attrs, baseUrl);
            if (sub) found.push(sub);
            start = end;
        }
    }
    return found;
}

function fromHtmlTracks(page, baseUrl) {
    const found = [];
    let track;
    HTML_TRACK_RE.lastIndex = 0;
    while ((track = HTML_TRACK_RE.exec(page)) !== null) {
        const attrs = {};
        let am;
        ATTR_RE.lastIndex = 0;
        while ((am = ATTR_RE.exec(track[1])) !== null) {
            attrs[am[1].toLowerCase()] = am[2];
        }
        if (!attrs.src) continue;
        const sub = build(attrs.src, attrs, baseUrl);
        if (sub) found.push(sub);
    }
    return found;
}

/**
 * Tous les sous-titres réels déclarés par l'embed (dédupliqués par URL).
 * @returns {Array<{url: string, lang: string, label: string}>}
 */
export function extractSubtitles(page, baseUrl) {
    const found = fromLoadTracks(page, baseUrl).concat(fromHtmlTracks(page, baseUrl));
    const seen = {};
    const unique = [];
    for (const s of found) {
        if (seen[s.url]) continue;
        seen[s.url] = true;
        unique.push(s);
    }
    return unique;
}
