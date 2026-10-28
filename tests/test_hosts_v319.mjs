// Tests v3.1.9 — nouvelles sources FR (frenchCS) : extracteurs vidmoly /
// xtremestream / veev + parseurs FrenchStream (tagz) et WookaFR (Dooplay +
// lecteurvideo OD_*). Offline : fetch global mocké, structures dérivées du
// reverse gowaru + des sondes live du 2026-10-28 (voir worklog Task 24).
import { resolveEmbed, providerFromEmbedUrl, PROVIDER_ORDER } from '../src/hosts/index.js';
import { parseTagNewsIds } from '../src/sources/french-stream.js';
import {
    parseSearchCards,
    parseEpisodes,
    extractAjaxConfig,
    decodeB64Url,
    parseLecteurvideoServers,
} from '../src/sources/wookafr.js';

let ok = 0, ko = 0;
const t = (n, c, d = '') => { c ? ok++ : ko++; console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : ' → ' + d)); };

/* ── 1. Hints providerFromEmbedUrl (ordres critiques) ────────────────────── */
{
    t('vidmoly.biz → vidmoly', providerFromEmbedUrl('https://vidmoly.biz/embed-abc.html') === 'vidmoly');
    t('vidmoly.me (TLD mort) → vidmoly', providerFromEmbedUrl('https://vidmoly.me/embed-abc.html') === 'vidmoly');
    // ⚠ 'voembed' commence par 'voe' : le hint dédié doit gagner.
    t('voembed.xyz → vidmoly (PAS voe)', providerFromEmbedUrl('https://voembed.xyz/e/abc') === 'vidmoly');
    t('ansembed.net → vidmoly', providerFromEmbedUrl('https://ansembed.net/e/abc') === 'vidmoly');
    t('lecteur2.xtremestream.xyz → xtremestream', providerFromEmbedUrl('https://lecteur2.xtremestream.xyz/player/index.php?data=x') === 'xtremestream');
    t('veev.to → veev', providerFromEmbedUrl('https://veev.to/v/abc') === 'veev');
    t('wishonly.site → veev (player packé générique)', providerFromEmbedUrl('https://wishonly.site/v/abc') === 'veev');
    t('livavid.com → veev', providerFromEmbedUrl('https://livavid.com/e/abc') === 'veev');
    t('voe.sx reste → voe', providerFromEmbedUrl('https://voe.sx/e/abc') === 'voe');
    t('PROVIDER_ORDER : uqload 1er, vidzy dernier, nouveaux insérés',
        PROVIDER_ORDER[0] === 'uqload' &&
        PROVIDER_ORDER[PROVIDER_ORDER.length - 1] === 'vidzy' &&
        PROVIDER_ORDER.indexOf('vidmoly') === 1 &&
        PROVIDER_ORDER.indexOf('xtremestream') === 2 &&
        PROVIDER_ORDER.indexOf('veev') !== -1);
}

