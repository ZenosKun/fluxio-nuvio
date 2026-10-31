/**
 * Tests unitaires offline du noyau v3 : plan, stopper (anti-blocage),
 * stream (tri/dédup), settings, parseurs purs (papadustream, webflix).
 * Aucun réseau.
 */

import assert from 'node:assert';
import { buildPlan, kindOf, affinityOf } from '../src/core/plan.js';
import { createStopper, raceEarlyExit, makeSourceShouldStop } from '../src/core/stopper.js';
import { makeStream, finalizeStreams, composeTitle, qualityFromUrl, qualityRank, resolutionLabel, TEST_STREAMS } from '../src/core/stream.js';
import { bestHlsQuality, muxedVariantUrl } from '../src/core/verify.js';
import { readConfig } from '../src/utils/settings.js';
import { parseEpisodesJson, extractHlsUrls, extractMovieHlsUrl } from '../src/sources/papadustream.js';
import { extractStreamUrls, nexusQuery, moviezToken, moviezLang, realQuality, sizeToGb, nexusVariants } from '../src/sources/webflix.js';
import { parseSearchResponse, parseNewsId } from '../src/sources/dle-common.js';

let ok = 0;
let ko = 0;
function t(name, fn) {
    try {
        fn();
        ok++;
        console.log('  ✓ ' + name);
    } catch (err) {
        ko++;
        console.error('  ✗ ' + name + ' — ' + err.message);
    }
}

const CFG = { fallbackLangs: ['vf', 'vostfr', 'vo'], allowOtherLang: true };
const CFG_VOSTFR = { fallbackLangs: ['vostfr', 'vf', 'vo'], allowOtherLang: true };
const CFG_STRICT = { fallbackLangs: ['vf', 'vostfr', 'vo'], allowOtherLang: false };

console.log('\n— plan.js : routage par type de contenu —');

t('anime → french-manga en vague 1, fstream en vague 2', () => {
    const p = buildPlan(['fstream', 'french-manga'], 'anime');
    assert.deepStrictEqual(p.wave1, ['french-manga']);
    assert.deepStrictEqual(p.wave2, ['fstream']);
});

t('film → fstream en vague 1, french-manga en vague 2', () => {
    const p = buildPlan(['fstream', 'french-manga'], 'movie');
    assert.deepStrictEqual(p.wave1, ['fstream']);
    assert.deepStrictEqual(p.wave2, ['french-manga']);
});

t('série → idem film', () => {
    const p = buildPlan(['fstream', 'french-manga'], 'tv');
    assert.deepStrictEqual(p.wave1, ['fstream']);
    assert.deepStrictEqual(p.wave2, ['french-manga']);
});

t('tier direct : bflix/webflix actifs partout, papadustream secours sur anime', () => {
    const all = ['bflix', 'webflix', 'papadustream'];
    const mv = buildPlan(all, 'movie');
    assert.deepStrictEqual(mv.wave1.slice().sort(), ['bflix', 'papadustream', 'webflix']);
    assert.deepStrictEqual(mv.wave2, []);
    const an = buildPlan(all, 'anime');
    assert.deepStrictEqual(an.wave1.slice().sort(), ['bflix', 'webflix']);
    assert.deepStrictEqual(an.wave2, ['papadustream']);
});

t('generic (détection désactivée) → tout en vague 1, rien en secours', () => {
    const p = buildPlan(['fstream', 'french-manga', 'bflix'], 'generic');
    assert.deepStrictEqual(p.wave2, []);
    assert.deepStrictEqual(p.wave1.slice().sort(), ['bflix', 'french-manga', 'fstream']);
});

t('source spécialiste seule activée → reste en secours hors son type (choix utilisateur préservé au filet)', () => {
    const p = buildPlan(['french-manga'], 'movie');
    assert.deepStrictEqual(p.wave1, []); // secours uniquement, lancé si vague 1 vide
    assert.deepStrictEqual(p.wave2, ['french-manga']);
});

t('kindOf : anime = tv + hint ja ; Simpsons (us) reste tv', () => {
    assert.strictEqual(kindOf('tv', true), 'anime');
    assert.strictEqual(kindOf('tv', false), 'tv');
    assert.strictEqual(kindOf('movie', true), 'movie'); // animation non-ja ≠ anime
    assert.strictEqual(kindOf('movie', false), 'movie');
});

t('affinityOf : source inconnue = active par défaut', () => {
    assert.strictEqual(affinityOf('inconnu', 'movie'), 2);
});

console.log('\n— stopper.js : anti-blocage (v3.1 — plus de quota de flux) —');

t('avant échéance douce : même 5 flux pertinents = PAS assez (une source peut livrer plusieurs qualités du même titre)', () => {
    const s = createStopper({ startedAt: Date.now(), hardMs: 50000, softMs: 9000 });
    const streams = [mk('vf'), mk('vf'), mk('vf'), mk('vostfr'), mk('vo')];
    assert.strictEqual(s.goodEnough(streams, CFG), false);
});

t('1 flux avant échéance douce = PAS assez', () => {
    const s = createStopper({ startedAt: Date.now(), hardMs: 50000, softMs: 9000 });
    assert.strictEqual(s.goodEnough([mk('vf')], CFG), false);
});

t('aucun flux = PAS assez (le rendu ne se déclenche jamais sur du vide)', () => {
    const s = createStopper({ startedAt: Date.now() - 30000, hardMs: 50000, softMs: 9000 });
    assert.strictEqual(s.goodEnough([], CFG), false);
});

t('après échéance douce : 1 flux pertinent = assez', () => {
    const s = createStopper({ startedAt: Date.now() - 9500, hardMs: 50000, softMs: 9000 });
    assert.strictEqual(s.goodEnough([mk('vf')], CFG), true);
});

t('après échéance douce : 2 flux pertinents = assez aussi', () => {
    const s = createStopper({ startedAt: Date.now() - 9500, hardMs: 50000, softMs: 9000 });
    assert.strictEqual(s.goodEnough([mk('vf'), mk('vostfr')], CFG), true);
});

t('mode strict (allowOtherLang=false) : après échéance, VO seul = PAS assez, VF = assez', () => {
    const s = createStopper({ startedAt: Date.now() - 9500, hardMs: 50000, softMs: 9000 });
    assert.strictEqual(s.goodEnough([mk('vo')], CFG_STRICT), false);
    assert.strictEqual(s.goodEnough([mk('vf')], CFG_STRICT), true);
});

t('budget dur épuisé → shouldStop', () => {
    const s = createStopper({ startedAt: Date.now() - 51000, hardMs: 50000, softMs: 9000 });
    assert.strictEqual(s.shouldStop(), true);
});

console.log('\n— stream.js : tri langue + dédup —');

t('VF en tête, dédup par URL, champs internes retirés', () => {
    const out = finalizeStreams(
        [
            makeStream({ title: 'b', url: 'http://b', _langKey: 'vo' }),
            makeStream({ title: 'a', url: 'http://a', _langKey: 'vf' }),
            makeStream({ title: 'a2', url: 'http://a', _langKey: 'vf' }),
            makeStream({ title: 'c', url: 'http://c', _langKey: 'vostfr' }),
        ],
        CFG
    );
    assert.deepStrictEqual(
        out.map(s => s.url),
        ['http://a', 'http://c', 'http://b']
    );
    for (const s of out) {
        assert.strictEqual(s._langKey, undefined);
        assert.strictEqual(s._site, undefined);
        assert.ok(s.name && s.title && s.quality);
    }
});

t('mode strict : les flux hors langue préférée sont écartés', () => {
    const out = finalizeStreams(
        [makeStream({ title: 'b', url: 'http://b', _langKey: 'vo' }), makeStream({ title: 'a', url: 'http://a', _langKey: 'vf' })],
        CFG_STRICT
    );
    assert.deepStrictEqual(out.map(s => s.url), ['http://a']);
});

t('composeTitle : épisode paddé, type détecté', () => {
    const t1 = composeTitle({ site: 'FStream', episode: 3, host: 'uqload', url: 'https://x/embed.mp4', lang: 'VF' });
    assert.strictEqual(t1, 'FStream · E03 · uqload · MP4 · VF');
    const t2 = composeTitle({ site: 'BFlix', episode: 0, host: 'flixhq', url: 'https://x/playlist.m3u8', lang: 'VO' });
    assert.strictEqual(t2, 'BFlix · flixhq · HLS · VO');
});

