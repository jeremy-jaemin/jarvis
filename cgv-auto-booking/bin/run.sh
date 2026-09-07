#!/bin/bash
# 핸터를 브라우저 서피스에 주입한다.
#
# 사용법:  bin/run.sh <surface> [config.json]
#   예)   bin/run.sh surface:41 config.json
#
# 사전 조건: 해당 서피스가 CGV 예매 페이지(/cnm/selectVisitorCnt)에 있어야 하고,
#            그 페이지는 반드시 정상 흐름(영화→극장→회차 클릭)으로 진입한 것이어야 한다.
#            딥링크로 들어간 세션은 결제 단계에서 깨진다. docs/FINDINGS.md §7 참고.
set -eu
SURFACE="${1:-surface:1}"
CONF="${2:-}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
CMUX="${CMUX:-cmux}"

url=$("$CMUX" browser --surface "$SURFACE" get-url 2>&1)
case "$url" in
  *selectVisitorCnt*) ;;
  *) echo "예매 페이지가 아니다: $url"; echo "영화→극장→회차를 클릭해 예매 화면까지 이동한 뒤 다시 실행하라."; exit 1;;
esac

if [ -n "$CONF" ] && [ -f "$CONF" ]; then
  echo "설정 적용: $CONF"
  "$CMUX" browser --surface "$SURFACE" eval \
    --script "window.__CGV_CFG = $(cat "$CONF"); 'config set'"
fi

"$CMUX" browser --surface "$SURFACE" eval --script "$(cat "$DIR/src/hunter.js")"
echo "감시:  $DIR/bin/watch.sh $SURFACE"
