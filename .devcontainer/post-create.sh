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

claude_dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
claude_json=${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json

# The volume is root-owned on first creation, update to the container user.
mkdir -p "$claude_dir"
if [ "$(stat -c %u "$claude_dir")" != "$(id -u)" ]; then
    sudo chown -R "$(id -u):$(id -g)" "$claude_dir"
fi

# Skip onboarding and the per-folder trust dialog. Merge rather than overwrite.
claude_config=$(jq -n --arg dir "$PWD" '{
    hasCompletedOnboarding: true,
    projects: { ($dir): { hasTrustDialogAccepted: true } }
}')
if [ -f "$claude_json" ]; then
    jq --argjson add "$claude_config" '. * $add' "$claude_json" > "$claude_json.tmp"
else
    printf '%s\n' "$claude_config" > "$claude_json.tmp"
fi
mv "$claude_json.tmp" "$claude_json"

# The claude-code feature installs the package as root-owned, so
# in-place auto-updates fail with "no_permissions". Hand it to the container user.
npm_root=$(npm root -g)
if [ -d "$npm_root/@anthropic-ai" ]; then
    sudo chown -R "$(id -u):$(id -g)" "$npm_root/@anthropic-ai"
fi

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