console.log('\n— stream.js : tri qualité (v3.1.11) —');

t('qualityRank : ordre 4K > 1440p > 1080p > 720p > 480p > Auto HLS > Direct', () => {
    const r = q => qualityRank(q);
    assert.ok(r('4K') < r('1440p'), '4K < 1440p');
    assert.ok(r('1440p') < r('1080p'), '1440p < 1080p');
    assert.ok(r('1080p') < r('720p'), '1080p < 720p');
    assert.ok(r('720p') < r('480p'), '720p < 480p');
    assert.ok(r('480p') < r('Auto (HLS)'), '480p < Auto HLS');
    assert.ok(r('Auto (HLS)') < r('Direct'), 'Auto HLS < Direct');
    assert.strictEqual(r('4K'), 0);
    assert.strictEqual(r('2160p'), 0);
    assert.strictEqual(r('1080p'), 2);
    assert.strictEqual(r('720p'), 3);
    assert.strictEqual(r('Direct'), 6);
    assert.strictEqual(r(''), 6);
    assert.strictEqual(r(undefined), 6);
});

t('finalizeStreams : à langue égale, meilleures qualités en tête (tri secondaire)', () => {
    // Ordre d'arrivée volontairement inversé : les sources livrent dans leur
    // propre ordre, le tri doit reconstruire 4K > 1080p > 720p > Auto > Direct.
    const out = finalizeStreams(
        [
            makeStream({ title: 'fs', url: 'http://direct', quality: 'Direct', _langKey: 'vf' }),
            makeStream({ title: 'fs', url: 'http://hls', quality: 'Auto (HLS)', _langKey: 'vf' }),
            makeStream({ title: 'fs', url: 'http://720', quality: '720p', _langKey: 'vf' }),
            makeStream({ title: 'fs', url: 'http://4k', quality: '4K', _langKey: 'vf' }),
            makeStream({ title: 'fs', url: 'http://1080', quality: '1080p', _langKey: 'vf' }),
        ],
        CFG
    );
    assert.deepStrictEqual(
        out.map(s => s.url),
        ['http://4k', 'http://1080', 'http://720', 'http://hls', 'http://direct']
    );
});

t('finalizeStreams : la langue préférée passe AVANT la qualité (tri principal)', () => {
    const out = finalizeStreams(
        [
            makeStream({ title: 'x', url: 'http://vf-direct', quality: 'Direct', _langKey: 'vf' }),
            makeStream({ title: 'x', url: 'http://vostfr-4k', quality: '4K', _langKey: 'vostfr' }),
        ],
        CFG
    );
    assert.deepStrictEqual(out.map(s => s.url), ['http://vf-direct', 'http://vostfr-4k']);
});

t('finalizeStreams : weakPlayer reste TOUJOURS en fin de liste même en 4K', () => {
    const out = finalizeStreams(
        [
            makeStream({ title: 'w', url: 'http://weak', quality: '4K', _langKey: 'vf', _weakPlayer: true }),
            makeStream({ title: 'g', url: 'http://direct', quality: 'Direct', _langKey: 'vf' }),
        ],
        CFG
    );
    assert.deepStrictEqual(out.map(s => s.url), ['http://direct', 'http://weak']);
    assert.ok(/⚠$/.test(out[1].name), 'marqueur ⚠ sur le weak');
});

t('settings : défaut softMs = 10000 (v3.1.11 — 5 s coupait french-stream/french-manga)', () => {
    delete globalThis.SCRAPER_SETTINGS;
    const cfg = readConfig();
    assert.strictEqual(cfg.softMs, 10000);
});
t('settings : softMs réglable 3000-15000 via SCRAPER_SETTINGS, hors bornes → défaut', () => {
    globalThis.SCRAPER_SETTINGS = { softMs: '6000' };
    assert.strictEqual(readConfig().softMs, 6000);
    globalThis.SCRAPER_SETTINGS = { softMs: '1000' };
    assert.strictEqual(readConfig().softMs, 10000);
    delete globalThis.SCRAPER_SETTINGS;
});

console.log('\n— settings.js : réglages v3 —');

t('défauts : vf, toutes sources, earlyExit ON, detectAnime ON, budget 25 s (v3.1.2 anti-timeout)', () => {
    const cfg = readConfig();
    assert.strictEqual(cfg.language, 'vf');
    assert.strictEqual(cfg.earlyExit, true);
    assert.strictEqual(cfg.detectAnime, true);
    assert.strictEqual(cfg.allowOtherLang, true);
    assert.strictEqual(cfg.budgetMs, 25000);
    assert.deepStrictEqual(cfg.fallbackLangs, ['vf', 'vostfr', 'vo']);
});

t('chaînes de langue vostfr/all', () => {
    globalThis.SCRAPER_SETTINGS = { language: 'vostfr' };
    assert.deepStrictEqual(readConfig().fallbackLangs, ['vostfr', 'vf', 'vo']);
    globalThis.SCRAPER_SETTINGS = { language: 'all' };
    assert.deepStrictEqual(readConfig().fallbackLangs, ['vf', 'vostfr', 'vo']);
});

t('booléens natifs ET chaînes tolérés (earlyExit=false natif)', () => {
    globalThis.SCRAPER_SETTINGS = { earlyExit: false, allowOtherLang: false, detectAnime: 'false' };
    const cfg = readConfig();
    assert.strictEqual(cfg.earlyExit, false);
    assert.strictEqual(cfg.allowOtherLang, false);
    assert.strictEqual(cfg.detectAnime, false);
});

t('compat réglage v2 « sites » accepté, timeout borné (défaut 10 s en v3.1.2)', () => {
    globalThis.SCRAPER_SETTINGS = { sites: 'fstream, bflix', timeoutSec: '200' };
    const cfg = readConfig();
    assert.strictEqual(cfg.sources, 'fstream,bflix');
    assert.strictEqual(cfg.timeoutMs, 10000);
    delete globalThis.SCRAPER_SETTINGS;
});

console.log('\n— parseurs purs : papadustream —');

const PAPA_PAGE =
    '<script>EPISODES=[{"url":"/hls/p/1719000000/AbC123/s5/serial/tt0903747/2/3/playlist.m3u8","title":"Episode 3","season":2,"episode":3},' +
    '{"url":"/hls/s5/serial/tt0903747/2/4/playlist.m3u8","title":"Ep 4","season":2,"episode":4}];</script>';
const PAPA_FILM =
    '<a href="/hls/p/1719000000/Tok9/s5/movie/tt0137523/playlist.m3u8">play</a>';

t('parseEpisodesJson : sélection S2E3 exacte possible', () => {
    const eps = parseEpisodesJson(PAPA_PAGE);
    assert.strictEqual(eps.length, 2);
    const sel = eps.filter(e => e.season === 2 && e.episode === 3);
    assert.strictEqual(sel.length, 1);
    assert.ok(sel[0].url.indexOf('AbC123') !== -1);
});

t('extractHlsUrls (fallback regex) : format signé et non signé', () => {
    const got = extractHlsUrls(PAPA_PAGE);
    assert.strictEqual(got.length, 2);
    assert.strictEqual(got[0].season, 2);
    assert.strictEqual(got[1].episode, 4);
});

t('extractMovieHlsUrl : cible le bon IMDb, rejette les autres', () => {
    assert.ok(extractMovieHlsUrl(PAPA_FILM, 'tt0137523').indexOf('Tok9') !== -1);
    assert.strictEqual(extractMovieHlsUrl(PAPA_FILM, 'tt9999999'), null);
    assert.ok(extractMovieHlsUrl(PAPA_FILM, '').indexOf('tt0137523') !== -1);
});

console.log('\n— parseurs purs : webflix —');

const WF_PAGE =
    '<iframe src="https://uqload.io/embed-abc.html"></iframe>' +
    '<iframe src="https://vidzy.org/e/xyz"></iframe>' +
    '<script>urls=["https://cdn.site/v.mp4","https://cdn.site/v2.m3u8?tok=1"]</script>' +
    '<a href="https://stream.fluxora.sbs/v1/anime?t=abc&format=hls">x</a>';

