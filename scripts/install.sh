#!/usr/bin/env bash
set -euo pipefail

IMAGE="${MOEX_IMAGE:-moex:latest}"
BIN_DIR="${MOEX_BIN_DIR:-}"
MODE="native"
PULL_POLICY="always"
LOCAL_BUILD=0

print_usage() {
  cat <<'EOF'
moex installer — Install the `moex` CLI & MCP server from the Docker image.

Usage:
  install.sh [options]

Options:
  --image <name:tag>   Docker image to install from (default: moex:latest)
  --bin-dir <path>     Target directory for the `moex` command (default: ~/.local/bin)
  --system             Install into /usr/local/bin
  --local              Build Docker image locally from current repo Dockerfile (if present)
  --no-pull            Skip `docker pull` and use already-cached local image
  --docker-wrapper     Install a `docker run` shell wrapper instead of extracting native binary
  -h, --help           Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)
      IMAGE="${2:-}"
      if [[ -z "$IMAGE" ]]; then
        echo "[moex-install] Error: --image requires a value." >&2
        exit 1
      fi
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="${2:-}"
      if [[ -z "$BIN_DIR" ]]; then
        echo "[moex-install] Error: --bin-dir requires a value." >&2
        exit 1
      fi
      shift 2
      ;;
    --system)
      BIN_DIR="/usr/local/bin"
      shift
      ;;
    --local)
      LOCAL_BUILD=1
      PULL_POLICY="never"
      shift
      ;;
    --no-pull)
      PULL_POLICY="never"
      shift
      ;;
    --docker-wrapper)
      MODE="wrapper"
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "[moex-install] Error: Unknown argument '$1'." >&2
      print_usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$BIN_DIR" ]]; then
  BIN_DIR="${HOME}/.local/bin"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[moex-install] Error: docker CLI not found. Install Docker first." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[moex-install] Error: Docker daemon is not reachable. Start Docker and retry." >&2
  exit 1
fi

OS_NAME="$(uname -s)"
if [[ "$MODE" == "native" && "$OS_NAME" != "Linux" ]]; then
  echo "[moex-install] Notice: Host OS is '${OS_NAME}'. Native binary in '${IMAGE}' targets Linux; switching to --docker-wrapper mode."
  MODE="wrapper"
fi

if [[ "$LOCAL_BUILD" -eq 1 ]]; then
  if [[ ! -f "./Dockerfile" ]]; then
    echo "[moex-install] Error: --local requested but ./Dockerfile not found in $(pwd)." >&2
    exit 1
  fi
  echo "[moex-install] Building Docker image '${IMAGE}' locally..."
  docker build -t "$IMAGE" .
elif [[ "$PULL_POLICY" == "always" ]]; then
  echo "[moex-install] Pulling Docker image '${IMAGE}'..."
  docker pull "$IMAGE"
else
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "[moex-install] Error: Local Docker image '${IMAGE}' not found." >&2
    exit 1
  fi
fi

mkdir -p "$BIN_DIR"
TARGET_BIN="${BIN_DIR}/moex"

if [[ "$MODE" == "native" ]]; then
  CONTAINER_ID=""
  TMP_BIN="${BIN_DIR}/.moex.tmp.$$"

  cleanup() {
    if [[ -n "$CONTAINER_ID" ]]; then
      docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true
    fi
    rm -f "$TMP_BIN" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT

  echo "[moex-install] Extracting native 'moex' binary from '${IMAGE}'..."
  CONTAINER_ID="$(docker create "$IMAGE")"
  docker cp "${CONTAINER_ID}:/usr/local/bin/moex" "$TMP_BIN"
  chmod 0755 "$TMP_BIN"
  mv -f "$TMP_BIN" "$TARGET_BIN"
else
  echo "[moex-install] Installing Docker wrapper script to '${TARGET_BIN}'..."
  TMP_WRAPPER="${BIN_DIR}/.moex.wrapper.tmp.$$"
  cat >"$TMP_WRAPPER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
MOEX_DATA_DIR="\${XDG_DATA_HOME:-\$HOME/.local/share}/moex"
mkdir -p "\$MOEX_DATA_DIR"
MOUNT_ROOT="\${MOEX_WORKSPACE_ROOT:-\$HOME}"
exec docker run --rm -i \\
  --user "\$(id -u):\$(id -g)" \\
  -v "\${MOEX_DATA_DIR}:/data" \\
  -e "MOEX_DB_PATH=/data/tasklist.db" \\
  -v "\${MOUNT_ROOT}:\${MOUNT_ROOT}" \\
  -w "\$(pwd)" \\
  "${IMAGE}" "\$@"
EOF
  chmod 0755 "$TMP_WRAPPER"
  mv -f "$TMP_WRAPPER" "$TARGET_BIN"
fi

echo "[moex-install] Installed: $("$TARGET_BIN" --version) -> ${TARGET_BIN}"

case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    ;;
  *)
    echo "[moex-install] Note: '${BIN_DIR}' is not in your current PATH."
    echo "  Add it with: export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac

echo "[moex-install] Ready! Run 'moex init' inside any project root to start."
