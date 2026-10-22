#!/usr/bin/env bash
# build-graphify.sh — build the local, code-only `graphify` graph of this repository.
#
#   scripts/devops/build-graphify.sh          # takes NO arguments, on purpose
#
# Writes <repo>/graphify-out/graph.json (gitignored). ~45 s, 8 workers, no network.
#
# WHAT THIS IS FOR. graphify sits NEXT TO codegraph, it does not replace it.
# codegraph (MCP, live-watched) stays the tool for TypeScript/TSX navigation, callers,
# blast radius and test coverage. graphify indexes what codegraph returns nothing for:
# SQL DDL (.sql), shell scripts (.sh) and JSON. It does NOT index markdown or yaml.
# Division of labour: .claude/rules/common/mcp-first.md.
# Query it with the CLI, e.g.
#   graphify query "append-only trigger" --graph graphify-out/graph.json
#   graphify affected "<symbol>" --depth 1 --graph graphify-out/graph.json
# (--depth 1 for "who calls this": depth 2 prints transitive callers formatted like
# direct ones). It is deliberately NOT registered as an MCP server: a second server puts
# a second tool set in every agent's context on every request, for questions asked rarely.
#
# NOTHING LEAVES THE MACHINE. What guarantees it, in order of strength:
#   1. `--code-only`. The extract command exists ONCE below, with that flag. `graphify
#      extract` WITHOUT it runs a semantic pass that sends file contents to a model backend
#      (it would read .claude/**, ADRs and docs/legal/**). This script takes no arguments
#      and passes none through, so a caller cannot drop the flag; `run_tool` additionally
#      refuses, at run time, any `extract` call lacking `--code-only` (or carrying
#      `--no-gitignore` / `--postgres`), and tests/test-build-graphify.sh asserts both that
#      refusal and the flag in the argv the tool receives. THIS is the guarantee.
#   2. The audit (verify_graph), after the fact: every edge must be AST-origin, no
#      hyperedges, no doc/paper/image/.env source. It detects a semantic run; it cannot
#      recall content a model backend already received, which is why 1 is the real guard.
#   3. Defence in depth, NOT a guarantee: the tool runs under `env -i` (PATH, LANG and a
#      throwaway empty HOME only), so no API key or *_BASE_URL in the caller's environment
#      reaches it and it finds no credentials in ~/.config. The working directory is still
#      the repository root, and nothing here shows graphify reads credentials only from the
#      environment - so do not read this layer as "the semantic path would have no backend".
#   tests/test-build-graphify.sh feeds this script a fake graphify and proves each refusal.
#
# WHAT "OK" MEANS (the audit refuses otherwise):
#   - coverage: of the tracked .sql / .sh / code files (git ls-files, minus what
#     .graphifyignore excludes) at least MIN_COVERAGE_PCT percent appear as graph sources,
#     per group. Derived from the repository, not typed constants, so it keeps working as the
#     repo grows: 3 of 60 SQL files fails, and 30 of 600 fails the same way. 95 because the
#     measured coverage on 2026-10-22 was 100% in all three groups (60/60 sql, 126/126 sh,
#     2173/2173 code); the 5% headroom absorbs a few legitimately empty files, while a
#     hollow build (a third missing, a grammar absent) fails by a wide margin.
#   - no regression: node and edge counts are at least MIN_KEEP_PCT percent of the previous
#     graphify-out/graph.json, if there is one. A deliberate deletion of >10% of the code
#     needs `rm -rf graphify-out` first. The first build is checked by coverage alone.
#
# WHY .env STAYS OUT (the one place this is explained; .graphifyignore points here).
# Two independent facts, both measured 2026-10-22 with planted canary values:
#   a. graphify has no extractor for the .env format: with or without --no-gitignore, the
#      values of a .env file never reach the graph.
#   b. graphify honours .gitignore by default, and that is what keeps every OTHER gitignored
#      source file (a .py/.ts under a gitignored directory) out - with --no-gitignore such a
#      file's symbols DO appear. So the flag does not protect .env; it protects the rest.
#   The audit adds a backstop for a tracked .env-like file: basename starting `.env`,
#   ending `.env` (prod.env), or `.env.<local|production|...>` is refused.
#
# DELIBERATELY NOT WIRED:
#   --no-gitignore   see (b). Never pass it.
#   --postgres DSN   reads a live database schema. The live crm_db is read-only for
#                    agents (.claude/rules/common/live-db-access.md); the DDL is already
#                    in apps/api/drizzle/** as files, which is what this indexes.
#   `graphify hook install`, `label`, `cluster-only` (without --no-label): the first
#                    installs git hooks, the others call a model to name communities.
#
# VERSIONS ARE PINNED (an unpinned tool that changes its extraction silently is a trap).
# Install / repair:
#   uv tool install --reinstall "graphifyy[sql]==0.9.93" --with "tree-sitter-sql==0.3.11"
# The script refuses to run on any other version of either.
#
# Test overrides, honoured in ANY invocation (not only tests): GRAPHIFY_BIN (the
# executable), GRAPHIFY_REPO_ROOT (the tree to scan and publish into).
set -euo pipefail

