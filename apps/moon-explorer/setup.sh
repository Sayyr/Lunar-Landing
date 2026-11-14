#!/usr/bin/env bash
# setup.sh — télécharge et prépare les données NASA / IAU dans ./data (non versionnées).
#
# Usage : ./setup.sh            # ldem_4 + ldem_16 + couleur 4k + noms
#         ./setup.sh --light    # sans ldem_16 (66 Mo)
#
# Rien n'est téléchargé à l'exécution du site : seul ce script, lancé explicitement, accède
# au réseau. Les fichiers déjà présents ne sont pas retéléchargés.
set -euo pipefail

cd "$(dirname "$0")"
HERE="$(pwd)"
DATA="$HERE/data"
RAW="$DATA/raw"           # téléchargements bruts (non servis par le site)
mkdir -p "$RAW"

SVS="https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720"
IAU="https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip"

LIGHT=0
[[ "${1:-}" == "--light" ]] && LIGHT=1

# Tailles relevées le 2026-11-14 (Content-Length du serveur SVS) : contrôle d'intégrité simple.
# (fonction plutôt que tableau associatif : bash 3.2 de macOS n'a pas `declare -A`)
expected_size() {
  case "$1" in
    lroc_color_poles_4k.tif) echo 13095388 ;;
    ldem_4.tif) echo 4153352 ;;
    ldem_16.tif) echo 66378634 ;;
  esac
}

fetch() { # fetch URL DEST
  if command -v wget >/dev/null; then
    wget -q --show-progress -O "$2.part" "$1"
  else
    echo "  (wget absent : utilisation de curl)"
    curl -fL --progress-bar -o "$2.part" "$1"
  fi
  mv "$2.part" "$2"
}

filesize() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1"; }

get_svs() { # get_svs NOM DEST
  local name="$1" dest="$2"
  if [[ -f "$dest" ]]; then echo "✓ $name déjà présent"; return; fi
  echo "↓ $name"
  fetch "$SVS/$name" "$dest"
  local want; want="$(expected_size "$name")"
  local got; got="$(filesize "$dest")"
  if [[ -n "$want" && "$got" != "$want" ]]; then
    echo "⚠ $name : $got octets (attendu $want). Le fichier a peut-être changé sur le serveur SVS ;"
    echo "  vérifiez https://svs.gsfc.nasa.gov/4720 avant de l'utiliser."
  fi
}

# 1. Altitude LOLA (TIFF float32, km relatifs à 1737,4 km) — servie telle quelle.
get_svs ldem_4.tif "$DATA/ldem_4.tif"
if [[ $LIGHT == 0 ]]; then get_svs ldem_16.tif "$DATA/ldem_16.tif"; fi

# 2. Couleur LROC WAC 4k → JPEG.
get_svs lroc_color_poles_4k.tif "$RAW/lroc_color_poles_4k.tif"
if [[ ! -f "$DATA/moon_color.jpg" ]]; then
  echo "⚙ conversion couleur → moon_color.jpg"
  SRC="$RAW/lroc_color_poles_4k.tif"; OUT="$DATA/moon_color.jpg"
  if command -v magick >/dev/null; then
    magick "$SRC" -depth 8 -quality 90 -interlace JPEG "$OUT"
  elif command -v convert >/dev/null; then
    convert "$SRC" -depth 8 -quality 90 -interlace JPEG "$OUT"
  elif command -v gdal_translate >/dev/null; then
    gdal_translate -q -of JPEG -ot Byte -co QUALITY=90 "$SRC" "$OUT"
    rm -f "$OUT.aux.xml"
  elif command -v sips >/dev/null; then   # macOS, sans dépendance
    sips -s format jpeg -s formatOptions 90 "$SRC" --out "$OUT" >/dev/null
  else
    echo "✗ ImageMagick, GDAL ou sips requis pour convertir la couleur." >&2; exit 1
  fi
fi

# 3. Noms IAU : shapefile officiel → JSON léger.
#    (L'export « CSV » du site USGS est généré dans le navigateur, sans URL directe ;
#     un CSV exporté à la main est aussi accepté : python3 -I scripts/build_features.py fichier.csv data/features.json)
if [[ ! -f "$DATA/features.json" ]]; then
  echo "↓ gazetteer IAU (Lune)"
  fetch "$IAU" "$RAW/MOON_nomenclature_center_pts.zip"
  # -I : mode isolé, n'importe rien depuis le dossier des données téléchargées.
  python3 -I "$HERE/scripts/build_features.py" "$RAW/MOON_nomenclature_center_pts.zip" "$DATA/features.json"
fi

# 4. Empreintes (à reporter dans data/README.md pour la traçabilité).
echo "⚙ SHA-256 → data/SHA256SUMS"
( cd "$DATA" && shasum -a 256 ./*.tif ./*.jpg ./*.json raw/* 2>/dev/null > SHA256SUMS || true )

echo
ls -lh "$DATA" | sed 1d
echo
echo "Terminé. Test local :  cd $(basename "$HERE") && python3 -m http.server 8000"
