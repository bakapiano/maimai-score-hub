#!/usr/bin/env bash
set -Eeuo pipefail

URL="${FRONTEND_PROBE_URL:-http://127.0.0.1:8848/}"
DURATION_SECONDS="${FRONTEND_PROBE_DURATION_SECONDS:-60}"
INTERVAL_MS="${FRONTEND_PROBE_INTERVAL_MS:-100}"
TIMEOUT_SECONDS="${FRONTEND_PROBE_TIMEOUT_SECONDS:-2}"
LOG_FILE="${FRONTEND_PROBE_LOG_FILE:-}"
STOP_FILE="${FRONTEND_PROBE_STOP_FILE:-}"

usage() {
  cat <<'EOF'
Usage: frontend/scripts/probe-frontend-availability.sh [options]

Continuously probes the frontend from the side while a deploy runs. It exits
non-zero if any request fails, times out, or returns a non-2xx/3xx status.

Options:
  --url URL              URL to probe. Default: http://127.0.0.1:8848/
  --duration SECONDS     Probe duration. Default: 60
  --interval-ms MS       Interval between requests. Default: 100
  --timeout SECONDS      Per-request timeout. Default: 2
  --log-file PATH        Also write CSV samples to PATH.
  --stop-file PATH       Stop early when PATH exists.
  -h, --help             Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      URL="$2"
      shift
      ;;
    --duration)
      DURATION_SECONDS="$2"
      shift
      ;;
    --interval-ms)
      INTERVAL_MS="$2"
      shift
      ;;
    --timeout)
      TIMEOUT_SECONDS="$2"
      shift
      ;;
    --log-file)
      LOG_FILE="$2"
      shift
      ;;
    --stop-file)
      STOP_FILE="$2"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if ! command -v curl >/dev/null 2>&1; then
  echo "Missing required command: curl" >&2
  exit 127
fi
if ! command -v awk >/dev/null 2>&1; then
  echo "Missing required command: awk" >&2
  exit 127
fi

sleep_seconds="$(awk "BEGIN { printf \"%.3f\", $INTERVAL_MS / 1000 }")"
end_at=$((SECONDS + DURATION_SECONDS))
total=0
failures=0
max_ms=0

if [[ -n "$LOG_FILE" ]]; then
  mkdir -p "$(dirname "$LOG_FILE")"
  printf 'timestamp,http_code,total_ms,ok\n' >"$LOG_FILE"
fi

if [[ -n "$STOP_FILE" ]]; then
  printf 'probing %s for up to %ss every %sms; stop file: %s\n' "$URL" "$DURATION_SECONDS" "$INTERVAL_MS" "$STOP_FILE"
else
  printf 'probing %s for %ss every %sms\n' "$URL" "$DURATION_SECONDS" "$INTERVAL_MS"
fi

while (( SECONDS < end_at )); do
  if [[ -n "$STOP_FILE" && -e "$STOP_FILE" && "$total" -gt 0 ]]; then
    break
  fi

  timestamp="$(date +'%Y-%m-%dT%H:%M:%S%z')"
  sample="$(curl -L -sS -o /dev/null -w '%{http_code} %{time_total}' --max-time "$TIMEOUT_SECONDS" "$URL" 2>/dev/null || true)"
  code="${sample%% *}"
  seconds="${sample#* }"
  if [[ "$sample" == "$code" ]]; then
    seconds="0"
  fi
  total_ms="$(awk "BEGIN { printf \"%d\", $seconds * 1000 }")"
  ok=0
  if [[ "$code" =~ ^(2|3)[0-9][0-9]$ ]]; then
    ok=1
  else
    failures=$((failures + 1))
    printf 'probe failure at %s: code=%s total_ms=%s\n' "$timestamp" "${code:-curl_error}" "$total_ms" >&2
  fi

  total=$((total + 1))
  if (( total_ms > max_ms )); then
    max_ms="$total_ms"
  fi

  if [[ -n "$LOG_FILE" ]]; then
    printf '%s,%s,%s,%s\n' "$timestamp" "${code:-curl_error}" "$total_ms" "$ok" >>"$LOG_FILE"
  fi

  sleep "$sleep_seconds"
done

printf 'probe summary: total=%s failures=%s max_ms=%s\n' "$total" "$failures" "$max_ms"

if (( failures > 0 )); then
  exit 1
fi
