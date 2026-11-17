#!/usr/bin/env bash
set -euo pipefail

IMAGE="${MOEX_IMAGE:-moex:latest}"
BIN_DIR="${MOEX_BIN_DIR:-}"
MODE="native"
MODE_EXPLICIT=""
PULL_POLICY="always"
LOCAL_BUILD=0
IMAGE_FLAG=0
NO_PULL_FLAG=0

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
  --host-build         Compile native binary directly on host using local Bun (no Docker required)
  --no-pull            Skip `docker pull` and use already-cached local image
  --docker-wrapper     Install a `docker run` shell wrapper instead of extracting native binary
  -h, --help           Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)
      if [[ $# -lt 2 || -z "${2:-}" || "${2}" == -* ]]; then
        echo "[moex-install] Error: --image requires a valid value." >&2
        exit 1
      fi
      IMAGE="$2"
      IMAGE_FLAG=1
      shift 2
      ;;
    --bin-dir)
      if [[ $# -lt 2 || -z "${2:-}" || "${2}" == -* ]]; then
        echo "[moex-install] Error: --bin-dir requires a valid path." >&2
        exit 1
      fi
      BIN_DIR="$2"
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
    --host-build)
      if [[ -n "$MODE_EXPLICIT" && "$MODE_EXPLICIT" != "host-build" ]]; then
        echo "[moex-install] Error: --host-build cannot be combined with --docker-wrapper." >&2
        exit 1
      fi
      MODE="host-build"
      MODE_EXPLICIT="host-build"
      shift
      ;;
    --no-pull)
      PULL_POLICY="never"
      NO_PULL_FLAG=1
      shift
      ;;
    --docker-wrapper)
      if [[ -n "$MODE_EXPLICIT" && "$MODE_EXPLICIT" != "wrapper" ]]; then
        echo "[moex-install] Error: --docker-wrapper cannot be combined with --host-build." >&2
        exit 1
      fi
      MODE="wrapper"
      MODE_EXPLICIT="wrapper"
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

if [[ "$MODE" == "host-build" && ( "$LOCAL_BUILD" -eq 1 || "$NO_PULL_FLAG" -eq 1 || "$IMAGE_FLAG" -eq 1 ) ]]; then
  echo "[moex-install] Error: --host-build cannot be combined with Docker options (--local, --no-pull, --image)." >&2
  exit 1
fi

if [[ -z "$BIN_DIR" ]]; then
  if [[ -z "${HOME:-}" ]]; then
    echo "[moex-install] Error: HOME is not set; specify --bin-dir <path> explicitly." >&2
    exit 1
  fi
  BIN_DIR="${HOME}/.local/bin"
fi

while [[ "$BIN_DIR" != "/" && "$BIN_DIR" == */ ]]; do
  BIN_DIR="${BIN_DIR%/}"
done

OS_NAME="$(uname -s)"
if [[ "$MODE" == "native" && "$OS_NAME" != "Linux" ]]; then
  if [[ "$LOCAL_BUILD" -eq 1 ]] && command -v bun >/dev/null 2>&1 && [[ -f "./src/index.ts" && -f "./package.json" && -f "./Dockerfile" ]]; then
    echo "[moex-install] Notice: Host OS is '${OS_NAME}' and Bun is available; using --host-build for native binary."
    MODE="host-build"
  else
    echo "[moex-install] Notice: Host OS is '${OS_NAME}'. Native binary in '${IMAGE}' targets Linux; switching to --docker-wrapper mode."
    MODE="wrapper"
  fi
fi

