#!/usr/bin/env node
/**
 * Tests e2e RÉELS du bundle minifié v3 (réseau vivant, comme en prod).
 *
 *   node tests/test_e2e.cjs
 *
 * Scénarios :
 *   A. Fight Club (film)         → anti-blocage, routage Film/série, VF en tête
 *   B. The Last of Us S1E1 (tv)  → épisode E01 dans les titres
 *   C. One Piece S1E1 (anime)    → routage Animé → French-Manga, VOSTFR
 *   D. NAZA (documentaire)       → ZÉRO flux anime (le bug Gowaru historique)
 *   E. The Simpsons (animation occidentale) → NON classée anime
 *   F. earlyExit OFF (Fight Club) → attend tout, plus de flux, chronométrage
 *   G. detectAnime OFF            → aucun log de routage
 *   H. Binge (TLOU E1 → E2)       → 2e appel accéléré (caches)
 */

const path = require('path');

const BUNDLE = path.join(__dirname, '..', 'providers', 'fluxio.js');

/* Sélection : node tests/test_e2e.cjs [A,B,C] — vide = tous */
const ONLY = (process.argv[2] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const want = id => !ONLY.length || ONLY.indexOf(id) !== -1;

let ok = 0;
let ko = 0;
const timings = {};

function scenario(name, fn) {
    return (async () => {
        const logs = [];
        const orig = { log: console.log, warn: console.warn, error: console.error };
        const capture = level => (...args) => {
            const line = args.map(String).join(' ');
            logs.push({ level, line });
            orig[level]('[  ' + line);
        };
        console.log = capture('log');
        console.warn = capture('warn');
        console.error = capture('error');
        globalThis.__lastLogs = logs; // référence vivante, disponible DANS fn()
        try {
            const result = await fn();
            ok++;
            console.log('');
            console.log('✓ ' + name + ' [' + result.ms + ' ms, ' + (result.streams || []).length + ' flux]');
            return result;
        } catch (err) {
            ko++;
            console.log('');
            console.error('✗ ' + name + ' — ' + err.message);
            return { streams: [], ms: 0 };
        } finally {
            console.log = orig.log;
            console.warn = orig.warn;
            console.error = orig.error;
            globalThis.__lastLogs = logs;
        }
    })();
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

function assertLog(logs, fragment, why) {
    assert(
        logs.some(l => l.line.indexOf(fragment) !== -1),
        (why ? why + ' : ' : '') + 'log « ' + fragment + ' » absent'
    );
}

function assertNoLog(logs, fragment) {
    assert(!logs.some(l => l.line.indexOf(fragment) !== -1), 'log « ' + fragment + ' » ne devrait pas exister');
}

function lastMs(t0) {
    return Date.now() - t0;
}

function hasStream(streams, pred) {
    return streams.some(pred);
}

(async () => {
    const provider = require(BUNDLE);
    assert(typeof provider.getStreams === 'function', 'getStreams manquant dans le bundle');

    if (want('A'))
    /* ── A. Fight Club — anti-blocage ON ───────────────────────────── */
    {
        const t0 = Date.now();
        await scenario('A. Fight Club (film) — anti-blocage + routage Film/série', async () => {
            const streams = await provider.getStreams(550, 'movie', 0, 0);
            const logs = globalThis.__lastLogs;
            assert(streams.length >= 1, 'aucun flux pour Fight Club');
            assertLog(logs, 'Film/série', 'routage attendu');
            assertLog(logs, 'fstream', 'FStream attendu dans la vague de recherche');
            // VF (langue préférée) en tête du rendu final
            assert(
                /VF/i.test(String(streams[0].language || '')) || /VOSTFR/i.test(String(streams[0].language || '')),
                'premier flux devrait être VF/VOSTFR, reçu : ' + streams[0].language
            );
            // Le titre du plugin est présent (name)
            assert(streams[0].name && streams[0].name.length > 0, 'name manquant');
            return { streams, ms: lastMs(t0) };
        }).then(r => { timings.fightClubEarly = r.ms; });
    }

    if (want('B'))
    /* ── B. The Last of Us S1E1 ─────────────────────────────────────────── */
    {
        const t0 = Date.now();
        await scenario('B. The Last of Us S1E1 — épisode ciblé', async () => {
            const streams = await provider.getStreams(100088, 'tv', 1, 1);
            assert(streams.length >= 1, 'aucun flux pour TLOU S1E1');
            const e01 = hasStream(streams, s => /E01/.test(s.title));
            assert(e01, 'aucun titre avec E01 : ' + streams.map(s => s.title).join(' | '));
            return { streams, ms: lastMs(t0) };
        }).then(r => { timings.tlou = r.ms; });
    }

    if (want('C'))
    /* ── C. One Piece S1E1 — anime ──────────────────────────────────────── */
    {
        const t0 = Date.now();
        await scenario('C. One Piece S1E1 — routage Animé → French-Manga', async () => {
            const streams = await provider.getStreams(37854, 'tv', 1, 1);
            const logs = globalThis.__lastLogs;
            assertLog(logs, 'Animé', 'detection anime attendue');
            assertLog(logs, 'french-manga', 'French-Manga attendu en vague 1');
            assertNoLog(logs, 'Animé → recherche : fstream');
            assert(streams.length >= 1, 'aucun flux pour One Piece S1E1');
            // French-Manga est VOSTFR : vérifier qu un flux VOSTFR existe
            const vost = hasStream(streams, s => /VOSTFR/i.test(s.language || '') || /VOSTFR/i.test(s.title || ''));
            assert(vost, 'aucun flux VOSTFR pour One Piece');
            return { streams, ms: lastMs(t0) };
        }).then(r => { timings.onePiece = r.ms; });
    }

    if (want('D'))
    /* ── D. NAZA (documentaire) — le bug Gowaru ne doit PAS se produire ─── */
    {
        const t0 = Date.now();
        await scenario('D. NAZA (documentaire Gaza) — zéro animé renvoyé', async () => {
            const streams = await provider.getStreams(1755291, 'movie', 0, 0);
            const logs = globalThis.__lastLogs;
            assertLog(logs, 'Film/série', 'un documentaire n est PAS un anime');
            assertNoLog(logs, 'Animé →');
            for (const s of streams) {
                assert(
                    !/french-manga/i.test(String(s.title || '')) && !/french manga/i.test(String(s.title || '')),
                    'flux issu de French-Manga (source anime) pour un documentaire !'
                );
            }
            return { streams, ms: lastMs(t0) };
        }).then(r => { timings.naza = r.ms; });
    }

    if (want('E'))
    /* ── E. The Simpsons — animation occidentale ≠ anime ────────────────── */
    {
        const t0 = Date.now();
        await scenario('E. The Simpsons S1E1 — animation US non classée anime', async () => {
            const streams = await provider.getStreams(1416, 'tv', 1, 1);
            const logs = globalThis.__lastLogs;
            assertLog(logs, 'Film/série', 'Simpsons doit être traité film/série (mode strict ja)');
            assertNoLog(logs, 'Animé →');
            return { streams, ms: lastMs(t0) };
        }).then(r => { timings.simpsons = r.ms; });
    }

    if (want('F'))
    /* ── F. earlyExit OFF — comportement v2 (tout attendre) ─────────────── */
    {
        globalThis.SCRAPER_SETTINGS = { earlyExit: 'false' };
        const t0 = Date.now();
        await scenario('F. Fight Club — earlyExit OFF (tout attendre)', async () => {
            const streams = await provider.getStreams(550, 'movie', 0, 0);
            assert(streams.length >= 1, 'aucun flux');
            assertNoLog(globalThis.__lastLogs, 'échéance douce');
            assertNoLog(globalThis.__lastLogs, 'résultats suffisants');
            return { streams, ms: lastMs(t0) };
        }).then(r => { timings.fightClubFull = r.ms; });
        delete globalThis.SCRAPER_SETTINGS;
    }

    if (want('G'))
    /* ── G. detectAnime OFF — aucun routage ─────────────────────────────── */
    {
        globalThis.SCRAPER_SETTINGS = { detectAnime: 'false' };
        const t0 = Date.now();
        await scenario('G. Fight Club — detectAnime OFF (comportement v2)', async () => {
            const streams = await provider.getStreams(550, 'movie', 0, 0);
            const logs = globalThis.__lastLogs;
            // Pas de routage par type : ni anime, ni film/série, ni secours —
            // toutes les sources de recherche partent ensemble (vague 1).
            assertNoLog(logs, 'Animé →');
            assertNoLog(logs, 'Film/série →');
            assertNoLog(logs, 'secours :');
            assertLog(logs, 'détection désactivée', 'mode v2 attendu');
            assert(streams.length >= 1, 'aucun flux');
            return { streams, ms: lastMs(t0) };
        }).then(r => { timings.detectOff = r.ms; });
        delete globalThis.SCRAPER_SETTINGS;
    }

    if (want('H'))
    /* ── H. Binge TLOU E1 → E2 — caches ─────────────────────────────────── */
    {
        const t0 = Date.now();
        await scenario('H. Binge TLOU E1 puis E2 — le 2e appel est accéléré', async () => {
            await provider.getStreams(100088, 'tv', 1, 1);
            const t2 = Date.now();
            const streams2 = await provider.getStreams(100088, 'tv', 1, 2);
            const ms2 = Date.now() - t2;
            assert(streams2.length >= 1, 'aucun flux pour TLOU S1E2');
            const e02 = hasStream(streams2, s => /E02/.test(s.title));
            assert(e02, 'aucun titre avec E02 : ' + streams2.map(s => s.title).join(' | '));
            timings.bingeFirst = lastMs(t0) - ms2; // approximatif : durée E1
            timings.bingeSecond = ms2;
            return { streams: streams2, ms: lastMs(t0) };
        });
    }

    /* ── Résumé ─────────────────────────────────────────────────────────── */
    console.log('');
    console.log('════════ Chronométrage (variance réseau non négligeable) ════════');
    for (const [k, v] of Object.entries(timings)) {
        console.log('   ' + k.padEnd(18) + (v / 1000).toFixed(1) + ' s');
    }
    console.log('');
    console.log('Résultat : ' + ok + ' scénario(s) OK, ' + ko + ' échec(s)');
    process.exit(ko ? 1 : 0);
})();
