# Lune 3D — explorateur statique

Site statique (HTML/CSS/JS vanilla, modules ES, sans bundler) : la Lune en 3D avec, au survol,
latitude, longitude, altitude LOLA et formation IAU la plus proche.

> Outil de visualisation. Il ne calcule ni éphémérides ni éclairage réel : le « Soleil » est une
> lumière directionnelle fixe et illustrative.

## Arborescence

```
apps/moon-explorer/
├── index.html            page + importmap (three@0.170.0, geotiff@2.1.3 via jsDelivr)
├── css/style.css
├── js/
│   ├── main.js           démarrage, qualité, chargement, interactions, CustomEvent
│   ├── globe.js          scène three.js, displacement/bump, grille, marqueurs, pointage
│   ├── loaders.js        fetch avec progression, décodage TIFF (geotiff.js)
│   ├── heightmap.js      raster d'altitude CPU (pur, testé)
│   ├── features.js       index spatial + recherche des formations (pur, testé)
│   └── geo.js            conversions UV ↔ lat/lon, haversine, formatage (pur, testé)
├── scripts/build_features.py   gazetteer IAU (shapefile .zip ou CSV) → data/features.json
├── setup.sh              téléchargement + conversion des données
├── tests/core.test.mjs   node --test, sans dépendance
├── deploy/nginx.conf     exemple Nginx
├── _headers              en-têtes Cloudflare Pages
└── data/                 (git-ignoré) ldem_4.tif, ldem_16.tif, moon_color.jpg, features.json
```

## Installation et test local

```bash
cd apps/moon-explorer
./setup.sh                 # ~85 Mo téléchargés ; ./setup.sh --light pour sauter ldem_16
python3 -m http.server 8000
# ouvrir http://localhost:8000          (relief auto : ldem_16 sur ordinateur, ldem_4 sur mobile)
# forcer :  http://localhost:8000/?dem=4   ou   ?dem=16
npm test                   # tests unitaires (Node ≥ 20, aucune installation npm)
```

`setup.sh` utilise `wget` (repli sur `curl`), convertit la couleur avec ImageMagick
(repli : `gdal_translate`, puis `sips` sur macOS) et lance Python 3.11+ (bibliothèque standard
uniquement). Il écrit les empreintes SHA-256 dans `data/SHA256SUMS`.

Pour tester sur mobile en réseau local : `python3 -m http.server 8000 --bind 0.0.0.0`, puis
ouvrir `http://<IP-du-poste>:8000/` (sans HTTPS, la copie dans le presse-papiers retombe sur
un champ texte sélectionné).

## Données et écarts avec la demande initiale

