#!/usr/bin/env bash
# test-build-graphify.sh — proves scripts/devops/build-graphify.sh cannot report success
# for a graph that was not built, or built by the LLM path.
#
# WHAT THE RED IS WORTH: the script's claim is "OK means a local, code-only, AST graph that
# covers the repository's SQL, shell and code was just produced". A test that only ran the
# happy path would be satisfied by a script whose body is `echo OK`. So every refusal is
# provoked here with a fake `graphify` (lib/fake-graphify.sh) that does exactly the bad
# thing, and EACH red case asserts the one message that only its own check prints - a
# substring two checks share would let a deleted check hide behind its neighbour (the
# `--version` pin once survived deletion that way, review of PR #1089, CR-M-2).
#
# The fake repo has 100 tracked .sql, 100 .sh and 100 .ts files, so a coverage percentage
# is a file count: 95 passes (the threshold is inclusive), 94 does not.
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
  local d="$TMP/$1" i
  mkdir -p "$d/bin" "$d/repo/db" "$d/repo/scripts" "$d/repo/src"
  cp "$FAKE" "$d/bin/graphify" && chmod +x "$d/bin/graphify"
  printf '%s\n' "${2:-}" >"$d/bin/mode"
  printf '%s\n' "${3:-0.9.93}" >"$d/bin/ver"
  # stand-in for the tool venv's python: answers the tree-sitter-sql version probe
  printf '#!/bin/sh\necho "%s"\n' "${4:-0.3.11}" >"$d/bin/python"
  chmod +x "$d/bin/python"
  for i in $(seq 1 100); do
    : >"$d/repo/db/m$i.sql"
    : >"$d/repo/scripts/s$i.sh"
    : >"$d/repo/src/f$i.ts"
  done
  (cd "$d/repo" && git init -q . && git add -A && git -c user.email=t@t -c user.name=t commit -q -m init)
}

# build <name> — the command under test, as a string for assert_*'s `bash -c`
build() { echo "GRAPHIFY_BIN='$TMP/$1/bin/graphify' GRAPHIFY_REPO_ROOT='$TMP/$1/repo' bash '$BUILD' 2>&1"; }

mk_case good
assert_green "a clean code-only build is published, with coverage of all three groups in the OK line" \
  --contains "build-graphify: OK" --contains "sql 100/100" --contains "sh 100/100" --contains "code 100/100" \
  -- bash -c "$(build good)"
assert_green "the published graph is at graphify-out/graph.json in the repo" \
  -- test -s "$TMP/good/repo/graphify-out/graph.json"
assert_green "the tool was invoked with --code-only and --no-viz" \
  --contains "--code-only" --contains "--no-viz" \
  -- cat "$TMP/good/bin/argv.log"
assert_green "the tool was NOT invoked with --no-gitignore or --postgres" \
  --not-contains "--no-gitignore" --not-contains "--postgres" \
  -- cat "$TMP/good/bin/argv.log"

# ── environment: an allow-list, proven with names the script has never heard of ─────────────
mk_case envscrub
assert_green "the build runs with credentials of several vendors in the caller's environment" \
  --contains "build-graphify: OK" \
  -- bash -c "GEMINI_API_KEY=canary-a FOO_CANARY=canary-b ANTHROPIC_API_KEY=canary-c HTTPS_PROXY=http://x \
       $(build envscrub)"
assert_green "the tool saw PATH (so this is not an empty file passing for an empty environment)" \
  --contains "PATH=" \
  -- cat "$TMP/envscrub/bin/env.log"
assert_green "the tool saw ONLY PATH / HOME / LANG (plus bash's own PWD, SHLVL, _): nothing else leaks" \
  --not-contains "UNEXPECTED" \
  -- bash -c "sed 's/=.*//' '$TMP/envscrub/bin/env.log' | grep -v -x -E 'PATH|HOME|LANG|PWD|SHLVL|_|OLDPWD' | sed 's/^/UNEXPECTED /'"
assert_green "...and HOME is a throwaway directory, not the caller's" \
  --contains "graphify-stage" --not-contains "HOME=$HOME" \
  -- bash -c "grep '^HOME=' '$TMP/envscrub/bin/env.log'"

# ── refusals: each asserts the message only its own check prints ────────────────────────────
assert_red "arguments are refused (the flags are fixed; nothing is passed through)" \
  --contains "takes no arguments" \
  -- bash -c "GRAPHIFY_BIN='$TMP/good/bin/graphify' GRAPHIFY_REPO_ROOT='$TMP/good/repo' bash '$BUILD' --no-gitignore 2>&1"

mk_case nobuild none
assert_red "exit 0 from the tool but no graph written is 'nothing was built', not success" \
  --contains "nothing was built" \
  -- bash -c "$(build nobuild)"
assert_red "...and no graphify-out was published" \
  -- test -e "$TMP/nobuild/repo/graphify-out"

