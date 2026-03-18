#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${LMSTUDIO_E2E_SKIP_INSTALL:-0}" != "1" ]; then
  node "$ROOT/scripts/install-local.js" --yes
fi
node "$ROOT/scripts/e2e-runner.js" list