| Fichier | Source | Remarque |
|---|---|---|
| `ldem_4.tif`, `ldem_16.tif` | [NASA SVS CGI Moon Kit](https://svs.gsfc.nasa.gov/4720), LOLA | Noms inchangés. **Ce sont des TIFF float32 simples, pas des GeoTIFF** (aucune GeoKey) : le géoréférencement (ligne 0 = +90°, colonne 0 = −180°, pixels « area ») vient de la doc SVS et a été vérifié (point culminant à 5,4° N 158,6° O, +10,6 km ; minimum dans Antoniadi, ≈ 70° S 172° O). Valeurs en km relatives à 1737,4 km. |
| `moon_color.jpg` | `lroc_color_poles_4k.tif` (LROC WAC) | Nom inchangé. 4096×2048, converti en JPEG qualité 90 (~2 Mo). |
| `features.json` | [IAU/USGS Gazetteer](https://planetarynames.wr.usgs.gov) | **Il n'existe pas d'URL CSV téléchargeable par script** : le bouton « CSV » de la page de résultats génère le fichier dans le navigateur. `setup.sh` utilise donc le shapefile officiel `MOON_nomenclature_center_pts.zip` (page *GIS Downloads*) et lit sa table `.dbf`. Un CSV exporté à la main reste accepté : `python3 -I scripts/build_features.py export.csv data/features.json`. Longitudes 0–360° E converties en [−180, 180), formations « Dropped » exclues. |

Crédits : NASA's Scientific Visualization Studio (CGI Moon Kit, données LRO LROC/LOLA) ;
Gazetteer of Planetary Nomenclature, IAU WGPSN / USGS Astrogeology. Citez ces sources si le
site est publié.

## Conventions et limites

- **Repère** : latitude planétocentrique, longitude positive vers l'est dans [−180, 180).
  LOLA et le gazetteer sont supposés exprimés dans le même repère lunaire (Mean Earth / Polar
  Axis) ; non revérifié à l'échelle sub-kilométrique.
- **Altitude** : relative à une sphère de 1737,4 km (pas un géoïde, pas une altitude
  au-dessus du terrain local). Interpolation bilinéaire, alignée sur le filtrage GPU.
  Résolution : ≈ 7,6 km/px (ldem_4) ou ≈ 1,9 km/px (ldem_16) à l'équateur.
- **Formation affichée** : celle dont le centre est le plus proche, parmi celles dont le cercle
  (diamètre IAU / 2) contient le point. Les contours réels ne sont pas circulaires.
- **Pointage** : sans affinage, le rayon est intersecté avec la sphère *non déplacée* ; avec
  une forte exagération le point lu peut alors être décalé par rapport au relief visible
  (avertissement affiché dans le panneau). Avec « Pointage sur le relief affiché » (par
  défaut), une marche de rayon sur le raster CPU suit le relief à la résolution du maillage près.
  La sphère est intersectée analytiquement (O(1)) plutôt que via `Raycaster` sur les ~500 k
  triangles du mesh ; pour la sphère non déplacée le résultat est identique, et
  lon = u·360 − 180, lat = v·180 − 90 sont appliquées sur l'UV du point.
- **Pôles** : la longitude est affichée « — » à moins de 1e-4° d'un pôle ; l'index spatial
  inspecte toutes les colonnes près des pôles.
- **Mémoire** : le TIFF est téléchargé, décodé en un `Float32Array`, puis le tampon brut est
  relâché. Les lignes sont inversées *en place* et le même tableau sert à la `DataTexture`
  (displacement + bump) et aux lectures d'altitude : une seule copie CPU en régime permanent
  (le GPU a la sienne). Pic transitoire ≈ 2× au décodage. Changer de qualité recharge la page.
- Si la carte graphique ne prend pas en charge les textures de 5760 px, ldem_4 est utilisé
  automatiquement. Sans `OES_texture_float_linear`, le relief est échantillonné en « nearest ».

## Événements pour le reste du site

Émis sur `#globe`, avec `bubbles: true` :

```js
document.addEventListener('moonhover', (e) => console.log(e.detail));
document.addEventListener('moonclick', (e) => {
  const { lat, lon, altM, feature } = e.detail;
  // feature : null ou { name, type, diameterKm, lat, lon, distanceKm }
});
```

Interactions : survol à la souris, clic = marqueur. Sur écran tactile : tap = survol
(infobulle), appui long = marqueur + `moonclick`.

## Déploiement

Tout est statique : déposez le contenu de `apps/moon-explorer/` (avec `data/` généré par
`setup.sh`) sur n'importe quel hébergeur de fichiers. Les fichiers de `data/` ne changent pas
de contenu sans changer de nom : on peut les mettre en cache longtemps. `index.html`, `js/` et
`css/` ne sont pas versionnés par nom : cache court avec revalidation.

### Nginx

Voir [`deploy/nginx.conf`](deploy/nginx.conf) :

- `data/*.tif` : `Cache-Control: public, max-age=31536000, immutable`, compression gzip activée
  pour `image/tiff` (le TIFF float non compressé se compresse bien) ;
- `data/*.jpg` : même cache, pas de gzip (JPEG déjà compressé) ;
- `features.json` : cache 1 jour + gzip ;
- HTML/JS/CSS : `no-cache` (revalidation via ETag).

`loaders.js` désactive la barre de progression précise quand la réponse est compressée
(`Content-Encoding` présent) : la progression reste correcte mais devient indéterminée.

### Cloudflare Pages

1. Déposez le dossier (par exemple `npx wrangler pages deploy apps/moon-explorer`, ou un dépôt Git
   avec ce dossier comme racine de build et aucune commande de build).
2. Le fichier [`_headers`](_headers) est pris en compte automatiquement.
3. **Limite : 25 Mio par fichier sur Pages.** `ldem_16.tif` (63 Mio) dépasse cette limite ;
   hébergez-le sur R2 (ou un autre stockage) avec CORS autorisé pour votre domaine, et
   renseignez son URL dans `js/main.js` (`DEM_BASE`), ou déployez en `--light` (ldem_4 uniquement).
