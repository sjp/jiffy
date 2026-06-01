#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>  (e.g. v1.2.0 or 1.2.0)"
  exit 1
fi

# Strip optional leading 'v'
CLEAN_VERSION="${VERSION#v}"

# Validate: 1–4 dot-separated integers (matches build script regex)
if ! [[ "$CLEAN_VERSION" =~ ^[0-9]+(\.[0-9]+){0,3}$ ]]; then
  echo "Invalid version: '$CLEAN_VERSION'. Expected format: 1.2.0"
  exit 1
fi

TAG="release/$CLEAN_VERSION"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag '$TAG' already exists."
  exit 1
fi

# Bump version in source files
perl -i -pe "s/\"version\": \"[^\"]*\"/\"version\": \"$CLEAN_VERSION\"/" package.json manifest.chrome.json manifest.firefox.json

git add package.json manifest.chrome.json manifest.firefox.json
git commit -m "Release $CLEAN_VERSION"

echo "Creating and pushing tag: $TAG"
git tag "$TAG"
git push origin HEAD "$TAG"
echo "Done. Watch the workflow at: https://github.com/$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/')/actions"
