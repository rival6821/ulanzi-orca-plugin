#!/usr/bin/env bash
# 배포용 zip을 dist/에 만든다 (ws 포함, 바로 Plugins 폴더에 넣을 수 있는 형태).
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="com.ulanzi.orcasessions.ulanziPlugin"
VERSION=$(node -p "require('./$NAME/manifest.json').Version")
npm --prefix "$NAME" ci --omit=dev

mkdir -p dist
OUT="dist/orca-sessions-ulanziPlugin-$VERSION.zip"
rm -f "$OUT"
zip -qr "$OUT" "$NAME" -x '*.DS_Store'
echo "만들어짐: $OUT"
