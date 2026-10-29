// Tests offline de la vérification de liens et du nom affiché.
import { verifyStreams, probeOne, nextHlsUri } from '../src/core/verify.js';
import { finalizeStreams, makeStream } from '../src/core/stream.js';
import { buildMp4, buildMp4HeadJunk, buildMp4Tail, buildMp4MdatHead } from './helpers_mp4.mjs';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : ' → ' + d)); };
const calls = [];
const h = ct => ({ get: k => (String(k).toLowerCase() === 'content-type' ? ct : '') });
/** Master uqload synthétique : renditions audio séparées (fr=a1, en=a2) +
 * variantes vidéo MUXÉES index-v1-a2 (anglais) — la structure réelle constatée
 * live sur strm8.uqload.vc (Fall 2 : écran noir). lo = variante basse, hi =
 * haute BANDWIDTH (le swap cible la hi). */
const UQ_MOCK_MASTER = (lo, hi) => [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="Français",LANGUAGE="fr",AUTOSELECT=YES,DEFAULT=YES,CHANNELS="1",URI="https://cdn.example/' + lo + '/index-a1.m3u8?t=K"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="English",LANGUAGE="en",AUTOSELECT=NO,DEFAULT=NO,CHANNELS="1",URI="https://cdn.example/' + lo + '/index-a2.m3u8?t=K"',
  '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=587356,RESOLUTION=664x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="audio0"',
  'https://cdn.example/' + lo + '/index-v1-a2.m3u8?t=K',
  '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=3848585,RESOLUTION=1920x1040,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio0"',
  'https://cdn.example/' + hi + '/index-v1-a2.m3u8?t=K',
].join('\n');
globalThis.fetch = async (url, o = {}) => {
  calls.push([o.method, url, o.headers || {}]);
  if (url.includes('dead.m3u8')) return { status: 403, url, text: async () => 'forbidden' };
  if (url.includes('html.m3u8')) return { status: 200, url, text: async () => '<html>captcha</html>' };
  if (url.includes('good.m3u8')) return { status: 200, url, text: async () => '#EXTM3U\n#EXT-X-VERSION:3' };
  // v3.1.13 — anti-écran-noir uqload : master multi-pistes (EXT-X-MEDIA +
  // variantes index-vN-aN.m3u8 muxées -a2 anglais) → la sonde doit servir la
  // variante muxée de la langue (-a1 fr), validée par un fetch.
  if (url.includes('uqok.m3u8')) return { status: 200, url, text: async () => UQ_MOCK_MASTER('dp1', 'dp2') };
  if (url.includes('dp2/index-v1-a1.m3u8')) return { status: 200, url, text: async () => '#EXTM3U\n#EXTINF:5.0,\nseg-mux.ts' };
  if (url.includes('seg-mux.ts')) return { status: 200, url, headers: h('video/mp2t'), text: async () => '' };
  if (url.includes('dp1/index-v1-a2.m3u8')) return { status: 200, url, text: async () => '#EXTM3U\n#EXTINF:5.0,\nseg-dp1.ts' };
  if (url.includes('seg-dp1.ts')) return { status: 200, url, headers: h('video/mp2t'), text: async () => '' };
  if (url.includes('uqfail.m3u8')) return { status: 200, url, text: async () => UQ_MOCK_MASTER('dp3', 'dp3') };
  if (url.includes('dp3/index-v1-a1.m3u8')) return { status: 404, url, text: async () => 'not found' };
  if (url.includes('dp3/index-v1-a2.m3u8')) return { status: 200, url, text: async () => '#EXTM3U\n#EXTINF:5.0,\nseg-dp3.ts' };
  if (url.includes('seg-dp3.ts')) return { status: 200, url, headers: h('video/mp2t'), text: async () => '' };
  if (url.includes('nohead.mp4')) return { status: 405, url, text: async () => '' };
  if (url.includes('gone.mp4')) return { status: 404, url, text: async () => '' };
  // v3.1.7 — sonde profonde (variante + segment) et redirections HTML
  if (url.includes('gate.m3u8')) return { status: 200, url, text: async () => '#EXTM3U\n#EXTINF:4.0,\nseg-gate.ts' };
  if (url.includes('seg-gate.ts')) return { status: 403, url, headers: h('video/mp2t'), text: async () => 'forbidden' };
  if (url.includes('master.m3u8')) return { status: 200, url, text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nv0.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=400000\nv1.m3u8' };
  if (url.includes('v0.m3u8')) return { status: 200, url, text: async () => '#EXTM3U\n#EXTINF:4.0,\nseg0.ts' };
  if (url.includes('seg0.ts')) return { status: 200, url, headers: h('video/mp2t'), text: async () => '' };
  if (url.includes('htmlseg.m3u8')) return { status: 200, url, text: async () => '#EXTM3U\n#EXTINF:4.0,\nseg-html.ts' };
  if (url.includes('seg-html.ts')) return { status: 200, url, headers: h('text/html'), text: async () => '' };
  // v3.1.9 — content-type mensonger : le CDN sert le VRAI MP4 mais annonce
  // text/html (fastflux webflix → zen-blk.store, vérifié live). La sonde
  // goûte les premiers octets (GET Range) avant de trancher.
  if (url.includes('proxy.mp4')) return { status: 200, url, headers: h('text/html; charset=utf-8'), text: async () => '<html>captcha</html>' };
  // ⚠ AVANT 'lying.mp4' : 'voidlying' CONTIENT 'lying' — ordre discriminant.
  if (url.includes('voidlying.mp4')) {
    if (o.method === 'HEAD') return { status: 200, url, headers: h('text/html'), text: async () => '' };
    return { status: 200, url, headers: h('text/html'), text: async () => '' };
  }
  if (url.includes('lying.mp4')) {
    if (o.method === 'HEAD') return { status: 200, url, headers: h('text/html'), text: async () => '' };
    return { status: 200, url, headers: h('text/html'), text: async () => '\u0000\u0000\u0000\u0018ftypisom\u0000\u0000\u0002\u0000isomiso2avc1mp41' };
  }
  // v3.1.10 — qualité réelle des MP4 via moov/tkhd (octets bruts, Range 128 Ko)
  if (url.includes('lying1080.mp4')) {
    if (o.method === 'HEAD') return { status: 200, url, headers: h('text/html'), text: async () => '' };
    const b = buildMp4(1080, { version: 0 });
    return { status: 206, url, headers: h('text/html'), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), text: async () => '' };
  }
  if (url.includes('bare4k.mp4')) {
    if (o.method === 'HEAD') return { status: 200, url, headers: h('video/mp4'), text: async () => '' };
    const b = buildMp4(2160, { version: 1 });
    return { status: 206, url, headers: h('video/mp4'), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), text: async () => '' };
  }
  if (url.includes('lyinghtml.mp4')) {
    if (o.method === 'HEAD') return { status: 200, url, headers: h('text/html'), text: async () => '' };
    return { status: 200, url, headers: h('text/html'), text: async () => '<html>captcha</html>' };
  }
  // v3.1.12 — sonde de QUEUE : MP4 non faststart (moov en FIN de fichier —
  // bug utilisateur : fastflux 4K HEVC affiché « Direct » alors que le
  // lecteur montre 3840×2160). Le serveur répond selon le Range demandé :
  // tête → ftyp+mdat sans moov ; suffix range → moov complet.
  const respBytes = (status, ct, b) => ({ status, url, headers: h(ct), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), text: async () => '' });
  if (url.includes('tail4k.mp4')) {
    if (o.method === 'HEAD') return { status: 200, url, headers: h('video/mp4'), text: async () => '' };
    const rg = String((o.headers || {}).Range || '');
    if (rg === 'bytes=-262144') return respBytes(206, 'video/mp4', buildMp4Tail(2160, { version: 0 }));
    return respBytes(206, 'video/mp4', buildMp4HeadJunk());
  }
  if (url.includes('tailbig.mp4')) {
    // moov > 256 Ko : le 1er suffix range ne contient pas de tkhd → escalade 1 Mo.
    if (o.method === 'HEAD') return { status: 200, url, headers: h('video/mp4'), text: async () => '' };
    const rg = String((o.headers || {}).Range || '');
    if (rg === 'bytes=-262144') return respBytes(206, 'video/mp4', new Uint8Array(4096));
    if (rg === 'bytes=-1048576') return respBytes(206, 'video/mp4', buildMp4Tail(1080, { version: 1 }));
    return respBytes(206, 'video/mp4', buildMp4HeadJunk());
  }
  if (url.includes('flxtail.mp4')) {
    // fastflux : content-type mensonger ET moov en fin de fichier (combo réel).
    if (o.method === 'HEAD') return { status: 200, url, headers: h('text/html'), text: async () => '' };
    const rg = String((o.headers || {}).Range || '');
    if (rg === 'bytes=-262144') return respBytes(206, 'text/html', buildMp4Tail(2160, { version: 0 }));
    return respBytes(206, 'text/html', buildMp4HeadJunk());
  }
  // v3.1.16 — ciblage chirurgical du moov : moov NON faststart > 1 Mo (cas
  // réel Fall 2 : 6,6 Mo) — les suffix ranges de queue n'atteignent jamais le
  // tkhd (début du moov). L'en-tête mdat annonce 3 000 000 o à l'offset 20 :
  // le moov commence pile à 20 + 3 000 000 = 3 000 020 → le Range ciblé
  // bytes=3000020-3131091 doit être émis et contenir le tkhd.
  if (url.includes('moovfar.mp4')) {
    if (o.method === 'HEAD') return { status: 200, url, headers: h('video/mp4'), text: async () => '' };
    const rg = String((o.headers || {}).Range || '');
    if (rg === 'bytes=0-131071') return respBytes(206, 'video/mp4', buildMp4MdatHead(3000000));
    if (rg === 'bytes=3000020-3131091') return respBytes(206, 'video/mp4', buildMp4Tail(1080, { version: 0 }));
    return respBytes(206, 'video/mp4', buildMp4HeadJunk());
  }
  if (url.includes('moovfarfail.mp4')) {
    // Le Range ciblé échoue (404) → repli suffix ranges de queue (v3.1.12).
    if (o.method === 'HEAD') return { status: 200, url, headers: h('video/mp4'), text: async () => '' };
    const rg = String((o.headers || {}).Range || '');
    if (rg === 'bytes=0-131071') return respBytes(206, 'video/mp4', buildMp4MdatHead(3000000));
    if (rg === 'bytes=3000020-3131091') return { status: 404, url, headers: h('video/mp4'), text: async () => 'gone' };
    if (rg === 'bytes=-262144') return respBytes(206, 'video/mp4', buildMp4Tail(720, { version: 1 }));
    return respBytes(206, 'video/mp4', buildMp4HeadJunk());
  }
  // v3.1.16 — neutralité : échec RÉSEAU (statut 0) d'un MP4 → l'hôte est mis
  // en quarantaine 2 min par le disjoncteur ; TOUT autre lien du même hôte
  // doit ensuite rester « ? » (non testé), jamais « KO » retiré.
  if (url.includes('netfail.mp4')) throw new Error('getaddrinfo ENOTFOUND h8.example');
  return { status: 200, url, text: async () => '' };
};
const cfg = { fallbackLangs: ['vf', 'vostfr', 'vo'], allowOtherLang: true };
const mk = (title, url, site, headers) => makeStream({ title, url, language: 'VF', _langKey: 'vf', _site: site, headers });
const fin = finalizeStreams([
  mk('FStream · uqload · MP4 · VF', 'https://a.example/gone.mp4', 'fstream', { Referer: 'https://uqload.is/' }),
  mk('Webflix · FastFlux · HLS · VF', 'https://b.example/dead.m3u8', 'webflix'),
  mk('Papadustream · hls · HLS · VF', 'https://c.example/good.m3u8', 'papadustream', { Referer: 'https://p.example/' }),
  mk('FStream · voe · MP4 · VF', 'https://d.example/nohead.mp4', 'fstream'),
  mk('BFlix · rpmvid · HLS · VF', 'https://e.example/html.m3u8', 'bflix'),
], cfg);
ok('nom affiché = Fluxio · source · hôte', fin[0].name === 'Fluxio · fstream · uqload', fin[0].name);
for (const mode of ['timers', 'sans timers']) {
  calls.length = 0;
  const saved = globalThis.setTimeout;
  if (mode === 'sans timers') globalThis.setTimeout = undefined;
  const out = await verifyStreams(fin, { remainingMs: 20000 });
  globalThis.setTimeout = saved;
  console.log('— ' + mode);
  ok('flux vivants d\'abord', out[0].url.includes('good.m3u8') && out[1].url.includes('nohead.mp4'), out.map(s => s.name).join(' | '));
  ok('403 / 404 / playlist HTML → RETIRÉS de la liste (gowaru anti flux-mort)', out.length === 2 && !out.some(s => s.url.includes('gone.mp4') || s.url.includes('dead.m3u8') || s.url.includes('html.m3u8')), out.map(s => s.name).join(' | '));
  ok('HEAD 405 → conservé (inconnu)', !out.find(s => s.url.includes('nohead')).name.endsWith('⚠'));
  ok('MP4 sondé en HEAD, HLS en GET', calls.filter(c => c[1].endsWith('.mp4')).every(c => c[0] === 'HEAD') && calls.filter(c => c[1].endsWith('.m3u8')).every(c => c[0] === 'GET'));
  ok('Referer du flux transmis à la sonde', calls.some(c => c[1].includes('good.m3u8') && c[2].Referer === 'https://p.example/'));
}
const ep = finalizeStreams([mk('french-manga · E05 · uqload · HLS · VF', 'https://f.example/good.m3u8', 'french-manga')], cfg)[0];
ok('nom avec épisode = Fluxio · site · hôte · E05', ep.name === 'Fluxio · french-manga · uqload · E05', ep.name);
const skip = await verifyStreams(fin, { remainingMs: 2000 });
ok('budget restant trop court → aucune sonde, liste inchangée', skip === fin);

