/**
 * Plugin v3 — multi-sources FR orchestrées pour Nuvio (aucun serveur requis).
 *
 * Sources : FStream, French-Manga (recherche par titre ancrée TMDB, routage
 * par type de contenu) + BFlix, Webflix, Papadustream (résolution directe
 * par tmdbId/IMDb). Extracteurs d'hôtes en JS : uqload, vidzy, premium,
 * netu, luluvid, filmoon, voe.
 *
 * Un serveur sestudio auto-hébergé reste optionnel (kisskh + uniquestream)
 * en repli si rien ne sort en direct.
 *
 * Réglages depuis l'UI du plugin sur NuvioMobile, ou SCRAPER_SETTINGS sur
 * NuvioTV.
 */

import { extractStreams } from '../core/orchestrator.js';
import { createProvider, createSettingsLayout } from '../utils/provider.js';

module.exports = {
    getStreams: createProvider('v3', extractStreams, { timeout: 27000 }),
    onSettings: createSettingsLayout([
        { type: 'header', label: 'Lecture directe multi-sources (aucun serveur requis)' },
        {
            type: 'info',
            label: '5 sources orchestrées : FStream, French-Manga, BFlix, Papadustream, Webflix. Toutes les qualités des sources réactives sont affichées — installe-le, c est tout.',
        },
        { type: 'header', label: 'Langue et sources' },
        {
            type: 'select',
            key: 'language',
            label: 'Langue préférée',
            description: 'Langue demandée en priorité ; le plugin bascule automatiquement si absente',
            defaultValue: 'vf',
            options: [
                { label: 'VF d’abord', value: 'vf' },
                { label: 'VOSTFR d’abord', value: 'vostfr' },
                { label: 'VO d’abord', value: 'vo' },
                { label: 'Auto (VF puis VOSTFR puis VO)', value: 'all' },
            ],
        },
        {
            type: 'toggle',
            key: 'allowOtherLang',
            label: 'Autoriser une autre langue / un autre site si absent',
            defaultValue: true,
        },
        {
            type: 'text',
            key: 'sources',
            label: 'Sources activées (optionnel)',
            description:
                'Ids séparés par des virgules : fstream, french-manga, bflix, papadustream, webflix. Vide = toutes.',
            placeholder: 'fstream, webflix, bflix',
        },
        {
            type: 'toggle',
            key: 'detectAnime',
            label: 'Détecter les animés via TMDB',
            description:
                'Anime → French-Manga d’abord (FStream en secours). Films/séries → FStream + Webflix + Bflix. Désactivé : toutes les sources pour tout.',
            defaultValue: true,
        },
        {
            type: 'toggle',
            key: 'earlyExit',
            label: 'Couper les sources bloquantes (rapide)',
            description:
                'Affiche TOUS les flux des sources qui répondent — qualités et hosts multiples inclus. Après 5 s, si au moins un flux est trouvé, les sites bloqués ne sont plus attendus. Désactivé : attendre toutes les sources jusqu au budget.',
            defaultValue: true,
        },
        {
            type: 'toggle',
            key: 'verifyLinks',
            label: 'Tester les liens avant affichage',
            description:
                'Teste rapidement chaque lien (8 s max) : les liens morts passent en fin de liste avec ⚠ au lieu de bloquer en « buffering ».',
            defaultValue: true,
        },
        {
            type: 'toggle',
            key: 'selfTest',
            label: 'Mode diagnostic (flux de test + domaine des liens)',
            description:
                'Ajoute 2 flux publics de test en tête de liste et le domaine de chaque lien dans son nom. Si les flux de test ne se lisent pas non plus, le problème vient du lecteur de l’app, pas du plugin.',
            defaultValue: false,
        },
        {
            type: 'text',
            key: 'tmdbKey',
            label: 'Clé API TMDB personnelle (optionnel)',
            description:
                'La clé publique intégrée est très répandue et peut être révoquée. Ta propre clé (gratuite sur themoviedb.org) est plus fiable.',
            placeholder: 'ex. 1a2b3c…',
        },
        { type: 'header', label: 'Avancé — serveur sestudio (optionnel)' },
        {
            type: 'text',
            key: 'serverUrl',
            label: 'URL d’un serveur sestudio (repli)',
            description:
                'Facultatif : ajoute kisskh et uniquestream via ton serveur (uvx sestudio). Vide = mode direct uniquement.',
            placeholder: 'http://192.168.1.50:8080',
        },
        {
            type: 'select',
            key: 'timeoutSec',
            label: 'Timeout réseau',
            defaultValue: '10',
            options: [
                { label: '10 s (recommandé)', value: '10' },
                { label: '15 s', value: '15' },
                { label: '30 s', value: '30' },
                { label: '45 s', value: '45' },
            ],
        },
        {
            type: 'info',
            label: 'Astuce : certains hosts (uqload, vidzy…) sont plus lents le soir ; avec « rendre dès que c’est bon », les sources lentes ne te bloquent plus — essaie un autre flux.',
        },
        {
            type: 'info',
            label: 'Si TOUTES les sources échouent chez toi : ton fournisseur d’accès bloque peut-être les domaines (DNS). Un VPN ou le DNS 1.1.1.1 règle le problème — le plugin répond toujours avant le timeout de Nuvio, liste vide ou pas.',
        },
    ]),
};
