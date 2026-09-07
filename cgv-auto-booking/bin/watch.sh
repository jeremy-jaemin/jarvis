#!/bin/bash
# 핸터 감시자.
#  - 핸터 상태를 주기적으로 읽어 로그로 남긴다
#  - 페이지가 예매 화면을 벗어나거나 핸터가 사라지면 알린다
#  - 좌석 확보(localStorage 마커)가 감지되면 스크린샷을 남기고 종료한다
#
# 사용법:  bin/watch.sh <surface> [로그파일]
#   예)   bin/watch.sh surface:41 ./watch.log
set -u
SURFACE="${1:-surface:1}"
LOG="${2:-./watch.log}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
CMUX="${CMUX:-cmux}"
STATE_JS="$(cat "$DIR/src/state.js")"

log() { echo "$(date +%H:%M:%S) $*" | tee -a "$LOG"; }
n=0

while true; do
  n=$((n + 1))
  R=$("$CMUX" browser --surface "$SURFACE" eval --script "$STATE_JS" 2>&1 | tr -d '\n')
  st=$(printf '%s' "$R" | jq -r '.state // empty' 2>/dev/null)
  url=$(printf '%s' "$R" | jq -r '.url // empty' 2>/dev/null)
  mark=$(printf '%s' "$R" | jq -r '.mark // empty' 2>/dev/null)

  # 좌석을 잡으면 페이지가 결제 화면으로 넘어가므로 URL 이탈로 오판하면 안 된다.
  # 마커가 있으면 무조건 성공으로 본다.
  if [ -n "$mark" ] && [ "$mark" != "null" ]; then
    log "SECURED $mark  url=$url"
    "$CMUX" browser --surface "$SURFACE" screenshot --out "$DIR/secured.png" >/dev/null 2>&1
    log "스크린샷: $DIR/secured.png"
    log "결제수단 페이지에서 정지했다. 쿠폰 적용과 최종 결제는 직접 진행하라."
    exit 0
  fi

  if [ -z "$st" ]; then
    log "WARN 상태 읽기 실패: $(printf '%s' "$R" | cut -c1-120)"
  elif [ "$st" = "MISSING" ]; then
    log "WARN 핸터 소실 (페이지 리로드 추정) url=$url  -> src/hunter.js 재주입 필요"
  elif [ "$st" = "error" ]; then
    log "ERROR $(printf '%s' "$R" | jq -r '.err // ""')"
  else
    case "$url" in
      *selectVisitorCnt*) ;;
      *) log "WARN 예매 페이지 이탈: $url" ;;
    esac
  fi

  # 핸터 내부 로그 중 새로 생긴 줄만 출력
  lines=$(printf '%s' "$R" | jq -r '.log[]?' 2>/dev/null)
  if [ -n "${last:-}" ]; then
    new=$(printf '%s\n' "$lines" | awk -v l="$last" 'f{print} $0==l{f=1}')
  else
    new=$(printf '%s\n' "$lines")
  fi
  [ -n "$new" ] && printf '%s\n' "$new" | grep -v '^$' | tee -a "$LOG"
  ll=$(printf '%s\n' "$lines" | tail -1); [ -n "$ll" ] && last="$ll"

  if [ $((n % 60)) -eq 0 ]; then
    log "heartbeat $(printf '%s' "$R" | jq -c '{scans,refreshes,personFixes,free,targetFree}' 2>/dev/null)"
  fi
  sleep 3
done