console.log('— v3.1.7 : sonde par segment + redirections HTML + weak player');
ok('nextHlsUri : 1re variante d un maître', nextHlsUri('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv0.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nv1.m3u8', '#EXT-X-STREAM-INF') === 'v0.m3u8');
ok('nextHlsUri : 1er segment d un média', nextHlsUri('#EXTM3U\n#EXTINF:4.0,\nseg0.ts\n#EXTINF:4.0,\nseg1.ts', '#EXTINF') === 'seg0.ts');
ok('nextHlsUri : absent → chaîne vide', nextHlsUri('#EXTM3U\n#EXT-X-VERSION:3', '#EXTINF') === '');

calls.length = 0;
const deepOk = finalizeStreams([mk('W · master · HLS · VF', 'https://g.example/master.m3u8', 'webflix')], cfg);
const outDeep = await verifyStreams(deepOk, { remainingMs: 20000 });
ok('chaîne maître→variante→segment OK', outDeep.length === 1 && !outDeep[0].name.endsWith('⚠'), outDeep.map(s => s.name).join(' | '));
const segCall = calls.find(c => c[1].includes('seg0.ts'));
ok('segment sondé en GET Range borné', !!segCall && segCall[0] === 'GET' && segCall[2].Range === 'bytes=0-16383', JSON.stringify(segCall && segCall[2]));

