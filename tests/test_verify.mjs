// Tests offline de la vérification de liens et du nom affiché.
import { verifyStreams } from '../src/core/verify.js';
import { finalizeStreams, makeStream } from '../src/core/stream.js';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : ' → ' + d)); };
const calls = [];
globalThis.fetch = async (url, o = {}) => {
  calls.push([o.method, url, o.headers && o.headers.Referer]);
  if (url.includes('dead.m3u8')) return { status: 403, url, text: async () => 'forbidden' };
  if (url.includes('html.m3u8')) return { status: 200, url, text: async () => '<html>captcha</html>' };
  if (url.includes('good.m3u8')) return { status: 200, url, text: async () => '#EXTM3U\n#EXT-X-VERSION:3' };
  if (url.includes('nohead.mp4')) return { status: 405, url, text: async () => '' };
  if (url.includes('gone.mp4')) return { status: 404, url, text: async () => '' };
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
  ok('403 / 404 / playlist invalide → ⚠ en fin', out.slice(2).every(s => s.name.endsWith(' ⚠')) && out.length === 5);
  ok('HEAD 405 → conservé (inconnu)', !out.find(s => s.url.includes('nohead')).name.endsWith('⚠'));
  ok('MP4 sondé en HEAD, HLS en GET', calls.filter(c => c[1].endsWith('.mp4')).every(c => c[0] === 'HEAD') && calls.filter(c => c[1].endsWith('.m3u8')).every(c => c[0] === 'GET'));
  ok('Referer du flux transmis à la sonde', calls.some(c => c[1].includes('good.m3u8') && c[2] === 'https://p.example/'));
}
const skip = await verifyStreams(fin, { remainingMs: 2000 });
ok('budget restant trop court → aucune sonde, liste inchangée', skip === fin);
console.log(`\nRésultat : ${pass} OK, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
