#!/usr/bin/env bash
# End-to-end test of the one-click updater against real Docker containers.
#
# Starts a throwaway registry on 127.0.0.1:5055, builds portal images 9.9.1,
# 9.9.2 and 9.9.3 (9.9.3 exits right away), builds the updater locally and runs
# both in the compose project "e2e-updater" from a temp folder. Then it drives
# three update requests through data/update/request.json:
#   9.9.2 -> done, 9.9.3 -> rolledBack, 9.9.9 (missing) -> failed.
#
# Safety: the script only creates, stops and removes its own resources (compose
# project e2e-updater, container e2e-updater-registry, images under
# 127.0.0.1:5055/ and e2e-updater/). All containers that run before the start
# must still run with the same id before and after every case.
#
# Usage: scripts/e2e-updater.sh   (needs docker, node, curl, rsync, nc)
set -euo pipefail

PROJECT=e2e-updater
REGISTRY_NAME=e2e-updater-registry
REGISTRY_IMAGE=registry:2
REGISTRY_PORT=5055
REGISTRY=127.0.0.1:$REGISTRY_PORT
PORTAL_REPO=$REGISTRY/tanss-agent-portal
UPDATER_IMAGE=e2e-updater/updater:e2e
HOST_PORT=3898
HEALTH_URL=http://127.0.0.1:$HOST_PORT/health
STATUS_TIMEOUT=180

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/e2e-updater.XXXXXX")
RUN_DIR=$WORK/run
DATA_DIR=$RUN_DIR/data
UPDATE_DIR=$DATA_DIR/update
COMPOSE_FILE=$RUN_DIR/compose.yaml
LOG_DIR=$WORK/logs

GUARD_IDS=""
AGENT_PORTAL_ID=""
REGISTRY_PULLED=0
FAILED=0

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }

compose() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

dump_logs() {
  echo "----- docker logs (updater) -----"
  compose logs --no-color updater 2>&1 | tail -n 80 || true
  echo "----- docker logs (portal) -----"
  compose logs --no-color portal 2>&1 | tail -n 40 || true
  echo "----- status.json -----"
  cat "$UPDATE_DIR/status.json" 2>/dev/null || echo "(keine)"
  echo
}

fail() {
  echo "FAIL: $*" >&2
  FAILED=1
  dump_logs >&2
  exit 1
}

pass() { echo "PASS: $*"; }

cleanup() {
  local code=$?
  set +e
  log "Aufräumen …"
  if [ -f "$COMPOSE_FILE" ]; then
    (cd "$RUN_DIR" && compose down -v --remove-orphans --timeout 5) >"$LOG_DIR/down.log" 2>&1 \
      || echo "WARN: compose down fehlgeschlagen, siehe $LOG_DIR/down.log" >&2
  fi
  if docker container inspect "$REGISTRY_NAME" >/dev/null 2>&1; then
    docker rm -f -v "$REGISTRY_NAME" >/dev/null
  fi
  for img in "$PORTAL_REPO:9.9.1" "$PORTAL_REPO:9.9.2" "$PORTAL_REPO:9.9.3" "$PORTAL_REPO:e2e" "$UPDATER_IMAGE"; do
    if docker image inspect "$img" >/dev/null 2>&1; then docker rmi "$img" >/dev/null; fi
  done
  if [ "$REGISTRY_PULLED" = 1 ] && docker image inspect "$REGISTRY_IMAGE" >/dev/null 2>&1; then
    docker rmi "$REGISTRY_IMAGE" >/dev/null
  fi
  check_guard "nach dem Aufräumen" || code=1
  if [ "$code" = 0 ]; then
    rm -rf "$WORK" 2>/dev/null || echo "WARN: $WORK nicht vollständig gelöscht" >&2
  else
    echo "Arbeitsordner bleibt zur Analyse: $WORK" >&2
  fi
  exit "$code"
}

# --- guard for containers that are not ours --------------------------------

snapshot_guard() {
  GUARD_IDS=$(docker ps -q --no-trunc | sort)
  AGENT_PORTAL_ID=$(docker container inspect -f '{{.Id}}' agent-portal 2>/dev/null || true)
  local n
  n=$(printf '%s\n' "$GUARD_IDS" | grep -c . || true)
  if [ -n "$AGENT_PORTAL_ID" ]; then
    log "Schutz: $n fremde Container laufen, darunter agent-portal ${AGENT_PORTAL_ID:0:12}"
  else
    log "Schutz: $n fremde Container laufen (kein agent-portal vorhanden)"
  fi
}