const gated = finalizeStreams([
  mk('W · gate · HLS · VF', 'https://t.example/gate.m3u8', 'webflix'),
  mk('W · master · HLS · VF', 'https://g.example/master.m3u8', 'webflix'),
], cfg);
const outGate = await verifyStreams(gated, { remainingMs: 20000 });
ok('playlist OK + segment 403 → RETIRÉ (cas vidzy TLS)', outGate.length === 1 && outGate[0].url.includes('master.m3u8'), outGate.map(s => s.name).join(' | '));

const htmlSeg = finalizeStreams([mk('W · htmlseg · HLS · VF', 'https://t.example/htmlseg.m3u8', 'webflix')], cfg);
const outHtmlSeg = await verifyStreams(htmlSeg, { remainingMs: 20000 });
ok('segment content-type text/html → RETIRÉ', outHtmlSeg.length === 0, JSON.stringify(outHtmlSeg.map(s => s.name)));

const proxied = finalizeStreams([mk('W · proxy · MP4 · VF', 'https://t.example/proxy.mp4', 'webflix')], cfg);
const outProxy = await verifyStreams(proxied, { remainingMs: 20000 });
ok('MP4 HEAD 200 text/html + corps HTML (goûtage) → RETIRÉ (redirection proxy)', outProxy.length === 0, JSON.stringify(outProxy.map(s => s.name)));