t('extractStreamUrls : iframes + urls= + HLS direct, sans doublon', () => {
    const got = extractStreamUrls(WF_PAGE, 'https://frembed.best/api/film.php?id=550');
    assert.ok(got.indexOf('https://uqload.io/embed-abc.html') !== -1);
    assert.ok(got.indexOf('https://vidzy.org/e/xyz') !== -1);
    assert.ok(got.indexOf('https://cdn.site/v.mp4') !== -1);
    assert.ok(got.indexOf('https://cdn.site/v2.m3u8?tok=1') !== -1);
    assert.ok(got.some(u => u.indexOf('stream.fluxora.sbs/v1/') !== -1));
    assert.strictEqual(new Set(got).size, got.length);
});

console.log('\n— parseurs purs : DLE search —');

// HTML réaliste : data-seasons encode ses double quotes en &quot;, les films
// passent par le chemin onclick (jamais data-seasons).
const DLE_SEARCH =
    '<div class="search-item">' +
    '<div class="search-title">Fight Club (1999)</div>' +
    '<img src="//img/1.jpg">' +
    '<a href="#" onclick="location.href=\'/111-the-movie.html\'">go</a>' +
    '</div>' +
    '<div class="search-item">' +
    '<div class="search-title">The Last of Us</div>' +
    '<div class="search-series" data-seasons="[{&quot;n&quot;:1,&quot;l&quot;:&quot;/222-the-last-of-us-saison-1-2023.html&quot;,&quot;p&quot;:&quot;//img/2.jpg&quot;},{&quot;n&quot;:2,&quot;l&quot;:&quot;/223-the-last-of-us-saison-2-2025.html&quot;,&quot;p&quot;:&quot;//img/3.jpg&quot;}]"></div>' +
    '</div>';

t('parseSearchResponse : film (onclick) + série (data-seasons → 1 carte/saison)', () => {
    const site = { id: 'fstream', isAnime: false };
    const cards = parseSearchResponse('https://fs26.lol', site, DLE_SEARCH);
    assert.strictEqual(cards.length, 3); // film + 2 saisons
    const film = cards.find(c => c.is_film);
    assert.strictEqual(film.title, 'Fight Club');
    assert.strictEqual(film.year, 1999);
    assert.strictEqual(film.source, 'fstream');
    const s1 = cards.find(c => c.season_number === 1);
    assert.strictEqual(s1.series_name, 'The Last of Us');
    assert.ok(s1.page_url.indexOf('/222-') !== -1);
    const s2 = cards.find(c => c.season_number === 2);
    assert.ok(s2.page_url.indexOf('/223-') !== -1);
    assert.strictEqual(s2.year, 2025);
});

t('parseSearchResponse : interstitiel → 0 carte', () => {
    const cards = parseSearchResponse('https://fs26.lol', { id: 'fstream', isAnime: false }, 'Verification fsschal');
    assert.deepStrictEqual(cards, []);
});

t('parseNewsId : data-news-id dans #serie-config', () => {
    const html = '<div id="serie-config" data-news-id="4567" data-title="One Piece - Saison 21"></div>';
    assert.strictEqual(parseNewsId(html), '4567');
});

console.log('\n— raceEarlyExit : course et garde-fous runtime —');

t('toutes les sources finissent avant l\'échéance → allDone gagne, TOUS les flux livrés', async () => {
    const s = createStopper({ startedAt: Date.now(), hardMs: 50000, softMs: 5000 });
    const allDone = new Promise(r => setTimeout(r, 120));
    const outcome = await raceEarlyExit({
        stopper: s,
        collected: [mk('vf'), mk('vf'), mk('vf')], // des flux présents ne doivent PAS couper
        cfg: CFG,
        allDone: allDone,
    });
    assert.strictEqual(outcome, 'done');
});

t('source bloquée au-delà de l\'échéance douce → enough dès qu\'un flux pertinent existe', async () => {
    const s = createStopper({ startedAt: Date.now(), hardMs: 50000, softMs: 80 });
    const outcome = await raceEarlyExit({
        stopper: s,
        collected: [mk('vf')],
        cfg: CFG,
        allDone: new Promise(() => {}), // ne finit jamais (site bloqué)
    });
    assert.strictEqual(outcome, 'enough');
});

t('source bloquée, zéro flux pertinent → jamais enough avant le budget', async () => {
    const s = createStopper({ startedAt: Date.now(), hardMs: 50000, softMs: 80 });
    const winner = Promise.race([
        raceEarlyExit({
            stopper: s,
            collected: [mk('vo')],
            cfg: CFG_STRICT, // VO hors langues autorisées
            allDone: new Promise(() => {}),
        }),
        new Promise(r => setTimeout(() => r('timeout-ok'), 600)),
    ]);
    const outcome = await winner;
    assert.strictEqual(outcome, 'timeout-ok'); // la course n\'a PAS tranché
});

console.log('\n— makeSourceShouldStop : arrêt des chaînes internes (TV ≡ Mobile) —');

t('avant échéance → jamais stop (les sources livrent tout)', () => {
    const s = createStopper({ startedAt: Date.now(), hardMs: 50000, softMs: 9000 });
    const stop = makeSourceShouldStop(s, [mk('vf'), mk('vf')], CFG);
    assert.strictEqual(stop(), false);
});

t('après échéance sans aucun résultat → on continue (dernière chance)', () => {
    const s = createStopper({ startedAt: Date.now() - 9500, hardMs: 50000, softMs: 9000 });
    const stop = makeSourceShouldStop(s, [], CFG);
    assert.strictEqual(stop(), false);
});

t('après échéance avec ≥1 flux pertinent → stop aux frontières de boucles', () => {
    const s = createStopper({ startedAt: Date.now() - 9500, hardMs: 50000, softMs: 9000 });
    const stop = makeSourceShouldStop(s, [mk('vf')], CFG);
    assert.strictEqual(stop(), true);
});

t('après échéance, flux hors langue en mode strict → on continue', () => {
    const s = createStopper({ startedAt: Date.now() - 9500, hardMs: 50000, softMs: 9000 });
    const stop = makeSourceShouldStop(s, [mk('vo')], CFG_STRICT);
    assert.strictEqual(stop(), false);
});

t("budget dur épuisé → stop quoi qu'il arrive", () => {
    const s = createStopper({ startedAt: Date.now() - 51000, hardMs: 50000, softMs: 9000 });
    const stop = makeSourceShouldStop(s, [], CFG);
    assert.strictEqual(stop(), true);
});

t('sans setTimeout : la course rend allDone', async () => {
    const saved = globalThis.setTimeout;
    try {
        delete globalThis.setTimeout;
        const s = createStopper({ startedAt: Date.now(), hardMs: 50000, softMs: 9000 });
        const outcome = await raceEarlyExit({
            stopper: s,
            collected: [mk('vf')],
            cfg: CFG,
            allDone: Promise.resolve(),
        });
        assert.strictEqual(outcome, 'done');
    } finally {
        globalThis.setTimeout = saved;
    }
});

function mk(lang) {
    return makeStream({ title: 'x', url: 'http://' + Math.random().toString(36).slice(2), _langKey: lang });
}

