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
 *
 * v3.1.12 complément (retour utilisateur) : un FAUX POSITIF du scan — dans
 * un mdat, la séquence d'octets 'tkhd' peut apparaître PAR HASARD (hauteur
 * 1359 « lue » alors que le lecteur affiche 1280×720 ; 1359 passait les
 * bornes brutes 96-8192). Le scan n'accepte plus qu'une hauteur STANDARD
 * ± 8 px (arrondi/crop) OU un crop cinémascope cohérent, ET une largeur
 * plausible (ratio w/h 1,2-3,2) — un leurre géométriquement absurde ne fait
 * plus de libellé fantaisiste.
 *
 * v3.1.12 complément 2 (retour utilisateur) : les CROPS SCOPE étaient
 * étiquetés par leur hauteur brute (« 800p ») alors que le lecteur affiche
 * « 1920 × 800 (1080p) » — cinémascope 2,40:1 taillé dans un master 1080p.
 * standardHeight() reclassifie comme les lecteurs et le nommage P2P : la
 * LARGEUR décide (1920×800 → 1080p, 1280×536 → 720p, 3840×1608 → 4K).
 */

/** Hauteurs vidéo standard (anti faux positifs du scan, v3.1.12) : une
 * hauteur qui n'est pas une résolution réelle — ou très proche (± 8 px,
 * arrondi/crop d'encodage) — provient d'octets apparus par hasard dans du
 * mdat, pas d'un vrai tkhd. */
const STD_HEIGHTS = [240, 360, 480, 576, 720, 1080, 1440, 2160];
function isPlausibleHeight(h) {
    for (let i = 0; i < STD_HEIGHTS.length; i++) {
        if (Math.abs(h - STD_HEIGHTS[i]) <= 8) return true;
    }
    return false;
}

/** Hauteur du BUCKET standard affiché pour un couple annoncé (v3.1.12) :
 * les lecteurs (panel « 1920 × 800 (1080p) ») et le nommage P2P classent
 * un crop cinémascope par sa LARGEUR — 1920×800 est un 1080p scope,
 * 1280×536 un 720p scope, 3840×1608 un 4K scope. La hauteur seule donnait
 * « 800p » (bug utilisateur). Portrait (h > w) et SD : hauteur brute
 * (720×576 → « 576p », pas de bucket SD fiabilisable par largeur). */
export function standardHeight(w, h) {
    w = Math.round(w); h = Math.round(h);
    if (h > w) return h; // portrait (vidéo téléphone…) : pas de reclassification
    if (w >= 3400 || h >= 2000) return 2160;
    if (w >= 2300 || h >= 1300) return 1440;
    if (w >= 1700 || h >= 1000) return 1080;
    if (w >= 1100 || h >= 700) return 720;
    return h;
}

/** Géométrie plausible d'un candidat tkhd du scan (anti faux positifs) :
 * largeur cohérente (w > 0, ratio w/h 1,2-3,2 — 4:3 1,33, 16:9 1,78, scope
 * 2,39 et 1920×720 2,67 passent ; w=0, portrait/square ou ratio absurde
 * non — bornes plus larges que le 1,2-2,5 initial proposé : un vrai film
 * 1920×720 serait sinon rejeté, régression cinéma scope) ET hauteur
 * standard ± 8 px OU crop cinémascope d'un bucket (ratio cinéma ≥ 1,8 —
 * 1,85, 2,20, 2,35, 2,39 — et hauteur dans la fourchette des crops réels :
 * 1920×800, 1280×536, 3840×1608…). */
function isPlausibleGeometry(w, h) {
    if (!(w > 0) || w / h < 1.2 || w / h > 3.2) return false;
    if (isPlausibleHeight(h)) return true;
    return w / h >= 1.8 && h >= 500 && h <= 1720;
}

/** Scan par signature des tkhd (v3.1.12) : retrouve la hauteur dans un chunk
 * non aligné (queue de fichier). Chaque candidat 'tkhd' n'est accepté que si
 * sa boîte déclarée est plausible et entièrement contenue dans le buffer et
 * que sa géométrie est crédible (isPlausibleGeometry) ; le meilleur candidat
 * est reclassifié dans le bucket standard par largeur (standardHeight). */
function scanTkhd(u8, dv) {
    let best = 0;
    for (let i = 4; i + 12 <= u8.length; i++) {
        if (u8[i] !== 0x74 || u8[i + 1] !== 0x6b || u8[i + 2] !== 0x68 || u8[i + 3] !== 0x64) continue; // 'tkhd'
        if (u8[i + 4] > 1) continue; // version 0 ou 1
        const size = dv.getUint32(i - 4);
        if (size < 92 || size > 208 || i - 4 + size > u8.length) continue;
        const h = Math.round(dv.getUint32(i - 4 + size - 4) / 65536);
        const w = Math.round(dv.getUint32(i - 4 + size - 8) / 65536);
        // Anti faux positifs (retour utilisateur : 1359 lu dans du mdat,
        // lecteur = 1280×720) : géométrie crédible (hauteur standard ± 8
        // px OU crop scope cohérent, largeur plausible) puis bucket standard.
        if (h >= 96 && h <= 8192 && isPlausibleGeometry(w, h)) {
            const tier = standardHeight(w, h);
            if (tier > best) best = tier;
        }
    }
    return best;
}

/** Hauteur vidéo max annoncée par les tkhd d'un buffer MP4 (0 = inconnu),
 * reclassifiée dans le bucket standard par largeur (1920×800 → 1080).
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
                // Bucket standard (v3.1.12) : 1920×800 (crop scope) → 1080,
                // comme le panel du lecteur — la hauteur seule donnait 800.
                if (size >= 84 && endBox <= end) {
                    const w = dv.getUint32(endBox - 8) / 65536;
                    const h = dv.getUint32(endBox - 4) / 65536;
                    const tier = standardHeight(w, h);
                    if (tier > best) best = tier;
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