// v3.1.9 — CDN à content-type mensonger (fastflux/zen-blk.store) : le corps
// est le VRAI MP4 (signature ftyp) → le lien doit être CONSERVÉ.
const lying = finalizeStreams([mk('W · fastflux · MP4 · VF', 'https://t.example/lying.mp4', 'webflix')], cfg);
const outLying = await verifyStreams(lying, { remainingMs: 20000 });
ok('MP4 200 text/html + corps binaire ftyp → CONSERVÉ (fausse mort réparée)', outLying.length === 1, JSON.stringify(outLying.map(s => s.name)));
const sniffCall = calls.find(c => c[1].includes('lying.mp4') && c[0] === 'GET');
ok('goûtage en GET Range borné (128 Ko, lit aussi le moov)', !!sniffCall && sniffCall[2].Range === 'bytes=0-131071', JSON.stringify(sniffCall && sniffCall[2]));

const emptyLying = finalizeStreams([mk('W · fastflux vide · MP4 · VF', 'https://t.example/voidlying.mp4', 'webflix')], cfg);
const outEmpty = await verifyStreams(emptyLying, { remainingMs: 20000 });
ok('MP4 text/html + corps vide → « ? » conservé (on ne tue pas pour notre faute)', outEmpty.length === 1, JSON.stringify(outEmpty.map(s => s.name)));