mk_case toolfail fail
assert_red "a failing tool is a failure" \
  --contains "exited non-zero" \
  -- bash -c "$(build toolfail)"

mk_case wrongver "" 0.9.94
assert_red "a different graphify binary version is refused (message of the BINARY check only)" \
  --contains "graphify version is '" --not-contains "graph written by" \
  -- bash -c "$(build wrongver)"

mk_case wrongsql "" 0.9.93 0.3.10
assert_red "a different tree-sitter-sql version is refused" \
  --contains "tree-sitter-sql is '0.3.10'" \
  -- bash -c "$(build wrongsql)"

mk_case oldver oldver
assert_red "a graph stamped by a different graphify version is refused (message of the STAMP check only)" \
  --contains "graph written by graphify" --not-contains "graphify version is" \
  -- bash -c "$(build oldver)"

mk_case llm llm
assert_red "edges with origin 'llm' are refused: the LLM path ran" \
  --contains "only 'ast' is allowed" \
  -- bash -c "$(build llm)"

mk_case inferred inferred
assert_red "edges with any other origin are refused too (allow-list, not a denylist of 'llm')" \
  --contains "only 'ast' is allowed" \
  -- bash -c "$(build inferred)"

mk_case noorigin noorigin
assert_red "an edge carrying no origin is refused (allow-list)" \
  --contains "only 'ast' is allowed" \
  -- bash -c "$(build noorigin)"

mk_case nolinks nolinks
assert_red "an empty edge list is refused: no edges is not 'all edges are AST'" \
  --contains "or there are no edges" \
  -- bash -c "$(build nolinks)"

mk_case hyper hyper
assert_red "hyperedges (semantic output) are refused" \
  --contains "hyperedges (semantic output)" \
  -- bash -c "$(build hyper)"

mk_case md md
assert_red "a markdown source in the graph is refused (markdown must not be indexed)" \
  --contains "doc/image/.env sources" --contains "adr.md" \
  -- bash -c "$(build md)"

mk_case assets assets
assert_red "the excluded design bundles reappearing is refused" \
  --contains ".graphifyignore not applied" \
  -- bash -c "$(build assets)"

# .env-like basenames: prefix, suffix, and the .env.<stage> form. env.ts is ordinary code.
mk_case envprefix "env=.env"
assert_red "a tracked '.env' is refused" --contains "doc/image/.env sources" -- bash -c "$(build envprefix)"
mk_case envprod "env=.env.production"
assert_red "a tracked '.env.production' is refused" --contains "doc/image/.env sources" -- bash -c "$(build envprod)"
mk_case envsuffix "env=prod.env"
assert_red "a tracked 'prod.env' (suffix form) is refused" --contains "doc/image/.env sources" -- bash -c "$(build envsuffix)"
mk_case envlocal "env=app.env.local"
assert_red "a tracked 'app.env.local' is refused" --contains "doc/image/.env sources" -- bash -c "$(build envlocal)"
mk_case envcode "env=env.ts"
assert_green "an ordinary 'env.ts' is NOT mistaken for a secrets file" \
  --contains "build-graphify: OK" -- bash -c "$(build envcode)"

# ── coverage is a fraction of what the repo tracks (threshold 95, inclusive) ────────────────
mk_case sqledge "sqlpct=95 shpct=95 codepct=95"
assert_green "exactly 95% of each group is accepted (the threshold is inclusive, so 'stricter' mutants die)" \
  --contains "sql 95/100" --contains "sh 95/100" --contains "code 95/100" \
  -- bash -c "$(build sqledge)"
mk_case sqllow "sqlpct=94"
assert_red "94% of the SQL files is refused, naming the group and the counts" \
  --contains "sql coverage 94/100" \
  -- bash -c "$(build sqllow)"
mk_case shlow "shpct=94"
assert_red "94% of the shell files is refused (no shell floor can be 0 and survive)" \
  --contains "sh coverage 94/100" \
  -- bash -c "$(build shlow)"
mk_case nosh "shpct=0"
assert_red "no shell files covered at all is refused" \
  --contains "sh coverage 0/100" \
  -- bash -c "$(build nosh)"
mk_case codelow "codepct=50"
assert_red "half of the code files is refused" \
  --contains "code coverage 50/100" \
  -- bash -c "$(build codelow)"

# the same fraction holds when the repo is 6x larger: 570/600 passes, 3 of 60-style loss fails
mk_case big "sqlpct=90"
for i in $(seq 101 600); do : >"$TMP/big/repo/db/m$i.sql"; done
(cd "$TMP/big/repo" && git add -A && git -c user.email=t@t -c user.name=t commit -q -m more)
assert_red "the fraction scales with the repo: 90% of 600 SQL files fails exactly like 90% of 100" \
  --contains "sql coverage 540/600" \
  -- bash -c "$(build big)"