/* ── v3.1.8 : qualité réelle (helpers partagés) ─────────────────────────── */
t('resolutionLabel : hauteurs → libellés Nuvio', () => {
    assert.strictEqual(resolutionLabel(2160), '4K');
    assert.strictEqual(resolutionLabel(3840), '4K');
    assert.strictEqual(resolutionLabel(1080), '1080p');
    assert.strictEqual(resolutionLabel(720), '720p');
    assert.strictEqual(resolutionLabel(480), '480p');
    assert.strictEqual(resolutionLabel('x'), '');
    assert.strictEqual(resolutionLabel(0), '');
});
t('qualityFromUrl : motifs URL courants', () => {
    assert.strictEqual(qualityFromUrl('https://cdn.zen/animes/VF/S01/sao-S01-E01-1080p.mp4'), '1080p');
    assert.strictEqual(qualityFromUrl('https://x.co/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_30MB.mp4'), '1080p');
    assert.strictEqual(qualityFromUrl('https://x.co/2160/movie.mkv'), '4K');
    assert.strictEqual(qualityFromUrl('https://x.co/video-720p.mp4'), '720p');
    assert.strictEqual(qualityFromUrl('https://x.co/series/S01/E01.mp4'), '');
    assert.strictEqual(qualityFromUrl('https://x.co/h264/episode.mp4'), '');
});
t('bestHlsQuality : RESOLUTION max de la playlist maître', () => {
    const master = '#EXTM3U\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=640x360\n' +
        'v360.m3u8\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=4128000,RESOLUTION=1920x1080\n' +
        'v1080.m3u8\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=3840x2160\n' +
        'v2160.m3u8\n';
    assert.strictEqual(bestHlsQuality(master), '4K');
    assert.strictEqual(bestHlsQuality('#EXTM3U\n#EXTINF:4.0,\nseg1.ts\n'), '');
    assert.strictEqual(bestHlsQuality(''), '');
});

/* ── v3.1.8 : garde-fou flux TEST (l'URL a pivoté 3 fois dans l'historique) ── */
t('TEST_STREAMS : 2 flux publics, MP4 sur test-videos.co.uk (l URL google répond 403)', () => {
    assert.strictEqual(TEST_STREAMS.length, 2);
    assert.ok(/\.m3u8(\?|$)/.test(TEST_STREAMS[0].url), 'TEST HLS doit être un m3u8');
    assert.ok(TEST_STREAMS[1].url.startsWith('https://test-videos.co.uk/'),
        'TEST MP4 : le bucket GCS gtv-videos-bucket répond désormais 403 (vérifié live)');
    assert.ok(/\.mp4(\?|$)/.test(TEST_STREAMS[1].url), 'TEST MP4 doit être un mp4');
    assert.strictEqual(TEST_STREAMS[1].quality, 'Direct');
});

/* ── v3.1.10 : qualité réelle MP4 via moov/tkhd ─────────────────────────── */
import { mp4MaxHeight, mp4QualityLabel, bytesLookHtml, looksMp4 } from '../src/utils/mp4.js';
import { buildMp4, buildMp4HeadJunk, buildMp4Tail } from './helpers_mp4.mjs';

t('mp4MaxHeight : tkhd v0 → 1080 (MP4 synthétique faststart)', () => {
    const u8 = buildMp4(1080, { version: 0 });
    assert.strictEqual(looksMp4(u8), true);
    assert.strictEqual(mp4MaxHeight(u8), 1080);
    assert.strictEqual(mp4QualityLabel(mp4MaxHeight(u8)), '1080p');
});
t('mp4MaxHeight : tkhd v1 → 2160 → 4K', () => {
    assert.strictEqual(mp4QualityLabel(mp4MaxHeight(buildMp4(2160, { version: 1 }))), '4K');
});
t('mp4MaxHeight : buffer HTML → 0, bytesLookHtml → true', () => {
    const html = new Uint8Array(Array.from('<!DOCTYPE html><html></html>').map(c => c.charCodeAt(0)));
    assert.strictEqual(bytesLookHtml(html), true);
    assert.strictEqual(mp4MaxHeight(html), 0);
});
t('mp4MaxHeight : buffer court / vide → 0', () => {
    assert.strictEqual(mp4MaxHeight(new Uint8Array(0)), 0);
    assert.strictEqual(mp4MaxHeight(new Uint8Array(10).fill(0x41)), 0);
});
t('mp4QualityLabel : bornes 2000 → 4K, 96 plafonné 8192', () => {
    assert.strictEqual(mp4QualityLabel(2000), '4K');
    assert.strictEqual(mp4QualityLabel(480), '480p');
    assert.strictEqual(mp4QualityLabel(0), '');
});

/* ── v3.1.12 : sonde de queue — moov en fin de fichier (non faststart) ──── */
t('mp4MaxHeight : chunk de QUEUE non aligné, tkhd v0 2160 → 4K (scan signature)', () => {
    // Le chunk démarre au milieu du mdat (97 octets non alignés) : le parcours
    // strict des boîtes échoue, seul le scan retrouve le tkhd du moov final.
    const tail = buildMp4Tail(2160, { version: 0 });
    assert.strictEqual(looksMp4(tail), false); // pas de ftyp en tête (chunk de queue)
    assert.strictEqual(mp4MaxHeight(tail), 2160);
    assert.strictEqual(mp4QualityLabel(2160), '4K');
});
t('mp4MaxHeight : chunk de QUEUE, tkhd v1 1080 → 1080p', () => {
    assert.strictEqual(mp4MaxHeight(buildMp4Tail(1080, { version: 1 })), 1080);
});
t('mp4MaxHeight : tête de MP4 NON faststart (ftyp+mdat sans moov) → 0', () => {
    // Cas du bug utilisateur : la sonde tête seule ne voit rien (moov en fin).
    const head = buildMp4HeadJunk();
    assert.strictEqual(looksMp4(head), true);
    assert.strictEqual(mp4MaxHeight(head), 0);
});
t('mp4MaxHeight : binaire sans aucun tkhd → 0 (pas de faux positif du scan)', () => {
    const junk = new Uint8Array(4096).fill(0x5a);
    assert.strictEqual(mp4MaxHeight(junk), 0);
});
t('mp4MaxHeight : candidat tkhd farci dans du mdat mais boîte farfelue → rejeté', () => {
    // 'tkhd' présent mais taille déclarée absurde (4000 o) : le scan refuse.
    const b = [0, 0, 0, 0];
    const put32 = (n) => b.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    put32(4000); for (const c of 'tkhd') b.push(c.charCodeAt(0)); b.push(0); // v0
    for (let i = 0; i < 200; i++) b.push(0x41);
    assert.strictEqual(mp4MaxHeight(new Uint8Array(b)), 0);
});

/* ── v3.1.16 : ciblage chirurgical du moov — mp4MoovStartOffset ─────────── */
// Cas réel Fall 2 : le moov d'un long métrage dépasse 1 Mo (6,6 Mo live) —
// les suffix ranges de queue n'atteignent jamais le tkhd (début du moov).
// L'en-tête du mdat suffit à calculer son début PILE.
import { mp4MoovStartOffset } from '../src/utils/mp4.js';
import { buildMp4MdatHead } from './helpers_mp4.mjs';

t('mp4MoovStartOffset : ftyp+mdat(3 Mo) → moov pile après le mdat (20+S)', () => {
    // 20 (ftyp) + 3 000 000 (mdat déclaré, en-tête inclus) = 3 000 020.
    assert.strictEqual(mp4MoovStartOffset(buildMp4MdatHead(3000000)), 3000020);
});
t('mp4MoovStartOffset : faststart (moov visible dans le chunk) → -1 (parcours strict suffit)', () => {
    assert.strictEqual(mp4MoovStartOffset(buildMp4(1080)), -1);
});
t('mp4MoovStartOffset : junk v3.1.12 (mdat 136 o) → 156', () => {
    // buildMp4HeadJunk : ftyp 20 o + mdat (8+128=136 o) → 20 + 136 = 156.
    assert.strictEqual(mp4MoovStartOffset(buildMp4HeadJunk()), 156);
});
t('mp4MoovStartOffset : mdat largesize u64 → offset calculé sur la taille 64 bits', () => {
    const b = [];
    const put32 = (n) => b.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    put32(20); for (const c of 'ftyp') b.push(c.charCodeAt(0)); for (const c of 'isom') b.push(c.charCodeAt(0)); put32(0x200); for (const c of 'isom') b.push(c.charCodeAt(0));
    put32(1); for (const c of 'mdat') b.push(c.charCodeAt(0)); // size=1 → largesize
    put32(0); put32(2000000); // u64 = 2 000 000
    b.push(0x41, 0x42, 0x43, 0x44);
    assert.strictEqual(mp4MoovStartOffset(new Uint8Array(b)), 20 + 2000000);
});
t('mp4MoovStartOffset : mdat size=0 (dernière boîte) → -1, rien après', () => {
    const b = [];
    const put32 = (n) => b.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    put32(20); for (const c of 'ftyp') b.push(c.charCodeAt(0)); for (const c of 'isom') b.push(c.charCodeAt(0)); put32(0x200); for (const c of 'isom') b.push(c.charCodeAt(0));
    put32(0); for (const c of 'mdat') b.push(c.charCodeAt(0)); b.push(0xff, 0xff, 0xff, 0xff);
    assert.strictEqual(mp4MoovStartOffset(new Uint8Array(b)), -1);
});
t('mp4MoovStartOffset : buffer court / boîte tronquée → -1 (on n extrapole pas)', () => {
    assert.strictEqual(mp4MoovStartOffset(new Uint8Array(0)), -1);
    assert.strictEqual(mp4MoovStartOffset(new Uint8Array(10).fill(0x41)), -1);
    // ftyp(size 20) puis boîte de 4 o (corrompue) → -1.
    const b = [];
    const put32 = (n) => b.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    put32(20); for (const c of 'ftyp') b.push(c.charCodeAt(0)); for (const c of 'isom') b.push(c.charCodeAt(0)); put32(0x200); for (const c of 'isom') b.push(c.charCodeAt(0));
    put32(4); for (const c of 'free') b.push(c.charCodeAt(0));
    assert.strictEqual(mp4MoovStartOffset(new Uint8Array(b)), -1);
});