PIN_GRAPHIFY="0.9.93"
PIN_TREE_SITTER_SQL="0.3.11"
MIN_COVERAGE_PCT=95
MIN_KEEP_PCT=90

die() { echo "build-graphify: FAIL: $*" >&2; exit 1; }

[ "$#" -eq 0 ] || die "takes no arguments (got: $*). The flags are fixed on purpose: see the header."

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${GRAPHIFY_REPO_ROOT:-$(cd "$SELF_DIR/../.." && pwd)}"
BIN="${GRAPHIFY_BIN:-$(command -v graphify || true)}"
[ -n "$BIN" ] && [ -x "$BIN" ] || die "graphify not found. Install: uv tool install --reinstall \"graphifyy[sql]==$PIN_GRAPHIFY\" --with \"tree-sitter-sql==$PIN_TREE_SITTER_SQL\""

# Every graphify invocation goes through this wrapper: scrubbed environment, empty HOME.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/graphify-stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/home"
run_tool() {
  # Refuse, here and now, an `extract` that could take the semantic path or read a live DB:
  # a careless edit fails where it happens, not later in CI.
  if [ "${1:-}" = "extract" ]; then
    case " $* " in *" --code-only "*) ;; *) die "refusing to run 'graphify extract' without --code-only (semantic path)." ;; esac
    case " $* " in *" --no-gitignore "* | *" --postgres "*) die "refusing to run 'graphify extract' with --no-gitignore or --postgres." ;; esac
  fi
  env -i PATH="$PATH" HOME="$STAGE/home" LANG=C "$BIN" "$@"
}

# ── pins ────────────────────────────────────────────────────────────────────────
got="$(run_tool --version 2>&1 | head -1)"
[ "$got" = "graphify $PIN_GRAPHIFY" ] || die "graphify version is '$got', pinned to 'graphify $PIN_GRAPHIFY'."

BIN_REAL="$(readlink -f "$BIN" 2>/dev/null || python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$BIN")"
TOOL_PY="$(dirname "$BIN_REAL")/python"
[ -x "$TOOL_PY" ] || die "no python next to $BIN_REAL, so the tree-sitter-sql pin cannot be verified."
got_sql="$("$TOOL_PY" -I -c 'import importlib.metadata as m; print(m.version("tree-sitter-sql"))' 2>/dev/null || true)"
[ "$got_sql" = "$PIN_TREE_SITTER_SQL" ] || die "tree-sitter-sql is '${got_sql:-missing}', pinned to '$PIN_TREE_SITTER_SQL' (the [sql] extra)."

# ── what the repository contains (the audit's expectation) ──────────────────────
git -C "$REPO_ROOT" ls-files -z >"$STAGE/tracked.z" || die "git ls-files failed: cannot derive the coverage expectation."
: >"$STAGE/excluded.z"
if [ -f "$REPO_ROOT/.graphifyignore" ]; then
  git -C "$REPO_ROOT" ls-files -z -ci --exclude-from=.graphifyignore >"$STAGE/excluded.z" ||
    die "git ls-files --exclude-from=.graphifyignore failed."
fi
PREV="$REPO_ROOT/graphify-out/graph.json"

# ── build into a FRESH staging directory ────────────────────────────────────────
# Fresh, so that "graph.json exists" can only mean "this run wrote it" and graphify's
# incremental cache cannot hand back a stale answer. The live graphify-out/ is replaced
# only after the audit passes, so a failed build never leaves a half-trusted graph.
echo "build-graphify: extracting (local AST, --code-only), about 45 s; silent stretches are normal" >&2
(
  cd "$REPO_ROOT"
  run_tool extract . --code-only --no-viz --out "$STAGE"
) >"$STAGE/extract.log" 2>&1 || { tail -20 "$STAGE/extract.log" >&2; die "graphify extract exited non-zero."; }

GRAPH="$STAGE/graphify-out/graph.json"
[ -s "$GRAPH" ] || { tail -20 "$STAGE/extract.log" >&2; die "no graph.json was produced: nothing was built."; }
WARNINGS="$(grep -c '^ *warning:' "$STAGE/extract.log" || true)"

# ── audit ───────────────────────────────────────────────────────────────────────
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"

