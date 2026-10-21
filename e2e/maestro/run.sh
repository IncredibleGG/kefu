#!/usr/bin/env bash
# 執行 Maestro 登入流程(CI 的 e2e-android / e2e-ios 共用;本機也可用)。
# 用法:run.sh <輸出目錄> [maestro 全域參數…]      例:run.sh e2e-out --device <UDID>
# 環境變數:
#   E2E_PLATFORM   android | ios(失敗時用來截整個畫面)
#   SIM_UDID       iOS 模擬器 UDID(E2E_PLATFORM=ios 時)
#   E2E_SERVER / E2E_EMAIL / E2E_PASSWORD
#   E2E_ATTEMPTS   最多跑幾次(預設 2;模擬器偶發 "Device server died" 這類基礎設施問題時重跑)
# 產出:<輸出目錄>/maestro.txt、report.xml、screenshots/(最後一次的截圖)、attempt-N/(每次的完整記錄)
set -uo pipefail
out="$(mkdir -p "$1" && cd "$1" && pwd)"
shift
flow="$(cd "$(dirname "$0")" && pwd)/login.yaml"
attempts="${E2E_ATTEMPTS:-2}"
rc=1
for n in $(seq 1 "$attempts"); do
  dir="$out/attempt-$n"
  mkdir -p "$dir"
  echo "==== Maestro 第 $n 次 ====" | tee -a "$out/maestro.txt"
  (
    cd "$dir" &&
    maestro "$@" test \
      -e E2E_SERVER="${E2E_SERVER:-https://kf.56k.cc}" \
      -e E2E_EMAIL="${E2E_EMAIL:-}" \
      -e E2E_PASSWORD="${E2E_PASSWORD:-}" \
      --format junit --output "$dir/report.xml" \
      --test-output-dir "$dir/maestro-output" \
      --debug-output "$dir/maestro-debug" \
      "$flow"
  ) 2>&1 | tee -a "$out/maestro.txt"
  rc=${PIPESTATUS[0]}
  if [ "$rc" -ne 0 ]; then
    case "${E2E_PLATFORM:-}" in
      android) adb exec-out screencap -p > "$dir/failure-screen.png" 2>/dev/null || true ;;
      ios) xcrun simctl io "${SIM_UDID:-booted}" screenshot "$dir/failure-screen.png" >/dev/null 2>&1 || true ;;
    esac
    maestro "$@" hierarchy > "$dir/failure-hierarchy.json" 2>&1 || true
  fi
  [ "$rc" -eq 0 ] && break
done

# 截圖只收最後一次(成功的那次,或全部失敗時的最後一次)
rm -rf "$out/screenshots" && mkdir -p "$out/screenshots"
find "$dir" -name '0*.png' -exec cp {} "$out/screenshots/" \; 2>/dev/null || true
cp "$dir/report.xml" "$out/report.xml" 2>/dev/null || true
echo "Maestro 結束:exit=$rc(共 $n 次)" | tee -a "$out/maestro.txt"
exit "$rc"
