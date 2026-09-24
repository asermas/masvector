#!/usr/bin/env bash
# Windows paketi için poppler (pdftocairo/pdftoppm/pdfinfo) indir → vendor/poppler-win
# Yalnız bu üç aracın içe aktardığı DLL'ler tutulur (≈59 MB yerine ≈140 MB).
set -euo pipefail
VER="${POPPLER_WIN_VERSION:-26.09.0-0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/poppler-win"
[ -x "$DEST/bin/pdftocairo.exe" ] || [ -f "$DEST/bin/pdftocairo.exe" ] && { echo "poppler-win mevcut: $DEST"; exit 0; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/p.zip" "https://github.com/oschwartz10612/poppler-windows/releases/download/v$VER/Release-$VER.zip"
unzip -q "$TMP/p.zip" -d "$TMP/x"
SRC="$(ls -d "$TMP"/x/poppler-*)"
rm -rf "$DEST"; mkdir -p "$DEST/etc/fonts"
mv "$SRC/Library/bin" "$DEST/bin"; mv "$SRC/share" "$DEST/share"
cp "$ROOT/scripts/poppler-fonts.conf" "$DEST/etc/fonts/fonts.conf"
cd "$DEST/bin"
python3 - <<'PY'
import os, re, subprocess
have = {f.lower(): f for f in os.listdir('.')}
need, stack = set(), ['pdftocairo.exe', 'pdftoppm.exe', 'pdfinfo.exe']
while stack:
    f = stack.pop()
    if f.lower() in need: continue
    need.add(f.lower())
    out = subprocess.run(['objdump', '-p', have[f.lower()]], capture_output=True, text=True).stdout
    stack += [d for d in re.findall(r'DLL Name: (\S+)', out) if d.lower() in have]
for k, f in have.items():
    if k not in need: os.remove(f)
PY
printf 'Poppler %s Windows x64 (conda-forge tabanlı)\nKaynak: https://github.com/oschwartz10612/poppler-windows/releases/tag/v%s\nLisans: GPL-2.0-or-later (poppler); bağımlılıklar kendi lisanslarıyla.\n' "$VER" "$VER" > "$DEST/KAYNAK.txt"
echo "poppler-win hazır: $(du -sh "$DEST" | cut -f1)"
