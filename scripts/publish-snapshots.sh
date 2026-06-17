#!/usr/bin/env bash
# Publish diff images (.vrt/out/*.png) to the snapshot branch under pr-<PR>/<HEAD_SHA>/.
# Replaces this PR's previous images and tolerates concurrent pushes via retry.
# Writes snap_sha + prefix to $GITHUB_OUTPUT.
#
# Env: PR, HEAD_SHA (required); SNAP_BRANCH (default vrt-snapshots)
set -euo pipefail

: "${PR:?PR required}"
: "${HEAD_SHA:?HEAD_SHA required}"
SNAP_BRANCH="${SNAP_BRANCH:-vrt-snapshots}"
PREFIX="pr-${PR}/${HEAD_SHA}"
ROOT="$PWD"
SNAP_DIR="$ROOT/.vrt/snap"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# (Re)build the snapshot worktree from origin (or an orphan if the branch is new),
# drop this PR's old images, copy in the fresh ones, and stage a commit.
apply() {
  rm -rf "$SNAP_DIR"
  git worktree prune
  git fetch origin "$SNAP_BRANCH" --depth=1 2>/dev/null || true
  if git show-ref --verify --quiet "refs/remotes/origin/$SNAP_BRANCH"; then
    git worktree add -B "$SNAP_BRANCH" "$SNAP_DIR" "origin/$SNAP_BRANCH" >/dev/null
  else
    git worktree add --detach "$SNAP_DIR" >/dev/null
    ( cd "$SNAP_DIR" && git checkout --orphan "$SNAP_BRANCH" >/dev/null 2>&1 && git rm -rfq . >/dev/null 2>&1 || true )
  fi
  rm -rf "${SNAP_DIR:?}/pr-${PR}"
  mkdir -p "$SNAP_DIR/$PREFIX"
  cp "$ROOT"/.vrt/out/*.png "$SNAP_DIR/$PREFIX/" 2>/dev/null || true
  cp "$ROOT/.vrt/out/report.json" "$SNAP_DIR/$PREFIX/" 2>/dev/null || true # for comment-triggered re-eval
  ( cd "$SNAP_DIR" && git add -A && (git diff --cached --quiet || git commit -q -m "VRT snapshots: PR #${PR} @ ${HEAD_SHA}") )
}

SNAP_SHA=""
for attempt in 1 2 3; do
  apply
  # Nothing new vs the branch tip we based on? Just reuse current HEAD.
  if git -C "$SNAP_DIR" diff --quiet "origin/$SNAP_BRANCH" 2>/dev/null; then
    SNAP_SHA="$(git -C "$SNAP_DIR" rev-parse HEAD 2>/dev/null || echo '')"
    echo "no image changes vs $SNAP_BRANCH"
    break
  fi
  if git -C "$SNAP_DIR" push origin "HEAD:$SNAP_BRANCH" 2>/dev/null; then
    SNAP_SHA="$(git -C "$SNAP_DIR" rev-parse HEAD)"
    break
  fi
  echo "push race on $SNAP_BRANCH; retry $attempt" >&2
  sleep $(( attempt * 2 ))
done

git worktree remove --force "$SNAP_DIR" 2>/dev/null || true

if [ -z "$SNAP_SHA" ]; then
  echo "WARNING: could not publish snapshots after retries" >&2
fi

{
  echo "snap_sha=$SNAP_SHA"
  echo "prefix=$PREFIX"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"
echo "Published $PREFIX -> ${SNAP_SHA:-<none>}"
