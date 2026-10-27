/**
 * Source BFlix/vidnest — provider v3 (résolution directe par tmdbId).
 *
 * Porté de v2 (extractor.directBflix) : la source est infaillible sur
 * l'identité du contenu (indexation par tmdbId — zéro risque de matching),
 * apporte VO + sous-titres FR/EN. Aucune dépendance aux métadonnées TMDB :
 * démarre immédiatement, avant même la classification.
 */

import { resolveBflix, bflixSubtitles } from './bflix-scrape.js';
import { makeStream } from '../core/stream.js';

export default {
    id: 'bflix',
    label: 'BFlix',
    needsMeta: false,
    async run(ctx) {
        const { cfg, signal, push, tmdbId, mediaType, season, episode } = ctx;

        // BFlix est VO/VOSTFR uniquement : en VF exclusive stricte, inutile.
        if (cfg.language === 'vf' && !cfg.allowOtherLang) return;

        const isTv = mediaType === 'tv';
        const s = parseInt(season, 10) || 1;
        const e = parseInt(episode, 10) || 1;
        const path = isTv ? 'tv/' + tmdbId + '/' + s + '/' + e : 'movie/' + tmdbId;

        let resolved;
        try {
            resolved = await resolveBflix(tmdbId, mediaType, isTv ? s : 0, isTv ? e : 0, {
                timeout: cfg.timeoutMs,
                signal: signal,
            });
        } catch (err) {
            console.warn('[bflix] échoué : ' + (err && err.message ? err.message : err));
            return;
        }
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
        const langKey = hasFr ? 'vostfr' : 'vo';
        const langLabel = hasFr ? 'VOSTFR' : 'VO';

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
