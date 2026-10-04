#!/bin/sh
# Cut a release: verify prerequisites, compute the tag, push it, and
# print draft release notes. The release workflow (triggered by the
# v* tag) does the building and publishing — this script automates the
# manual ritual around it documented in RELEASING.md.
#
# Usage: tooling/cut-release.sh <version>   (e.g. 0.0.1-alpha.2)
#        tooling/cut-release.sh --notes <version>  # notes only, no tag
#
# Checks before tagging: on main, tree clean, upstream synced, manifest
# version-line consistent, version orderable and strictly newer than
# every existing tag (versionCode ordering — a stable outranks its own
# prereleases), ci.yml green on origin/main.
set -e
cd "$(dirname "$0")/.."

notes_only=0
case "$1" in
    --notes) notes_only=1; shift ;;
esac
version="${1:?usage: tooling/cut-release.sh <version> | --notes <version>}"
version="${version#v}"
tag="v$version"

# Fresh refs before any baseline is derived — local tags can lag
# origin, and a stale latest_tag makes both the ordering gate and the
# notes range lie.
git fetch origin main --tags

# The baseline is the newest tag by the upgrade order Android actually
# enforces — versionCodeOf — not git/version sort, which ranks a stable
# below its own prereleases (v0.0.1-alpha.25 > v0.0.1) and would pick
# the wrong notes range once a bare stable ships.
# shellcheck disable=SC2046 # tag names carry no spaces/globs — splitting intended
latest_tag="$(node --input-type=module -e '
import { versionCodeOf } from "./tooling/version-code.mjs";
let best = null, bestCode = -1;
for (const t of process.argv.slice(1)) {
    const c = versionCodeOf(t.replace(/^v/, ""));
    if (c !== null && c > bestCode) { bestCode = c; best = t; }
}
if (best !== null) console.log(best);
' $(git tag -l 'v*'))"
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
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || {
    echo "cut-release: HEAD != origin/main — sync first" >&2; exit 1; }

# A command inside an AND list is exempt from `set -e` — a failing
# --check would only skip the echo and let tagging proceed, so this
# gate must exit explicitly like the checks around it.
node tooling/stamp-version.mjs --check >/dev/null || {
    echo "cut-release: manifest version-lines inconsistent" >&2; exit 1; }
echo "==> manifest version-line consistent"

# versionCodeOf is the upgrade order Android enforces. sort -V orders
# a stable below its own prereleases (0.0.1 < 0.0.1-alpha.23), so it
# cannot gate releases: the version must be orderable on its own
# (unknown channels and out-of-range counters die here instead of at
# the release stamp) and strictly above every existing tag.
# shellcheck disable=SC2046 # tag names carry no spaces/globs — splitting intended
node --input-type=module -e '
import { versionCodeOf } from "./tooling/version-code.mjs";
const version = process.argv[1];
const code = versionCodeOf(version);
if (code === null) {
    console.error(`cut-release: ${version} is not an orderable release version — want x.y.z or x.y.z-<alpha|beta|rc>.<n>`);
    process.exit(1);
}
let maxTag = null, maxCode = -1;
for (const t of process.argv.slice(2)) {
    const c = versionCodeOf(t.replace(/^v/, ""));
    if (c !== null && c > maxCode) { maxCode = c; maxTag = t; }
}
if (maxTag !== null && code <= maxCode) {
    console.error(`cut-release: ${version} not newer than ${maxTag}`);
    process.exit(1);
}
' "$version" $(git tag -l 'v*')
echo "==> $version orderable and newer than all existing tags"

# ci.yml is the release gate (release.yml calls it as a reusable
# workflow); android-cache-warm also runs on main pushes, so an
# unfiltered run list can read the wrong workflow's result. Pin the
# workflow and the exact SHA.
head_sha="$(git rev-parse HEAD)"
conclusion=$(gh run list --workflow ci.yml --branch main --commit "$head_sha" --limit 1 --json conclusion --jq '.[0].conclusion // ""')
if [ "$conclusion" != "success" ]; then
    echo "cut-release: ci.yml run on $head_sha not green (conclusion: ${conclusion:-none found})" >&2
    exit 1
fi
echo "==> ci green on $head_sha"

echo "==> tagging $tag"
notes="$(git log --format='- %s' "$range" | sed 's/ (\#[0-9]*)$//')"
git tag -a "$tag" -m "Release ${tag#v}" -m "$notes"
git push origin "$tag"
echo "==> pushed $tag — release.yml is running"
echo "    draft notes:"
echo "$notes"