/* ── 2. Mock fetch : pages embed vidmoly / xtremestream / veev ──────────── */
function packedScript(fileUrl) {
    // Format Dean-Edwards réel (même helper que test_hosts_v318).
    return (
        '<script>eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp("\\\\b"+c.toString(36)+"\\\\b","g"),k[c]);return p}' +
        '(\'' + 'file:"0"' + '\',36,1,\'' + fileUrl + '\'.split(\'|\'),0,{}))</script>'
    );
}
globalThis.fetch = async (url) => {
    const u = String(url);
    // Remplissage réaliste : les VRAIES pages vidmoly font > 500 o (les
    // pages plus courtes sont des pubs/404 — garde du résolveur).
    const PAD = '<div class="player-container">' + 'x'.repeat(600) + '</div>';

    // vidmoly : page serve .biz avec m3u8 en clair (gowaru live 2026-10)
    if (u.includes('vidmoly.me')) {
        // .me répond (200) mais page pub courte → le résolveur doit passer
        // au TLD suivant (.biz).
        return { status: 200, url: u, text: async () => '<html><body>ad</body></html>' };
    }
    if (u.includes('vidmoly.biz/embed-good')) {
        return {
            status: 200,
            url: 'https://vidmoly.biz/embed-good',
            text: async () =>
                PAD + '<html><body><script>file: "https://cdn.vidmoly.biz/hls/abc/master.m3u8"</script></body></html>',
        };
    }
    if (u.includes('vidmoly.biz/embed-packed')) {
        return {
            status: 200,
            url: 'https://vidmoly.biz/embed-packed',
            text: async () => PAD + packedScript('https://cdn.vidmoly.biz/hls/xyz/master.m3u8'),
        };
    }
    if (u.includes('vidmoly.biz/embed-jwt-real')) {
        // ⚠ AVANT le handler 'embed-jwt' : 'embed-jwt-real' contient
        // 'embed-jwt' — l'ordre des includes est discriminant.
        return {
            status: 200,
            url: 'https://vidmoly.biz/embed-jwt-real?ch=1&js=JWT',
            text: async () =>
                PAD + '<html><body><script>file: "https://cdn.vidmoly.biz/hls/jwt/master.m3u8"</script></body></html>',
        };
    }
    if (u.includes('vidmoly.biz/embed-jwt')) {
        // JWT redirect : window.location.replace('…?ch=1&js=JWT')
        return {
            status: 200,
            url: u,
            text: async () =>
                PAD + '<script>window.location.replace("https://vidmoly.biz/embed-jwt-real?ch=1&js=JWT");</script>',
        };
    }
    // vidmoly : ad-marker gowaru → doit échouer proprement
    if (u.includes('vidmoly.biz/embed-ad')) {
        return {
            status: 200,
            url: u,
            text: async () =>
                '<html><body>redirect finisheddaysflamboyant <a href="https://finisheddaysflamboyant.com/x">go</a></body></html>',
        };
    }

    // xtremestream : page player avec video_id + m3u8_loader_url, puis le
    // loader répond le manifest (#EXTM3U) avec Referer = player origin.
    if (u.includes('lecteur2.xtremestream.xyz/player')) {
        return {
            status: 200,
            url: u,
            text: async () =>
                '<html><body><script>var video_id = `b069bEXAMPLEid`;\nvar m3u8_loader_url = `https://lecteur2.xtremestream.xyz/xs1.php?data=`;</script></body></html>',
        };
    }
    if (u.includes('xtremestream.xyz/xs1.php?data=b069bEXAMPLEid')) {
        return {
            status: 200,
            url: u,
            text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nseg/1.m3u8',
        };
    }
    if (u.includes('xtremestream-broken')) {
        return { status: 200, url: u, text: async () => '<html>no vars</html>' };
    }

    // veev : player packé générique
    if (u.includes('veev.to/v/good')) {
        return {
            status: 200,
            url: u,
            text: async () => PAD + packedScript('https://cdn.veev.to/hls/abc/master.m3u8'),
        };
    }
    if (u.includes('wishonly.site/v/good')) {
        return {
            status: 200,
            url: u,
            text: async () =>
                PAD + '<html><body><script>jwplayer("v").setup({sources:[{file:"https://d1.wishonly.site/hls/9/master.m3u8"}]});</script></body></html>',
        };
    }
    if (u.includes('veev.to/v/dead')) {
        return { status: 200, url: u, text: async () => PAD + '<html><body>File was deleted</body></html>' };
    }

    return { status: 404, url: u, text: async () => 'not found' };
};

const R = (p, u) => resolveEmbed(p, u, { timeout: 4000 });

