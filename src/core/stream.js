/**
 * Normalisation, tri et déduplication des flux.
 *
 * Chaque source produit des flux internes annotés :
 *   { title, url, quality, language, headers, subtitles?, _langKey, _site }
 * Le cœur transforme ça en objets Nuvio propres (champs internes retirés),
 * triés par langue préférée puis, à langue égale, par qualité décroissante
 * (v3.1.11 : 4K > 1080p > 720p > Auto (HLS) > Direct), et dédupliqués par URL.
 * v3.1.18 : le champ size (« 1.27 GB », annoncé par l'API FastFlux) traverse
 * jusqu'au flux Nuvio — le panneau de l'app l'affiche (Gowaru le passe aussi,
 * cf. panneau « 720p · 1.27 GB · fr »).
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
 * dédoublonnage ; ils sont retirés à la normalisation finale. _weakPlayer
 * (vidzy : TLS Chrome + gk= inaccessibles au lecteur natif) est rangé en
 * dernier avec un ⚠ même si le lien répond correctement à la sonde.
 */
export function makeStream(parts) {
    const st = {
        title: String(parts.title || '').trim() || 'Flux',
        url: String(parts.url || ''),
        quality: parts.quality || 'Direct',
        language: parts.language || '',
        headers: parts.headers && Object.keys(parts.headers).length ? parts.headers : undefined,
        subtitles: parts.subtitles && parts.subtitles.length ? parts.subtitles : undefined,
        _langKey: parts._langKey || 'vo',
        _site: parts._site || '',
    };
    // v3.1.18 : taille annoncée par l'API (« 1.27 GB ») — affichée par le
    // panneau Nuvio. Champ optionnel : absent pour les flux sans info.
    if (parts.size) st.size = String(parts.size);
    if (parts._weakPlayer === true) st._weakPlayer = true;
    return st;
}

/** Titre composé « Site [E12] · Hôte · Type · Langue » (style sestudio). */
export function composeTitle({ site, episode, host, url, lang }) {
    const kind = /\.m3u8(\?|$)/i.test(String(url || '')) ? 'HLS' : 'MP4';
    const epLabel = episode > 0 ? ' · E' + String(episode).padStart(2, '0') : '';
    return `${site}${epLabel} · ${host} · ${kind} · ${langLabel(lang)}`;
}

/** Flux publics de test : si eux non plus ne se lisent pas, le problème est le lecteur, pas les sources. */
export const TEST_STREAMS = [
    { name: 'Fluxio · TEST HLS (mux.dev)', title: 'Test HLS', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', quality: 'Auto (HLS)', language: 'TEST' },
    // Flux public de test vérifié vivant (v3.1.8 : l'URL google
    // gtv-videos-bucket répond désormais 403 — bucket GCS restreint ;
    // test-videos.co.uk sert 206 video/mp4 avec support Range, vérifié live).
    { name: 'Fluxio · TEST MP4 (test-videos)', title: 'Test MP4', url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_30MB.mp4', quality: 'Direct', language: 'TEST' },
];

/** Nom affiché dans la liste (l'app n'affiche pas `title`) : Fluxio · source · hôte. */
function displayName(s) {
    if (s.name) return s.name;
    // Titre = « site[ · E05] · hôte · type · langue » : on sort le n° d'épisode.
    const parts = String(s.title || '').split(' · ');
    let ep = '';
    const rest = [];
    parts.forEach(function (p, i) {
        if (i > 0 && /^E\d{1,4}$/.test(p)) ep = p;
        else rest.push(p);
    });
    const host = rest.length > 1 ? rest[1] : '';
    return PROVIDER_NAME + (s._site ? ' · ' + s._site : '') + (host ? ' · ' + host : '') + (ep ? ' · ' + ep : '');
}

/** Libellé Nuvio d'une hauteur vidéo : 2160+ → 4K, sinon « <h>p ». */
export function resolutionLabel(height) {
    const h = parseInt(height, 10);
    if (!(h > 0)) return '';
    return h >= 2000 ? '4K' : h + 'p';
}

/** Motif de qualité dans une URL (…/1080/…, -1080p.mp4, _720p…) → « 1080p ». */
export function qualityFromUrl(url) {
    const m = /(?:^|[\/._\-])(2160|1440|1080|720|576|480|360|240)p?(?:[\/._\-]|$)/.exec(String(url || ''));
    if (!m) return '';
    return resolutionLabel(m[1]);
}

/**
 * Rang de qualité pour le tri secondaire (v3.1.11) : plus petit = meilleure.
 * Ordre : 4K (0) > 1440p (1) > 1080p (2) > 720p (3) > autres hauteurs (4)
 * > Auto (HLS) (5) > Direct/inconnu (6). À langue égale, les meilleures
 * qualités arrivent donc en tête de liste.
 * @param {string} quality champ quality d'un flux interne (« 4K », « 1080p »,
 *        « Auto (HLS) », « Direct »…)
 * @returns {number} rang 0-6
 */
export function qualityRank(quality) {
    const q = String(quality || '').toLowerCase();
    if (/2160|4k/.test(q)) return 0;
    const m = /(\d{3,4})\s*p/.exec(q);
    if (m) {
        const h = parseInt(m[1], 10);
        if (h >= 1440) return 1;
        if (h >= 1080) return 2;
        if (h >= 720) return 3;
        return 4; // 480p et en dessous
    }
    if (/hls|auto/.test(q)) return 5; // flux adaptatif : meilleure piste inconnue
    return 6; // « Direct », vide, inconnu
}

/** Tri par langue préférée, à langue égale par qualité décroissante
 * (4K > 1080p > 720p > Auto HLS > Direct), puis dédoublonnage par URL,
 * format Nuvio final.
 * Les flux _weakPlayer (vidzy : segments refusés au lecteur natif) passent en
 * dernier avec un ⚠ — ils restent affichés mais ne bloquent plus la liste. */
export function finalizeStreams(streams, cfg) {
    const order = cfg.fallbackLangs;
    const allowed = cfg.allowOtherLang ? order : order.slice(0, 1);
    const idxOf = key => {
        const i = order.indexOf(key);
        return i === -1 ? 99 : i;
    };
    const relevant = (streams || []).filter(s => s && s.url && allowed.indexOf(s._langKey) !== -1);
    // Tri principal = langue (préférence utilisateur, non négociable) ;
    // tri secondaire = qualité décroissante (v3.1.11) : à langue égale, la
    // 4K passe devant le 1080p, lui-même devant l'Auto HLS et le Direct.
    const sorted = relevant.slice().sort(
        (a, b) =>
            idxOf(a._langKey) - idxOf(b._langKey) ||
            qualityRank(a.quality) - qualityRank(b.quality)
    );

    const seen = {};
    const good = [];
    const weak = [];
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
        if (s.size) clean.size = String(s.size);
        if (s.headers && Object.keys(s.headers).length) clean.headers = s.headers;
        if (s.subtitles && s.subtitles.length) clean.subtitles = s.subtitles;
        (s._weakPlayer === true ? weak : good).push(clean);
    }
    return good.concat(
        weak.map(function (w) {
            if (!/ ⚠$/.test(w.name)) w.name += ' ⚠';
            return w;
        })
    );
}
