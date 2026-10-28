# Fluxio

**Plugin Nuvio multi-sources FR — orchestration intelligente, tout ce qui répond s'affiche.**

Films, séries et animés VF/VOSTFR en lecture directe sur [Nuvio](https://nuvio.tv) (Mobile + TV), sans serveur. Fluxio orchestre **5 sources françaises** autour de trois principes : *routage par type de contenu*, *anti-blocage* (les sources réactives livrent tous leurs flux — qualités multiples incluses ; les bloquées sont coupées après 5 s) et *ancrage TMDB* (zéro mauvais match — jamais un animé à la place d'un documentaire).

---

## Pourquoi Fluxio

| | Gowaru (34 providers) | sestudio-nuvio v2 | **Fluxio v3** |
|---|---|---|---|
| Sources par recherche | 34 dont ~24 inutiles | 3 | 5, toutes utiles au type demandé |
| Temps mesuré (film) | 43 s – 12 min | 2,7 – 12 s | **2,7 – 6 s** (tout afficher) |
| Source lente ou morte | bloque tout | bloque | coupée après 5 s, le reste s'affiche |
| Matching | titre brut → faux matches | ancré TMDB | ancré TMDB + plages d'épisodes |
| 2e épisode d'une série | re-complet | re-complet | accéléré (caches TMDB + recherche) |

Mesures réelles (bundle minifié, réseau vivant, `tests/test_e2e.cjs`, variance réseau non négligeable) : Fight Club **3-5 flux en 2,7 – 6 s** (toutes les qualités des sources réactives), SAO S1E5 **2-3 flux**, TLOU S1E1/S1E2 **4-5 flux** chacun, NAZA 1 flux (pire cas ~40 s : documentaire absent des sources, rendu avant le budget (25 s, 18 s sans timers)).

## Architecture

```
                          ┌────────────────────────────────┐
   Nuvio (movie/tv)  ───► │ ORCHESTRATEUR (src/core)       │
                          │ budget 25 s (18 s TV) · anti-blocage 5 s │
                          │ vagues 1/2 · collecte partagée │
                          └───────┬───────────────┬────────┘
             tier direct (immédiat)│              │tier recherche (dès TMDB)
        ┌──────────┬───────────────┤              ├──────────────┐
        │ Webflix  │   BFlix       │              │ FStream      │ French-Manga
        │ FastFlux │  (tmdbId)     │              │ (film/série) │ (anime)
        │ Discover │               │              └──────────────┘
        │ Frembed/ │  Papadustream │              routage (plan.js) :
        │ Zenix    │  (IMDb→HLS)   │              anime → French-Manga
        └──────────┴───────────────┘              film/série → FStream
                          │
                          ▼ extracteurs d'hôtes (JS, portés de sestudio)
        uqload · vidzy · premium · netu · luluvid · filmoon · voe
```

**Trois idées structurantes :**

1. **Contrat SourceProvider** (`src/core/registry.js`) — chaque source est un module autonome (`{ id, label, needsMeta, run(ctx) }`). Ajouter une source = écrire un fichier et le déclarer dans le registre. Le noyau ne connaît ni leurs sites ni leurs protocoles.
2. **Anti-blocage** (`src/core/stopper.js`) — une même source sert souvent **plusieurs qualités/hosts du même titre** : aucun quota de flux ne coupe prématurément, toutes les sources répondantes livrent tout. Seule l'échéance douce (5 s) abrège : au-delà, si ≥ 1 flux pertinent existe déjà, les sites bloqués ne te retardent plus — et les chaînes internes des sources abandonnent d'elles-mêmes aux frontières de boucles (identique TV/Mobile). L'échéance reste courte car **Nuvio attend la réponse complète du plugin** (réglage app « Stream Selection Timeout ») : une réponse trop tardive s'affiche en erreur. Désactivable (`earlyExit=false` : tout attendre jusqu'au budget, comportement v2) et ajustable (`softMs`, tunable SCRAPER_SETTINGS 3-15 s).
3. **Dégradation gracieuse TV/Mobile** — un seul bundle : sur Mobile (timers présents) la course anti-blocage et le parallélisme s'appliquent ; sur TV (fetch synchrone) les tâches se sérialisent naturellement et le noyau passe en mode « requêtes minimales ».

## Sources

| Source | Mode | Contenu | Notes |
|---|---|---|---|
| **FStream** | recherche titre TMDB | films, séries VF/VOSTFR | DLE-CMS, domaines tournants auto-résolus |
| **French-Manga** | recherche titre TMDB | animes VOSTFR (VF) | spécialiste anime, numérotation absolue gérée |
| **BFlix** | direct par tmdbId | VO + sous-titres FR/EN | infaillible sur l'identité du contenu |
| **Papadustream** | direct par IMDb (TMDB→external_ids) | films/séries HLS multi-audio VF/VO | tokens signés, refresh automatique |
| **Webflix** | direct par tmdbId | MP4/HLS VF + miroir VOSTFR anime | FastFlux, Discovery (1 appel = tous les épisodes), Zenix, Frembed |

Routage anime/film/série via TMDB (genre Animation + langue originale japonaise, mode strict). Désactivable (`detectAnime=false`) : comportement v2, toutes les sources pour tout.

## Installation

1. Nuvio → Settings → Plugins → **Add Plugin**
2. Colle l'URL du `manifest.json` :
   `https://raw.githubusercontent.com/ZenosKun/fluxio-nuvio/main/manifest.json`
3. Clique un film : les flux arrivent. C'est tout.

Aucun serveur requis. Un serveur [sestudio](https://pypi.org/project/sestudio/) auto-hébergé reste utilisable en repli (réglage `serverUrl`) pour kisskh/uniquestream.

## Réglages

| Réglage | Défaut | Effet |
|---|---|---|
| Langue préférée | VF | langue demandée en priorité, bascule auto si absente |
| Autoriser autre langue/site | ON | secours si absent |
| Sources activées | toutes | ids : `fstream, french-manga, bflix, papadustream, webflix` |
| Détecter les animés via TMDB | ON | routage par type de contenu |
| **Couper les sources bloquantes** | ON | tout afficher des sources réactives ; après 5 s (avec ≥ 1 flux), sites bloqués abandonnés ; OFF = tout attendre (v2) |
| Clé API TMDB personnelle | clé publique | recommandée (gratuite sur themoviedb.org) |
| URL serveur sestudio | vide | repli optionnel |
| Timeout réseau | 30 s | budget par requête |

## Tests

```
npm install
node tests/test_units.mjs          # 38 tests offline : plan, anti-blocage, tri, réglages, parseurs
node tests/capture_fixtures.cjs    # capture le HTML réel des sites (best-effort, isolé par site)
node tests/test_fixtures.mjs       # 15 tests offline sur fixtures réelles (détecte la casse d'un site)
npm test                           # e2e réseau vivant : 8 scénarios + chronométrage
node tests/test_e2e.cjs A,C        # e2e par scénario (A Fight Club, B TLOU, C One Piece,
                                   #   D NAZA, E Simpsons, F earlyExit OFF, G detectAnime OFF, H binge)
```

La régression d'un parseur se fait **offline en secondes** contre `tests/fixtures/` : si un site change son HTML, le test casse ici et non en prod. Heiwastream (SPA) et WWEmbed (méta-page) ont été écartés du pool Webflix après audit des fixtures.

## Fiabilité du matching

- **Ancrage TMDB** : sans fiche TMDB, échec propre — jamais de faux résultat.
- Garde-fous de titre : frontières de mot, filtre d'année dur films (>1 an) et séries (>2 ans), rejet des homonymes.
- **Plages d'épisodes** : les saisons éditoriales des animes (« Saison 6 (144-195) ») sont déclassées si l'épisode demandé n'y est pas.
- BFlix/Papadustream/Webflix : résolution par identifiant — zéro ambiguïté de titre.

## Limites connues

- Les hosts gratuits (uqload, vidzy…) restent périssables ; l'anti-blocage garantit que leurs lenteurs ne te bloquent pas.
- BFlix est VO/VOSTFR : la VF vient du tier DLE/Papa.
- Vidzy exige une empreinte TLS navigateur : dépriorisé en fin de chaîne d'hôtes.
- Un contenu absent de TMDB ne peut pas être cherché (choix d'architecture : échec propre plutôt que faux match).

## Licence

GPL-3.0 — voir [LICENSE](LICENSE) et [NOTICE](NOTICE) (portage JS des extracteurs de [sestudio](https://github.com/DSestu/sestudio) © David Sestu, sources Gowaru utilisées comme référence de protocoles).

## Runtimes à fetch bloquant (NuvioTV, Desktop) — v3.1.3

Sans timer, aucune requête en cours ne peut être interrompue. Deux garde-fous dans `src/utils/http.js` :

- **Budget global** : plus aucune requête n'est lancée à moins de 1,5 s de l'échéance, et chaque timeout est plafonné au temps restant (25 s avec timers, 18 s sans).
- **Disjoncteur par hôte** : après un échec réseau/timeout, l'hôte est écarté 2 min — un domaine bloqué ne coûte qu'un timeout.

`npm run test:blocking` simule ce runtime (horloge virtuelle). Avant 3.1.3, le provider imposait 60 s et écrasait le budget de 25 s.

## Diagnostic du « buffering » infini — v3.1.4

- **Nom des flux** : `Fluxio · source · hôte` (l'app n'affiche pas le champ `title`), pour savoir quel hôte pose problème.
- **Test des liens** (réglage « Tester les liens avant affichage », activé par défaut) : HLS en GET de la playlist, MP4 en HEAD, avec les en-têtes du flux, 8 s au maximum. Les liens morts (403/404/playlist invalide) passent en fin de liste avec ⚠.
- **Logs** : chaque flux final est journalisé (`[stream] nom | qualité | langue | url | headers=…`) ; lance l'app depuis un terminal pour les voir, puis teste le lien avec `mpv --http-header-fields="Referer: …" "<url>"`.