/* ── 3. vidmoly ──────────────────────────────────────────────────────────── */
{
    const got = await R('vidmoly', 'https://vidmoly.me/embed-good.html');
    t('vidmoly : TLD mort → repli .biz', got && /master\.m3u8/.test(got.url), JSON.stringify(got && got.url));
    t('vidmoly : Referer = domaine qui a servi', got && got.referer === 'https://vidmoly.biz/', got && got.referer);

    const got2 = await R('vidmoly', 'https://vidmoly.me/embed-packed.html');
    t('vidmoly : page packée déballée (file:)', got2 && /master\.m3u8/.test(got2.url), JSON.stringify(got2 && got2.url));

    const got3 = await R('vidmoly', 'https://vidmoly.me/embed-jwt.html');
    t('vidmoly : redirection JWT suivie', got3 && /jwt\/master\.m3u8/.test(got3.url), JSON.stringify(got3 && got3.url));

    let adErr = '';
    try { await R('vidmoly', 'https://vidmoly.me/embed-ad.html'); } catch (e) { adErr = e.message; }
    t('vidmoly : page pub (finisheddaysflamboyant) rejetée', adErr.indexOf('vidmoly irresolvable') !== -1, adErr);
}

/* ── 4. xtremestream ─────────────────────────────────────────────────────── */
{
    const got = await R('xtremestream', 'https://lecteur2.xtremestream.xyz/player/index.php?data=abc');
    t('xtremestream : URL = loader + video_id', got && got.url === 'https://lecteur2.xtremestream.xyz/xs1.php?data=b069bEXAMPLEid', JSON.stringify(got && got.url));
    t('xtremestream : Referer de lecture = player origin', got && got.referer === 'https://lecteur2.xtremestream.xyz/', got && got.referer);

    let err = '';
    try { await R('xtremestream', 'https://lecteur2.xtremestream-broken.xyz/player/index.php?data=x'); } catch (e) { err = e.message; }
    t('xtremestream : vars absentes → erreur claire', err.indexOf('video_id/loader introuvables') !== -1, err);
}

/* ── 5. veev / wishonly (player packé générique) ─────────────────────────── */
{
    const got = await R('veev', 'https://veev.to/v/good');
    t('veev : packé → m3u8', got && /veev\.to\/hls\/abc\/master\.m3u8/.test(got.url), JSON.stringify(got && got.url));
    t('veev : Referer = origin de l embed', got && got.referer === 'https://veev.to/', got && got.referer);

    const got2 = await R('veev', 'https://wishonly.site/v/good');
    t('wishonly (même player) → sources:[file:] m3u8', got2 && /wishonly\.site\/hls\/9\/master\.m3u8/.test(got2.url), JSON.stringify(got2 && got2.url));

    let err = '';
    try { await R('veev', 'https://veev.to/v/dead'); } catch (e) { err = e.message; }
    t('veev : fichier supprimé → erreur claire', err.indexOf('player packé sans source') !== -1, err);
}

/* ── 6. FrenchStream : parseTagNewsIds (structure live xfsearch tagz) ───── */
{
    // Dérivé de la page live f-27205 (Inception, newsId 1022) — les 3
    // marqueurs décrivent le même ID.
    const tagHtml =
        '<span id="ratig-layer-1022" class="ignore-select">+214</span>' +
        '<div class="vote-circle" data-id="1022"><span class="vote-score">0.0</span></div>' +
        '<img src="https://image.tmdb.org/t/p/w400/aej3.jpg" alt="Inception">' +
        '<a class="info-button" onclick="openModal(\'1022\')"></a>';
    const ids = parseTagNewsIds(tagHtml);
    t('french-stream : un seul newsId malgré 3 marqueurs', ids.length === 1 && ids[0] === '1022', JSON.stringify(ids));

    const multi = parseTagNewsIds('<div data-id="1022"></div><div data-id="2049"></div>');
    t('french-stream : newsIds multiples distincts, ordre conservé', multi.join(',') === '1022,2049', JSON.stringify(multi));
    t('french-stream : page vide → []', parseTagNewsIds('').length === 0);
}

