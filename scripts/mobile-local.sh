#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE_DIR="$ROOT_DIR/apps/mobile"
INFERENCE_DIR="$ROOT_DIR/apps/inference"
ACTION="${1:-dev}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="$INFERENCE_DIR/.venv"
BUCKET_NAME="pet-hotel-photos-dev"
STARTED_PIDS=()
LOCK_DIR="${TMPDIR:-/tmp}/ucbarkley-mobile-${UID}.lock"

log() {
  printf '\n\033[1;32m[ucbarkley]\033[0m %s\n' "$*"
}

fail() {
  printf '\n\033[1;31m[ucbarkley]\033[0m %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing '$1'. $2"
}

detect_ip() {
  if [[ -n "${LOCAL_IP:-}" ]]; then
    printf '%s' "$LOCAL_IP"
    return
  fi

  local interface=""
  local address=""

  if command -v route >/dev/null 2>&1; then
    interface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
  fi

  if [[ -n "$interface" ]]; then
    address="$(ipconfig getifaddr "$interface" 2>/dev/null || true)"
  fi

  if [[ -z "$address" ]]; then
    address="$(ipconfig getifaddr en0 2>/dev/null || true)"
  fi

  if [[ -z "$address" ]]; then
    address="$(ipconfig getifaddr en1 2>/dev/null || true)"
  fi

  [[ -n "$address" ]] || fail "Could not find this Mac's LAN IP. Run: make mobile LOCAL_IP=<your-ip>"
  printf '%s' "$address"
}

copy_env_if_missing() {
  local example="$1"
  local destination="$2"

  if [[ ! -f "$destination" ]]; then
    cp "$example" "$destination"
    log "Created ${destination#"$ROOT_DIR/"} from its example file."
  fi
}

check_node_version() {
  local major minor
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  minor="$(node -p 'Number(process.versions.node.split(".")[1])')"
  if (( major < 22 || major == 23 || (major == 22 && minor < 13) || (major == 24 && minor < 3) )); then
    fail "Expo SDK 57 requires Node 22.13+, 24.3+, or 25+. Node 23 is unsupported. Run 'nvm use' from the repository root. Current version: $(node --version)"
  fi
}

ensure_python_environment() {
  require_command "$PYTHON_BIN" "Install Python 3.12 or newer."

  if [[ ! -x "$VENV_DIR/bin/python" ]] || ! "$VENV_DIR/bin/python" -c 'import sys' >/dev/null 2>&1; then
    log "Creating a fresh inference Python environment..."
    "$PYTHON_BIN" -m venv --clear "$VENV_DIR"
  fi
}

install_dependencies() {
  require_command npm "Install Node.js 22.13 or newer."
  require_command "$PYTHON_BIN" "Install Python 3.12 or newer."
  check_node_version

  log "Installing JavaScript dependencies..."
  (cd "$ROOT_DIR" && npm install)

  ensure_python_environment

  log "Installing inference dependencies..."
  "$VENV_DIR/bin/pip" install -r "$INFERENCE_DIR/requirements.txt"

  copy_env_if_missing "$ROOT_DIR/apps/api/.env.example" "$ROOT_DIR/apps/api/.env"
  copy_env_if_missing "$ROOT_DIR/apps/worker/.env.example" "$ROOT_DIR/apps/worker/.env"
}

ensure_dependencies() {
  require_command npm "Install Node.js 22.13 or newer."
  require_command docker "Install and start Docker Desktop."
  require_command curl "curl is required for local health checks."
  require_command ipconfig "This workflow currently supports macOS."
  check_node_version

  if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
    log "JavaScript dependencies are missing; installing them now..."
    (cd "$ROOT_DIR" && npm install)
  fi

  copy_env_if_missing "$ROOT_DIR/apps/api/.env.example" "$ROOT_DIR/apps/api/.env"
  copy_env_if_missing "$ROOT_DIR/apps/worker/.env.example" "$ROOT_DIR/apps/worker/.env"

  if [[ ! -x "$VENV_DIR/bin/uvicorn" ]] || ! "$VENV_DIR/bin/python" -c 'import uvicorn' >/dev/null 2>&1; then
    log "Inference dependencies are missing; creating them now..."
    ensure_python_environment
    "$VENV_DIR/bin/pip" install -r "$INFERENCE_DIR/requirements.txt"
  fi
}

wait_for_postgres() {
  local attempt
  for attempt in {1..30}; do
    if (cd "$ROOT_DIR" && docker compose exec -T postgres pg_isready -U pethotel >/dev/null 2>&1); then
      return
    fi
    sleep 1
  done
  fail "Postgres did not become ready. Check: docker compose logs postgres"
}

