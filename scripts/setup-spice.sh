#!/usr/bin/env bash
# Fetch CSPICE (NAIF toolkit N0067) and the SPICE kernels used by the science service.
# Explicit, one-time setup: nothing is downloaded at build or run time. ~88 MB in total.
#
#   scripts/setup-spice.sh            # CSPICE + kernels
#   scripts/setup-spice.sh --kernels  # kernels only (e.g. for the Docker volume, or CSPICE installed elsewhere)
#   scripts/setup-spice.sh --cspice   # CSPICE only (used by services/science/Dockerfile)
#
# CSPICE   -> services/science/third_party/cspice/   (git-ignored; CMake finds it there)
# Kernels  -> data/kernels/ + SHA256SUMS             (git-ignored; set SELENE_KERNEL_DIR to it)
#
# Platforms (bash: macOS, Linux, Git Bash/MSYS2 on Windows):
#   macOS arm64 / x86_64, Linux x86_64 : NAIF's prebuilt lib/cspice.a is linked.
#   Linux arm64 (e.g. Docker on Apple Silicon), Windows : NAIF ships no usable prebuilt library;
#     the package's sources are kept and CMake compiles CSPICE (about 20 s to 2 min, once).
#
# Every file is checked against the SHA-256 below. NAIF publishes no checksums for these files:
# the hashes were recorded from the NAIF server on 2026-11-15 (see data/README.md). A mismatch
# means NAIF replaced the file or the download is corrupt: stop and re-validate, do not edit the hash.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-all}"
case "$MODE" in all|--kernels|--cspice) ;; *) echo "usage: $0 [--kernels|--cspice]" >&2; exit 2 ;; esac
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
if [ "$MODE" != "--cspice" ]; then
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
echo "kernels in $KDIR"
fi
[ "$MODE" = "--kernels" ] && exit 0

# --- CSPICE toolkit N0067 ---
# PKG = NAIF package; SOURCE_ONLY = 1 when its prebuilt library cannot be linked here (wrong CPU
# or compiler), so it is removed and CMake builds CSPICE from the package's sources.
SOURCE_ONLY=0
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)   PKG=MacM1_OSX_clang_64bit/packages/cspice.tar.Z;    CSUM=0deae048443e11ca4d093cac651d9785d4f2594631a183d85a3d58949f4d0aa9 ;;
  Darwin-x86_64)  PKG=MacIntel_OSX_AppleC_64bit/packages/cspice.tar.Z; CSUM=6f4980445fee4d363dbce6f571819f4a248358d2c1bebca47e0743eedfe9935e ;;
  Linux-x86_64)   PKG=PC_Linux_GCC_64bit/packages/cspice.tar.Z;        CSUM=60a95b51a6472f1afe7e40d77ebdee43c12bb5b8823676ccc74692ddfede06ce ;;
  Linux-aarch64|Linux-arm64)
                  PKG=PC_Linux_GCC_64bit/packages/cspice.tar.Z;        CSUM=60a95b51a6472f1afe7e40d77ebdee43c12bb5b8823676ccc74692ddfede06ce; SOURCE_ONLY=1 ;;
  MINGW64*-x86_64|MSYS*-x86_64|CYGWIN*-x86_64)
                  PKG=PC_Windows_VisualC_64bit/packages/cspice.zip;    CSUM=98d60b814b412fa55294aeaaeb7dab46d849cc87a8b709ffe835d08de17625dc; SOURCE_ONLY=1 ;;
  *)
    echo "No CSPICE package recorded for $(uname -s)-$(uname -m)." >&2
    echo "Get one from $NAIF/toolkit/C/, verify it, extract it to $CDIR/cspice (CMake compiles" >&2
    echo "src/cspice if lib/cspice.a is unusable), or pass -DSELENE_CSPICE_DIR=... to CMake." >&2
    exit 1 ;;
esac
mkdir -p "$CDIR"
ARCHIVE="$CDIR/$(basename "$PKG")"
fetch "$NAIF/toolkit/C/$PKG" "$ARCHIVE" "$CSUM"
rm -rf "$CDIR/cspice"
case "$ARCHIVE" in
  *.zip)
    if command -v unzip >/dev/null; then unzip -q "$ARCHIVE" -d "$CDIR"
    else powershell.exe -NoProfile -Command "Expand-Archive -LiteralPath '$(cygpath -w "$ARCHIVE")' -DestinationPath '$(cygpath -w "$CDIR")'"; fi ;;
  *) tar -xf "$ARCHIVE" -C "$CDIR" ;;
esac
[ -f "$CDIR/cspice/include/SpiceUsr.h" ] && [ -f "$CDIR/cspice/src/cspice/spkcpo_c.c" ] || { echo "unexpected CSPICE layout" >&2; exit 1; }
if [ "$SOURCE_ONLY" = 1 ]; then
  rm -f "$CDIR/cspice/lib/"*.a "$CDIR/cspice/lib/"*.lib
  echo "CSPICE sources in $CDIR/cspice (no prebuilt library for this platform: CMake compiles them)."
else
  echo "CSPICE in $CDIR/cspice (prebuilt lib/cspice.a)."
fi
echo "Reconfigure: cmake -S services/science -B services/science/build"
[ "$MODE" = "all" ] && echo "Run with: SELENE_KERNEL_DIR=$KDIR"
exit 0