/* ── 7. WookaFR : parseurs recherche / épisodes / AJAX ──────────────────── */
{
    // Dérivé du HTML live ?s=inception (2026-10-28) : carte moviecard avec
    // lien /streaming/{genre}/{slug}/ + alt d image + navigation à écarter.
    const searchHtml =
        '<article id="post-127604" class="moviecard col-6 col-sm-4 col-md-2 py-3">' +
        '<figure class="hoverable"><div class="meta-header"><ul class="list-inline">' +
        '<li class="badge-group"><span class="badge badge-warning">TMDB</span><span class="badge badge-light">0</span></li>' +
        '</ul></div>' +
        '<a href="https://wookafr.boston/streaming/aventure/inception/">' +
        '<img src="https://wookafr.boston/wp-content/themes/somosmovies/assets/img/placeholder_slider.webp" ' +
        'data-src="https://image.tmdb.org/t/p/w600/aej3.jpg" alt="Inception" class="rounded img-fluid rounded lazy"></a>' +
        '</figure></article>' +
        '<article id="post-2" class="moviecard x"><a href="https://wookafr.boston/streaming/slider/yiya-murano/">' +
        '<img alt="Yiya Murano : Quand le mal infuse"></a></article>' +
        '<article id="post-3" class="moviecard x"><a href="https://wookafr.boston/streaming/category/action/">' +
        '<img alt="Action"></a></article>';
    const cards = parseSearchCards(searchHtml, 'https://wookafr.boston');
    t('wookafr : 1 carte résultat (slider + category écartés)', cards.length === 1, JSON.stringify(cards.map(c => c.title)));
    t('wookafr : titre dérivé de l alt image', cards[0] && cards[0].title === 'Inception', cards[0] && cards[0].title);
    t('wookafr : film (pas /series/)', cards[0] && cards[0].is_film === true);
    t('wookafr : page_url conservée', cards[0] && cards[0].page_url === 'https://wookafr.boston/streaming/aventure/inception/');

    const seriesHtml =
        '<article class="moviecard"><a href="https://wookafr.boston/streaming/series/squid-game/">' +
        '<img alt="Squid Game"></a></article>';
    const sc = parseSearchCards(seriesHtml, 'https://wookafr.boston');
    t('wookafr : /streaming/series/ → is_film false', sc[0] && sc[0].is_film === false);
}

{
    // Épisodes : format URL live vérifié (suffixe -2 toléré, gowaru fix).
    const epsHtml =
        '<div class="lpep"><div class="itlep"><a href="https://wookafr.boston/episodes/squid-game-saison-3-episode-1/">' +
        '<h6 class="title">Episode 1</h6></a></div>' +
        '<div class="itlep"><a href="https://wookafr.boston/episodes/squid-game-saison-3-episode-2-2/">' +
        '<h6 class="title">Episode 2</h6></a></div></div>';
    const eps = parseEpisodes(epsHtml);
    t('wookafr : 2 épisodes parsés', eps.length === 2, JSON.stringify(eps));
    t('wookafr : saison+épisode extraits (format classique)', eps[0] && eps[0].season === 3 && eps[0].episode === 1, JSON.stringify(eps[0]));
    t('wookafr : suffixe -2 (2e publication) toléré', eps[1] && eps[1].episode === 2, JSON.stringify(eps[1]));

    // nonce sm_Public — format JSON strict (live) + format JS ancien.
    const j1 = extractAjaxConfig('var sm_Public = {"url":"https://wookafr.boston/wp-admin/admin-ajax.php","nonce":"84313b6639"};');
    t('wookafr : nonce JSON strict extrait', j1 && j1.nonce === '84313b6639' && /admin-ajax\.php$/.test(j1.url), JSON.stringify(j1));
    const j2 = extractAjaxConfig('var sm_Public = {url: "https://wookafr.boston/wp-admin/admin-ajax.php", nonce: "abc123"};');
    t('wookafr : nonce format JS ancien extrait', j2 && j2.nonce === 'abc123', JSON.stringify(j2));
    t('wookafr : sans config → null', extractAjaxConfig('<html></html>') === null);
}

