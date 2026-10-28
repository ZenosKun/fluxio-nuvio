// Simule un runtime SANS timers avec fetch BLOQUANT (NuvioTV / Desktop) : chaque fetch avance une horloge virtuelle.
// Usage : node tests/sim_blocking.cjs providers/fluxio.js <fast|slow|dead|hang> [settingsJSON] [movie|tv]
// Critère de réussite : "rendu après" < 30 s virtuelles dans tous les scénarios sauf "hang" (une requête en vol ne peut pas être coupée).
const vm = require('vm'), fs = require('fs');
const code = fs.readFileSync(process.argv[2], 'utf8');
const scenario = process.argv[3] || 'dead';
const settings = process.argv[4] ? JSON.parse(process.argv[4]) : {};
const mediaType = process.argv[5] || 'movie';
const clock = { t: 1_800_000_000_000 };
class VDate extends Date { static now() { return clock.t; } constructor(...a) { if (a.length) super(...a); else super(clock.t); } }
const reqs = []; const logs = [];
const TMDB = { title: 'Fight Club', name: 'Fight Club', original_title: 'Fight Club', original_name: 'Fight Club', release_date: '1999-10-15', first_air_date: '1999-10-15', original_language: 'en', genres: [{ id: 18 }], external_ids: { imdb_id: 'tt0137523' }, imdb_id: 'tt0137523', titles: [{ title: 'Fight Club' }], results: [] };
const model = {
  dead:  { lat: 10000, fail: true,  desc: 'domaines bloqués (chaque requête attend son timeout)' },
  slow:  { lat: 3000,  fail: false, desc: 'sites lents, réponses 404/vides en 3 s' },
  fast:  { lat: 300,   fail: false, desc: 'sites rapides mais vides' },
  hang:  { lat: 30000, fail: true,  desc: 'fetch qui ignore le timeout et bloque 30 s' },
}[scenario];
const sandbox = {
  console: { log: m => logs.push(String(m)), warn: m => logs.push('W ' + m), error: m => logs.push('E ' + m) },
  Date: VDate, SCRAPER_SETTINGS: settings,
  fetch: async (url, opts = {}) => {
    const host = url.replace(/^https?:\/\//, '').split('/')[0];
    if (host === 'api.themoviedb.org') { clock.t += 300; reqs.push([host, 300]); return { status: 200, url, text: async () => JSON.stringify(TMDB), json: async () => TMDB }; }
    const lat = model.lat; clock.t += lat; reqs.push([host, lat]);
    if (model.fail) throw new Error('network error');
    return { status: 404, url, text: async () => 'not found', json: async () => ({}) };
  },
  Promise, JSON, Math, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, Object, Array, String, Number, Boolean, RegExp, Error, TypeError, Map, Set, WeakMap, Uint8Array, Int32Array, Uint32Array, Uint16Array, DataView, ArrayBuffer, Symbol, Reflect, Proxy,
};
sandbox.globalThis = sandbox; vm.createContext(sandbox);
try { vm.runInContext(code, sandbox); } catch (e) { console.log('CHARGEMENT KO:', e.message); process.exit(1); }
const gs = sandbox.getStreams;
if (typeof gs !== 'function') { console.log('getStreams absent'); process.exit(1); }
const t0 = clock.t;
gs('550', mediaType, mediaType === 'tv' ? 1 : null, mediaType === 'tv' ? 1 : null).then(r => {
  const byHost = {}; reqs.forEach(([h]) => byHost[h] = (byHost[h] || 0) + 1);
  console.log(`scénario "${scenario}" (${model.desc}) réglages=${JSON.stringify(settings)}`);
  console.log(`→ rendu après ${((clock.t - t0) / 1000).toFixed(1)} s virtuelles | ${reqs.length} requêtes | flux: ${Array.isArray(r) ? r.length : typeof r}`);
  console.log('  hôtes:', Object.entries(byHost).map(([h, n]) => h + '×' + n).join(', ').slice(0, 300));
  if (process.env.V) console.log(logs.join('\n'));
}).catch(e => console.log('EXCEPTION', e.message));
