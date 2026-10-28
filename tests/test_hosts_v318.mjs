// Tests v3.1.8 — correctifs calqués sur les références (sestudio + gowaru).
// Offline : fetch global mocké. Cible :
//   1. vidzy 2026+ : brute-force BC 0..255 (gowaru resolveFsvidVidzy)
//   2. luluvid : rejet du CDN tnmr.org (403 vérifié live, gowaru) + exception cdn-tnmr
//   3. vidzy : rejet du leurre troll/master.m3u8 (gowaru isKnownFakeDirectUrl)
//   4. Referer de lecture vidzy.live / fsvid.lol (gowaru, vérifié live 200)
//   5. webflix extractStreamUrls : URLs stream.fluxora.sbs/v1/ (HLS pré-tokenisé)
import { resolveEmbed } from '../src/hosts/index.js';
import { extractStreamUrls } from '../src/sources/webflix.js';
import { deobfuscateSrc } from '../src/hosts/vidzyShared.js';
import { hostOffset } from '../src/hosts/vidzyShared.js';

let ok = 0, ko = 0;
const t = (n, c, d = '') => { c ? ok++ : ko++; console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : ' → ' + d)); };

/* ── 1. Brute-force BC (motif gowaru 2026 : clé = (0x3d + i*89 + H + BC) & 255,
 *       octets inversés, payload base64 — BC non calculable côté plugin) ── */
{
    const url = 'https://s1.fsvid.lol/hls/abc123/master.m3u8';
    const hostname = 'fsvid.lol';
    const H = hostOffset(hostname);
    const BC = 137;
    // Encodage (inverse du décodeur) : XOR puis INVERSION des octets puis b64.
    let enc = '';
    for (let i = 0; i < url.length; i++) {
        enc += String.fromCharCode(url.charCodeAt(i) ^ ((0x3d + i * 89 + H + BC) & 255));
    }
    enc = enc.split('').reverse().join('');
    const payload = Buffer.from(enc, 'binary').toString('base64');
    const body =
        'src:(function(s){var b=atob(s),a=b.split("").reverse().join(""),r="";' +
        'for(var i=0;i<a.length;i++){var kk=(0x3d+i*89+H+BC)&255;r+=String.fromCharCode(a.charCodeAt(i)^kk)}' +
        'return /^https?:/.test(r)?r:"troll"})("' + payload + '")';

    let got = '';
    try { got = deobfuscateSrc(body, payload, hostname); } catch (e) { got = 'ERR ' + e.message; }
    t('BC brute-force : clé (0x3d+i*89+H+BC) décodée (BC=' + BC + ')', got === url, got.slice(0, 90));

    // Payload base64URL (gowaru : '-'→'+', '_'→'/')
    const payloadUrlSafe = payload.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    let got2 = '';
    try { got2 = deobfuscateSrc(body, payloadUrlSafe, hostname); } catch (e) { got2 = 'ERR ' + e.message; }
    t('payload base64url acceptée', got2 === url, got2.slice(0, 90));

    // Décalage non couvert par les 4 offsets classiques : BC arbitraire 255
    const BC2 = 255;
    let enc2 = '';
    for (let i = 0; i < url.length; i++) {
        enc2 += String.fromCharCode(url.charCodeAt(i) ^ ((0x3d + i * 89 + H + BC2) & 255));
    }
    enc2 = enc2.split('').reverse().join('');
    const payload2 = Buffer.from(enc2, 'binary').toString('base64');
    const body2 = body.replace(payload, payload2);
    let got3 = '';
    try { got3 = deobfuscateSrc(body2, payload2, hostname); } catch (e) { got3 = 'ERR ' + e.message; }
    t('BC=255 (offset hors {0,host,layout,host+layout}) décodé', got3 === url, got3.slice(0, 90));
}

/* ── Mock fetch : pages embed luluvid/vidzy ── */
function packedScript(fileUrl) {
    // Vrai format Dean-Edwards (décodable par src/hosts/unpack.js) :
    // payload et clés en GUILLEMETS SIMPLES (format du packer réel),
    // token '0' → URL, base 36, 1 mot.
    return (
        '<script>eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp("\\\\b"+c.toString(36)+"\\\\b","g"),k[c]);return p}' +
        '(\'' + 'file:"0"' + '\',36,1,\'' + fileUrl + '\'.split(\'|\'),0,{}))</script>'
    );
}
globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('luluvdo.com/e/tnmr')) {
        return { status: 200, url: u, text: async () => packedScript('https://htvpd1vylmox.tnmr.org/hls/master.m3u8?t=1') };
    }
    if (u.includes('luluvdo.com/e/cdntnmr')) {
        return { status: 200, url: u, text: async () => packedScript('https://cdn-tnmr.org/hls/master.m3u8?t=1') };
    }
    if (u.includes('luluvdo.com/e/good')) {
        return { status: 200, url: u, text: async () => packedScript('https://htvpd1vylmox.tnmr.org/hls/master.m3u8'.replace('tnmr.org', 'example.net') + '?t=1') };
    }
    if (u.includes('fsvid.lol/embed/troll')) {
        return { status: 200, url: u, text: async () => 'src:"https://s1.fsvid.lol/troll/master.m3u8"' };
    }
    return { status: 404, url: u, text: async () => 'nf' };
};

/* ── 2. luluvid : rejet tnmr.org + exception cdn-tnmr ── */
{
    let msg = '';
    try { await resolveEmbed('luluvid', 'https://vidhsareup.io/embed-tnmr.html', { timeout: 3000 }); }
    catch (e) { msg = e.message; }
    t('luluvid → tnmr.org rejeté (403 live vérifié, gowaru)', /tnmr\.org/.test(msg), msg);

    let okCdn = null;
    try { okCdn = await resolveEmbed('luluvid', 'https://vidhsareup.io/embed-cdntnmr.html', { timeout: 3000 }); }
    catch (e) { okCdn = null; }
    t('exception cdn-tnmr.org conservée (sous-domaine légitime)', !!okCdn && okCdn.url.includes('cdn-tnmr.org'), okCdn && okCdn.url);

    let okGood = null;
    try { okGood = await resolveEmbed('luluvid', 'https://vidhsareup.io/embed-good.html', { timeout: 3000 }); }
    catch (e) { okGood = null; }
    t('luluvid hors tnmr.org : résolution normale', !!okGood && /\.m3u8/.test(okGood.url), okGood && okGood.url);
}

/* ── 3+4. vidzy : leurre troll rejeté ; referer de lecture = vidzy.live ── */
{
    let msg = '';
    try { await resolveEmbed('premium', 'https://fsvid.lol/embed/troll.html', { timeout: 3000 }); }
    catch (e) { msg = e.message; }
    t('leurre troll/master.m3u8 rejeté (gowaru isKnownFakeDirectUrl)', /troll/.test(msg), msg);
}

/* ── 5. webflix : URLs stream.fluxora.sbs/v1/ extraites (HLS pré-tokenisé) ── */
{
    const html = 'var videoUrl="https://stream.fluxora.sbs/v1/anime?t=tok1&format=hls";urls=["https://other.example/x.m3u8"]';
    const urls = extractStreamUrls(html, 'https://fluxora.sbs/embed/zenix');
    t('stream.fluxora.sbs/v1/ extrait par le scan marqueur', urls.some(u => u.startsWith('https://stream.fluxora.sbs/v1/anime?')), JSON.stringify(urls));
}

console.log(`\nRésultat : ${ok} OK, ${ko} échec(s)`);
process.exit(ko ? 1 : 0);