/* ── v3.1.16 : qualité MP4 direct webflix lue à la RÉSOLUTION ───────────── */
// Le bug utilisateur : le MP4 FastFlux (Fall-2-HD-2026.mp4 = 1280×720) ne
// devait sa qualité qu'à la sonde de vérification (best-effort, budget
// partagé) — coupée sur le device → « Direct » affiché. Désormais la qualité
// est fixée dès la résolution (miroir uqload/Nexus), testée par fetch mocké.
const tA = async (name, fn) => {
    try { await fn(); ok++; console.log('  ✓ ' + name); }
    catch (err) { ko++; console.error('  ✗ ' + name + ' — ' + err.message); }
};
{
    const { directMp4Quality } = await import('../src/sources/webflix.js');
    const mp4Resp = b => ({
        status: 206,
        url: 'https://cdn80.zen-blk.store/movies/Fall-2-HD-2026.mp4',
        headers: { get: () => 'video/mp4' },
        arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
        text: async () => '',
    });
    const savedFetch = globalThis.fetch;
    try {
        await tA('directMp4Quality : MP4 faststart sans motif URL → « 720p » dès la résolution', async () => {
            globalThis.fetch = async () => mp4Resp(buildMp4(720, { version: 0 }));
            assert.strictEqual(await directMp4Quality('https://cdn80.zen-blk.store/movies/Fall-2-HD-2026.mp4'), '720p');
        });
        await tA('directMp4Quality : moov non faststart loin dans le fichier → ciblage après mdat', async () => {
            const head = buildMp4MdatHead(3000000);
            const moov = buildMp4Tail(1080, { version: 0 });
            globalThis.fetch = async (url, o = {}) => {
                const rg = String((o.headers || {}).Range || '');
                if (rg === 'bytes=0-131071') return mp4Resp(head);
                if (rg === 'bytes=3000020-3131091') return mp4Resp(moov);
                return { status: 404, url, headers: { get: () => '' }, text: async () => '' };
            };
            assert.strictEqual(await directMp4Quality('https://cdn80.zen-blk.store/movies/Film-4K.mp4'), '1080p');
        });
        await tA('directMp4Quality : corps HTML / erreur réseau → chaîne vide (jamais de libellé inventé)', async () => {
            globalThis.fetch = async () => ({
                status: 200,
                url: 'https://cdn80.zen-blk.store/movies/x.mp4',
                headers: { get: () => 'text/html' },
                text: async () => '<html>captcha</html>',
                arrayBuffer: async () => new ArrayBuffer(0),
            });
            assert.strictEqual(await directMp4Quality('https://cdn80.zen-blk.store/movies/x.mp4'), '');
            // Hôte distinct : une erreur réseau status 0 met l'hôte en
            // quarantaine 2 min (disjoncteur) — ne pas empoisonner cdn80
            // pour les tests suivants de ce processus.
            globalThis.fetch = async () => { throw new Error('réseau injoignable'); };
            assert.strictEqual(await directMp4Quality('https://blackhole.example/movies/x.mp4'), '');
        });
        // v3.1.17 — chaîne de redirections payée UNE fois : la 1re réponse
        // (206) porte l'URL FINALE (signée ?ff=) dans res.url → la requête de
        // ciblage moov doit partir de CETTE URL, pas de l'URL d'origine
        // (repayer la chaîne 3 sauts dépassait le timeout sur device).
        await tA('directMp4Quality : URL finale (signée ?ff=) réutilisée pour le ciblage moov', async () => {
            const SIGNED = 'https://cdn80.zen-blk.store/movies/Film-4K.mp4?ff=1793291310.zAbCdEfG';
            const head = buildMp4MdatHead(3000000);
            const moov = buildMp4Tail(1080, { version: 0 });
            const urls = [];
            globalThis.fetch = async (u, o = {}) => {
                urls.push(u);
                const rg = String((o.headers || {}).Range || '');
                const bytes = b => ({
                    status: 206,
                    url: SIGNED,
                    headers: { get: () => 'video/mp4' },
                    arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
                    text: async () => '',
                });
                if (rg === 'bytes=0-131071') return bytes(head);
                if (rg === 'bytes=3000020-3131091') return bytes(moov);
                return { status: 404, url: u, headers: { get: () => '' }, text: async () => '' };
            };
            assert.strictEqual(await directMp4Quality('https://cdn80.zen-blk.store/movies/Film-4K.mp4'), '1080p');
            assert.ok(urls.length >= 2 && urls[1].indexOf('?ff=') !== -1,
                'le ciblage doit partir de l URL signée finale, pas de l origine : ' + urls[1]);
        });
        // v3.1.17 — 2 tentatives : sous la charge parallèle, le TTFB du proxy
        // falzey.lol spike — une 2e tentative juste après réussit souvent là
        // où la 1re a calé (timeout). Le gouverneur ne doit PAS s'interposer
        // (_bypassGov) : sa quarantaine 2 min retirait cette seconde chance.
        await tA('directMp4Quality : 2e tentative après un échec réseau → « 1080p »', async () => {
            let n = 0;
            globalThis.fetch = async () => {
                n++;
                if (n === 1) throw new Error('timeout réseau (5000 ms) : https://cdn80.zen-blk.store/movies/Film-HD.mp4');
                return mp4Resp(buildMp4(1080, { version: 0 }));
            };
            assert.strictEqual(await directMp4Quality('https://cdn80.zen-blk.store/movies/Film-HD.mp4'), '1080p');
            assert.strictEqual(n, 2, 'la 2e tentative doit être émise');
        });
        await tA('directMp4Quality : échec 2× → chaîne vide (jamais de libellé inventé)', async () => {
            let n = 0;
            globalThis.fetch = async () => { n++; throw new Error('timeout réseau (5000 ms)'); };
            assert.strictEqual(await directMp4Quality('https://blackhole.example/movies/x.mp4'), '');
            assert.strictEqual(n, 2, 'exactement 2 tentatives');
        });
    } finally {
        globalThis.fetch = savedFetch;
    }
}

/* ── v3.1.12 : garde anti faux positifs — 'tkhd' apparu PAR HASARD dans du mdat ── */
// Leurre : boîte 'tkhd' de géométrie plausible (taille 100 o, version 0,
// contenue dans le buffer) dont la hauteur/largeur sont contrôlées — c'est
// exactement à quoi ressemblent des octets vidéo tombés par hasard sur la
// séquence 'tkhd'. Préfixe mdat (97 o non alignés) : le parcours strict des
// boîtes doit échouer d'emblée, seul le scan voit le leurre.
const fakeTkhd = (b, w, h) => {
    const put32 = (n) => b.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    put32(100); for (const c of 'tkhd') b.push(c.charCodeAt(0));
    b.push(0); // version 0
    for (let i = 0; i < 83; i++) b.push(0x41); // farcissage jusqu'aux 8 derniers octets
    put32(w * 65536); put32(h * 65536); // width, height (16.16)
};
const junkPrefix = (b) => { for (let i = 0; i < 97; i++) b.push(i === 0 ? 0x00 : (i * 53 + 7) & 0xff); };

