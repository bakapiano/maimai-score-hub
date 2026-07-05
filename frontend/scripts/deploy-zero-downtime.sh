#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$FRONTEND_DIR/.." && pwd)"

COMPOSE_FILE="${COMPOSE_FILE:-$FRONTEND_DIR/docker-compose.yml}"
SERVICE="${FRONTEND_SERVICE:-frontend}"
HEALTH_URL="${FRONTEND_HEALTH_URL:-http://127.0.0.1:8848/}"
IMAGE_REPO="${FRONTEND_IMAGE_REPO:-maimai-score-hub-frontend}"
REVISION="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
IMAGE_TAG="${FRONTEND_IMAGE_TAG:-deploy-$REVISION-$(date +%Y%m%d%H%M%S)}"
IMAGE="$IMAGE_REPO:$IMAGE_TAG"

BOOTSTRAP=0
SKIP_CANDIDATE_PROBE=0
DRY_RUN=0
PLAN_ONLY=0

usage() {
  cat <<'EOF'
Usage: frontend/scripts/deploy-zero-downtime.sh [options]

Builds a candidate frontend image, probes it on a temporary local port, then
publishes only the static files into the running nginx container. The running
container is not restarted, so the host port remains bound during deploy.

Options:
  --bootstrap               Start the compose service if no running container exists.
  --skip-candidate-probe    Skip probing the newly built candidate container.
  --dry-run                 Print commands without changing containers.
  --plan                    Print the deploy plan without requiring Docker.
  -h, --help                Show this help.

Environment:
  COMPOSE_FILE              Compose file path. Default: frontend/docker-compose.yml
  FRONTEND_SERVICE          Compose service name. Default: frontend
  FRONTEND_HEALTH_URL       Public URL to verify after publish. Default: http://127.0.0.1:8848/
  FRONTEND_IMAGE_REPO       Temporary build image repo. Default: maimai-score-hub-frontend
  FRONTEND_IMAGE_TAG        Temporary build image tag. Default: deploy-<git>-<timestamp>
  FRONTEND_COMPOSE_CMD      Compose command. Default: docker-compose if present, otherwise docker compose
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bootstrap)
      BOOTSTRAP=1
      ;;
    --skip-candidate-probe)
      SKIP_CANDIDATE_PROBE=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --plan)
      PLAN_ONLY=1
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

log() {
  printf '[%s] %s\n' "$(date +'%Y-%m-%dT%H:%M:%S%z')" "$*"
}

run() {
  log "+ $*"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 127
  fi
}

compose() {
  "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" "$@"
}

container_id() {
  compose ps -q "$SERVICE"
}

