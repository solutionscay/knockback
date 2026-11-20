#!/usr/bin/env bash
# One-command deploy of the match server (#26). Builds the image here, ships it
# to the VM over SSH (no registry), uploads the compose files, takes a backup,
# switches .env to the new image tag, starts it and waits until it is healthy.
#
#   KB_HOST=deploy@vm.example.com deploy/deploy.sh            # deploy HEAD
#   KB_HOST=deploy@vm.example.com deploy/deploy.sh --rollback # back to the previous tag
#   KB_HOST=local KB_DIR=/tmp/kb-stage deploy/deploy.sh       # rehearse against the local Docker
#
# Env: KB_HOST (user@host, or "local"), KB_DIR (default /opt/knockback),
# KB_PLATFORM (default linux/amd64; linux/arm64 for Hetzner CAX), KB_ALLOW_DIRTY=1
# to deploy uncommitted changes (tagged <hash>-dirty).
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${KB_HOST:?set KB_HOST=user@host (or local)}
DIR=${KB_DIR:-/opt/knockback}
PLATFORM=${KB_PLATFORM:-linux/amd64}
MODE=${1:-deploy}

remote() { # run a shell snippet in $DIR on the target
  if [ "$HOST" = local ]; then (cd "$DIR" && bash -c "$1"); else ssh "$HOST" "cd '$DIR' && bash -c $(printf '%q' "$1")"; fi
}
wait_healthy='ok=; for i in $(seq 1 60); do s=$(docker inspect -f "{{.State.Health.Status}}" "$(docker compose ps -q server)" 2>/dev/null || true); if [ "$s" = healthy ]; then ok=1; echo "server healthy"; break; fi; sleep 2; done; if [ -z "$ok" ]; then echo "server not healthy after 120 s" >&2; docker compose logs --tail 50 server >&2; exit 1; fi'
set_tag='tag="$1"; touch .env; if grep -q "^KB_IMAGE_TAG=" .env; then sed -i.bak "s/^KB_IMAGE_TAG=.*/KB_IMAGE_TAG=$tag/" .env && rm -f .env.bak; else echo "KB_IMAGE_TAG=$tag" >> .env; fi'

if [ "$MODE" = --rollback ]; then
  remote '
    prev=$(cat .previous-tag 2>/dev/null) || { echo "rollback: no previous tag recorded" >&2; exit 1; }
    cur=$(grep "^KB_IMAGE_TAG=" .env | cut -d= -f2)
    docker image inspect "knockback-server:$prev" >/dev/null || { echo "rollback: image knockback-server:$prev is not on this host" >&2; exit 1; }
    set -- "$prev"; '"$set_tag"'
    echo "$cur" > .previous-tag
    docker compose up -d --no-build
    '"$wait_healthy"'
    echo "rolled back: $cur -> $prev"'
  exit 0
fi

TAG=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then
  [ "${KB_ALLOW_DIRTY:-}" = 1 ] || { echo "deploy: uncommitted changes (commit, or KB_ALLOW_DIRTY=1)" >&2; exit 1; }
  TAG="$TAG-dirty"
fi
IMAGE=knockback-server:$TAG
echo "deploy: building $IMAGE for $PLATFORM"
docker build --platform "$PLATFORM" -t "$IMAGE" --build-arg KB_VERSION="$TAG" .

echo "deploy: files to $HOST:$DIR"
FILES=(docker-compose.yml deploy/Caddyfile deploy/.env.example deploy/backup.sh deploy/restore.sh deploy/deploy.sh)
if [ "$HOST" = local ]; then
  mkdir -p "$DIR/deploy"
  for f in "${FILES[@]}"; do cp "$f" "$DIR/$f"; done
else
  ssh "$HOST" "mkdir -p '$DIR/deploy'"
  tar -cf - "${FILES[@]}" | ssh "$HOST" "tar -C '$DIR' -xf -"
  echo "deploy: image to $HOST ($(docker image inspect -f '{{.Size}}' "$IMAGE" | awk '{printf "%.0f MB", $1/1e6}') unpacked)"
  docker save "$IMAGE" | gzip -1 | ssh "$HOST" 'gunzip | docker load'
fi

remote '
  set -e
  if [ ! -f .env ]; then
    cp deploy/.env.example .env
    echo "deploy: created .env from deploy/.env.example: set KB_DOMAIN (and the rest) in '"$DIR"'/.env, then run deploy again" >&2
    exit 2
  fi
  if docker compose ps --status running --services 2>/dev/null | grep -qx server; then deploy/backup.sh; fi
  cur=$(grep "^KB_IMAGE_TAG=" .env | cut -d= -f2 || true)
  [ -n "$cur" ] && [ "$cur" != "'"$TAG"'" ] && echo "$cur" > .previous-tag
  set -- "'"$TAG"'"; '"$set_tag"'
  docker compose up -d --no-build
  '"$wait_healthy"'
  docker compose ps
  echo "deployed '"$TAG"' (previous: ${cur:-none}); rollback: deploy/deploy.sh --rollback"'
