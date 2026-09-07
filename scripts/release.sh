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

# The changelog section for this version has to exist before the tag is pushed:
# the release workflow hands it to `gh release create --notes-file`, so what is
# written under [Unreleased] is what people read on the GitHub Release.
if ! grep -q '^## \[Unreleased\]' CHANGELOG.md; then
  echo "CHANGELOG.md has no '## [Unreleased]' heading to roll."
  exit 1
fi

# Refuse an empty section — a release whose notes are a blank heading is worse
# than one that falls back to the generated commit list.
if [[ -z "$(awk '/^## \[Unreleased\]/{f=1;next} f&&/^## /{exit} f' CHANGELOG.md | tr -d '[:space:]')" ]]; then
  echo "Nothing under '## [Unreleased]' in CHANGELOG.md. Write the notes first."
  exit 1
fi

# Roll [Unreleased] into a dated section for this version and leave a fresh,
# empty [Unreleased] above it for the next cycle.
TODAY="$(date +%F)"
perl -i -pe "s/^## \\[Unreleased\\]\$/## [Unreleased]\\n\\n## [$CLEAN_VERSION] \\xe2\\x80\\x94 $TODAY/" CHANGELOG.md

# Bump package.json only. The committed manifests deliberately keep a static
# placeholder version: scripts/build.mjs stamps the real one in as it writes
# dist-*/manifest.json, taking it from the release tag (JIFFY_VERSION in CI) and
# falling back to package.json for local builds. Rewriting them here as well
# would give the version two homes and let them drift.
perl -i -pe "s/\"version\": \"[^\"]*\"/\"version\": \"$CLEAN_VERSION\"/" package.json

git add package.json CHANGELOG.md
git commit -m "Release $CLEAN_VERSION"

echo "Creating and pushing tag: $TAG"
git tag "$TAG"
git push origin HEAD "$TAG"
echo "Done. Watch the workflow at: https://github.com/$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/')/actions"
