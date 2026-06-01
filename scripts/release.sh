#!/usr/bin/env bash
set -euo pipefail

TAG="release/${1:-$(date +%Y%m%d)}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag '$TAG' already exists."
  exit 1
fi

echo "Creating and pushing tag: $TAG"
git tag "$TAG"
git push origin "$TAG"
echo "Done. Watch the workflow at: https://github.com/$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/')/actions"
