#!/usr/bin/env bash
set -euo pipefail

# Mozilla's extension CLI — used in-container for `web-ext lint` and
# `web-ext build`. `web-ext run` (which launches Firefox) is intended to be
# run on the host, against the bind-mounted workspace.
if ! command -v web-ext >/dev/null 2>&1; then
  npm install -g web-ext
fi

if [ -f package.json ]; then
  npm install
fi

sudo chown -R $(id -u):$(id -g) ~/.claude
echo '{"hasCompletedOnboarding":true,"numStartups":1,"installMethod":"npm"}' > ~/.claude.json

cat <<'EOF'

──────────────────────────────────────────────────────────────────────
  Jiffy devcontainer ready.

  In-container (build / lint / package):
    npm run build              # once a build script exists
    web-ext lint -s dist/
    web-ext build -s dist/ -a web-ext-artifacts/

  On the macOS host (run / debug):
    web-ext run -s dist/       # launches Firefox with the extension
    -- or --
    Firefox → about:debugging#/runtime/this-firefox
           → Load Temporary Add-on → pick dist/manifest.json
──────────────────────────────────────────────────────────────────────

EOF