wait_for_url() {
  local name="$1"
  local url="$2"
  local attempt

  for attempt in {1..180}; do
    if curl --silent --fail --max-time 2 "$url" >/dev/null 2>&1; then
      log "$name is ready."
      return
    fi
    sleep 1
  done

  fail "$name did not become ready at $url."
}

url_is_ready() {
  curl --silent --fail --max-time 2 "$1" >/dev/null 2>&1
}

start_background() {
  local name="$1"
  shift

  log "Starting $name..."
  "$@" &
  STARTED_PIDS+=("$!")
}

cleanup() {
  local pid
  if (( ${#STARTED_PIDS[@]} > 0 )); then
    log "Stopping the local app processes started by this command..."
    for pid in "${STARTED_PIDS[@]}"; do
      kill "$pid" >/dev/null 2>&1 || true
    done
    wait "${STARTED_PIDS[@]}" 2>/dev/null || true
  fi
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}

acquire_lock() {
  local existing_pid=""

  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return
  fi

  if [[ -f "$LOCK_DIR/pid" ]]; then
    existing_pid="$(<"$LOCK_DIR/pid")"
  fi

  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    fail "Another 'make mobile' process is running (PID $existing_pid). Stop it with Ctrl-C before starting another."
  fi

  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || fail "Could not clear the stale mobile-development lock at $LOCK_DIR."
  mkdir "$LOCK_DIR"
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
}

start_local_stack() {
  local api_url="$1"
  local s3_url="${api_url%:3000}:9000"

  docker info >/dev/null 2>&1 || fail "Docker Desktop is not running. Open it, wait for it to start, and retry."

  log "Starting Postgres and MinIO..."
  (cd "$ROOT_DIR" && docker compose up -d postgres minio)
  wait_for_postgres

  log "Applying database migrations..."
  (cd "$ROOT_DIR" && npm run migrate)

  log "Ensuring the local photo bucket exists..."
  (cd "$ROOT_DIR" && docker compose exec -T minio mc alias set local http://localhost:9000 pethotel pethotel_dev_secret >/dev/null)
  (cd "$ROOT_DIR" && docker compose exec -T minio mc mb --ignore-existing "local/$BUCKET_NAME" >/dev/null)

  if url_is_ready "http://localhost:8000/health"; then
    log "Inference is already running; reusing it."
  else
    start_background "inference" bash -c "cd '$INFERENCE_DIR' && exec .venv/bin/uvicorn main:app --reload --host 0.0.0.0 --port 8000"
    wait_for_url "Inference" "http://localhost:8000/health"
  fi

  if url_is_ready "http://localhost:3000/health"; then
    log "API is already running; reusing it instead of starting a duplicate on port 3000."
    log "If phone uploads fail, stop that older API so this command can restart it with S3_ENDPOINT=$s3_url."
  else
    start_background "API" env S3_ENDPOINT="$s3_url" bash -c "cd '$ROOT_DIR' && exec npm run dev:api"
    wait_for_url "API" "http://localhost:3000/health"
  fi

  start_background "photo and video worker" bash -c "cd '$ROOT_DIR' && exec npm run dev:worker"

  log "Phone API URL: $api_url"
  log "Keep the Mac and iPhone on the same Wi-Fi. Press Ctrl-C to stop."
}

case "$ACTION" in
  setup)
    install_dependencies
    log "Local mobile dependencies are ready. Next run: make mobile-build"
    ;;
  ip)
    resolved_ip="$(detect_ip)"
    printf 'LAN IP:  %s\nAPI URL: http://%s:3000\n' "$resolved_ip" "$resolved_ip"
    ;;
  dev|ios)
    ensure_dependencies
    acquire_lock
    trap cleanup EXIT INT TERM

    resolved_ip="$(detect_ip)"
    api_url="http://${resolved_ip}:3000"
    start_local_stack "$api_url"

    if [[ "$ACTION" == "ios" ]]; then
      developer_dir="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
      [[ -d "$developer_dir" ]] || fail "Xcode was not found at $developer_dir. Override it with DEVELOPER_DIR=/path/to/Xcode.app/Contents/Developer."
      log "Refreshing the generated iOS project and automatic-signing settings..."
      (cd "$MOBILE_DIR" && env DEVELOPER_DIR="$developer_dir" npx expo prebuild --platform ios --no-install)
      log "Building and installing UCBarkley Staff on a connected iPhone..."
      (cd "$MOBILE_DIR" && env DEVELOPER_DIR="$developer_dir" EXPO_PUBLIC_API_URL="$api_url" npx expo run:ios --device)
    else
      log "Starting Expo development server..."
      (cd "$MOBILE_DIR" && env EXPO_PUBLIC_API_URL="$api_url" npx expo start --dev-client --lan --clear)
    fi
    ;;
  *)
    fail "Unknown action '$ACTION'. Use dev, ios, setup, or ip."
    ;;
esac
