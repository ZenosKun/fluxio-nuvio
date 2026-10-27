/**
 * Registre des sources (contrat Provider v3).
 *
 * Une source est un module autonome :
 *   {
 *     id: string,            — identifiant stable (réglages, plan, logs)
 *     label: string,         — nom affiché
 *     needsMeta: boolean,    — true = recherche par titre TMDB (DLE) ;
 *                              false = résolution directe par tmdbId/IMDb
 *     run(ctx): Promise<void> — pousse des flux internes dans ctx.push
 *                               au fur et à mesure ; respecte ctx.shouldStop
 *   }
 *
 * ctx (orchestrateur → source) :
 *   { tmdbId, mediaType, season, episode, cfg, signal, push, shouldStop,
 *     stopper, meta }   — meta : Promise<Meta|null> partagée (routage+titres)
 *
 * Ajouter une source = écrire son module + le déclarer ici. Aucune autre
 * modification du noyau n'est nécessaire (plan, settings, UI se mettent à
 * jour via les listes ci-dessous).
 */

import fstream from '../sources/fstream.js';
import frenchManga from '../sources/french-manga.js';
import bflix from '../sources/bflix.js';
import papadustream from '../sources/papadustream.js';
import webflix from '../sources/webflix.js';

/** Ordre de déclaration = ordre de présentation dans les réglages. */
export const ALL_SOURCES = [fstream, frenchManga, bflix, papadustream, webflix];

/** Ids connus du registre (réglages « sources »). */
export const KNOWN_IDS = ALL_SOURCES.map(s => s.id);

/**
 * Sources actives selon les réglages utilisateur ('' ou vide = toutes).
 * @param {{sources: string}} cfg
 * @returns {Array} providers actifs (dans l'ordre du registre)
 */
export function resolveSources(cfg) {
    const wanted = String(cfg.sources || '')
        .split(',')
        .map(x => x.trim().toLowerCase())
        .filter(Boolean);
    if (!wanted.length) return ALL_SOURCES.slice();
    return ALL_SOURCES.filter(s => wanted.indexOf(s.id) !== -1);
}
