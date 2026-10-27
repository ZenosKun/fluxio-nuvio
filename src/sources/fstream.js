/**
 * Source FStream (DLE-CMS) — provider v3.
 * Toute la mécanique (recherche par titre TMDB, cartes, épisodes, hosts)
 * vit dans dle-runner.js ; ce module ne fait que le lier au registre.
 */

import { runDleSite } from './dle-runner.js';

export default {
    id: 'fstream',
    label: 'FStream',
    needsMeta: true, // recherche par titre → attend les métadonnées TMDB
    async run(ctx) {
        return runDleSite(ctx, 'fstream');
    },
};