const weakFin = finalizeStreams([
  mk('FStream · uqload · HLS · VF', 'https://w.example/good.m3u8', 'fstream'),
  makeStream({ title: 'FStream · vidzy · HLS · VF', url: 'https://w2.example/good.m3u8', quality: 'Auto (HLS)', language: 'VF', _langKey: 'vf', _site: 'fstream', _weakPlayer: true }),
], cfg);
ok('weak player rangé en dernier avec ⚠ (finalize)', weakFin[0].url.includes('w.example') && weakFin[1].url.includes('w2.example') && weakFin[1].name.endsWith(' ⚠'), weakFin.map(s => s.name).join(' | '));
const outWeak = await verifyStreams(weakFin, { remainingMs: 20000 });
ok('verify conserve le tri weak, ⚠ non doublé', outWeak[1].url.includes('w2.example') && outWeak[1].name.endsWith(' ⚠') && !outWeak[1].name.endsWith(' ⚠ ⚠'), outWeak.map(s => s.name).join(' | '));

// v3.1.10 — qualité réelle des MP4 via moov/tkhd (bug utilisateur : fastflux
// webflix affiché « Direct » alors qu'il est en 1080p ; l'URL ne porte aucun
// motif de résolution et l'API répond quality=Unknown).
{
  const r1 = await probeOne({ url: 'https://h.example/lying1080.mp4', headers: {} }, 4000, false);
  ok('CDN mensonger + moov 1080 → conservé + qualité « 1080p »', r1.ok === true && r1.quality === '1080p', JSON.stringify(r1));
  const r2 = await probeOne({ url: 'https://h.example/bare4k.mp4', headers: {} }, 4000, false);
  ok('MP4 sain sans motif URL + moov tkhd v1 2160 → « 4K »', r2.ok === true && r2.quality === '4K', JSON.stringify(r2));
  const r3 = await probeOne({ url: 'https://h.example/lyinghtml.mp4', headers: {} }, 4000, false);
  ok('CDN mensonger + HTML réel → toujours KO (octets)', r3.ok === false, JSON.stringify(r3));
  const q4 = await verifyStreams(finalizeStreams([mk('W · Lupin · MP4 · VF', 'https://t.example/bare4k.mp4', 'webflix')], cfg), { remainingMs: 20000 });
  ok('verifyStreams propage la qualité moov dans la liste Nuvio', q4.length === 1 && q4[0].quality === '4K', JSON.stringify(q4.map(s => s.quality)));
}

