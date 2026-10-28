/**
 * Source BFlix/vidnest — provider v3 (résolution directe par tmdbId).
 *
 * Porté de v2 (extractor.directBflix) : la source est infaillible sur
 * l'identité du contenu (indexation par tmdbId — zéro risque de matching),
 * apporte VO + sous-titres FR/EN. Aucune dépendance aux métadonnées TMDB :
 * démarre immédiatement, avant même la classification.
 *
 * v3.1.10 — LANGUE réelle du flux : avant, l'étiquette venait des seuls
 * sous-titres (fr présent → « VOSTFR ») — faux pour les contenus dont la
 * langue originale EST le français (Lupin, TMDB 96677 : audio muxé français
 * étiqueté VOSTFR à tort). La langue est maintenant déduite de :
 *   1. les pistes audio annoncées par le master HLS (EXT-X-MEDIA TYPE=AUDIO,
 *      même parseur que papadustream) — une seule piste FR → « VF » ;
 *   2. sinon la langue originale TMDB : l'audio muxé de vidnest est la
 *      langue originale → original=fr ⇒ « VF », sinon fr subs ⇒ « VOSTFR ».
 * En VF exclusive stricte, la source ne tourne que si l'original est fr
 * (audio muxé = VF) — avant elle était écartée à tort aussi dans ce cas.
 */

import { resolveBflix, bflixSubtitles } from './bflix-scrape.js';
import { makeStream } from '../core/stream.js';
import { fetchText } from '../utils/http.js';

const LANG_LABELS = { vf: 'VF', vostfr: 'VOSTFR', vo: 'VO' };

/**
 * Clé de langue d'un flux bflix — PUR (testé unitairement).
 * @param {string[]} audioLangs langues LANGUAGE=/NAME= des pistes AUDIO du
 *        master HLS ([] = aucune info : audio muxé non décrit)
 * @param {boolean} hasFrSubs sous-titres français disponibles sur vidnest
 * @param {string} origLang langue originale TMDB ('fr', 'en'…, '' = inconnue)
 * @returns {'vf'|'vostfr'|'vo'}
 */
export function bflixLangKey(audioLangs, hasFrSubs, origLang) {
    const uniq = [];
    for (const raw of audioLangs || []) {
        const l = String(raw || '').toLowerCase().split('-')[0];
        if (l && uniq.indexOf(l) === -1) uniq.push(l);
    }
    // Une seule piste audio annoncée : c'est la vérité du serveur.
    if (uniq.length === 1) return uniq[0] === 'fr' ? 'vf' : (hasFrSubs ? 'vostfr' : 'vo');
    // Plusieurs pistes : le défaut du lecteur est inconnu (FR dub en piste
    // secondaire ≠ VF garantie) → on retombe sur l'heuristique du contenu.
    // Aucune info : l'audio muxé de vidnest = langue originale du titre.
    if (String(origLang || '').toLowerCase() === 'fr') return 'vf';
    return hasFrSubs ? 'vostfr' : 'vo';
}

/**
 * Langues audio annoncées par un master HLS (TYPE=AUDIO → LANGUAGE=, repli
 * NAME= français). Best effort : échec/timeout → [] (heuristique TMDB).
 */
export async function hlsAudioLangs(stream, timeoutMs, signal) {
    try {
        const headers = {};
        if (stream.referer) headers.Referer = stream.referer;
        if (stream.ua) headers['User-Agent'] = stream.ua;
        if (stream.provider && stream.provider !== 'flixhq') headers.Origin = 'https://vidnest.fun';
        const res = await fetchText(stream.url, {
            method: 'GET',
            headers: headers,
            timeout: Math.min(3000, timeoutMs || 3000),
            signal: signal,
        });
        const text = String(res.text || '');
        if (text.indexOf('#EXTM3U') === -1) return [];
        const langs = [];
        for (const line of text.split('\n')) {
            if (line.indexOf('TYPE=AUDIO') === -1) continue;
            // Une EXT-X-MEDIA = une ligne : ligne par ligne pour ne pas
            // attribuer le LANGUAGE des sous-titres à une piste audio.
            const m = /LANGUAGE="([^"]+)"/.exec(line);
            if (m) { langs.push(m[1]); continue; }
            const n = /NAME="([^"]+)"/.exec(line);
            if (n && /french|français|francais|^vf$/i.test(n[1])) langs.push('fr');
        }
        return langs;
    } catch (e) {
        return [];
    }
}

