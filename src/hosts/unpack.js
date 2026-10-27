/**
 * Décodeur « Dean-Edwards packer » (eval(function(p,a,c,k,e,d){…})).
 *
 * Les embeds uqload / vidzy / luluvid / premium (fsvid.lol) empaquetent leur
 * player avec ce packer ; le décodage est un simple remplacement base-N des
 * jetons du dictionnaire. Portage fidèle de sestudio/providers/vidzy._unpack.
 *
 * Supporte les bases jusqu'à 62 (radix 62 = 0-9a-zA-Z) : l'original sestudio
 * s'arrête à 36, mais les hosts passent parfois au radix supérieur dès que le
 * dictionnaire dépasse 36 mots.
 */

const PACKED_RE = /\}\s*\('((?:[^']|\\.)+)',\s*(\d+)\s*,\s*(\d+)\s*,'((?:[^']|\\.)*?)'\s*\.split\('\|'\)/;

/**
 * Chiffre n en base b, même alphabet que le packer original :
 * 0-9 → '0'-'9', 10-35 → 'a'-'z', 36-61 → 'A'-'Z' (c + 29).
 */
function toBase(n, b) {
    const digit = c => (c < 36 ? c.toString(36) : String.fromCharCode(c + 29));
    return (n < b ? '' : toBase(Math.floor(n / b), b)) + digit(n % b);
}

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Décompresse le script s'il est empaqueté, sinon le renvoie tel quel.
 * @param {string} packed  HTML ou script contenant l'eval(function(p,a,c,k…)
 * @returns {string} script décompressé (ou texte d'origine)
 */
export function unpack(packed) {
    const text = String(packed || '');
    const m = PACKED_RE.exec(text);
    if (!m) return text;

    const payload = m[1].replace(/\\'/g, "'").replace(/\\"/g, '"');
    const base = parseInt(m[2], 10) || 10;
    const count = parseInt(m[3], 10) || 0;
    const keys = m[4].split('|');

    let result = payload;
    for (let i = count - 1; i >= 0; i--) {
        if (i < keys.length && keys[i]) {
            const token = toBase(i, base);
            // Remplacement via fonction : un mot du dictionnaire contenant
            // $&, $1… ne doit jamais être interprété comme motif de replacement.
            const word = keys[i];
            result = result.replace(new RegExp('\\b' + escapeRe(token) + '\\b', 'g'), () => word);
        }
    }
    return result;
}

/** Recherche l'eval packed dans une page ; renvoie le match complet ou ''. */
export function findPackedScript(html) {
    const m = /eval\s*\(function\s*\(p,a,c,k[\s\S]*?<\/script>/.exec(String(html || ''));
    return m ? m[0] : '';
}
