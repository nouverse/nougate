#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
#  Nougate — Development Runner
#  Runs a single container with:
#    • Backend (bun --watch) — auto-restarts on source changes
#    • Frontend (vite build + inotifywait) — auto-rebuilds on changes
#  Frontend is built and served by backend at /frontend/
#
#  Usage:
#    ./run-dev.sh              # start dev container
#    ./run-dev.sh down         # tear down container
#    ./run-dev.sh logs         # tail logs
#    ./run-dev.sh restart      # restart container
#    ./run-dev.sh status       # show container status
# ──────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.dev.yml"

# ── Colors ───────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

log_info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ── Pre-flight checks ───────────────────────────────────
check_prereqs() {
  if ! command -v docker &>/dev/null; then
    log_error "Docker is not installed. Please install Docker first."
    exit 1
  fi

  if ! docker info &>/dev/null; then
    log_error "Docker daemon is not running. Please start Docker first."
    exit 1
  fi

  if ! docker compose version &>/dev/null; then
    log_error "Docker Compose v2 is required. Please update Docker."
    exit 1
  fi
}

# ── Ensure node_modules are installed ────────────────────
ensure_deps() {
  if [ ! -d "$SCRIPT_DIR/apps/backend/node_modules" ]; then
    log_warn "Backend node_modules not found. Installing..."
    (cd "$SCRIPT_DIR" && bun install)
  fi
}

# ── Cleanup handler ──────────────────────────────────────
cleanup() {
  echo ""
  log_info "Shutting down container..."
  docker compose -f "$COMPOSE_FILE" down --remove-orphans
  log_ok "Dev container stopped."
}

# ── Main ─────────────────────────────────────────────────
main() {
  check_prereqs

  local cmd="${1:-up}"

  case "$cmd" in
    up|start)
      echo -e "${BOLD}"
      echo "  ╔═══════════════════════════════════════╗"
      echo "  ║     🚀 Nougate Dev Environment        ║"
      echo "  ╚═══════════════════════════════════════╝"
      echo -e "${NC}"

      ensure_deps

      log_info "Starting dev container with file watching..."
      log_info "API      → http://localhost:${PORT:-3000}"
      log_info "Frontend → http://localhost:${PORT:-3000}/frontend/"
      echo ""
      log_info "Backend  auto-restarts on source changes (bun --watch)"
      log_info "Frontend auto-rebuilds on source changes (inotifywait)"
      echo ""

      trap cleanup EXIT INT TERM

      docker compose -f "$COMPOSE_FILE" up \
        --build \
        --remove-orphans \
        --force-recreate
      ;;

    down|stop)
      log_info "Tearing down dev container..."
      docker compose -f "$COMPOSE_FILE" down --remove-orphans --volumes
      log_ok "Dev container and volumes removed."
      ;;

    logs)
      docker compose -f "$COMPOSE_FILE" logs -f --tail=100
      ;;

    restart)
      log_info "Restarting dev container..."
      docker compose -f "$COMPOSE_FILE" restart
      log_ok "Restarted."
      ;;

    status|ps)
      docker compose -f "$COMPOSE_FILE" ps
      ;;

    *)
      echo -e "${BOLD}Usage:${NC} $0 {up|down|logs|restart|status}"
      echo ""
      echo "  up, start     Start dev container (default)"
      echo "  down, stop    Tear down container and volumes"
      echo "  logs          Tail container logs"
      echo "  restart       Restart container"
      echo "  status, ps    Show container status"
      exit 1
      ;;
  esac
}

main "$@"