is_running_container() {
  local id="$1"
  [[ -n "$id" ]] && [[ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)" == "true" ]]
}

wait_http() {
  local url="$1"
  local label="$2"
  local timeout_seconds="${3:-30}"
  local deadline=$((SECONDS + timeout_seconds))
  local code

  while (( SECONDS < deadline )); do
    code="$(curl -L -sS -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null || true)"
    if [[ "$code" =~ ^(2|3)[0-9][0-9]$ ]]; then
      log "$label healthy: HTTP $code"
      return 0
    fi
    sleep 1
  done

  echo "$label did not become healthy within ${timeout_seconds}s: $url" >&2
  return 1
}

cleanup() {
  local code=$?
  if [[ -n "${CANDIDATE_CONTAINER:-}" ]]; then
    docker rm -f "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ -n "${EXTRACT_CONTAINER:-}" ]]; then
    docker rm -f "$EXTRACT_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ -n "${WORK_DIR:-}" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
  exit "$code"
}
if [[ "$PLAN_ONLY" -eq 1 ]]; then
  cat <<EOF
Zero-downtime frontend deploy plan
1. Locate the running compose service: $SERVICE
2. Confirm the current public URL is healthy: $HEALTH_URL
3. Build candidate image: $IMAGE
4. Start candidate on an ephemeral localhost port and probe it
5. Extract /usr/share/nginx/html from the candidate image
6. Copy static files into the running nginx container without restarting it
7. Publish manifest.webmanifest, sw.js, and index.html last via same-directory mv
8. Probe the public URL again
EOF
  exit 0
fi

trap cleanup EXIT

require_command docker
require_command curl

if [[ -n "${FRONTEND_COMPOSE_CMD:-}" ]]; then
  # shellcheck disable=SC2206
  COMPOSE_CMD=($FRONTEND_COMPOSE_CMD)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  COMPOSE_CMD=(docker compose)
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi

ACTIVE_CONTAINER="$(container_id)"
if ! is_running_container "$ACTIVE_CONTAINER"; then
  if [[ "$BOOTSTRAP" -eq 1 ]]; then
    log "No running $SERVICE container; bootstrapping compose service."
    run compose up -d --build "$SERVICE"
    ACTIVE_CONTAINER="$(container_id)"
  else
    echo "No running $SERVICE container. Start it once with: docker compose -f \"$COMPOSE_FILE\" up -d --build $SERVICE" >&2
    exit 1
  fi
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  wait_http "$HEALTH_URL" "current frontend" 30
fi

WORK_DIR="$(mktemp -d)"
DIST_DIR="$WORK_DIR/dist"
mkdir -p "$DIST_DIR"

log "Building candidate image $IMAGE"
run docker build -t "$IMAGE" -f "$FRONTEND_DIR/Dockerfile" "$ROOT_DIR"

if [[ "$DRY_RUN" -eq 0 && "$SKIP_CANDIDATE_PROBE" -eq 0 ]]; then
  log "Starting candidate container on an ephemeral localhost port"
  CANDIDATE_CONTAINER="$(docker run -d --rm -p 127.0.0.1::80 "$IMAGE")"
  CANDIDATE_PORT="$(docker inspect -f '{{(index (index .NetworkSettings.Ports "80/tcp") 0).HostPort}}' "$CANDIDATE_CONTAINER")"
  wait_http "http://127.0.0.1:$CANDIDATE_PORT/" "candidate frontend" 30
  docker rm -f "$CANDIDATE_CONTAINER" >/dev/null
  CANDIDATE_CONTAINER=""
fi

log "Extracting candidate static files"
if [[ "$DRY_RUN" -eq 0 ]]; then
  EXTRACT_CONTAINER="$(docker create "$IMAGE")"
  docker cp "$EXTRACT_CONTAINER:/usr/share/nginx/html/." "$DIST_DIR"
  docker rm "$EXTRACT_CONTAINER" >/dev/null
  EXTRACT_CONTAINER=""
else
  log "+ docker create $IMAGE"
  log "+ docker cp <candidate>:/usr/share/nginx/html/. $DIST_DIR"
fi

ACTIVE_CONTAINER="$(container_id)"
if ! is_running_container "$ACTIVE_CONTAINER"; then
  echo "Active frontend container disappeared before publish." >&2
  exit 1
fi

log "Publishing static files into running container $ACTIVE_CONTAINER"
if [[ "$DRY_RUN" -eq 0 ]]; then
  docker exec "$ACTIVE_CONTAINER" sh -c 'rm -rf /usr/share/nginx/html/.deploy-next && mkdir -p /usr/share/nginx/html/.deploy-next'
  docker cp "$DIST_DIR/." "$ACTIVE_CONTAINER:/usr/share/nginx/html/.deploy-next/"
  docker exec -i "$ACTIVE_CONTAINER" sh <<'EOF'
set -eu
cd /usr/share/nginx/html

# Publish hashed assets and secondary files first. Existing hashed assets are
# intentionally kept so users with an old index.html can still load chunks.
for path in .deploy-next/*; do
  name="${path##*/}"
  case "$name" in
    index.html|sw.js|manifest.webmanifest)
      continue
      ;;
  esac
  if [ -d "$path" ]; then
    cp -a "$path" .
  elif [ -f "$path" ]; then
    cp "$path" ".$name.next"
    mv -f ".$name.next" "$name"
  fi
done

# Publish entry files last via same-directory rename. index.html must be last
# because it points browsers at the newly copied hashed assets.
for file in manifest.webmanifest sw.js index.html; do
  if [ -f ".deploy-next/$file" ]; then
    cp ".deploy-next/$file" ".$file.next"
    mv -f ".$file.next" "$file"
  fi
done

rm -rf .deploy-next
EOF
else
  log "+ docker exec $ACTIVE_CONTAINER publish staged dist with atomic entry-file rename"
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  wait_http "$HEALTH_URL" "published frontend" 30
fi

log "Deploy complete: $IMAGE"
