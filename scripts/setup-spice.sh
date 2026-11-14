#!/usr/bin/env bash
# Fetch CSPICE (NAIF toolkit N0067) and the SPICE kernels used by the science service.
# Explicit, one-time setup: nothing is downloaded at build or run time. ~88 MB in total.
#
#   scripts/setup-spice.sh            # CSPICE + kernels
#   scripts/setup-spice.sh --kernels  # kernels only (e.g. CSPICE already installed elsewhere)
#
# CSPICE   -> services/science/third_party/cspice/   (git-ignored; CMake finds it there)
# Kernels  -> data/kernels/ + SHA256SUMS             (git-ignored; set SELENE_KERNEL_DIR to it)
#
# Every file is checked against the SHA-256 below. NAIF publishes no checksums for these files:
# the hashes were recorded from the NAIF server on 2026-11-15 (see data/README.md). A mismatch
# means NAIF replaced the file or the download is corrupt: stop and re-validate, do not edit the hash.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAIF="https://naif.jpl.nasa.gov/pub/naif"
KDIR="$ROOT/data/kernels"
CDIR="$ROOT/services/science/third_party"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

fetch() {  # url dest sha256
  local url="$1" dest="$2" want="$3"
  if [ -f "$dest" ] && [ "$(sha256 "$dest")" = "$want" ]; then echo "ok      $(basename "$dest")"; return; fi
  echo "fetch   $url"
  curl -fSL --retry 3 -o "$dest.part" "$url"
  local got; got="$(sha256 "$dest.part")"
  if [ "$got" != "$want" ]; then
    rm -f "$dest.part"
    echo "SHA-256 mismatch for $(basename "$dest"): expected $want, got $got" >&2
    exit 1
  fi
  mv "$dest.part" "$dest"
}

# --- kernels (same set as the team's calcul_positions.py / test_validation_lunar_mission.py) ---
mkdir -p "$KDIR"
KERNELS=(
  "lsk/naif0012.tls 678e32bdb5a744117a467cd9601cd6b373f0e9bc9bbde1371d5eee39600a039b"
  "spk/planets/de440s.bsp c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2"
  "pck/pck00011.tpc 3dff7b1dbeceaa01f25467767d3fa25816051c85d162d1edf04acb310ee28bb1"
  "pck/moon_pa_de440_200625.bpc 60cd55aa401ea2ea97360636f567554bfe4e37bb829f901b4460a455dfaf783f"
  "fk/satellites/moon_de440_250416.tf a47c71e9c9f33796bdafb2c9d69a7ee447b6016ecad80f71cd6f3e479f9cf768"
)
: > "$KDIR/SHA256SUMS.part"
for k in "${KERNELS[@]}"; do
  set -- $k
  fetch "$NAIF/generic_kernels/$1" "$KDIR/$(basename "$1")" "$2"
  echo "$2  $(basename "$1")" >> "$KDIR/SHA256SUMS.part"
done
mv "$KDIR/SHA256SUMS.part" "$KDIR/SHA256SUMS"

[ "${1:-}" = "--kernels" ] && { echo "kernels in $KDIR"; exit 0; }

# --- CSPICE toolkit (prebuilt static library for this platform) ---
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  PLAT=MacM1_OSX_clang_64bit;  CSUM=0deae048443e11ca4d093cac651d9785d4f2594631a183d85a3d58949f4d0aa9 ;;
  *)
    echo "No recorded CSPICE checksum for $(uname -s)-$(uname -m)." >&2
    echo "Download cspice.tar.Z for your platform from $NAIF/toolkit/C/, verify it, and extract it" >&2
    echo "so that $CDIR/cspice/lib/cspice.a exists (or pass -DSELENE_CSPICE_DIR=... to CMake)." >&2
    exit 1 ;;
esac
mkdir -p "$CDIR"
fetch "$NAIF/toolkit/C/$PLAT/packages/cspice.tar.Z" "$CDIR/cspice.tar.Z" "$CSUM"
rm -rf "$CDIR/cspice"
tar -xf "$CDIR/cspice.tar.Z" -C "$CDIR"
[ -f "$CDIR/cspice/lib/cspice.a" ] && [ -f "$CDIR/cspice/include/SpiceUsr.h" ] || { echo "unexpected CSPICE layout" >&2; exit 1; }
echo "CSPICE in $CDIR/cspice. Reconfigure: cmake -S services/science -B services/science/build"
echo "Run with: SELENE_KERNEL_DIR=$KDIR"