t('mp4MaxHeight : leurre tkhd 1359 dans du mdat → 0 (hauteur non standard)', () => {
    // Cas réel remonté : 1359 « lu » par le scan alors que le lecteur
    // affiche 1280×720 — 1359 passait les bornes brutes 96-8192.
    const b = [];
    junkPrefix(b);
    fakeTkhd(b, 1920, 1359);
    for (let i = 0; i < 32; i++) b.push(0x41); // la boîte doit tenir dans le buffer
    assert.strictEqual(mp4MaxHeight(new Uint8Array(b)), 0);
});
t('mp4MaxHeight : leurre 1359 + VRAI tkhd 1280×720 en queue → 720 (bug utilisateur)', () => {
    // Avant le garde : le scan prenait le MAX des candidats → 1359 gagnait
    // sur le vrai 720. Le leurre rejeté, le tkhd authentique du moov final
    // refait surface.
    const b = [];
    junkPrefix(b);
    fakeTkhd(b, 1920, 1359);
    for (const x of buildMp4Tail(720, { version: 0 })) b.push(x);
    assert.strictEqual(mp4MaxHeight(new Uint8Array(b)), 720);
});
t('mp4MaxHeight : leurre hauteur standard mais largeur absurde → 0 (ratio w/h)', () => {
    // Garde-fou largeur : w=0 (piste non vidéo), ratio 0,09 (portrait
    // extrême) ou 4,0 (au-delà de tout cinéma) → rejeté malgré la hauteur.
    for (const [w, h] of [[0, 720], [64, 720], [2880, 720]]) {
        const b = [];
        junkPrefix(b);
        fakeTkhd(b, w, h);
        for (let i = 0; i < 32; i++) b.push(0x41);
        assert.strictEqual(mp4MaxHeight(new Uint8Array(b)), 0,
            'leurre ' + w + 'x' + h + ' doit être rejeté');
    }
});
t('mp4MaxHeight : tolérance ± 8 px — 1084 accepté (→ bucket 1080), 1092 rejeté', () => {
    const accept = [];
    junkPrefix(accept);
    fakeTkhd(accept, 1927, 1084); // 1080 + 4 (arrondi/crop) — ratio 1,78
    for (let i = 0; i < 32; i++) accept.push(0x41);
    assert.strictEqual(mp4MaxHeight(new Uint8Array(accept)), 1080); // reclassifié par la largeur 1927
    const reject = [];
    junkPrefix(reject);
    fakeTkhd(reject, 1941, 1092); // 1080 + 12 : hors tolérance
    for (let i = 0; i < 32; i++) reject.push(0x41);
    assert.strictEqual(mp4MaxHeight(new Uint8Array(reject)), 0);
});
t('mp4MaxHeight : 1920×800 crop scope d un 1080 → 1080p (bug utilisateur)', () => {
    // Panel lecteur : « 1920 × 800 (1080p) » — cinémascope 2,40:1 taillé
    // dans un master 1080p. La hauteur seule donnait « 800p » ; la largeur
    // décide, comme chez le lecteur et le nommage P2P.
    const u8 = buildMp4(800, { width: 1920 });
    assert.strictEqual(mp4MaxHeight(u8), 1080);
    assert.strictEqual(mp4QualityLabel(mp4MaxHeight(u8)), '1080p');
});
t('mp4MaxHeight : QUEUE non faststart 1920×800 → scan scope → 1080', () => {
    // 800 n est pas une hauteur standard ± 8 : le scan l accepte via le
    // ratio cinéma (2,40 ≥ 1,8, hauteur dans la fourchette des crops) puis
    // la reclassifie par la largeur → bucket 1080.
    const tail = buildMp4Tail(800, { width: 1920, version: 0 });
    assert.strictEqual(mp4MaxHeight(tail), 1080);
});
t('mp4MaxHeight : 1280×536 crop scope d un 720 → 720p', () => {
    assert.strictEqual(mp4MaxHeight(buildMp4(536, { width: 1280 })), 720);
    assert.strictEqual(mp4QualityLabel(720), '720p');
});

/* ── v3.1.17 : buffer RÉEL fastflux (Fall 2, cdn80.zen-blk.store) ────────── */
// 131 072 octets de tête captés live (Range bytes=0-131071, Referer
// webflix.art) : ftyp(32 o) + moov de 6,3 Mo TRONQUÉ par le Range. Le tkhd
// (1280×692, piste vidéo hdlr 'vide', box 92 o) vit à l'offset 160 — DANS le
// buffer — mais le parcours strict échoue (moov puis trak tronqués) ; seul le
// scan par signature le retrouve (ratio 1,85 → crop scope → bucket 720p).
// C'est le cas utilisateur exact : la sonde lisait ce buffer puis affichait
// « Direct » faute de temps (chaîne 3 sauts > timeout) et/ou de scan.
import { readFileSync } from 'node:fs';
t('mp4MaxHeight : buffer RÉEL fastflux Fall 2 (moov 6,3 Mo tronqué, tkhd @160) → 720p', () => {
    const raw = readFileSync(new URL('./fixtures/fastflux_fall2_head.bin', import.meta.url));
    const u8 = new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    assert.strictEqual(u8.length, 131072);
    assert.strictEqual(bytesLookHtml(u8), false, 'le CDN livre bien du binaire, pas du HTML');
    assert.strictEqual(mp4MaxHeight(u8), 720);
    assert.strictEqual(mp4QualityLabel(mp4MaxHeight(u8)), '720p');
});

/* ── v3.1.12 : crops scope côté HLS (bestHlsQuality, importé en tête) ───── */
t('bestHlsQuality : RESOLUTION=1920x800 (scope) → 1080p, 1280x536 → 720p', () => {
    assert.strictEqual(bestHlsQuality('#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x800\nv.m3u8'), '1080p');
    assert.strictEqual(bestHlsQuality('#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x536\nv.m3u8'), '720p');
    assert.strictEqual(bestHlsQuality('#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\nv.m3u8'), '1080p');
    assert.strictEqual(bestHlsQuality('#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=3840x1608\nv.m3u8'), '4K');
    assert.strictEqual(bestHlsQuality(''), '');
});

