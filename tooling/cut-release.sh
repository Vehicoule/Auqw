#!/bin/sh
# Cut a release: verify prerequisites, compute the tag, push it, and
# print draft release notes. The release workflow (triggered by the
# v* tag) does the building and publishing — this script automates the
# manual ritual around it documented in RELEASING.md.
#
# Usage: tooling/cut-release.sh <version>   (e.g. 0.0.1-alpha.2)
#        tooling/cut-release.sh --notes <version>  # notes only, no tag
#
# Checks before tagging: on main, tree clean, upstream synced, version
# strictly greater than the latest existing tag, CI green on origin/main.
set -e
cd "$(dirname "$0")/.."

notes_only=0
case "$1" in
    --notes) notes_only=1; shift ;;
esac
version="${1:?usage: tooling/cut-release.sh <version> | --notes <version>}"
tag="v${version#v}"

latest_tag="$(git tag --list 'v*' --sort=-v:refname | head -1)"
echo "==> latest tag: ${latest_tag:-none}"

range="${latest_tag:+$latest_tag..}HEAD"
echo "==> commits in ${range:-history}:"
git log --oneline "${range:-HEAD}"

if [ "$notes_only" = 1 ]; then
    echo
    echo "---- draft notes ----"
    git log --format='- %s' "$range" | sed 's/ (\#[0-9]*)$//'
    exit 0
fi

[ -n "$(git status --porcelain)" ] && { echo "cut-release: tree not clean" >&2; exit 1; }
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || { echo "cut-release: not on main (on $branch)" >&2; exit 1; }
git fetch origin main --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || {
    echo "cut-release: HEAD != origin/main — sync first" >&2; exit 1; }

node tooling/stamp-version.mjs --check >/dev/null && echo "==> manifest version-line consistent"

if [ -n "$latest_tag" ]; then
    newest=$(printf '%s\n%s\n' "${latest_tag#v}" "$version" | sort -V | tail -1)
    [ "$newest" = "$version" ] || { echo "cut-release: $version not newer than $latest_tag" >&2; exit 1; }
fi

conclusion=$(gh run list --branch main --limit 5 --json conclusion,headSha --jq '[.[] | select(.headSha == "'"$(git rev-parse HEAD)"'")][0].conclusion')
if [ "$conclusion" != "success" ]; then
    echo "cut-release: latest CI run on this HEAD is not green (conclusion: ${conclusion:-none found})" >&2
    exit 1
fi

echo "==> tagging $tag"
notes_file="$(mktemp)"
git log --format='- %s' "$range" | sed 's/ (\#[0-9]*)$//' > "$notes_file"
git tag -a "$tag" -m "Release ${tag#v}" -m "$(cat "$notes_file")"
git push origin "$tag"
echo "==> pushed $tag — release.yml is running"
echo "    draft notes:"
cat "$notes_file"
rm -f "$notes_file"
