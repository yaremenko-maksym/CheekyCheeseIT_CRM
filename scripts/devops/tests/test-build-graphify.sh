#!/usr/bin/env bash
# test-build-graphify.sh — proves scripts/devops/build-graphify.sh cannot report success
# for a graph that was not built, or built by the LLM path.
#
# WHAT THE RED IS WORTH: the script's claim is "OK means a local, code-only, AST graph
# containing SQL and shell was just produced". A test that only ran the happy path would
# be satisfied by a script whose body is `echo OK`. So every refusal the script makes is
# provoked here with a fake `graphify` (lib/fake-graphify.sh) that does exactly the bad
# thing: writes nothing, writes semantic edges, writes markdown nodes, writes a stale
# commit, drops the SQL grammar, reports the wrong version.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

BUILD="$GUARD_DIR/build-graphify.sh"
FAKE="$SELF_DIR/lib/fake-graphify.sh"

echo "== test-build-graphify.sh =="
echo

for f in "$BUILD" "$FAKE"; do
  if ! bash -n "$f" 2>/dev/null; then
    echo "FATAL: syntax error in $f"
    bash -n "$f"
    exit 1
  fi
done

TMP=$(mktemp -d "${TMPDIR:-/tmp}/build-graphify-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

# mk_case <name> [mode] [ver] [sqlver] — a fake tool dir plus a fake repo with one commit.
mk_case() {
  local d="$TMP/$1"
  mkdir -p "$d/bin" "$d/repo"
  cp "$FAKE" "$d/bin/graphify" && chmod +x "$d/bin/graphify"
  printf '%s\n' "${2:-}" >"$d/bin/mode"
  printf '%s\n' "${3:-0.9.93}" >"$d/bin/ver"
  # stand-in for the tool venv's python: answers the tree-sitter-sql version probe
  printf '#!/bin/sh\necho "%s"\n' "${4:-0.3.11}" >"$d/bin/python"
  chmod +x "$d/bin/python"
  (cd "$d/repo" && git init -q . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init)
}

# run_build <name> [args...]
run_build() {
  local d="$TMP/$1"
  shift
  GRAPHIFY_BIN="$d/bin/graphify" GRAPHIFY_REPO_ROOT="$d/repo" bash "$BUILD" "$@" 2>&1
}

mk_case good
assert_green "a clean code-only build is published and says OK with the SQL and shell counts" \
  --contains "build-graphify: OK" --contains "12 sql files" --contains "40 sh files" \
  -- bash -c "$(declare -f run_build); TMP='$TMP'; BUILD='$BUILD'; run_build good"
assert_green "the published graph is at graphify-out/graph.json in the repo" \
  -- test -s "$TMP/good/repo/graphify-out/graph.json"
assert_green "the tool was invoked with --code-only and --no-viz" \
  --contains "--code-only" --contains "--no-viz" \
  -- cat "$TMP/good/bin/argv.log"
assert_green "the tool was NOT invoked with --no-gitignore or --postgres" \
  --not-contains "--no-gitignore" --not-contains "--postgres" \
  -- cat "$TMP/good/bin/argv.log"

# env scrub: a key present in the caller's environment must not reach the tool.
mk_case envscrub
assert_green "the build runs" \
  -- bash -c "ANTHROPIC_API_KEY=sk-canary OPENAI_API_KEY=sk-canary2 HTTPS_PROXY=http://x \
       GRAPHIFY_BIN='$TMP/envscrub/bin/graphify' GRAPHIFY_REPO_ROOT='$TMP/envscrub/repo' bash '$BUILD' >/dev/null 2>&1"
assert_green "no API key, base URL or proxy from the caller's environment reached the tool" \
  --not-contains "sk-canary" --not-contains "ANTHROPIC" --not-contains "OPENAI" --not-contains "PROXY" \
  -- cat "$TMP/envscrub/bin/env.log"

# ── the negative cases: what "OK" must never be confused with ───────────────────
assert_red "arguments are refused (the flags are fixed; nothing is passed through)" \
  --contains "takes no arguments" \
  -- bash -c "GRAPHIFY_BIN='$TMP/good/bin/graphify' GRAPHIFY_REPO_ROOT='$TMP/good/repo' bash '$BUILD' --no-gitignore 2>&1"

mk_case nobuild none
assert_red "exit 0 from the tool but no graph written is 'nothing was built', not success" \
  --contains "nothing was built" \
  -- bash -c "$(declare -f run_build); TMP='$TMP'; BUILD='$BUILD'; run_build nobuild"
assert_red "...and no graphify-out was published" \
  -- test -e "$TMP/nobuild/repo/graphify-out"

mk_case toolfail fail
assert_red "a failing tool is a failure" \
  --contains "exited non-zero" \
  -- bash -c "$(declare -f run_build); TMP='$TMP'; BUILD='$BUILD'; run_build toolfail"

mk_case wrongver "" 0.9.94
assert_red "a different graphify version is refused" \
  --contains "pinned" \
  -- bash -c "$(declare -f run_build); TMP='$TMP'; BUILD='$BUILD'; run_build wrongver"

mk_case wrongsql "" 0.9.93 0.3.10
assert_red "a different tree-sitter-sql version is refused" \
  --contains "tree-sitter-sql" \
  -- bash -c "$(declare -f run_build); TMP='$TMP'; BUILD='$BUILD'; run_build wrongsql"

mk_case oldver oldver
assert_red "a graph stamped by a different graphify version is refused" \
  --contains "graph written by graphify" \
  -- bash -c "$(declare -f run_build); TMP='$TMP'; BUILD='$BUILD'; run_build oldver"

mk_case llm llm
assert_red "semantic (non-AST) edges are refused: the LLM path ran" \
  --contains "only 'ast' is allowed" \
  -- bash -c "$(declare -f run_build); TMP='$TMP'; BUILD='$BUILD'; run_build llm"

mk_case hyper hyper
assert_red "hyperedges (semantic output) are refused" \
  --contains "hyperedges" \
  -- bash -c "$(declare -f run_build); TMP='$TMP'; BUILD='$BUILD'; run_build hyper"

mk_case md md
assert_red "a markdown source in the graph is refused (markdown must not be indexed)" \
  --contains "doc/image/.env sources" \
  -- bash -c "$(declare -f run_build); TMP='$TMP'; BUILD='$BUILD'; run_build md"

mk_case envfile env
assert_red "an .env* source in the graph is refused" \
  --contains "doc/image/.env sources" \
  -- bash -c "$(declare -f run_build); TMP='$TMP'; BUILD='$BUILD'; run_build envfile"

mk_case assets assets
assert_red "the excluded design bundles reappearing is refused" \
  --contains ".graphifyignore not applied" \
  -- bash -c "$(declare -f run_build); TMP='$TMP'; BUILD='$BUILD'; run_build assets"

mk_case nosql nosql
assert_red "a graph with no SQL files (grammar missing) is refused: it adds nothing over codegraph" \
  --contains ".sql files" \
  -- bash -c "$(declare -f run_build); TMP='$TMP'; BUILD='$BUILD'; run_build nosql"

mk_case small small
assert_red "a graph under the node floor is refused" \
  --contains "floor" \
  -- bash -c "$(declare -f run_build); TMP='$TMP'; BUILD='$BUILD'; run_build small"

mk_case stale stalecommit
assert_red "a graph not built at HEAD is refused" \
  --contains "built_at_commit" \
  -- bash -c "$(declare -f run_build); TMP='$TMP'; BUILD='$BUILD'; run_build stale"

# A refused build must not destroy the previous good graph.
mk_case keep llm
mkdir -p "$TMP/keep/repo/graphify-out" && echo previous >"$TMP/keep/repo/graphify-out/graph.json"
run_build keep >/dev/null
assert_green "a refused build leaves the previous graphify-out untouched" \
  --contains "previous" \
  -- cat "$TMP/keep/repo/graphify-out/graph.json"

# The script text itself: the forbidden switches may appear in comments only.
assert_green "no executable line of the script mentions --no-gitignore or --postgres" \
  --not-contains "--no-gitignore" --not-contains "--postgres" \
  -- bash -c "grep -v '^[[:space:]]*#' '$BUILD' | grep -E -e '--no-gitignore|--postgres' || true"
assert_green "the one extract invocation carries --code-only" \
  --contains "--code-only" \
  -- bash -c "grep -E '\"\\\$BIN\" extract' '$BUILD'"

guard_test_summary "test-build-graphify.sh"