// v3.1.12 — sonde de queue : moov en fin de fichier (non faststart, surtout
// 4K HEVC — cf. retour utilisateur : fastflux webflix « Direct » alors que
// le lecteur affiche 3840×2160).
{
  const r1 = await probeOne({ url: 'https://h.example/tail4k.mp4', headers: {} }, 4000, false);
  ok('MP4 non faststart : sonde de QUEUE (suffix range) → « 4K »', r1.ok === true && r1.quality === '4K', JSON.stringify(r1));
  const tailRanges = calls.filter(c => c[1].includes('tail4k.mp4') && c[0] === 'GET').map(c => c[2].Range);
  ok('queue sondée en suffix range -262144 après échec tête 128 Ko', tailRanges.indexOf('bytes=-262144') !== -1, JSON.stringify(tailRanges));
  const r2 = await probeOne({ url: 'https://h.example/tailbig.mp4', headers: {} }, 4000, false);
  ok('moov > 256 Ko : escalade suffix range -1048576 → « 1080p »', r2.ok === true && r2.quality === '1080p', JSON.stringify(r2));
  const r3 = await probeOne({ url: 'https://h.example/flxtail.mp4', headers: {} }, 4000, false);
  ok('fastflux mensonger + moov final → conservé + « 4K » (combo réel)', r3.ok === true && r3.quality === '4K', JSON.stringify(r3));
  const q5 = await verifyStreams(finalizeStreams([mk('W · Discovery 4K · MP4 · VF', 'https://t.example/tail4k.mp4', 'webflix')], cfg), { remainingMs: 20000 });
  ok('verifyStreams propage la qualité de la sonde de queue', q5.length === 1 && q5[0].quality === '4K', JSON.stringify(q5.map(s => s.quality)));
}

// v3.1.16 — ciblage chirurgical du moov : moov non faststart > 1 Mo (Fall 2 :
// 6,6 Mo — la queue 256 Ko/1 Mo n'atteint jamais le tkhd, début du moov).
{
  calls.length = 0;
  const r1 = await probeOne({ url: 'https://h.example/moovfar.mp4', headers: {} }, 4000, false);
  ok('moov > 1 Mo non faststart : ciblage chirurgical après mdat → « 1080p »', r1.ok === true && r1.quality === '1080p', JSON.stringify(r1));
  const far = calls.filter(c => c[1].includes('moovfar.mp4') && c[0] === 'GET').map(c => c[2].Range);
  ok('Range ciblé émis à l offset calculé (20+mdat) AVANT la queue', far.indexOf('bytes=3000020-3131091') !== -1, JSON.stringify(far));
  ok('succès du ciblage → aucun suffix range de queue (1 requête au lieu de 2)', far.indexOf('bytes=-262144') === -1, JSON.stringify(far));
  const r2 = await probeOne({ url: 'https://h.example/moovfarfail.mp4', headers: {} }, 4000, false);
  ok('Range ciblé 404 → repli suffix range de queue → « 720p »', r2.ok === true && r2.quality === '720p', JSON.stringify(r2));
  const q6 = await verifyStreams(finalizeStreams([mk('W · film long · MP4 · VF', 'https://t.example/moovfar.mp4', 'webflix')], cfg), { remainingMs: 20000 });
  ok('verifyStreams propage la qualité du ciblage chirurgical', q6.length === 1 && q6[0].quality === '1080p', JSON.stringify(q6.map(s => s.quality)));
}

