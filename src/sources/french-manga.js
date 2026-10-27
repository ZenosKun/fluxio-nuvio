/**
 * Source French-Manga (DLE-CMS, spécialiste anime) — provider v3.
 * Toute la mécanique vit dans dle-runner.js ; ce module la lie au registre.
 */

import { runDleSite } from './dle-runner.js';

export default {
    id: 'french-manga',
    label: 'French-Manga',
    needsMeta: true,
    async run(ctx) {
        return runDleSite(ctx, 'french-manga');
    },
};