/* ── v3.1.13 : anti-écran-noir uqload — variante muxée de la bonne langue ── */
const UQ_MASTER = [
    '#EXTM3U',
    '',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="Français",LANGUAGE="fr",AUTOSELECT=YES,DEFAULT=YES,CHANNELS="1",URI="https://strm8.uqload.vc/hls2/x/dp_l/index-a1.m3u8?t=TOK"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="English",LANGUAGE="en",AUTOSELECT=NO,DEFAULT=NO,CHANNELS="1",URI="https://strm8.uqload.vc/hls2/x/dp_l/index-a2.m3u8?t=TOK"',
    '',
    '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=587356,RESOLUTION=664x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="audio0"',
    'https://strm8.uqload.vc/hls2/x/dp_l/index-v1-a2.m3u8?t=TOK',
    '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1526892,RESOLUTION=1328x720,CODECS="avc1.640020,mp4a.40.2",AUDIO="audio0"',
    'https://strm8.uqload.vc/hls2/x/dp_n/index-v1-a2.m3u8?t=TOK',
    '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=3848585,RESOLUTION=1920x1040,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio0"',
    'https://strm8.uqload.vc/hls2/x/dp_h/index-v1-a2.m3u8?t=TOK',
].join('\n');
t('muxedVariantUrl : VF → variante muxée la plus haute BW avec suffixe fr (a1), token préservée', () => {
    const u = muxedVariantUrl(UQ_MASTER, 'VF');
    assert.strictEqual(u, 'https://strm8.uqload.vc/hls2/x/dp_h/index-v1-a1.m3u8?t=TOK');
    assert.strictEqual(muxedVariantUrl(UQ_MASTER, 'VFQ'), u); // VFQ → même cible
});
t('muxedVariantUrl : VOSTFR / VO / TEST → pas de réécriture (le muxé fixerait l audio)', () => {
    assert.strictEqual(muxedVariantUrl(UQ_MASTER, 'VOSTFR'), '');
    assert.strictEqual(muxedVariantUrl(UQ_MASTER, 'VO'), '');
    assert.strictEqual(muxedVariantUrl(UQ_MASTER, 'TEST'), '');
    assert.strictEqual(muxedVariantUrl(UQ_MASTER, ''), '');
});
t('muxedVariantUrl : master sans EXT-X-MEDIA → rien à faire', () => {
    const simple = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nhttps://s.example/index-v1-a2.m3u8?t=K';
    assert.strictEqual(muxedVariantUrl(simple, 'VF'), '');
});
t('muxedVariantUrl : motif de variante inattendu → on ne touche à rien', () => {
    const odd = UQ_MASTER.replace('dp_h/index-v1-a2.m3u8', 'dp_h/ep-1.m3u8');
    assert.strictEqual(muxedVariantUrl(odd, 'VF'), '');
});
t('muxedVariantUrl : master sans piste « fr » (VO seule) → pas de réécriture', () => {
    const enOnly = UQ_MASTER.replace('LANGUAGE="fr",AUTOSELECT=YES,DEFAULT=YES,', 'LANGUAGE="de",').replace('index-a1.m3u8', 'index-a3.m3u8');
    assert.strictEqual(muxedVariantUrl(enOnly, 'VF'), '');
});
t('muxedVariantUrl : LANGUAGE régional « fr-FR » → piste fr (v3.1.14)', () => {
    const regional = UQ_MASTER.replace('LANGUAGE="fr"', 'LANGUAGE="fr-FR"');
    assert.strictEqual(muxedVariantUrl(regional, 'VF'), 'https://strm8.uqload.vc/hls2/x/dp_h/index-v1-a1.m3u8?t=TOK');
});
t('muxedVariantUrl : repli NAME « Français » sans attribut LANGUAGE (v3.1.14)', () => {
    const noLang = UQ_MASTER.replace('LANGUAGE="fr",', '');
    assert.strictEqual(muxedVariantUrl(noLang, 'VF'), 'https://strm8.uqload.vc/hls2/x/dp_h/index-v1-a1.m3u8?t=TOK');
});

/* ── v3.1.15 : lecteur Nexus webflix (moviez.ac) — voie qualité ─────────── */

/** Master RÉEL du lecteur Nexus (Fall 2 : Deadpoint, TMDB 1101412, VF —
 *  capté live 2026-10-29 : 3 variantes avc1 l/n/h + pistes audio séparées
 *  fr/en, variantes muxées a2 = anglais, même famille uqload). */
const NEXUS_FALL2_MASTER = [
    '#EXTM3U',
    '',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="Français",LANGUAGE="fr",AUTOSELECT=YES,DEFAULT=YES,CHANNELS="1",URI="https://strm8.uqload.vc/hls2/02/05845/dp4lgyiy4he6_l/index-a1.m3u8?t=TOK"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="English",LANGUAGE="en",AUTOSELECT=NO,DEFAULT=NO,CHANNELS="1",URI="https://strm8.uqload.vc/hls2/02/05845/dp4lgyiy4he6_l/index-a2.m3u8?t=TOK"',
    '',
    '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=587356,RESOLUTION=664x360,FRAME-RATE=23.974,CODECS="avc1.64001e,mp4a.40.2",VIDEO-RANGE=SDR,AUDIO="audio0"',
    'https://strm8.uqload.vc/hls2/02/05845/dp4lgyiy4he6_l/index-v1-a2.m3u8?t=TOK',
    '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1526892,RESOLUTION=1328x720,FRAME-RATE=23.974,CODECS="avc1.640020,mp4a.40.2",VIDEO-RANGE=SDR,AUDIO="audio0"',
    'https://strm8.uqload.vc/hls2/02/05845/dp4lgyiy4he6_n/index-v1-a2.m3u8?t=TOK',
    '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=3848585,RESOLUTION=1920x1040,FRAME-RATE=23.974,CODECS="avc1.640028,mp4a.40.2",VIDEO-RANGE=SDR,AUDIO="audio0"',
    'https://strm8.uqload.vc/hls2/02/05845/dp4lgyiy4he6_h/index-v1-a2.m3u8?t=TOK',
].join('\n');

