#!/usr/bin/env bash
#
# codegraph-patch-ignore-claude.sh
#
# Adds `.claude` to CodeGraph's hard-coded DEFAULT_IGNORE_DIRS so the indexer +
# file-watcher skip the whole `.claude/` tree — most importantly the nested git
# worktrees under `.claude/worktrees/<name>/`.
#
# WHY THIS IS NEEDED (CodeGraph issue #514 behaviour):
#   Our agent factory creates LINKED git worktrees under `.claude/worktrees/`.
#   Each is its own git boundary (own `.git` file, same git-common-dir). CodeGraph
#   deliberately discovers gitignored embedded git repos and indexes them anyway,
#   UNIFORMLY overriding the parent `.gitignore` (it's a multi-repo "super-repo"
#   feature). Result: every symbol in the main checkout is duplicated once per
#   live worktree (we measured 7.4k -> 94k nodes with 12 worktrees). There is no
#   config / `.codegraphignore` opt-out; the ONLY filter that applies to embedded
#   repos is the hard-coded DEFAULT_IGNORE_DIRS set in the bundled extractor.
#
# This patch edits the installed (per-platform) bundle. It is LOST on
# `codegraph upgrade` / reinstall — re-run this script afterwards, then reindex:
#     bash scripts/devops/codegraph-patch-ignore-claude.sh
#     codegraph index . --force
#
# Idempotent: detects the sentinel and no-ops if already patched.
# See docs/architecture/2026-06-12-codegraph-adoption.md.
set -euo pipefail

SENTINEL="CRM-PATCH:ignore-claude"
GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
if [ -z "$GLOBAL_ROOT" ]; then
  echo "codegraph-patch: could not resolve 'npm root -g'." >&2
  exit 1
fi

# The heavy logic ships as a per-platform optionalDependency nested under the
# main package: @colbymchenry/codegraph/node_modules/@colbymchenry/codegraph-<os>-<arch>/
# (bash 3.2 on macOS has no `mapfile`; node_modules paths have no spaces/newlines).
OLDIFS="$IFS"; IFS=$'\n'
TARGETS=( $(find "$GLOBAL_ROOT/@colbymchenry" -path '*/lib/dist/extraction/index.js' 2>/dev/null || true) )
IFS="$OLDIFS"

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "codegraph-patch: extraction/index.js not found under $GLOBAL_ROOT/@colbymchenry." >&2
  echo "  Is CodeGraph installed? (npm i -g @colbymchenry/codegraph)" >&2
  exit 1
fi

patched_any=0
for f in "${TARGETS[@]}"; do
  if grep -q "$SENTINEL" "$f"; then
    echo "codegraph-patch: already patched -> $f"
    continue
  fi
  if ! grep -q 'DEFAULT_IGNORE_DIRS = new Set(\[' "$f"; then
    echo "codegraph-patch: anchor 'DEFAULT_IGNORE_DIRS = new Set([' not found in $f — bundle layout changed, patch manually." >&2
    continue
  fi
  # Insert `.claude` as the first element right after the Set declaration line
  # (the most version-stable anchor).
  # `.js` suffix so `node --check` below treats it as CommonJS (a bare mktemp
  # name has no extension -> ERR_UNKNOWN_FILE_EXTENSION, a false failure).
  tmp="$(mktemp)"; mv "$tmp" "$tmp.js"; tmp="$tmp.js"
  # q = a single-quote char passed in (portable across awk variants; macOS awk
  # has no \xNN escape).
  awk -v sentinel="$SENTINEL" -v q="'" '
    { print }
    /DEFAULT_IGNORE_DIRS = new Set\(\[/ && !done {
      print "    " q ".claude" q ", // " sentinel " — keep .claude/ (incl. nested worktree checkouts) out of the code graph"
      done = 1
    }
  ' "$f" > "$tmp"
  # Sanity: the patched file must still parse as JS.
  if node --check "$tmp" 2>/dev/null; then
    cat "$tmp" > "$f"
    rm -f "$tmp"
    echo "codegraph-patch: patched -> $f"
    patched_any=1
  else
    rm -f "$tmp"
    echo "codegraph-patch: refused — patched file failed 'node --check' for $f (left untouched)." >&2
    exit 1
  fi
done

if [ "$patched_any" -eq 1 ]; then
  echo "codegraph-patch: done. Now rebuild the index:  codegraph index . --force"
fi
