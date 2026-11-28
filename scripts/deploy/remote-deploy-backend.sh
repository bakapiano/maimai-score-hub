#!/usr/bin/env bash
set -euo pipefail

DEPLOY_PATH="${1:?DEPLOY_PATH required}"
SOURCE_ARCHIVE="${2:?SOURCE_ARCHIVE required}"
RELEASE="${3:?RELEASE required}"
CONFIRM_DXNET_V2_CUTOVER="${4:-false}"

test -n "$DEPLOY_PATH"
test -f "$SOURCE_ARCHIVE"

mkdir -p "$DEPLOY_PATH"
cd "$DEPLOY_PATH"
sudo chown -R "$USER:$USER" "$(pwd)" || true

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  COMPOSE_CMD="docker compose"
fi

RUNTIME_DIR="$(mktemp -d)"
if [ -f backend/.env ]; then
  mkdir -p "$RUNTIME_DIR/backend"
  cp -a backend/.env "$RUNTIME_DIR/backend/.env"
fi
if [ -d backend/assets ]; then
  mkdir -p "$RUNTIME_DIR/backend"
  cp -a backend/assets "$RUNTIME_DIR/backend/assets"
fi

# Running replicas bind-mount backend/covers & backend/android-releases.
# Never delete or replace those directories while they are serving.
if [ -d backend ]; then
  find backend -mindepth 1 -maxdepth 1 \
    ! -name covers ! -name android-releases \
    -exec rm -rf -- {} +
fi
rm -rf shared package.json package-lock.json
tar -xzf "$SOURCE_ARCHIVE" -C "$DEPLOY_PATH"
rm -f "$SOURCE_ARCHIVE"

if [ -f "$RUNTIME_DIR/backend/.env" ]; then
  cp -a "$RUNTIME_DIR/backend/.env" backend/.env
  chmod 600 backend/.env
fi
if [ -d "$RUNTIME_DIR/backend/assets" ]; then
  mkdir -p backend/assets
  cp -a "$RUNTIME_DIR/backend/assets/." backend/assets/
fi
if [ ! -f backend/.env ]; then
  echo "❌ backend/.env is missing on target host; refusing to deploy"
  exit 1
fi
if [ ! -f backend/assets/fonts/ResourceHanRoundedCN-Bold.ttf ]; then
  echo "❌ backend/assets/fonts/ResourceHanRoundedCN-Bold.ttf is missing; refusing to build incomplete backend image"
  exit 1
fi
rm -rf "$RUNTIME_DIR"

printf '%s\n' "$RELEASE" > "$DEPLOY_PATH/.deploy-revision"

cd backend
sudo docker builder prune --force --keep-storage=2GB || true
sudo $COMPOSE_CMD build backend || { echo "❌ Build failed"; exit 1; }

sudo $COMPOSE_CMD up -d mongo redis

wait_service_healthy() {
  local service="$1"
  for i in $(seq 1 30); do
    local healthy
    healthy=$(sudo $COMPOSE_CMD ps "$service" --format json 2>/dev/null \
      | grep -c '"Health":"healthy"' || true)
    if [ "$healthy" -eq 0 ]; then
      healthy=$(sudo $COMPOSE_CMD ps "$service" 2>/dev/null \
        | grep -c "(healthy)" || true)
    fi
    echo "[wait] $service healthy=$healthy (attempt $i/30)"
    if [ "$healthy" -ge 1 ]; then
      return 0
    fi
    sleep 5
  done
  return 1
}

if ! wait_service_healthy mongo; then
  echo "❌ MongoDB did not become healthy within 150s"
  sudo $COMPOSE_CMD logs --tail=100 mongo
  exit 1
fi

if ! wait_service_healthy redis; then
  echo "❌ Redis did not become healthy within 150s"
  sudo $COMPOSE_CMD logs --tail=100 redis
  exit 1
fi

sudo $COMPOSE_CMD run --rm --no-deps \
  -e DXNET_V2_CUTOVER_CONFIRMED="$CONFIRM_DXNET_V2_CUTOVER" backend \
  npm run migrate:dxnet-routing-indexes