verify_graph() {
  python3 -I - "$GRAPH" "$PIN_GRAPHIFY" "$HEAD_SHA" "$MIN_COVERAGE_PCT" "$MIN_KEEP_PCT" \
    "$STAGE/tracked.z" "$STAGE/excluded.z" "$PREV" <<'PY'
import json, os, re, sys

path, pin, head, cov_pct, keep_pct, tracked_f, excluded_f, prev_f = sys.argv[1:9]
cov_pct, keep_pct = int(cov_pct), int(keep_pct)
fail = []
try:
    g = json.load(open(path))
except Exception as e:  # noqa: BLE001
    print(f"graph.json unreadable: {e}")
    sys.exit(1)

nodes, links = g.get("nodes"), g.get("links")
if not isinstance(nodes, list) or not isinstance(links, list):
    print("graph.json has no nodes/links lists")
    sys.exit(1)

if g.get("graph", {}).get("graphify_version") != pin:
    fail.append(f"graph written by graphify {g.get('graph', {}).get('graphify_version')!r}, pinned {pin!r}")
if head != "unknown" and g.get("built_at_commit") != head:
    fail.append(f"built_at_commit {g.get('built_at_commit')!r} != HEAD {head!r}")

# The LLM path: semantic extraction adds non-AST edges and hyperedges. Allow-list, and an
# empty edge list is not "all AST" - it is no graph.
origins = {l.get("_origin") for l in links}
if origins != {"ast"}:
    fail.append(f"edge origins {sorted(map(str, origins))} - only 'ast' is allowed (a semantic pass ran, or there are no edges)")
if g.get("hyperedges"):
    fail.append(f"{len(g['hyperedges']) if isinstance(g['hyperedges'], list) else g['hyperedges']} hyperedges (semantic output)")

DOC_EXT = {".md", ".mdx", ".txt", ".rst", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
           ".docx", ".xlsx", ".html", ".gdoc", ".gsheet", ".gslides"}
ENV_RE = re.compile(r"^\.env|\.env$|\.env\.(local|production|prod|development|dev|staging|test)$", re.I)
files = {n.get("source_file") for n in nodes if n.get("source_file")}
bad = sorted(f for f in files
             if os.path.splitext(f)[1].lower() in DOC_EXT or ENV_RE.search(os.path.basename(f)))
if bad:
    fail.append(f"doc/image/.env sources in graph: {bad[:5]}")
leak = sorted(f for f in files if f.startswith("docs/design/assets/"))
if leak:
    fail.append(f"excluded generated bundles are in the graph: {leak[:3]} (.graphifyignore not applied?)")

# Coverage, derived from the repository.
tracked = [f for f in open(tracked_f, "rb").read().decode().split("\0") if f]
excluded = {f for f in open(excluded_f, "rb").read().decode().split("\0") if f}
GROUPS = {"sql": {".sql"}, "sh": {".sh"},
          "code": {".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".py"}}
cov_parts = []
for name, exts in GROUPS.items():
    want = [f for f in tracked if f not in excluded and os.path.splitext(f)[1] in exts]
    if not want:
        if name in ("sql", "sh"):
            fail.append(f"no tracked {name} files: nothing to verify coverage against")
        continue
    hit = sum(1 for f in want if f in files)
    pct = 100.0 * hit / len(want)
    cov_parts.append(f"{name} {hit}/{len(want)}")
    if pct < cov_pct:
        fail.append(f"{name} coverage {hit}/{len(want)} = {pct:.0f}% < {cov_pct}% of tracked files")

# Regression against the previous local graph, if any.
keep = ""
if os.path.exists(prev_f):
    try:
        p = json.load(open(prev_f))
        pn, pl = len(p["nodes"]), len(p["links"])
        keep = f", vs previous {pn} nodes/{pl} edges"
        if len(nodes) * 100 < pn * keep_pct:
            fail.append(f"{len(nodes)} nodes < {keep_pct}% of previous {pn} (rm -rf graphify-out if the drop is deliberate)")
        if len(links) * 100 < pl * keep_pct:
            fail.append(f"{len(links)} edges < {keep_pct}% of previous {pl} (rm -rf graphify-out if the drop is deliberate)")
    except Exception as e:  # noqa: BLE001
        keep = f", previous graph unreadable ({type(e).__name__}): not compared"

if fail:
    print("; ".join(fail))
    sys.exit(1)
print(f"{len(nodes)} nodes, {len(links)} edges, coverage {', '.join(cov_parts)}{keep}, commit {g.get('built_at_commit')}")
PY
}

summary="$(verify_graph)" || die "audit refused the graph: $summary"

# ── publish ─────────────────────────────────────────────────────────────────────
rm -rf "$REPO_ROOT/graphify-out"
mv "$STAGE/graphify-out" "$REPO_ROOT/graphify-out"
echo "build-graphify: OK - $summary; $WARNINGS extractor warning line(s) -> graphify-out/graph.json"
