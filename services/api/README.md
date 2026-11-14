# Lunar Landing — back

API Rust (axum) qui reçoit un site lunaire, valide les données, puis exécute en parallèle les programmes de calcul C++ du profil demandé. Chaque résultat est renvoyé dès qu'il est prêt en NDJSON (une ligne JSON par message).

## Prérequis

- Docker (buildx recommandé : `docker-buildx`)

## Mise en place

1. Créer la configuration des profils :
   ```sh
   cp config/profiles.json.example config/profiles.json
   ```
2. Construire l'image :
   ```sh
   docker build -t lunar-landing .
   ```
3. Lancer le conteneur :
   ```sh
   docker run --rm -p 3000:3000 \
     -v "$PWD/config/profiles.json:/etc/lunar-landing/profiles.json:ro" \
     lunar-landing
   ```

Le serveur refuse de démarrer si la configuration est invalide et affiche la cause.

## Configuration des profils

`config/profiles.json` associe chaque profil à la liste des programmes exécutés en parallèle :

```json
{
  "default": "min",
  "profiles": {
    "min": ["calc-planete"],
    "basic": ["calc-planete", "calc-radio"]
  }
}
```

- `default` : profil utilisé quand la requête n'en précise pas.
- Les noms sont ceux des exécutables compilés, cherchés dans `SCRIPTS_DIR`. Pas de `/` ni de `..`.
- Le fichier n'est pas versionné : chaque déploiement a le sien, monté en lecture seule. Le front choisit seulement un nom de profil.
- Toute modification demande un redémarrage du conteneur.

Vérifications au démarrage : profil par défaut défini, aucun profil vide, chaque exécutable présent.

### Variables d'environnement

| Variable        | Défaut                             | Rôle                              |
| --------------- | ---------------------------------- | --------------------------------- |
| `PROFILES_FILE` | `/etc/lunar-landing/profiles.json` | chemin du fichier de profils      |
| `SCRIPTS_DIR`   | `/usr/local/lib/lunar-landing`     | dossier des programmes de calcul  |

## Programmes de calcul

`calc-planete` et `calc-radio` sont pour l'instant des simulateurs : `simulation/simulate.cpp` (3 s) et `simulation/simulate-slow.c` (4 s), sortie fixe. Pour brancher un vrai programme : le compiler dans le `Dockerfile` et le copier dans `/usr/local/lib/lunar-landing/<nom>`.

Contrat entre le back et un programme :

- Entrée : trois arguments `<lat> <lon> <height>` — latitude et longitude signées (sud et ouest négatifs), déjà validées par le back.
- Succès : un objet JSON sur stdout, code de sortie 0.
- Échec : code de sortie non nul, message sur stderr.

## API

### `GET /api/v1/health`

```json
{"status":"ok"}
```

### `POST /api/v1/site`

Corps (`Content-Type: application/json`) :

```json
{"lat":89.5,"ns":"S","lon":45,"ew":"E","height":2,"profile":"basic"}
```

- `lat` : 0 à 90, `ns` : `N` ou `S`
- `lon` : 0 à 180, `ew` : `E` ou `W`
- `height` : nombre
- `profile` : facultatif

Réponse (`application/x-ndjson`), une ligne par message :

```
{"type":"received","data":{"query":{...},"profile":"basic","steps":["calc-planete","calc-radio"]}}
{"type":"result","data":{"step":"calc-planete","output":{...}}}
{"type":"result","data":{"step":"calc-radio","output":{...}}}
{"type":"done"}
```

Un programme en échec produit `{"type":"error","data":{"step":"...","message":"..."}}` ; les autres ne sont pas affectés. Les lignes `result` et `error` arrivent dans l'ordre de fin des programmes, pas dans l'ordre du profil.

Erreurs avant le flux, au format `{"error":"..."}` :

- 400 : JSON mal formé
- 415 : `Content-Type` absent
- 422 : champ manquant, valeur hors limites ou profil inconnu

## Tests

```sh
curl localhost:3000/api/v1/health
curl -N -X POST localhost:3000/api/v1/site -H 'Content-Type: application/json' \
  -d '{"lat":89.5,"ns":"S","lon":45,"ew":"E","height":2,"profile":"basic"}'
```

`-N` désactive le tampon de curl : chaque ligne doit apparaître dès qu'elle est envoyée.
