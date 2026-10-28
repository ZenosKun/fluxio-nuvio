/**
 * Parsing MP4 minimal (v3.1.10) : extraire la vraie résolution vidéo d'un
 * MP4 direct pour l'afficher dans Nuvio (« 1080p », « 4K »…).
 *
 * Pourquoi : les libellés génériques (« Direct ») quand l'URL ne contient
 * aucun motif de résolution (fastflux webflix → cdn80.zen-blk.store sert
 * Squid-Game-S01-E01.mp4 sans indice ; l'API webflix répond elle-même
 * quality=Unknown). Le moov/tkhd du conteneur annonce la VRAIE hauteur.
 *
 * Format (ISO/IEC 14496-12) : boîtes [size:u32][type:4o] ; size=1 → taille
 * u64 dans les 8 octets suivants ; size=0 → dernière boîte (jusqu'à la fin).
 * moov → trak → tkhd : width/height = 8 DERNIERS octets du tkhd, virgule
 * fixe 16.16 (vrai pour les versions 0 et 1 du tkhd — les champs variables
 * précèdent). Seule la piste vidéo a une hauteur non nulle ; on prend la max.
 *
 * Usage sonde : GET Range bytes=0-131071 (128 Ko). Les MP4 « streaming »
 * (faststart) placent le moov en tête — derrière ftyp, avant mdat.
 *
 * v3.1.12 — moov en FIN de fichier (non faststart, surtout 4K HEVC) : le
 * lecteur affiche 3840×2160 mais la sonde tête seule répond « Direct ». Un
 * suffix range (derniers octets) ramène un chunk qui démarre au MILIEU d'une
 * boîte (mdat) : le parcours strict y échoue. mp4MaxHeight ajoute donc un
 * scan par signature des 'tkhd' sur tout le buffer — sans hypothèse
 * d'alignement — avec garde-fous anti-faux positifs (taille de boîte
 * plausible 92-208 o, version 0-1, hauteur vidéo plausible 96-8192).
 */

/** Scan par signature des tkhd (v3.1.12) : retrouve la hauteur dans un chunk
 * non aligné (queue de fichier). Chaque candidat 'tkhd' n'est accepté que si
 * sa boîte déclarée est plausible et entièrement contenue dans le buffer. */
function scanTkhd(u8, dv) {
    let best = 0;
    for (let i = 4; i + 12 <= u8.length; i++) {
        if (u8[i] !== 0x74 || u8[i + 1] !== 0x6b || u8[i + 2] !== 0x68 || u8[i + 3] !== 0x64) continue; // 'tkhd'
        if (u8[i + 4] > 1) continue; // version 0 ou 1
        const size = dv.getUint32(i - 4);
        if (size < 92 || size > 208 || i - 4 + size > u8.length) continue;
        const h = Math.round(dv.getUint32(i - 4 + size - 4) / 65536);
        if (h >= 96 && h <= 8192 && h > best) best = h;
    }
    return best;
}

/** Hauteur vidéo max annoncée par les tkhd d'un buffer MP4 (0 = inconnu).
 * 1. parcours strict des boîtes depuis l'offset 0 (chunk de tête aligné) ;
 * 2. sinon scan par signature (chunk de queue non aligné, v3.1.12). */
export function mp4MaxHeight(u8) {
    if (!u8 || u8.length < 16) return 0;
    let dv;
    try {
        dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    } catch (e) {
        return 0;
    }
    const type = off =>
        String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    let best = 0;

    /** Parcourt des boîtes dans [start,end) ; recurse dans moov → trak → tkhd. */
    const walk = (start, end, depth) => {
        let o = start;
        while (o + 8 <= end && depth < 4) {
            let size = dv.getUint32(o);
            const t = type(o);
            if (size === 1) {
                // Taille 64 bits (largeSize) — Number() sûr jusqu'à 2^53.
                try { size = Number(dv.getBigUint64(o + 8)); } catch (e) { return; }
            } else if (size === 0) {
                size = end - o;
            }
            if (size < 8 || o + size > end + 1) {
                // Boîte tronquée (moov coupé par le Range) : on peut encore
                // scanner les enfants déjà présents si c'est un moov.
                if (t === 'moov' && size >= 8) { walk(o + 8, end, depth + 1); }
                return;
            }
            if (t === 'moov') {
                walk(o + 8, Math.min(o + size, end), depth + 1);
            } else if (t === 'trak') {
                walk(o + 8, Math.min(o + size, end), depth + 1);
            } else if (t === 'tkhd') {
                const endBox = o + size;
                // tkhd v0 = 84 o au total, v1 = 96 o — width/height sont les
                // 8 DERNIERS octets dans les deux versions (les champs à
                // taille variable, dates étendues v1, précèdent la matrice).
                if (size >= 84 && endBox <= end) {
                    const w = dv.getUint32(endBox - 8) / 65536;
                    const h = dv.getUint32(endBox - 4) / 65536;
                    if (h > best) best = h;
                }
            }
            o += size;
        }
    };
    walk(0, u8.length, 0);

    if (best === 0) {
        // Chunk non aligné (queue de fichier, moov final) : le parcours strict
        // échoue dès l'offset 0 (milieu d'une boîte) — scan par signature.
        try {
            best = scanTkhd(u8, dv);
        } catch (e) {
            /* buffer capricieux : on n'invente rien */
        }
    }

    const h = Math.round(best);
    // Sanité : une hauteur plausible de vidéo (pas un float résiduel du
    // parsing d'une piste audio — 0 — ni un garbage > 8K).
    return h >= 96 && h <= 8192 ? h : 0;
}

/** Libellé Nuvio depuis une hauteur (réutilise la convention du cœur). */
export function mp4QualityLabel(height) {
    const h = parseInt(height, 10);
    if (!(h > 0)) return '';
    return h >= 2000 ? '4K' : h + 'p';
}

/**
 * Reconnaît un début de MP4 : boîte ftyp en offset 4 (taille puis 'ftyp'),
 * éventuellement précédée d'autres boîtes de 8+ octets — on accepte aussi
 * le cas standard strict. Retourne false pour un HTML/texte.
 */
export function looksMp4(u8) {
    if (!u8 || u8.length < 12) return false;
    if (String.fromCharCode(u8[4], u8[5], u8[6], u8[7]) === 'ftyp') return true;
    // Quelques conteneurs annoncés video/mp4 sans ftyp immédiat : moov en tête.
    if (String.fromCharCode(u8[4], u8[5], u8[6], u8[7]) === 'moov') return true;
    return false;
}

/** Premier fragment non ASCII-contrôlé → page HTML ? (équivalent binaire de
 * looksHtml de verify.js — pour goûter un corps en octets sans le décoder.) */
export function bytesLookHtml(u8) {
    if (!u8 || !u8.length) return false;
    let i = 0;
    while (i < u8.length && (u8[i] === 0x20 || u8[i] === 0x0a || u8[i] === 0x0d || u8[i] === 0x09)) i++;
    if (i >= u8.length) return false;
    if (u8[i] === 0x3c /* < */) return true;
    // BOM UTF-8 + '<'
    if (u8[i] === 0xef && u8[i + 1] === 0xbb && u8[i + 2] === 0xbf && u8[i + 3] === 0x3c) return true;
    return false;
}