# Returns non-zero (and prints why) if any container that ran at start has
# stopped or been replaced.
check_guard() {
  local where=$1 id state bad=0
  for id in $GUARD_IDS; do
    state=$(docker container inspect -f '{{.State.Running}}' "$id" 2>/dev/null || echo missing)
    if [ "$state" != true ]; then
      echo "SCHUTZ VERLETZT ($where): fremder Container ${id:0:12} läuft nicht mehr ($state)" >&2
      bad=1
    fi
  done
  if [ -n "$AGENT_PORTAL_ID" ]; then
    state=$(docker container inspect -f '{{.Id}} {{.State.Running}}' agent-portal 2>/dev/null || echo missing)
    if [ "$state" != "$AGENT_PORTAL_ID true" ]; then
      echo "SCHUTZ VERLETZT ($where): agent-portal ist nicht mehr derselbe laufende Container ($state)" >&2
      bad=1
    fi
  fi
  return "$bad"
}

guard() { check_guard "$1" || fail "fremde Container verändert ($1)"; }

# --- helpers ---------------------------------------------------------------

port_free() { ! nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }

portal_version() {
  curl -s --max-time 3 "$HEALTH_URL" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s).version;process.stdout.write(typeof v==="string"?v:"")}catch{}})' \
    || true
}

wait_version() {
  local want=$1 seconds=$2 i=0 got=""
  while [ "$i" -lt "$seconds" ]; do
    got=$(portal_version)
    [ "$got" = "$want" ] && return 0
    sleep 1
    i=$((i + 1))
  done
  echo "Portal meldet '${got}' statt '$want'" >&2
  return 1
}

portal_id() { compose ps -q portal; }

portal_count() { compose ps -a --format '{{.Service}}' | grep -cx portal || true; }

request_update() {
  local version=$1 id now
  now=$(date +%s)
  id="e2e-$version-$now-$$"
  printf '{"id":"%s","version":"%s","requestedAt":%s000}' "$id" "$version" "$now" >"$UPDATE_DIR/.request.json.tmp"
  mv "$UPDATE_DIR/.request.json.tmp" "$UPDATE_DIR/request.json"
  echo "$id"
}

