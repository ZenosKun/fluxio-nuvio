#!/usr/bin/env node
/**
 * Capture des fixtures HTML réelles pour les tests offline (rejouables).
 *
 *   node tests/capture_fixtures.cjs
 *
 * Best-effort : chaque section est isolée — un site mort n'empêche pas la
 * capture des autres. Les fixtures alimentent tests/test_fixtures.mjs :
 * si un site change son HTML, la régression offline le détecte sans réseau.
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

function save(name, text) {
    fs.writeFileSync(path.join(OUT, name), text);
    console.log('  💾 ' + name + ' (' + Math.max(1, Math.round(text.length / 1024)) + ' KB)');
}

async function get(url, headers) {
    const res = await fetch(url, { headers: headers || {} });
    return { text: await res.text(), status: res.status };
}

async function postForm(url, body, headers) {
    const res = await fetch(url, { method: 'POST', headers: headers, body: body });
    return { text: await res.text(), status: res.status };
}

const DLE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    'Accept-Language': 'fr-FR,fr;q=0.9',
    Cookie: 'fsschal=1',
};

async function captureDleSearch(origins, name, query) {
    for (const origin of origins) {
        try {
            const r = await postForm(
                origin + '/engine/ajax/search.php',
                'query=' + encodeURIComponent(query) + '&search_start=0&full_search=0&result_from=1',
                {
                    ...DLE_HEADERS,
                    Referer: origin + '/',
                    Origin: origin,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded',
                }
            );
            if (r.status === 200 && r.text && !/fsschal|Verification/i.test(r.text.slice(0, 2000))) {
                save(name, r.text);
                return { text: r.text, origin: origin };
            }
            console.warn('  ⚠ ' + name + ' sur ' + origin + ' : HTTP ' + r.status + ' (interstitiel ?)');
        } catch (e) {
            console.warn('  ⚠ ' + name + ' sur ' + origin + ' : ' + e.message);
        }
    }
    return null;
}

async function captureFstreamPage(origin, pageUrl) {
    try {
        const r = await get(pageUrl, DLE_HEADERS);
        if (r.status !== 200) {
            console.warn('  ⚠ page film : HTTP ' + r.status);
            return;
        }
        save('fstream_film_page.html', r.text);
        const idm = /data-news-id=["'](\d+)["']/.exec(r.text);
        if (idm) {
            const eps = await get(origin + '/data/eps_' + idm[1] + '.txt', {
                'User-Agent': DLE_HEADERS['User-Agent'],
                Cookie: 'fsschal=1',
                Referer: pageUrl,
            });
            if (eps.status === 200) save('fstream_eps_' + idm[1] + '.json', eps.text);
        }
    } catch (e) {
        console.warn('  ⚠ page film : ' + e.message);
    }
}

async function maybeSave(name, url, headers, mustContain) {
    try {
        const r = await get(url, headers);
        if (r.status === 200 && r.text && (!mustContain || r.text.indexOf(mustContain) !== -1)) {
            save(name, r.text);
        } else {
            console.warn('  ⚠ ' + name + ' : HTTP ' + r.status + (mustContain ? ' (marqueur absent)' : ''));
        }
    } catch (e) {
        console.warn('  ⚠ ' + name + ' : ' + e.message);
    }
}

(async () => {
    console.log('\n— FStream (film Fight Club + série The Last of Us) —');
    let origin = 'https://fs26.lol';
    const fc = await captureDleSearch([origin, 'https://fstream.top'], 'fstream_search_fightclub.html', 'fight club');
    await captureDleSearch([origin, 'https://fstream.top'], 'fstream_search_tlou.html', 'the last of us');
    if (fc) {
        const cm = /onclick=["']location\.href=['"]([^'"]+)['"]/i.exec(fc.text);
        if (cm) {
            const rel = cm[1];
            const pageUrl = /^https?:/i.test(rel) ? rel : fc.origin + rel;
            await captureFstreamPage(fc.origin, pageUrl);
        }
    }

    console.log('\n— French-Manga (anime One Piece) —');
    await captureDleSearch(
        ['https://w16.french-manga.net', 'https://french-manga.net'],
        'frenchmanga_search_onepiece.html',
        'one piece'
    );

    console.log('\n— Webflix (fastflux + Zenix + Heiwa + WWEmbed, Fight Club 550) —');
    await maybeSave(
        'webflix_fastflux_movie_550.json',
        'https://webflix.art/api/fastflux?type=movie&tmdb_id=550',
        {
            'User-Agent': CHROME_UA,
            Accept: 'application/json, text/plain, */*',
            Origin: 'https://webflix.art',
            Referer: 'https://webflix.art/',
        }
    );
    await maybeSave(
        'zenix_embed_550.html',
        'https://fluxora.sbs/embed/zenix?tmdb=550&type=movie&season=&episode=&lang=vf',
        { 'User-Agent': CHROME_UA, Referer: 'https://webflix.art/' }
    );
    await maybeSave(
        'heiwa_embed_550.html',
        'https://heiwastream.fr/embed/movie/550',
        { 'User-Agent': CHROME_UA, Referer: 'https://webflix.art/' }
    );
    await maybeSave(
        'wwembed_movie_550.html',
        'https://wwembed.wavewatch.cc/api/v1/streaming/ww-movie-550',
        { 'User-Agent': CHROME_UA, Referer: 'https://webflix.art/' }
    );
    await maybeSave(
        'frembed_film_550.html',
        'https://frembed.cyou/api/film.php?id=550',
        { 'User-Agent': CHROME_UA, Referer: 'https://webflix.art/' }
    );

    console.log('\n— Papadustream (film Fight Club + série Breaking Bad) —');
    let papaFilm = null;
    try {
        const r = await get('https://papadustream.club/films/tt0137523', {
            'User-Agent': CHROME_UA,
            'Accept-Language': 'fr-FR,fr;q=0.9',
        });
        if (r.status === 200 && r.text) {
            save('papa_film_fightclub.html', r.text);
            papaFilm = r.text;
        }
    } catch (e) {
        console.warn('  ⚠ papa film : ' + e.message);
    }
    await maybeSave('papa_series_breakingbad.html', 'https://papadustream.club/series/tt0903747', {
        'User-Agent': CHROME_UA,
        'Accept-Language': 'fr-FR,fr;q=0.9',
    });

    if (papaFilm) {
        const mvRe = /\/hls\/(?:p\/\d+\/[A-Za-z0-9_-]+\/)?s\d+\/movie\/tt0137523\/playlist\.m3u8/;
        const mv = mvRe.exec(papaFilm);
        if (mv) {
            await maybeSave(
                'papa_master_movie.m3u8',
                'https://www.papadustream.club' + mv[0],
                { 'User-Agent': CHROME_UA },
                '#EXTM3U'
            );
        }
    }

    console.log('\n✅ capture terminée — fixtures dans tests/fixtures/');
})();