if [[ "$MODE" != "host-build" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "[moex-install] Error: docker CLI not found. Install Docker first or use --host-build with Bun." >&2
    exit 1
  fi

  if ! docker info >/dev/null 2>&1; then
    echo "[moex-install] Error: Docker daemon is not reachable. Start Docker and retry (or use --host-build)." >&2
    exit 1
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
fi

mkdir -p "$BIN_DIR"
TARGET_BIN="${BIN_DIR}/moex"

if [[ "$MODE" == "host-build" ]]; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "[moex-install] Error: --host-build requires 'bun' in PATH." >&2
    exit 1
  fi
  if [[ ! -f "./src/index.ts" || ! -f "./package.json" ]]; then
    echo "[moex-install] Error: --host-build must be run from the moex repository root." >&2
    exit 1
  fi
  echo "[moex-install] Installing dependencies via bun..."
  bun install --frozen-lockfile --offline >/dev/null 2>&1 || bun install --frozen-lockfile
  TMP_HOST_BIN="${BIN_DIR}/.moex.host.tmp.$$"
  trap 'rm -f "$TMP_HOST_BIN" >/dev/null 2>&1 || true' INT TERM EXIT
  echo "[moex-install] Compiling native 'moex' binary on host (${OS_NAME})..."
  bun build \
    --compile \
    --minify \
    --no-compile-autoload-dotenv \
    --no-compile-autoload-bunfig \
    --outfile "$TMP_HOST_BIN" \
    src/index.ts
  chmod 0755 "$TMP_HOST_BIN"
  mv -f "$TMP_HOST_BIN" "$TARGET_BIN"
elif [[ "$MODE" == "native" ]]; then
  CONTAINER_ID=""
  TMP_BIN="${BIN_DIR}/.moex.tmp.$$"

  cleanup() {
    if [[ -n "$CONTAINER_ID" ]]; then
      docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true
    fi
    rm -f "$TMP_BIN" >/dev/null 2>&1 || true
  }
  trap cleanup INT TERM EXIT

  echo "[moex-install] Extracting native 'moex' binary from '${IMAGE}'..."
  CONTAINER_ID="$(docker create "$IMAGE")"
  docker cp "${CONTAINER_ID}:/usr/local/bin/moex" "$TMP_BIN"
  chmod 0755 "$TMP_BIN"
  mv -f "$TMP_BIN" "$TARGET_BIN"
else
  echo "[moex-install] Installing Docker wrapper script to '${TARGET_BIN}'..."
  TMP_WRAPPER="${BIN_DIR}/.moex.wrapper.tmp.$$"
  trap 'rm -f "$TMP_WRAPPER" >/dev/null 2>&1 || true' INT TERM EXIT
  printf -v ESCAPED_IMAGE '%q' "$IMAGE"
  cat >"$TMP_WRAPPER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
HOST_HOME="\${HOME:-/tmp}"
MOEX_DATA_DIR="\${XDG_DATA_HOME:-\$HOST_HOME/.local/share}/moex"
mkdir -p "\$MOEX_DATA_DIR"
MOUNT_ROOT="\${MOEX_WORKSPACE_ROOT:-\$HOST_HOME}"
CUR_DIR="\$(pwd)"
EXTRA_MOUNT_ARGS=()
if [[ "\$MOUNT_ROOT" != "/" && "\$CUR_DIR" != "\$MOUNT_ROOT" && "\$CUR_DIR" != "\$MOUNT_ROOT/"* ]]; then
  EXTRA_MOUNT_ARGS=("-v" "\${CUR_DIR}:\${CUR_DIR}")
fi
exec docker run --rm -i \\
  --user "\$(id -u):\$(id -g)" \\
  -e "HOME=/home/moex" \\
  -v "\${MOEX_DATA_DIR}:/data" \\
  -e "MOEX_DB_PATH=/data/tasklist.db" \\
  -v "\${MOUNT_ROOT}:\${MOUNT_ROOT}" \\
  "\${EXTRA_MOUNT_ARGS[@]}" \\
  -w "\$CUR_DIR" \\
  ${ESCAPED_IMAGE} "\$@"
EOF
  chmod 0755 "$TMP_WRAPPER"
  mv -f "$TMP_WRAPPER" "$TARGET_BIN"
fi

echo "[moex-install] Installed: $("$TARGET_BIN" --version) -> ${TARGET_BIN}"

case ":${PATH:-}:" in
  *":${BIN_DIR}:"*)
    ;;
  *)
    echo "[moex-install] Note: '${BIN_DIR}' is not in your current PATH."
    echo "  Add it with: export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac

echo "[moex-install] Ready! Run 'moex init' inside any project root to start."