wait_until_all_healthy() {
  local target_n="$1"
  for i in $(seq 1 30); do
    local healthy
    healthy=$(sudo $COMPOSE_CMD ps backend --format json 2>/dev/null \
      | grep -c '"Health":"healthy"' || true)
    if [ "$healthy" -eq 0 ]; then
      healthy=$(sudo $COMPOSE_CMD ps backend 2>/dev/null \
        | grep -c "(healthy)" || true)
    fi
    echo "[wait] healthy=$healthy / target=$target_n (attempt $i/30)"
    if [ "$healthy" -ge "$target_n" ]; then
      return 0
    fi
    sleep 5
  done
  return 1
}

UNHEALTHY_IDS=$(sudo $COMPOSE_CMD ps -q backend | xargs -r sudo docker inspect --format '{{if eq .State.Health.Status "unhealthy"}}{{.Id}}{{end}}' | grep -v '^$' || true)
if [ -n "$UNHEALTHY_IDS" ]; then
  echo "Removing leftover unhealthy containers: $UNHEALTHY_IDS"
  echo "$UNHEALTHY_IDS" | xargs -r sudo docker rm -f
fi

roll_one_replica() {
  echo "── rolling one replica ──"
  sudo $COMPOSE_CMD up -d --no-deps --no-recreate --scale backend=3 backend
  echo "Waiting for 3 healthy backend containers..."
  if ! wait_until_all_healthy 3; then
    echo "❌ New replica did not become healthy within 150s"
    sudo $COMPOSE_CMD logs --tail=100 backend
    exit 1
  fi

  local oldest_id
  oldest_id=$(sudo $COMPOSE_CMD ps -q backend \
    | xargs -r sudo docker inspect --format '{{.Created}} {{.Id}}' \
    | sort \
    | head -1 \
    | awk '{print $2}')
  if [ -z "$oldest_id" ]; then
    echo "❌ Could not identify oldest backend container"
    exit 1
  fi
  echo "Stopping oldest backend container $oldest_id..."
  sudo docker stop --time=60 "$oldest_id"
  sudo docker rm "$oldest_id"

  sudo $COMPOSE_CMD up -d --no-deps --no-recreate --scale backend=2 backend
  sleep 5
  if ! wait_until_all_healthy 2; then
    echo "❌ After scale-down, fewer than 2 healthy backend containers"
    sudo $COMPOSE_CMD logs --tail=100 backend
    exit 1
  fi
}

roll_one_replica
roll_one_replica

sudo $COMPOSE_CMD run --rm --no-deps \
  -e DXNET_V2_CUTOVER_CONFIRMED="$CONFIRM_DXNET_V2_CUTOVER" backend \
  npm run migrate:dxnet-routing-indexes

sudo $COMPOSE_CMD up -d nginx

test -s host-nginx/msh.conf
test -s host-nginx/msh-proxy-params.conf
test -s host-nginx/msh-web-locations.conf
sudo install -d -m 755 /etc/nginx/conf.d /etc/nginx/snippets
sudo install -m 644 host-nginx/msh.conf /etc/nginx/conf.d/msh.conf
sudo install -m 644 host-nginx/msh-proxy-params.conf /etc/nginx/snippets/msh-proxy-params.conf
sudo install -m 644 host-nginx/msh-web-locations.conf /etc/nginx/snippets/msh-web-locations.conf
sudo nginx -t
sudo systemctl reload nginx

if ! sudo $COMPOSE_CMD exec -T backend \
  curl -fsS http://host.docker.internal:19100/healthz \
  | grep -q '"mode":"real"'; then
  echo "❌ Backend container cannot reach the real OCR API tunnel"
  sudo $COMPOSE_CMD exec -T backend \
    curl -v http://host.docker.internal:19100/healthz || true
  exit 1
fi

for i in 1 2 3 4 5; do
  if curl -fsS http://localhost:8090/api/v1/health \
    && curl --resolve api.maiscorehub.bakapiano.com:443:127.0.0.1 \
      -fsS https://api.maiscorehub.bakapiano.com/api/v1/health; then
    echo "✅ Backend rolling deployment successful: $RELEASE"
    sudo $COMPOSE_CMD ps backend
    sudo docker image prune -f
    sudo docker builder prune --force --keep-storage=2GB || true
    exit 0
  fi
  echo "Final health check attempt $i failed, retrying..."
  sleep 5
done

echo "❌ Final nginx health check failed"
sudo $COMPOSE_CMD logs --tail=100 backend
exit 1