// v3.1.16 — neutralité du chemin MP4 HEAD : un échec réseau (statut 0) met
// l'hôte en quarantaine par le disjoncteur ; les sondes suivantes sur le même
// hôte reçoivent « hôte injoignable (disjoncteur) » — elles ne doivent PAS
// retirer le lien (bug observé en live : FastFlux retiré après un sniff trop
// lent, alors que le CDN répondait au lecteur).
{
  const dead = finalizeStreams([mk('W · netfail · MP4 · VF', 'https://h8.example/netfail.mp4', 'webflix')], cfg);
  const outDead = await verifyStreams(dead, { remainingMs: 20000 });
  ok('échec réseau réel (statut 0) → lien retiré (comportement inchangé)', outDead.length === 0, JSON.stringify(outDead.map(s => s.name)));
  const after = finalizeStreams([mk('W · même hôte · MP4 · VF', 'https://h8.example/autre.mp4', 'webflix')], cfg);
  const outAfter = await verifyStreams(after, { remainingMs: 20000 });
  ok('hôte en quarantaine (disjoncteur) → lien CONSERVÉ en « ? » (neutralité réparée)', outAfter.length === 1 && !outAfter[0].name.endsWith('⚠'), JSON.stringify(outAfter.map(s => s.name)));
}
// v3.1.13 — anti-écran-noir uqload : le master multi-pistes (pistes audio
// séparées + variantes MUXÉES -a2 anglais) est remplacé par la variante muxée
// de la langue du flux — structure réelle vérifiée live sur strm8.uqload.vc
// (Fall 2 : son VF + écran noir ; le français muxé index-v1-a1.m3u8 répond
// PMT vidéo AVC + AAC, vérifié live).
{
  const outMux = await verifyStreams(finalizeStreams([mk('W · uqload · HLS · VF', 'https://u.example/uqok.m3u8', 'uqload')], cfg), { remainingMs: 20000 });
  ok('master uqload multi-pistes → variante muxée FR servie directement', outMux.length === 1 && outMux[0].url.includes('dp2/index-v1-a1.m3u8'), outMux.map(s => s.url).join(' | '));
  ok('qualité conservée depuis le master (1920x1040 → 1080p)', outMux.length === 1 && outMux[0].quality === '1080p', outMux[0] && outMux[0].quality);
  const muxCall = calls.find(c => c[1].includes('dp2/index-v1-a1.m3u8'));
  ok('playlist muxée VALIDÉE par un fetch avant le remplacement', !!muxCall, JSON.stringify(muxCall && muxCall[1]));
  const outFail = await verifyStreams(finalizeStreams([mk('W · uqload fail · HLS · VF', 'https://u.example/uqfail.m3u8', 'uqload')], cfg), { remainingMs: 20000 });
  ok('variante -a1 indisponible (404) → master conservé, lien vivant', outFail.length === 1 && outFail[0].url.includes('uqfail.m3u8'), outFail.map(s => s.url).join(' | '));
  const vost = makeStream({ title: 'W · uqload · HLS · VOSTFR', url: 'https://u.example/uqok.m3u8', quality: 'Auto (HLS)', language: 'VOSTFR', _langKey: 'vostfr', _site: 'uqload' });
  const outVost = await verifyStreams(finalizeStreams([vost], cfg), { remainingMs: 20000 });
  ok('VOSTFR → master conservé (le muxé fixerait l audio français)', outVost.length === 1 && outVost[0].url.includes('uqok.m3u8'), outVost.map(s => s.url).join(' | '));
}
console.log(`\nRésultat : ${pass} OK, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
