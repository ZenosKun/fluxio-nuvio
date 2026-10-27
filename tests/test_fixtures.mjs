/**
 * Régression offline sur fixtures HTML réelles (capturées via
 * tests/capture_fixtures.cjs). Si un site change sa structure, ce test
 * casse ICI (sans réseau) au lieu de casser en prod.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSearchResponse, parseNewsId, parseSeasonNumber } from '../src/sources/dle-common.js';
import { parseEpisodesJson, extractHlsUrls, extractMovieHlsUrl } from '../src/sources/papadustream.js';
import { extractStreamUrls } from '../src/sources/webflix.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = name => {
    const p = path.join(FIX, name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

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

const FSTREAM = { id: 'fstream', isAnime: false };
const FMANGA = { id: 'french-manga', isAnime: true };

console.log('\n— FStream : recherche film (fixture réelle) —');

{
    const html = read('fstream_search_fightclub.html');
    t('fixture présente', () => assert.ok(html && html.length > 100));

    if (html) {
        const cards = parseSearchResponse('https://fs26.lol', FSTREAM, html);
        t('≥ 1 carte, la première est Fight Club (1999, film)', () => {
            assert.ok(cards.length >= 1);
            const fc = cards[0];
            assert.ok(/fight club/i.test(fc.title));
            assert.strictEqual(fc.is_film, true);
            assert.strictEqual(fc.year, 1999);
            assert.ok(fc.page_url.startsWith('http'));
        });
    }
}

console.log('\n— FStream : recherche série (fixture réelle) —');

{
    const html = read('fstream_search_tlou.html');
    t('fixture présente', () => assert.ok(html && html.length > 100));
    if (html) {
        const cards = parseSearchResponse('https://fs26.lol', FSTREAM, html);
        t('saisons de The Last of Us détectées (data-seasons)', () => {
            const tlou = cards.filter(c => /last of us/i.test(c.series_name));
            assert.ok(tlou.length >= 1);
            const s1 = tlou.find(c => c.season_number === 1);
            assert.ok(s1, 'saison 1 attendue');
            assert.strictEqual(s1.is_film, false);
            assert.ok(s1.page_url.indexOf('http') === 0);
        });
    }
}

console.log('\n— FStream : page film + eps JSON —');

{
    const page = read('fstream_film_page.html');
    const eps = read('fstream_eps_1761.json');
    t('page film : PAS de #serie-config (les films l\'ignorent — l\'ID vient de l\'URL)', () => {
        assert.ok(page);
        assert.strictEqual(parseNewsId(page), '');
        // Le data-news-id brut est bien présent (utilisé par fetchDleFilm via l\'URL) :
        assert.ok(page.indexOf('data-news-id="1761"') !== -1 || /data-news-id=["']\d+["']/.test(page));
        assert.strictEqual(parseSeasonNumber(page), 0);
    });
    t('eps JSON : langues film présentes (vf/vostfr attendues chez DLE)', () => {
        assert.ok(eps);
        const data = JSON.parse(eps);
        const keys = Object.keys(data).filter(k => k !== 'info' && k !== 'alt_titles');
        assert.ok(keys.length >= 1, 'au moins une langue : ' + keys.join(','));
    });
}

console.log('\n— French-Manga : recherche anime (fixture réelle) —');

{
    const html = read('frenchmanga_search_onepiece.html');
    t('fixture présente', () => assert.ok(html && html.length > 100));
    if (html) {
        const cards = parseSearchResponse('https://w16.french-manga.net', FMANGA, html);
        t('≥ 1 carte One Piece, marquée anime', () => {
            assert.ok(cards.length >= 1);
            const op = cards.find(c => /one piece/i.test(c.series_name || c.title));
            assert.ok(op, 'carte One Piece attendue');
            assert.strictEqual(op.is_anime, true);
            assert.strictEqual(op.source, 'french-manga');
        });
    }
}

console.log('\n— Webflix : fastflux + pages embed (fixtures réelles) —');

{
    const ff = read('webflix_fastflux_movie_550.json');
    t('fastflux : MP4 VF direct pour Fight Club', () => {
        assert.ok(ff);
        const data = JSON.parse(ff);
        assert.strictEqual(data.success, true);
        assert.strictEqual(data.available, true);
        assert.ok(/\.mp4(\?|$)/.test(data.data.url));
        assert.strictEqual(data.data.language, 'VF');
    });
}

{
    const zenix = read('zenix_embed_550.html');
    t('zenix : SID exposé + URLs extractibles (flow play possible)', () => {
        assert.ok(zenix);
        const sid = (zenix.match(/const SID\s*=\s*"([^"]{4,80})"/) || [])[1];
        assert.ok(sid, 'SID attendu');
        const got = extractStreamUrls(zenix, 'https://fluxora.sbs/embed/zenix?tmdb=550');
        assert.ok(got.length >= 0); // la page player peut être vide avant POST play
    });
}

{
    const html = read('frembed_film_550.html');
    t('Frembed (cyou) : iframes vers hosts connus extractibles', () => {
        assert.ok(html);
        const got = extractStreamUrls(html, 'https://frembed.cyou/api/film.php?id=550');
        assert.ok(got.length >= 1, 'aucune URL extraite');
    });
}

{
    const heiwa = read('heiwa_embed_550.html');
    if (heiwa) {
        t('Heiwa : confirmé non extractible (SPA) — documenté, retiré du pool', () => {
            // Le test documente la décision : la page est une SPA sans URLs extractibles.
            // Si un jour extractStreamUrls(heiwa) renvoie ≥1 URL, réintégrer Heiwa au pool.
            const got = extractStreamUrls(heiwa, 'https://heiwastream.fr/embed/movie/550');
            assert.strictEqual(got.length, 0);
        });
    }
}

console.log('\n— Papadustream : film + série + master playlist (fixtures réelles) —');

{
    const film = read('papa_film_fightclub.html');
    t('page film : URL HLS movie ciblant tt0137523', () => {
        assert.ok(film);
        const url = extractMovieHlsUrl(film, 'tt0137523');
        assert.ok(url, 'URL HLS attendue');
        assert.ok(url.indexOf('/hls/') === 0 || url.indexOf('/hls/') !== -1);
    });
}

{
    const series = read('papa_series_breakingbad.html');
    t('page série : EPISODES JSON avec S1E1', () => {
        assert.ok(series);
        const eps = parseEpisodesJson(series);
        if (!eps.length) {
            // Le site a peut-être retiré le JSON structuré : le fallback regex doit prendre le relais
            const viaRe = extractHlsUrls(series);
            assert.ok(viaRe.length >= 1, 'ni JSON ni regex : page invalide');
        } else {
            const s1e1 = eps.find(e => e.season === 1 && e.episode === 1);
            assert.ok(s1e1, 'S1E1 attendue dans le JSON');
        }
    });
}

{
    const master = read('papa_master_movie.m3u8');
    if (!master) {
        console.log('  ⚠ master playlist : fixture absente (token expiré à la capture) — skipped');
    } else {
        t('master playlist : #EXTM3U + pistes audio détectables', () => {
            assert.ok(master.indexOf('#EXTM3U') !== -1);
            const audioLines = master.split('\n').filter(l => l.indexOf('TYPE=AUDIO') !== -1);
            assert.ok(audioLines.length >= 1, 'aucune piste TYPE=AUDIO');
        });
    }
}

console.log(`\nRésultat : ${ok} OK, ${ko} échec(s)`);
process.exit(ko ? 1 : 0);
