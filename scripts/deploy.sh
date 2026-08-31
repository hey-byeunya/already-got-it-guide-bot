#!/usr/bin/env bash
# 두 앱을 한 번에 GitHub Pages 로 올린다.
#
#   bash scripts/deploy.sh            # 무엇을 올릴지 보여 주고 멈춘다
#   bash scripts/deploy.sh --push     # 실제로 올린다
#
#   /       ← support-bot (고객센터)   고객용이 주소의 주인이다
#   /dev/   ← dev-bot (개발자용)       먼저 만든 것은 하위로 물러난다
#
# Vite 의 base: './' 덕분에 하위 경로에서도 자산을 찾는다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.deploy"
REMOTE="$(git -C "$ROOT" remote get-url origin)"

echo "빌드 — support-bot"
(cd "$ROOT/support-bot/app" && npm run build >/dev/null)
echo "빌드 — dev-bot"
(cd "$ROOT/dev-bot/app" && npm run build >/dev/null)

rm -rf "$OUT"
cp -R "$ROOT/support-bot/app/dist" "$OUT"
rm -rf "$OUT/.git"
mkdir -p "$OUT/dev"
cp -R "$ROOT/dev-bot/app/dist/." "$OUT/dev/"
rm -rf "$OUT/dev/.git"

# 벡터스토어가 실제로 실려 있는지 확인한다. 없으면 배포된 페이지가
# 질문을 받고도 아무 도움말을 못 찾는다 — 열어 보기 전에는 모른다.
for f in "$OUT/help-docs.json" "$OUT/dev/already-got-it-docs.json"; do
  [ -s "$f" ] || { echo "멈춤: $f 가 없다. 벡터스토어를 먼저 만든다"; exit 1; }
done

echo
echo "올릴 것 ($OUT):"
du -sh "$OUT" | sed 's/^/  /'
echo "  고객센터 : $(du -h "$OUT/help-docs.json" | cut -f1) 도움말 $(python3 -c "import json;print(len(json.load(open('$OUT/help-docs.json'))))")개"
echo "  개발자용 : /dev/"

if [ "${1:-}" != "--push" ]; then
  echo
  echo "실제로 올리려면: bash scripts/deploy.sh --push"
  exit 0
fi

cd "$OUT"
git init -q
git checkout -q -b gh-pages
git add -A
git -c user.email="$(git -C "$ROOT" config user.email)" \
    -c user.name="$(git -C "$ROOT" config user.name)" \
    commit -q -m "배포: 고객센터(/) + 개발자용(/dev/) — $(date +%Y-%m-%d_%H%M)"
git remote add origin "$REMOTE"
git push -q --force origin gh-pages
echo
echo "올렸습니다."
echo "  고객센터 : https://hey-byeunya.github.io/already-got-it-guide-bot/"
echo "  개발자용 : https://hey-byeunya.github.io/already-got-it-guide-bot/dev/"
