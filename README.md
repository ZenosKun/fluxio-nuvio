# Fluxio

**Plugin Nuvio multi-sources FR — orchestration intelligente, tout ce qui répond s'affiche.**

Films, séries et animés VF/VOSTFR en lecture directe sur [Nuvio](https://nuvio.tv) (Mobile + TV), sans serveur. Fluxio orchestre **7 sources françaises** autour de trois principes : *routage par type de contenu*, *anti-blocage* (les sources réactives livrent tous leurs flux — qualités multiples incluses ; les bloquées sont coupées après 10 s) et *ancrage TMDB* (zéro mauvais match — jamais un animé à la place d'un documentaire).

---

## Pourquoi Fluxio

| | Gowaru (34 providers) | sestudio-nuvio v2 | **Fluxio v3** |
|---|---|---|---|
| Sources par recherche | 34 dont ~24 inutiles | 3 | 5, toutes utiles au type demandé |
| Temps mesuré (film) | 43 s – 12 min | 2,7 – 12 s | **2,7 – 6 s** (tout afficher) |
| Source lente ou morte | bloque tout | bloque | coupée après 10 s, le reste s'affiche |
| Matching | titre brut → faux matches | ancré TMDB | ancré TMDB + plages d'épisodes |
| 2e épisode d'une série | re-complet | re-complet | accéléré (caches TMDB + recherche) |

Mesures réelles (bundle minifié, réseau vivant, `tests/test_e2e.cjs`, variance réseau non négligeable) : Fight Club **3-5 flux en 2,7 – 6 s** (toutes les qualités des sources réactives), SAO S1E5 **2-3 flux**, TLOU S1E1/S1E2 **4-5 flux** chacun, NAZA 1 flux (pire cas ~40 s : documentaire absent des sources, rendu avant le budget (25 s, 18 s sans timers)).

## Architecture

```
                          ┌────────────────────────────────┐
   Nuvio (movie/tv)  ───► │ ORCHESTRATEUR (src/core)       │
                          │ budget 25 s (18 s TV) · anti-blocage 10 s │
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
        uqload · vidmoly · xtremestream · netu · filmoon · voe · veev ·
        luluvid · premium · vidzy   (v3.1.9 : vidmoly, xtremestream, veev)
```

**Trois idées structurantes :**

1. **Contrat SourceProvider** (`src/core/registry.js`) — chaque source est un module autonome (`{ id, label, needsMeta, run(ctx) }`). Ajouter une source = écrire un fichier et le déclarer dans le registre. Le noyau ne connaît ni leurs sites ni leurs protocoles.
2. **Anti-blocage** (`src/core/stopper.js`) — une même source sert souvent **plusieurs qualités/hosts du même titre** : aucun quota de flux ne coupe prématurément, toutes les sources répondantes livrent tout, et `finalizeStreams` (`src/core/stream.js`) trie à langue égale par qualité décroissante — **4K > 1080p > 720p > Auto (HLS) > Direct** (`qualityRank`, v3.1.11). Seule l'échéance douce (10 s) abrège : au-delà, si ≥ 1 flux pertinent existe déjà, les sites bloqués ne te retardent plus — et les chaînes internes des sources abandonnent d'elles-mêmes aux frontières de boucles (identique TV/Mobile). L'échéance reste sous le timeout de l'app car **Nuvio attend la réponse complète du plugin** (réglage app « Stream Selection Timeout ») : une réponse trop tardive s'affiche en erreur. Désactivable (`earlyExit=false` : tout attendre jusqu'au budget, comportement v2) et ajustable (`softMs`, tunable SCRAPER_SETTINGS 3-15 s).
3. **Dégradation gracieuse TV/Mobile** — un seul bundle : sur Mobile (timers présents) la course anti-blocage et le parallélisme s'appliquent ; sur TV (fetch synchrone) les tâches se sérialisent naturellement et le noyau passe en mode « requêtes minimales ».

## Sources