# ── a repo with nothing to verify against must not pass by default ───────────────────────────
mkdir -p "$TMP/empty/bin" "$TMP/empty/repo"
cp "$TMP/good/bin/graphify" "$TMP/good/bin/python" "$TMP/good/bin/ver" "$TMP/empty/bin/" 2>/dev/null
: >"$TMP/empty/bin/mode"
(cd "$TMP/empty/repo" && git init -q . && : >a.ts && : >b.ts && : >c.ts && git add -A && git -c user.email=t@t -c user.name=t commit -q -m init)
assert_red "a repo with no tracked .sql/.sh files is refused: there is nothing to verify coverage against" \
  --contains "no tracked sql files" \
  -- bash -c "$(build empty)"

# ── regression against the previous local graph ─────────────────────────────────────────────
mk_case regress "bigger=1000"
assert_green "a first build publishes (coverage alone)" \
  --contains "build-graphify: OK" -- bash -c "$(build regress)"
printf '%s\n' "" >"$TMP/regress/bin/mode"
assert_red "a rebuild that comes out under 90% of the previous graph is refused on BOTH counts" \
  --contains "nodes < 90% of previous" --contains "edges < 90% of previous" \
  -- bash -c "$(build regress)"
assert_green "...and the previous graph is still the published one" \
  --contains "pad999" \
  -- bash -c "grep -o 'pad999' '$TMP/regress/repo/graphify-out/graph.json' | head -1"
printf '%s\n' "bigger=1100" >"$TMP/regress/bin/mode"
assert_green "a rebuild that GROWS is accepted and reports the comparison" \
  --contains "vs previous" -- bash -c "$(build regress)"

# A refused build must not destroy the previous good graph.
mk_case keep llm
mkdir -p "$TMP/keep/repo/graphify-out" && echo previous >"$TMP/keep/repo/graphify-out/graph.json"
bash -c "$(build keep)" >/dev/null
assert_green "a refused build leaves the previous graphify-out untouched" \
  --contains "previous" \
  -- cat "$TMP/keep/repo/graphify-out/graph.json"

# ── run-time refusal: a careless edit of the extract line fails where it happens ─────────────
# Copies of the script with the extract line edited the way a careless change would.
mk_case edited
sed 's/run_tool extract \. --code-only --no-viz/run_tool extract . --no-viz/' "$BUILD" >"$TMP/edited/nocode.sh"
sed 's/run_tool extract \. --code-only --no-viz/run_tool extract . --code-only --no-gitignore --no-viz/' "$BUILD" >"$TMP/edited/nogi.sh"
sed 's/run_tool extract \. --code-only --no-viz/run_tool extract . --code-only --postgres x --no-viz/' "$BUILD" >"$TMP/edited/pg.sh"
assert_green "the edited copies really differ from the script (the sed did something)" \
  --not-contains "IDENTICAL" \
  -- bash -c "for f in nocode nogi pg; do cmp -s '$BUILD' '$TMP/edited/'\$f.sh && echo IDENTICAL \$f; done; true"
assert_red "an extract call without --code-only is refused by the script itself" \
  --contains "refusing to run 'graphify extract' without --code-only" \
  -- bash -c "GRAPHIFY_BIN='$TMP/edited/bin/graphify' GRAPHIFY_REPO_ROOT='$TMP/edited/repo' bash '$TMP/edited/nocode.sh' 2>&1"
assert_red "...and the tool was never invoked (no argv recorded)" \
  -- test -e "$TMP/edited/bin/argv.log"
assert_red "an extract call with --no-gitignore is refused by the script itself" \
  --contains "with --no-gitignore or --postgres" \
  -- bash -c "GRAPHIFY_BIN='$TMP/edited/bin/graphify' GRAPHIFY_REPO_ROOT='$TMP/edited/repo' bash '$TMP/edited/nogi.sh' 2>&1"
assert_red "an extract call with --postgres is refused by the script itself" \
  --contains "with --no-gitignore or --postgres" \
  -- bash -c "GRAPHIFY_BIN='$TMP/edited/bin/graphify' GRAPHIFY_REPO_ROOT='$TMP/edited/repo' bash '$TMP/edited/pg.sh' 2>&1"
assert_green "the unedited script still builds in the same fake repo" \
  --contains "build-graphify: OK" \
  -- bash -c "$(build edited)"

# The script text itself: the forbidden switches may appear in comments only.
assert_green "no executable line of the script mentions --no-gitignore or --postgres" \
  --not-contains "--no-gitignore" --not-contains "--postgres" \
  -- bash -c "grep -v '^[[:space:]]*#' '$BUILD' | grep -v 'refusing' | grep -E -e '--no-gitignore|--postgres' || true"
assert_green "the one extract invocation carries --code-only" \
  --contains "--code-only" \
  -- bash -c "grep -E 'run_tool extract' '$BUILD'"

guard_test_summary "test-build-graphify.sh"