/* ── 8. WookaFR : embed lecteurvideo (sections OD_*) ────────────────────── */
{
    // showVideo tokens en base64 standard (OD_FR) et base64url (OD_VOSTFR).
    const b64 = s => Buffer.from(s, 'utf8').toString('base64');
    const b64url = s => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const embedHtml =
        '<div class="tab-content">' +
        // OD_FR : xtremestream (prio 5) + uqload (prio 10) + une image à écarter
        '<div class="OD OD_FR active" id="od-fr">' +
        '<a onclick="showVideo(\'' + b64('https://lecteur2.xtremestream.xyz/player/index.php?data=abc') + '\',2)">XTREME</a>' +
        '<a onclick="showVideo(\'' + b64('https://uqload.cx/embed-abc123.html') + '\')">UQLOAD</a>' +
        '<a onclick="showVideo(\'' + b64('https://static.example.com/poster.jpg') + '\')">IMG</a>' +
        '</div>' +
        // OD_VOSTFR : vidmoly (prio 12) en base64url
        '<div class="OD OD_VOSTFR" id="od-vostfr">' +
        '<a onclick="showVideo(\'' + b64url('https://vidmoly.biz/embed-vost.html') + '\')">VIDMOLY</a>' +
        '</div>' +
        // OD_down : onglet téléchargement → ignoré (megaup morts)
        '<div class="OD OD_down" id="od-down">' +
        '<a onclick="showVideo(\'' + b64('https://megaup.net/abc/file.bin') + '\')">MEGAUP</a>' +
        '</div>' +
        '</div>';
    const servers = parseLecteurvideoServers(embedHtml);
    t('lecteurvideo : 3 serveurs (image + OD_down écartés)', servers.length === 3, JSON.stringify(servers.map(s => s.url)));
    t('lecteurvideo : xtremestream en priorité 5 (1er)', servers[0] && /xtremestream/.test(servers[0].url), servers[0] && servers[0].url);
    t('lecteurvideo : langue FR sur la section OD_FR', servers[0] && servers[0].lang === 'vf');
    t('lecteurvideo : langue VOSTFR sur OD_VOSTFR', servers.some(s => /vidmoly/.test(s.url) && s.lang === 'vostfr'), JSON.stringify(servers.map(s => s.lang)));
    const iUq = servers.findIndex(s => /uqload/.test(s.url));
    const iVid = servers.findIndex(s => /vidmoly/.test(s.url));
    const iXt = servers.findIndex(s => /xtremestream/.test(s.url));
    t('lecteurvideo : ordre prio xtremestream(5) < uqload(10) < vidmoly(12)',
        iXt === 0 && iUq === 1 && iVid === 2, 'xt=' + iXt + ' uq=' + iUq + ' vid=' + iVid);

    // OD_VFI (variante observée dans gowaru) → vf
    const embedVfi = '<div class="OD OD_VFI"><a onclick="showVideo(\'' + b64('https://uqload.cx/embed-vfi.html') + '\')"></a></div>';
    t('lecteurvideo : OD_VFI → vf', parseLecteurvideoServers(embedVfi)[0].lang === 'vf');

    // decodeB64Url : gardes
    t('decodeB64Url : non-URL → null', decodeB64Url(b64('pas une url')) === null);
    t('decodeB64Url : token vide → null', decodeB64Url('') === null);
    t('decodeB64Url : URL base64url décodée', (decodeB64Url(b64url('https://veev.to/v/x')) || '').indexOf('veev.to') !== -1);
}

/* ── Bilan ──────────────────────────────────────────────────────────────── */
console.log('\n' + (ko === 0 ? '✅ TOUS LES TESTS PASSENT' : '❌ ÉCHECS : ' + ko) + ' — ' + ok + ' ok / ' + (ok + ko) + ' total');
process.exit(ko === 0 ? 0 : 1);
