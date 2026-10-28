// Tests offline de la vérification de liens et du nom affiché.
import { verifyStreams, probeOne, nextHlsUri } from '../src/core/verify.js';
import { finalizeStreams, makeStream } from '../src/core/stream.js';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : ' → ' + d)); };
const calls = [];
const h = ct => ({ get: k => (String(k).toLowerCase() === 'content-type' ? ct : '') });
globalThis.fetch = async (url, o = {}) => {
  calls.push([o.method, url, o.headers || {}]);
  if (url.includes('dead.m3u8')) return { status: 403, url, text: async () => 'forbidden' };
  if (url.includes('html.m3u8')) return { status: 200, url, text: async () => '<html>captcha</html>' };
  if (url.includes('good.m3u8')) return { status: 200, url, text: async () => '#EXTM3U\n#EXT-X-VERSION:3' };
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
ok('goûtage en GET Range borné', !!sniffCall && sniffCall[2].Range === 'bytes=0-16383', JSON.stringify(sniffCall && sniffCall[2]));

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
console.log(`\nRésultat : ${pass} OK, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