export default {
    id: 'bflix',
    label: 'BFlix',
    needsMeta: false,
    async run(ctx) {
        const { cfg, signal, push, tmdbId, mediaType, season, episode } = ctx;

        const isTv = mediaType === 'tv';
        const s = parseInt(season, 10) || 1;
        const e = parseInt(episode, 10) || 1;
        const path = isTv ? 'tv/' + tmdbId + '/' + s + '/' + e : 'movie/' + tmdbId;

        // Résolution et méta en parallèle : la méta ne retarde jamais le
        // premier appel vidnest (les deux promesses partent ensemble).
        const resolvedP = (async () => {
            try {
                return await resolveBflix(tmdbId, mediaType, isTv ? s : 0, isTv ? e : 0, {
                    timeout: cfg.timeoutMs,
                    signal: signal,
                });
            } catch (err) {
                console.warn('[bflix] échoué : ' + (err && err.message ? err.message : err));
                return [];
            }
        })();
        const metaP = Promise.resolve(ctx.meta).then(m => m).catch(() => null);
        const [resolvedArr, meta] = [await resolvedP, await metaP];
        const resolved = resolvedArr || [];
        const orig = (meta && meta.originalLanguage) || '';

        // VF exclusive stricte : vidnest muxe l'audio ORIGINAL — la source
        // ne sert du VF que si l'original est le français (v3.1.10 ; avant,
        // la source était écartée même pour Lupin).
        if (cfg.language === 'vf' && !cfg.allowOtherLang && orig !== 'fr') return;
        if (!resolved.length) return;

        // Sous-titres facultatifs (chemin de type movie/tv sans slash final).
        let subs = [];
        try {
            subs = await bflixSubtitles(path, { timeout: cfg.timeoutMs, signal: signal });
        } catch (err) {
            /* sous-titres facultatifs */
        }
        const nuvioSubs = subs.map(sub => {
            const track = {
                url: sub.url,
                title: sub.label || String(sub.lang || '').toUpperCase(),
                lang: sub.lang === 'fr' ? 'fre' : sub.lang,
            };
            if (sub.lang === 'fr') track.default = true;
            return track;
        });
        const hasFr = subs.some(x => x.lang === 'fr');

        // Langue réelle : pistes audio du premier master HLS, sinon heuristique.
        const firstHls = resolved.find(r => /\.m3u8(\?|$)/i.test(String(r.url || '')));
        const audioLangs = firstHls ? await hlsAudioLangs(firstHls, cfg.timeoutMs, signal) : [];
        const langKey = bflixLangKey(audioLangs, hasFr, orig);
        const langLabel = LANG_LABELS[langKey] || langKey.toUpperCase();
        if (audioLangs.length) {
            console.log('[bflix] audio ' + JSON.stringify(audioLangs) + ' → ' + langLabel);
        } else {
            console.log('[bflix] audio muxé non décrit (original=' + (orig || '?') + ') → ' + langLabel);
        }

        for (const r of resolved) {
            const kind = /\.m3u8(\?|$)/i.test(String(r.url || '')) ? 'HLS' : 'MP4';
            // Origin sans slash final : un Origin est scheme://host[:port] sans chemin.
            const headers = {};
            if (r.referer) headers.Referer = r.referer;
            if (r.ua) headers['User-Agent'] = r.ua;
            if (r.provider !== 'flixhq') headers.Origin = 'https://vidnest.fun';

            push(
                makeStream({
                    title: `BFlix · ${r.provider} · ${kind} · ${langLabel}`,
                    url: r.url,
                    quality: kind === 'HLS' ? 'Auto (HLS)' : 'Direct',
                    language: langLabel,
                    headers: headers,
                    subtitles: nuvioSubs,
                    _langKey: langKey,
                    _site: 'bflix',
                })
            );
        }
    },
};