| Source | Mode | Contenu | Notes |
|---|---|---|---|
| **FStream** | recherche titre TMDB | films, séries VF/VOSTFR | DLE-CMS, domaines tournants auto-résolus |
| **French-Manga** | recherche titre TMDB | animes VOSTFR (VF) | spécialiste anime, numérotation absolue gérée |
| **BFlix** | direct par tmdbId | VO + sous-titres FR/EN | infaillible sur l'identité du contenu |
| **Papadustream** | direct par IMDb (TMDB→external_ids) | films/séries HLS multi-audio VF/VO | tokens signés, refresh automatique |
| **Webflix** | direct par tmdbId | MP4/HLS VF + VOSTFR via le flow Zenix réel (sources + play lang=vostfr) | FastFlux, Discovery (1 appel = tous les épisodes), Zenix, Frembed multi-domaines (.cyou/.bond/.site) |
| **FrenchStream** | direct par tmdbId (v3.1.9) | films/séries VF/VOSTFR | site le plus rapide mesuré (TTFB 0,29 s) — xfsearch `tagz f-/s-{tmdbId}` : zéro recherche de titre, `film_api` + `eps_*.txt` (même structure que French-Manga), hosts fsvid/vidzy/uqload |
| **WookaFR** | recherche titre TMDB (v3.1.9) | films/séries/animés VF + VOSTFR | thème Dooplay/somosmovies — embed lecteurvideo.com à sections de langue OD_FR/VFF/VFQ/VOSTFR, 10+ serveurs par fiche (xtremestream, uqload, vidmoly, veev…), nonce AJAX `getepisodes` |

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
| Sources activées | toutes | ids : `fstream, french-manga, bflix, papadustream, webflix, french-stream, wookafr` |
| Détecter les animés via TMDB | ON | routage par type de contenu |
| **Couper les sources bloquantes** | ON | tout afficher des sources réactives ; après 10 s (avec ≥ 1 flux), sites bloqués abandonnés ; OFF = tout attendre (v2) |
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
- v3.1.17 — **la chaîne de redirections fastflux n'écrase plus la sonde qualité** — diagnostic live (curl + sonde chronométrée) : l'URL de l'API fastflux (`cdn80.zen-blk.store/movies/Fall-2-HD-2026.mp4`) répond **302 → `falzey.lol/api/video_proxy.php` → 302 → URL signée `?ff=`** — 3 sauts, 3 handshakes TLS, **0,7 à 3,5 s mesurés depuis un datacenter** (médiane 1,9 s) pour 128 Ko. Le timeout qualité de 2,5 s (v3.1.16) avortait donc avant d'avoir lu le tkhd sur device → « Direct » AFFICHÉ malgré un buffer parfaitement lisible (le parsing, lui, était correct : le moov faststart de 6,3 Mo contient un tkhd 1280×692 à l'offset 160, retrouvé par le scan par signature → 720p). Correctifs : (1) le timeout de la sonde de résolution (`directMp4Quality`) passe à **6 s** — le budget du gouverneur global (25 s) et l'échéance douce (10 s) plafonnent toujours ; (2) **la chaîne n'est payée qu'UNE fois** : le goûtage qualité (sonde de vérification) et les requêtes suivantes (ciblage moov, suffix ranges de queue) partent de l'URL FINALE de la première réponse (`res.finalUrl` = URL signée, 1 saut ≈ 0,3 s au lieu de 3) ; (3) un timeout de NOTRE sonde (« timeout réseau ») devient **neutre** (« ? », lien conservé) — un timeout n'est pas une preuve de mort, et le bug live « FastFlux retiré après un sniff trop lent » est complètement fermé (v3.1.16 ne couvrait que le disjoncteur, pas le 1er probe). Le buffer RÉEL du CDN (131 072 octets captés live) est ajouté comme **fixture de régression** (`tests/fixtures/fastflux_fall2_head.bin` → 720p attendu).
- v3.1.16 — **la vraie qualité des MP4 direct webflix fixée à la résolution** — Fall 2 : le flux FastFlux restait étiqueté « Direct » alors que son fichier (`Fall-2-HD-2026.mp4`) est un 1280×720 : l'API répond `quality=Unknown`, l'URL ne porte aucun motif et la qualité ne devait qu'à la sonde de vérification (best-effort, budget partagé 8 s, échéance 4 s/flux — souvent coupée sur device avant d'avoir sniffé, alors qu'uqload/Nexus fixent la leur dès la résolution). Le moov/tkhd du conteneur est donc lu **dès la construction du flux** (GET Range 128 Ko + ciblage du moov, 2 × 2,5 s max, échec silencieux → « Direct » inchangé, jamais de libellé inventé — un hardcode « 720p » sur les URLs zen-blk aurait menti sur les fichiers 4K du même CDN). Ciblage chirurgical au passage : l'en-tête `mdat` du chunk de tête donne le début PILE du moov non faststart — le moov d'un long métrage dépasse 1 Mo (Fall 2 : 6,6 Mo) et les suffix ranges de queue 256 Ko/1 Mo n'atteignaient jamais le tkhd. Neutralité réparée dans la sonde : un arrêt par le disjoncteur (hôte en quarantaine — ex. sniff trop lent sous charge) ou le budget global n'est plus traité comme un lien mort (le MP4 HEAD retournait « KO injoignable » et retirait un lien que le lecteur pouvait lire).
- v3.1.9 — certains CDN servent le vrai média avec un content-type mensonger (`text/html`, ex. fastflux/zen-blk.store) : la sonde goûte les premiers octets avant de déclarer un lien mort — plus de fausses morts sur ces CDN.
- v3.1.10 + v3.1.12 — la qualité affichée des MP4 directs sans motif dans l'URL (fastflux…) est lue dans le `moov/tkhd` du conteneur : tête en GET Range 128 Ko (faststart), puis **sonde de queue** par suffix range 256 Ko → 1 Mo quand le moov est en FIN de fichier (non faststart, surtout 4K HEVC — le lecteur voyait 3840×2160 là où on affichait « Direct ») ; `mp4MaxHeight` retrouve le tkhd par signature même dans un chunk non aligné, filtrée anti faux positifs : un « tkhd » apparu par hasard dans du mdat (octets vidéo quelconques) ne fait plus afficher une résolution fantaisiste (cas réel : 1359p lu alors que le lecteur affichait 1280×720) — seules les hauteurs standard ± 8 px avec un ratio largeur/hauteur cohérent sont acceptées ; les crops cinémascope sont reclassés par la largeur comme le fait le lecteur (1920×800 → « 1080p », 1280×536 → « 720p ») au lieu de la hauteur brute (« 800p »). Échec silencieux → pas de libellé (on n'invente rien).
- v3.1.13 — **anti-écran-noir uqload** : ses masters HLS déclarent des pistes audio séparées (AAC Mono) alors que les variantes vidéo `index-vN-aN.m3u8` sont muxées avec une langue figée (anglais constaté) — certains lecteurs rendent l'audio séparé et n'affichent jamais la vidéo (son qui avance, écran noir). La sonde sert désormais directement la variante **muxée de la langue du flux** (VF → `a1` français, PMT vidéo+AAC vérifié live), validée par un fetch avant remplacement ; VOSTFR/VO gardent le master. Résolveur uqload durci : Referer dérivé du domaine de l'embed (les TLD tournent), détection des stubs de liens expirés (« File was deleted »…).
- v3.1.14 — **l'échange anti-écran-noir passe au niveau du résolveur** : sur le device, la sonde v3.1.13 dépendait du budget de vérification global (souvent épuisé sur TV — 8 s partagés entre tous les flux, 10 premiers liens seulement) → le master multi-pistes repartait tel quel au lecteur (audio seul + écran noir revenu). La langue du flux (`vf`/`vostfr`/`vo`) est désormais **passée aux extracteurs** et le résolveur uqload choisit lui-même la variante muxée de la langue (fetch master + fetch de validation de la variante, ~0,5 s, indépendants de tout budget de sonde) ; la qualité réelle (RESOLUTION du master) est aussi remontée dès la résolution (« 1080p » au lieu de « Auto (HLS) », meilleur tri). Mappage durci côté master : `LANGUAGE` régional (`fr-FR`, `fr-CA`) réduit à `fr`, repli `NAME="Français"/"French"`. Master conservé au moindre doute (langue non VF, variante injoignable, motif inattendu) — la sonde v3.1.13 reste le filet.
- v3.1.15 — **Webflix : la voie qualité (lecteur « Nexus »)** — Fall 2 : Deadpoint ne montrait qu'une seule entrée « 720p » (FastFlux MP4) alors que le site sert mieux. Deux causes corrigées : (1) le retour anticipé du chemin direct coupait les films après FastFlux — le lecteur **Nexus** du site (`/api/player-embed/nexus-path` → 302 `api.moviez.ac` → jeton `window.P2` 15 min → POST `/api/v2/stream`) n'était simplement pas implémenté et sert un **master HLS multi-variantes jusqu'à 1080p AVC** (vérifié live : 664×360 / 1328×720 / 1920×1040, tout `avc1` — le labellisé réel « 1080p » se classe donc devant le 720p FastFlux) ; le master VF déclare les mêmes pistes audio séparées que les embeds uqload → même remède v3.1.14 (variante muxée française servie dès la résolution), le master VOSTFR (autre upload, muxé simple) est conservé tel quel ; (2) un profil préférant la VOSTFR restait **sans aucun flux webflix en film** (le VF direct poussé était filtré par la langue) — le Nexus VOSTFR est tenté dans ce cas. Zenix (H.265 affiché « écran noir » par le site lui-même, page Livewire non extractible) et Frembed (redirigé vers une SPA Next.js) restent hors de portée statique — la voie mesurée la plus rapide est gardée pour le chemin direct VF.
- v3.1.10 — la langue de BFlix est déduite des pistes audio du master HLS, sinon de la langue originale TMDB : un titre français original (Lupin…) est étiqueté VF et sert aussi en VF exclusive. L'audio d'un dub français en piste secondaire n'est pas garanti côté lecteur.
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
- **Test des liens** (réglage « Tester les liens avant affichage », activé par défaut) : HLS en GET de la playlist, MP4 en HEAD, avec les en-têtes du flux, 8 s au maximum, sonde approfondie (variante + 1er segment) sur les 8 premiers liens. Les liens prouvés morts (403/404, page HTML, segment refusé) sont **retirés** de la liste — plus de panneau « lien ne fonctionne pas » sur un lien affiché ; les liens « inconnus » (sonde interrompue, HEAD 405) restent affichés. La famille vidzy/luluvid/premium reste marquée ⚠ en fin de liste (TLS Chrome non imitable par le lecteur natif), le CDN tnmr.org (luluvid) est rejeté d'office.
- **Logs** : chaque flux final est journalisé (`[stream] nom | qualité | langue | url | headers=…`) ; lance l'app depuis un terminal pour les voir, puis teste le lien avec `mpv --http-header-fields="Referer: …" "<url>"`.

## Mode diagnostic (activé par défaut jusqu'à nouvel ordre)

Deux flux de test (`TEST HLS`, `TEST MP4`) apparaissent en tête de liste et chaque nom de flux porte le domaine du lien (`@domaine`).
**Pour le désactiver** : Nuvio → Settings → Plugins → Fluxio → réglages → désactiver « Mode diagnostic ». Ou, sur NuvioTV : `SCRAPER_SETTINGS.selfTest = false`.
Pense à le désactiver (ou à repasser `defaultValue` et `boolOr(s.selfTest, …)` à `false`) avant de publier le plugin à d'autres.
