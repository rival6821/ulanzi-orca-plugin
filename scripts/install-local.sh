#!/usr/bin/env bash
# 플러그인을 이 Mac의 Ulanzi Studio 플러그인 폴더에 복사한다.
# 사용: npm run install:local   (끝나면 Ulanzi Studio를 재시작)
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="com.ulanzi.orcasessions.ulanziPlugin"
DEST_DIR="$HOME/Library/Application Support/Ulanzi/UlanziDeck/Plugins"

if [ ! -d "$NAME/node_modules/ws" ] || [ ! -d "$NAME/node_modules/gifenc" ] || [ ! -d "$NAME/node_modules/@resvg/resvg-wasm" ]; then
  echo "의존성 설치 중…"
  npm --prefix "$NAME" ci --omit=dev
fi

mkdir -p "$DEST_DIR"
rm -rf "$DEST_DIR/$NAME"
cp -R "$NAME" "$DEST_DIR/"
echo "설치됨: $DEST_DIR/$NAME"
echo "Ulanzi Studio를 완전히 종료했다가 다시 열어 주세요."