t('nexusQuery : film → kind/tmdbId/lang, sans season/episode', () => {
    assert.strictEqual(nexusQuery('film', '1101412', 'vf', 0, 0), 'kind=film&tmdbId=1101412&lang=vf');
});
t('nexusQuery : série → season/episode ajoutés (int, défaut 1)', () => {
    assert.strictEqual(
        nexusQuery('serie', '94605', 'vostfr', 2, 7),
        'kind=serie&tmdbId=94605&lang=vostfr&season=2&episode=7'
    );
    assert.strictEqual(
        nexusQuery('serie', '94605', 'vf', 'x', 'x'),
        'kind=serie&tmdbId=94605&lang=vf&season=1&episode=1'
    );
});
t('moviezToken : window.P2 réel (film vf) extrait', () => {
    const html = 'window.P2 = {"lang": "vf", "subs": 0, "t": "bW92aWV8MTEwMTQxMnwwfDB8dmZ8MTc5MzI3MTMwNA.yz9CkXZS9Ou9JVH1Y5HlIIY_"};';
    assert.strictEqual(moviezToken(html), 'bW92aWV8MTEwMTQxMnwwfDB8dmZ8MTc5MzI3MTMwNA.yz9CkXZS9Ou9JVH1Y5HlIIY_');
});
t('moviezToken : variante vostfr + token base64url (tiret/underscore)', () => {
    const html = 'window.P2 = {"lang": "vostfr", "subs": 2, "t": "dHZ8OTQ2MDV8MXwxfHZmfDE3OTMyNzE0NzU.HFxHrJBeZiH1dgSy_BlahETO"};';
    assert.strictEqual(moviezToken(html), 'dHZ8OTQ2MDV8MXwxfHZmfDE3OTMyNzE0NzU.HFxHrJBeZiH1dgSy_BlahETO');
});
t('moviezToken : page sans P2 / sans t → vide', () => {
    assert.strictEqual(moviezToken('<html>shell livewire sans player</html>'), '');
    assert.strictEqual(moviezToken('window.P2 = {"lang": "vf"};'), '');
    assert.strictEqual(moviezToken(''), '');
});
t('moviezLang : la langue servie par la page fait foi', () => {
    assert.strictEqual(moviezLang('window.P2 = {"lang": "vf", "t": "x"};'), 'vf');
    assert.strictEqual(moviezLang('window.P2 = {"lang": "vostfr", "t": "x"};'), 'vostfr');
    assert.strictEqual(moviezLang('<html>rien</html>'), 'vf'); // défaut conservateur
});
t('Nexus master Fall 2 (réel) : VF → variante muxée 1080p a1, token préservée', () => {
    const u = muxedVariantUrl(NEXUS_FALL2_MASTER, 'VF');
    assert.strictEqual(u, 'https://strm8.uqload.vc/hls2/02/05845/dp4lgyiy4he6_h/index-v1-a1.m3u8?t=TOK');
    // Et la qualité affichée dérive du même master : 1920x1040 → 1080p
    assert.strictEqual(bestHlsQuality(NEXUS_FALL2_MASTER), '1080p');
});
t('Nexus master Fall 2 (réel) : VOSTFR → master conservé (variante simple muxée)', () => {
    const vostMaster = NEXUS_FALL2_MASTER
        .replace(/#EXT-X-MEDIA[^\r\n]*\n/g, '')
        .replace(/,AUDIO="audio0"/g, '');
    assert.strictEqual(muxedVariantUrl(vostMaster, 'VOSTFR'), '');
    assert.strictEqual(bestHlsQuality(vostMaster), '1080p');
});

/* ── v3.1.10 : langue réelle bflix (audio muxé = langue originale) ──────── */
import { bflixLangKey } from '../src/sources/bflix.js';
t('bflixLangKey : Lupin (original fr, subs fr, audio non décrit) → VF (bug utilisateur)', () => {
    assert.strictEqual(bflixLangKey([], true, 'fr'), 'vf');
});
t('bflixLangKey : série EN + subs fr (audio muxé EN) → VOSTFR', () => {
    assert.strictEqual(bflixLangKey([], true, 'en'), 'vostfr');
});
t('bflixLangKey : série EN sans subs fr → VO', () => {
    assert.strictEqual(bflixLangKey([], false, 'en'), 'vo');
});
t('bflixLangKey : piste audio unique FR annoncée → VF (même original en)', () => {
    assert.strictEqual(bflixLangKey(['fr'], true, 'en'), 'vf');
    assert.strictEqual(bflixLangKey(['fr-FR'], false, 'en'), 'vf');
});
t('bflixLangKey : pistes multiples (en+fr) → défaut inconnu → repli sous-titres', () => {
    assert.strictEqual(bflixLangKey(['en', 'fr'], true, 'en'), 'vostfr');
});
t('bflixLangKey : playlist annonce en seul, original fr → la playlist gagne → VOSTFR', () => {
    assert.strictEqual(bflixLangKey(['en'], true, 'fr'), 'vostfr');
});
t('bflixLangKey : NAME français sans LANGUAGE reconnu via le parseur HLS (info [])', () => {
    // le repli NAME= est côté hlsAudioLangs (réseau) ; ici on vérifie [] only
    assert.strictEqual(bflixLangKey([], false, ''), 'vo');
});

/* ── v3.1.18 : heuristique TAILLE Gowaru — qualité FastFlux CONSTANTE ────── */
/* Bug utilisateur : « quand y a un flux FastFlux ça n'affiche pas la qualité,
 * alors qu'avec Gowaru ça s'affiche constamment ». La méthode Gowaru
 * (qualityFromApi, src/webflix/extractor.js) : champ API parlant, sinon
 * TAILLE (≥ 3 Go → 1080p, sinon taille connue → 720p/« HD ») — zéro sonde,
 * zéro timeout. Notre sonde moov/tkhd devient un RAFFINEMENT après coup. */
t('sizeToGb : formats de l’API (« 1.27 GB », « 512 MB », « 1.5 TB », bruit)', () => {
    assert.ok(Math.abs(sizeToGb('1.27 GB') - 1.27) < 1e-9);
    assert.ok(Math.abs(sizeToGb('3.55 GB') - 3.55) < 1e-9);
    assert.ok(Math.abs(sizeToGb('512 MB') - 0.5) < 0.001);
    assert.ok(Math.abs(sizeToGb('1.5 TB') - 1536) < 1e-9);
    assert.strictEqual(sizeToGb('Unknown'), 0);
    assert.strictEqual(sizeToGb(''), 0);
    assert.strictEqual(sizeToGb(undefined), 0);
    assert.strictEqual(sizeToGb('na 42 zzz'), 0);
});
t('realQuality v3.1.18 : FastFlux 1.27 Go (Fall 2) → « 720p » SANS aucune sonde', () => {
    assert.strictEqual(
        realQuality('Unknown', 'https://cdn80.zen-blk.store/movies/Fall-2-HD-2026.mp4', 'MP4', '1.27 GB'),
        '720p'
    );
});
t('realQuality : ≥ 3 Go → « 1080p » (gowaru : MP4 FastFlux > 3 GB = 1080p typique)', () => {
    assert.strictEqual(realQuality('Unknown', 'https://cdn80.zen-blk.store/movies/X.mp4', 'MP4', '3.55 GB'), '1080p');
    assert.strictEqual(realQuality('Unknown', 'https://cdn80.zen-blk.store/movies/X.mp4', 'MP4', '1.2 TB'), '1080p');
    // épisode série (payload S-E sans size chez discovery) : taille absente
    assert.strictEqual(realQuality('Unknown', 'https://cdn80.zen-blk.store/series/VF/X/S01/X-S01-E01.mp4', 'MP4', undefined), 'Direct');
});
t('realQuality : champ API parlant gagne sur tout, « Unknown » ignoré', () => {
    assert.strictEqual(realQuality('1080p', 'https://x/m.mp4', 'MP4', '1.27 GB'), '1080p');
    assert.strictEqual(realQuality('4K', 'https://x/m.mp4', 'MP4', '9 GB'), '4K');
});
t('realQuality : motif URL gagne sur la taille', () => {
    assert.strictEqual(realQuality('Unknown', 'https://cdn/x/1080/movie.mp4', 'MP4', '1.27 GB'), '1080p');
});
t('realQuality : taille inconnue → libellé technique (la sonde raffinera)', () => {
    assert.strictEqual(realQuality('Unknown', 'https://cdn/x/master.m3u8', 'HLS', undefined), 'Auto (HLS)');
    assert.strictEqual(realQuality('Unknown', 'https://cdn/x/film.mp4', 'MP4', ''), 'Direct');
});

/* ── v3.1.18 : expansion du master Nexus (toutes les qualités, gowaru expand) ── */
t('nexusVariants : master VF réel Fall 2 → 3 variantes MUXÉES fr (1080p/720p/360p)', () => {
    const v = nexusVariants(NEXUS_FALL2_MASTER, 'vf');
    assert.deepStrictEqual(v.map(x => x.quality), ['1080p', '720p', '360p']);
    assert.ok(v[0].uri.indexOf('dp4lgyiy4he6_h/index-v1-a1.m3u8') !== -1, '1080p → index-v1-a1 (fr)');
    assert.ok(v[1].uri.indexOf('dp4lgyiy4he6_n/index-v1-a1.m3u8') !== -1, '720p → index-v1-a1');
    assert.ok(v[2].uri.indexOf('dp4lgyiy4he6_l/index-v1-a1.m3u8') !== -1, '360p → index-v1-a1');
    assert.ok(v[0].uri.indexOf('?t=TOK') !== -1, 'token préservée');
});
t('nexusVariants : master muxé simple (VOSTFR) → variantes brutes, URI inchangées', () => {
    const vostMaster = NEXUS_FALL2_MASTER
        .replace(/#EXT-X-MEDIA[^\r\n]*\r?\n/g, '')
        .replace(/,AUDIO="audio0"/g, '');
    const v = nexusVariants(vostMaster, 'vostfr');
    assert.deepStrictEqual(v.map(x => x.quality), ['1080p', '720p', '360p']);
    assert.ok(v[0].uri.indexOf('index-v1-a2.m3u8') !== -1);
});
t('nexusVariants : pistes séparées hors VF (VO/VOSTFR) → [] (seul le swap muxé est sûr)', () => {
    assert.deepStrictEqual(nexusVariants(NEXUS_FALL2_MASTER, 'vo'), []);
    assert.deepStrictEqual(nexusVariants(NEXUS_FALL2_MASTER, 'vostfr'), []);
});
t('nexusVariants : motif non-uqload avec pistes séparées → [] (on n’invente rien)', () => {
    const weird = NEXUS_FALL2_MASTER.replace(/index-v1-a2\.m3u8/g, 'variants/enc-v1.m3u8');
    assert.deepStrictEqual(nexusVariants(weird, 'vf'), []);
});
t('nexusVariants : sans #EXTM3U / page HTML → []', () => {
    assert.deepStrictEqual(nexusVariants('', 'vf'), []);
    assert.deepStrictEqual(nexusVariants('<html>404</html>', 'vf'), []);
});

/* ── v3.1.18 : champ size traversé jusqu’au flux Nuvio ──────────────────── */
t('makeStream/finalizeStreams : size « 1.27 GB » atteint le panneau Nuvio', () => {
    const st = makeStream({ title: 'X', url: 'https://a/b.mp4', quality: '720p', language: 'VF', _langKey: 'vf', size: '1.27 GB' });
    assert.strictEqual(st.size, '1.27 GB');
    const out = finalizeStreams([st], CFG);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].size, '1.27 GB');
});
t('finalizeStreams : flux sans size → pas de champ (schéma Nuvio inchangé)', () => {
    const out = finalizeStreams([makeStream({ title: 'Y', url: 'https://a/c.mp4', quality: '720p', _langKey: 'vf' })], CFG);
    assert.strictEqual(out.length, 1);
    assert.ok(!('size' in out[0]));
});

console.log(`\nRésultat : ${ok} OK, ${ko} échec(s)`);
process.exit(ko ? 1 : 0);
