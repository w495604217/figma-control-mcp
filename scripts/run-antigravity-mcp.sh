#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

STATE_DIR_DEFAULT="${REPO_ROOT}/.figma-control-mcp"
STATE_PATH_DEFAULT="${STATE_DIR_DEFAULT}/bridge-state.json"
BRIDGE_PORT_DEFAULT="3847"

export FIGMA_CONTROL_MCP_STATE_PATH="${FIGMA_CONTROL_MCP_STATE_PATH:-${STATE_PATH_DEFAULT}}"
export FIGMA_CONTROL_BRIDGE_PORT="${FIGMA_CONTROL_BRIDGE_PORT:-${BRIDGE_PORT_DEFAULT}}"
export FIGMA_CONTROL_BRIDGE_TOKEN="${FIGMA_CONTROL_BRIDGE_TOKEN:-}"

mkdir -p "$(dirname "${FIGMA_CONTROL_MCP_STATE_PATH}")"

if [[ ! -f "${REPO_ROOT}/dist/index.js" ]]; then
  echo "figma-control-mcp: dist/index.js not found, running npm run build" >&2
  (cd "${REPO_ROOT}" && npm run build >/dev/null)
fi

exec node "${REPO_ROOT}/dist/index.js"