# Prints "<state> <message>" once status.json carries the id in a final state.
wait_status() {
  local id=$1 i=0 out
  while [ "$i" -lt "$STATUS_TIMEOUT" ]; do
    out=$(node -e '
      const fs = require("node:fs");
      try {
        const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (s.id === process.argv[2] && ["done", "failed", "rolledBack"].includes(s.state))
          process.stdout.write(s.state + " " + s.message);
      } catch {}
    ' "$UPDATE_DIR/status.json" "$id")
    if [ -n "$out" ]; then
      echo "$out"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }

set_version() {
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    pkg.version = process.argv[2];
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  ' "$1" "$2"
}

# Copies the repo without node_modules, data or secrets and sets the version.
make_source() {
  local dir=$1 version=$2
  mkdir -p "$dir"
  rsync -a --exclude node_modules --exclude .git --exclude dist --exclude data \
    --exclude .env --exclude .superpowers "$REPO_ROOT/" "$dir/"
  set_version "$dir/package.json" "$version"
}

build() {
  local name=$1
  shift
  log "Baue $name …"
  if ! docker build "$@" >"$LOG_DIR/build-$name.log" 2>&1; then
    tail -n 40 "$LOG_DIR/build-$name.log" >&2
    fail "Build $name fehlgeschlagen"
  fi
}

push() {
  if ! docker push "$1" >"$LOG_DIR/push.log" 2>&1; then
    tail -n 20 "$LOG_DIR/push.log" >&2
    fail "Push $1 fehlgeschlagen"
  fi
}

# --- setup -----------------------------------------------------------------

mkdir -p "$LOG_DIR" "$UPDATE_DIR"

cat >"$COMPOSE_FILE" <<EOF
# Mirrors the two services of compose.yaml with local images and port $HOST_PORT.
services:
  portal:
    image: $PORTAL_REPO:e2e
    restart: unless-stopped
    env_file: .env
    environment:
      SERVE_STATIC: "1"
      PORT: "3848"
      BIND: 0.0.0.0
      ALLOW_ALL_INTERFACES: "1"
      TZ: Europe/Berlin
      DATA_DIR: /app/data
    volumes:
      - ./data:/app/data
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "127.0.0.1:$HOST_PORT:3848"
    security_opt:
      - no-new-privileges:true

  updater:
    image: $UPDATER_IMAGE
    restart: unless-stopped
    stop_grace_period: 2m
    environment:
      PORTAL_REPO: $PORTAL_REPO
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data/update:/update
    security_opt:
      - no-new-privileges:true
EOF

cat >"$RUN_DIR/.env" <<EOF
TANSS_BASE_URL=http://127.0.0.1:9
SESSION_SECRET=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
UPDATE_CHECK=0
EOF

# Leftovers of an aborted earlier run carry our exact names only.
(cd "$RUN_DIR" && compose down -v --remove-orphans --timeout 5) >/dev/null 2>&1 || true
if docker container inspect "$REGISTRY_NAME" >/dev/null 2>&1; then docker rm -f -v "$REGISTRY_NAME" >/dev/null; fi

snapshot_guard
trap cleanup EXIT
guard "Start"

port_free "$REGISTRY_PORT" || fail "Port $REGISTRY_PORT ist belegt"
port_free "$HOST_PORT" || fail "Port $HOST_PORT ist belegt"

if ! docker image inspect "$REGISTRY_IMAGE" >/dev/null 2>&1; then
  REGISTRY_PULLED=1
  docker pull -q "$REGISTRY_IMAGE" >/dev/null
fi
log "Starte Registry $REGISTRY_NAME auf $REGISTRY …"
docker run -d --name "$REGISTRY_NAME" -p "$REGISTRY:5000" "$REGISTRY_IMAGE" >/dev/null
i=0
until curl -sf "http://$REGISTRY/v2/" >/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || fail "Registry antwortet nicht"
  sleep 1
done

make_source "$WORK/src-9.9.1" 9.9.1
make_source "$WORK/src-9.9.2" 9.9.2
build portal-9.9.1 -t "$PORTAL_REPO:9.9.1" -t "$PORTAL_REPO:e2e" "$WORK/src-9.9.1"
build portal-9.9.2 -t "$PORTAL_REPO:9.9.2" "$WORK/src-9.9.2"

# 9.9.3: says 9.9.3 but its process exits at once, so /health never answers.
mkdir -p "$WORK/src-9.9.3"
cp "$WORK/src-9.9.2/package.json" "$WORK/src-9.9.3/package.json"
set_version "$WORK/src-9.9.3/package.json" 9.9.3
cat >"$WORK/src-9.9.3/Dockerfile" <<EOF
FROM $PORTAL_REPO:9.9.2
COPY package.json /app/package.json
CMD ["node", "-e", "process.exit(1)"]
EOF
build portal-9.9.3 -t "$PORTAL_REPO:9.9.3" "$WORK/src-9.9.3"

build updater -f "$REPO_ROOT/updater/Dockerfile" --build-arg UPDATER_VERSION=0.0.0-e2e -t "$UPDATER_IMAGE" "$REPO_ROOT"

log "Pushe Images nach $REGISTRY …"
for tag in 9.9.1 e2e 9.9.2 9.9.3; do push "$PORTAL_REPO:$tag"; done
# The updater must really pull 9.9.2 and 9.9.3 from the registry.
docker rmi "$PORTAL_REPO:9.9.2" "$PORTAL_REPO:9.9.3" >/dev/null
# The daemon (not a container) pulls, so 127.0.0.1 here is the registry.
docker pull "$PORTAL_REPO:e2e" >"$LOG_DIR/pull-check.log" 2>&1 \
  || { cat "$LOG_DIR/pull-check.log" >&2; fail "Docker-Daemon kann nicht aus $REGISTRY laden"; }

log "Starte Compose-Projekt $PROJECT …"
(cd "$RUN_DIR" && compose up -d) >"$LOG_DIR/up.log" 2>&1 || { cat "$LOG_DIR/up.log" >&2; fail "compose up fehlgeschlagen"; }
wait_version 9.9.1 60 || fail "Portal 9.9.1 startet nicht"
i=0
until [ -f "$UPDATE_DIR/heartbeat.json" ]; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || fail "Updater schreibt keinen Heartbeat"
  sleep 1
done
log "Portal 9.9.1 und Updater laufen"
guard "nach dem Start"

# --- case 1: 9.9.2 -> done --------------------------------------------------

guard "vor Fall 9.9.2"
before=$(portal_id)
id=$(request_update 9.9.2)
log "Auftrag $id: 9.9.2"
result=$(wait_status "$id") || fail "9.9.2: kein Endstatus nach ${STATUS_TIMEOUT}s"
log "Status: $result"
[ "${result%% *}" = done ] || fail "9.9.2: erwartet done, bekommen: $result"
wait_version 9.9.2 15 || fail "9.9.2: /health meldet nicht 9.9.2"
count=$(portal_count)
[ "$count" = 1 ] || fail "9.9.2: $count Portal-Container statt genau einem"
after=$(portal_id)
[ -n "$after" ] && [ "$after" != "$before" ] || fail "9.9.2: Portal-Container wurde nicht ersetzt"
[ "$(image_id "$PORTAL_REPO:e2e")" = "$(image_id "$PORTAL_REPO:9.9.2")" ] \
  || fail "9.9.2: lokales :e2e zeigt nicht auf 9.9.2"
label_before=$(docker container inspect -f '{{index .Config.Labels "com.docker.compose.image"}}' "$after")
(cd "$RUN_DIR" && compose up -d) >"$LOG_DIR/up-again.log" 2>&1 \
  || { cat "$LOG_DIR/up-again.log" >&2; fail "erneutes compose up fehlgeschlagen"; }
sleep 3
wait_version 9.9.2 15 || fail "9.9.2: nach compose up -d läuft nicht mehr 9.9.2"
again=$(portal_id)
[ "$(docker container inspect -f '{{.Image}}' "$again")" = "$(image_id "$PORTAL_REPO:9.9.2")" ] \
  || fail "9.9.2: compose up -d hat das Portal auf ein anderes Image als 9.9.2 gesetzt"
if [ "$again" != "$after" ]; then
  # Compose saw drift in the com.docker.compose.image label the updater wrote.
  label_now=$(docker container inspect -f '{{index .Config.Labels "com.docker.compose.image"}}' "$again")
  cat "$LOG_DIR/up-again.log" >&2
  fail "9.9.2: compose up -d hat den Portal-Container neu erstellt;" \
    "com.docker.compose.image vom Updater $label_before, von Compose $label_now"
fi
guard "nach Fall 9.9.2"
pass "9.9.2 -> done, /health 9.9.2, ein Portal-Container, compose up -d lässt den Container stehen"

# --- case 2: 9.9.3 -> rolledBack -------------------------------------------

guard "vor Fall 9.9.3"
before=$(portal_id)
id=$(request_update 9.9.3)
log "Auftrag $id: 9.9.3"
result=$(wait_status "$id") || fail "9.9.3: kein Endstatus nach ${STATUS_TIMEOUT}s"
log "Status: $result"
[ "${result%% *}" = rolledBack ] || fail "9.9.3: erwartet rolledBack, bekommen: $result"
wait_version 9.9.2 30 || fail "9.9.3: nach Rollback meldet /health nicht 9.9.2"
[ "$(portal_id)" = "$before" ] || fail "9.9.3: nach Rollback läuft nicht der alte Container"
count=$(portal_count)
[ "$count" = 1 ] || fail "9.9.3: $count Portal-Container statt genau einem"
guard "nach Fall 9.9.3"
pass "9.9.3 -> rolledBack, /health weiter 9.9.2"

# --- case 3: 9.9.9 (missing) -> failed -------------------------------------

guard "vor Fall 9.9.9"
before=$(portal_id)
id=$(request_update 9.9.9)
log "Auftrag $id: 9.9.9"
result=$(wait_status "$id") || fail "9.9.9: kein Endstatus nach ${STATUS_TIMEOUT}s"
log "Status: $result"
[ "${result%% *}" = failed ] || fail "9.9.9: erwartet failed, bekommen: $result"
wait_version 9.9.2 5 || fail "9.9.9: /health meldet nicht mehr 9.9.2"
[ "$(portal_id)" = "$before" ] || fail "9.9.9: Portal-Container wurde angefasst"
guard "nach Fall 9.9.9"
pass "9.9.9 -> failed, Portal unverändert"

echo "E2E OK"
