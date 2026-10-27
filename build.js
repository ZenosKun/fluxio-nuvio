#!/usr/bin/env node

/**
 * Build script — plugin v3 (nom définitif : voir manifest.json)
 *
 * Bundle unique IIFE es2016 pour les runtimes Nuvio (Hermes / QuickJS).
 * Usage :
 *   node build.js             # build lisible
 *   node build.js --minify    # build minifié (publication)
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
const scraper = manifest.scrapers[0];

(async () => {
    const minify = process.argv.includes('--minify');
    const outFile = path.join(__dirname, scraper.filename);

    const result = await esbuild.build({
        entryPoints: [path.join(__dirname, 'src/plugin/index.js')],
        bundle: true,
        outfile: outFile,
        format: 'iife',
        platform: 'browser',
        target: 'es2016',
        minify: minify,
        sourcemap: false,
        globalName: '__provider',
        banner: {
            js: `/**\n * ${scraper.name} v${manifest.version} — multi-sources FR pour Nuvio\n * Built: ${new Date().toISOString()}\n */`,
        },
        footer: {
            js: `\nif (typeof module !== 'undefined' && module.exports) {\n    module.exports = __provider;\n}\nif (__provider && __provider.getStreams) {\n    if (typeof globalThis !== 'undefined') {\n        globalThis.getStreams = __provider.getStreams;\n    }\n    if (typeof global !== 'undefined') {\n        global.getStreams = __provider.getStreams;\n    }\n    if (typeof self !== 'undefined') {\n        self.getStreams = __provider.getStreams;\n    }\n}`,
        },
        logLevel: 'warning',
    });

    const stats = fs.statSync(outFile);
    console.log(`✅ ${scraper.filename} (${(stats.size / 1024).toFixed(1)} KB)${minify ? ' [minifié]' : ''}`);
})().catch(err => {
    console.error('❌ Échec du build :', err.message);
    process.exit(1);
});
