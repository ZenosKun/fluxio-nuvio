/**
 * Normalisation, tri et déduplication des flux.
 *
 * Chaque source produit des flux internes annotés :
 *   { title, url, quality, language, headers, subtitles?, _langKey, _site }
 * Le cœur transforme ça en objets Nuvio propres (champs internes retirés),
 * triés par langue préférée puis dédupliqués par URL.
 */

const LANG_LABELS = {
    vf: 'VF',
    vostfr: 'VOSTFR',
    vo: 'VO',
};

/** Étiquette Nuvio « name » des flux. */
export const PROVIDER_NAME = 'Fluxio';

/** Libellé humain d'une clé de langue interne. */
export function langLabel(langKey) {
    return LANG_LABELS[langKey] || String(langKey || '').toUpperCase();
}

/**
 * Fabrique un flux interne annoté. Les champs _* pilotent le tri et le
 * dédoublonnage ; ils sont retirés à la normalisation finale.
 */
export function makeStream(parts) {
    return {
        title: String(parts.title || '').trim() || 'Flux',
        url: String(parts.url || ''),
        quality: parts.quality || 'Direct',
        language: parts.language || '',
        headers: parts.headers && Object.keys(parts.headers).length ? parts.headers : undefined,
        subtitles: parts.subtitles && parts.subtitles.length ? parts.subtitles : undefined,
        _langKey: parts._langKey || 'vo',
        _site: parts._site || '',
    };
}

/** Titre composé « Site [E12] · Hôte · Type · Langue » (style sestudio). */
export function composeTitle({ site, episode, host, url, lang }) {
    const kind = /\.m3u8(\?|$)/i.test(String(url || '')) ? 'HLS' : 'MP4';
    const epLabel = episode > 0 ? ' · E' + String(episode).padStart(2, '0') : '';
    return `${site}${epLabel} · ${host} · ${kind} · ${langLabel(lang)}`;
}

/** Nom affiché dans la liste (l'app n'affiche pas `title`) : Fluxio · source · hôte. */
function displayName(s) {
    if (s.name) return s.name;
    const parts = String(s.title || '').split(' · ');
    const host = parts.length > 1 ? parts[1] : '';
    return PROVIDER_NAME + (s._site ? ' · ' + s._site : '') + (host ? ' · ' + host : '');
}

/** Tri par langue préférée puis dédoublonnage par URL, format Nuvio final. */
export function finalizeStreams(streams, cfg) {
    const order = cfg.fallbackLangs;
    const allowed = cfg.allowOtherLang ? order : order.slice(0, 1);
    const idxOf = key => {
        const i = order.indexOf(key);
        return i === -1 ? 99 : i;
    };
    const relevant = (streams || []).filter(s => s && s.url && allowed.indexOf(s._langKey) !== -1);
    const sorted = relevant.slice().sort((a, b) => idxOf(a._langKey) - idxOf(b._langKey));

    const seen = {};
    const out = [];
    for (const s of sorted) {
        if (seen[s.url]) continue;
        seen[s.url] = true;
        const clean = {
            name: displayName(s),
            title: s.title,
            url: s.url,
            quality: s.quality || 'Direct',
            language: s.language || LANG_LABELS[s._langKey] || String(s._langKey || '').toUpperCase(),
        };
        if (s.headers && Object.keys(s.headers).length) clean.headers = s.headers;
        if (s.subtitles && s.subtitles.length) clean.subtitles = s.subtitles;
        out.push(clean);
    }
    return out;
}
