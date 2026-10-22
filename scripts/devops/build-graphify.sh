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
# NOTHING LEAVES THE MACHINE — made structural, not a matter of remembering a flag:
#   1. The extract command exists ONCE below, with `--code-only` in it. `graphify extract`
#      WITHOUT that flag runs a semantic pass that sends file contents to a model backend
#      (and would read .claude/**, ADRs and docs/legal/**). This script takes no arguments
#      and passes none through, so the flag cannot be dropped by a caller.
#   2. The command runs under `env -i` with an allow-list of three variables. No API key,
#      no *_BASE_URL, no proxy can reach the tool; had the flag been edited away the
#      semantic path would have no backend and fail instead of silently calling out.
#   3. The result is then audited (verify_graph): every edge must be AST-origin, there
#      must be no hyperedges, no doc/paper/image or .env* source file, and the build
#      must contain the SQL and shell coverage that is the whole reason for the tool.
#      A build that took the semantic path, or built nothing, fails here, loudly.
#   tests/test-build-graphify.sh feeds this script a fake graphify and proves each of
#   those refusals fires.
#
# DELIBERATELY NOT WIRED:
#   --no-gitignore   .gitignore is honoured by default; that is one of the two layers that
#                    keep gitignored files out of the graph (docs/design/assets/ is the
#                    other, via .graphifyignore). Measured 2026-10-22: graphify never
#                    extracts a `.env` file at all (no extractor for the extension — with
#                    or without this flag the .env values are absent), but it WILL index
#                    any gitignored source file (.py/.ts/...) when the flag is on. So
#                    the flag is not what stops .env; it is what stops everything else
#                    under .gitignore. Never pass it.
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
# Test-only overrides: GRAPHIFY_BIN (path to the executable), GRAPHIFY_REPO_ROOT.
set -euo pipefail

PIN_GRAPHIFY="0.9.93"
PIN_TREE_SITTER_SQL="0.3.11"

# Floors: below these the graph is not what we claim it is. Measured 2026-10-22:
# ~17.5k nodes, 60 .sql files, 123 .sh files. Deliberately well under that, far above 0.
MIN_NODES=5000
MIN_SQL_FILES=10
MIN_SH_FILES=30

die() { echo "build-graphify: FAIL: $*" >&2; exit 1; }

[ "$#" -eq 0 ] || die "takes no arguments (got: $*). The flags are fixed on purpose: see the header."

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${GRAPHIFY_REPO_ROOT:-$(cd "$SELF_DIR/../.." && pwd)}"
BIN="${GRAPHIFY_BIN:-$(command -v graphify || true)}"
[ -n "$BIN" ] && [ -x "$BIN" ] || die "graphify not found. Install: uv tool install --reinstall \"graphifyy[sql]==$PIN_GRAPHIFY\" --with \"tree-sitter-sql==$PIN_TREE_SITTER_SQL\""

# ── pins ────────────────────────────────────────────────────────────────────────
got="$("$BIN" --version 2>&1 | head -1)"
[ "$got" = "graphify $PIN_GRAPHIFY" ] || die "graphify version is '$got', pinned to 'graphify $PIN_GRAPHIFY'."

BIN_REAL="$(readlink -f "$BIN" 2>/dev/null || python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$BIN")"
TOOL_PY="$(dirname "$BIN_REAL")/python"
[ -x "$TOOL_PY" ] || die "no python next to $BIN_REAL, so the tree-sitter-sql pin cannot be verified."
got_sql="$("$TOOL_PY" -I -c 'import importlib.metadata as m; print(m.version("tree-sitter-sql"))' 2>/dev/null || true)"
[ "$got_sql" = "$PIN_TREE_SITTER_SQL" ] || die "tree-sitter-sql is '${got_sql:-missing}', pinned to '$PIN_TREE_SITTER_SQL' (the [sql] extra)."

# ── build into a FRESH staging directory ────────────────────────────────────────
# Fresh, so that "graph.json exists" can only mean "this run wrote it" and graphify's
# incremental cache cannot hand back a stale answer. The live graphify-out/ is replaced
# only after the audit passes, so a failed build never leaves a half-trusted graph.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/graphify-stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

echo "build-graphify: extracting (local AST, --code-only), about 45 s; silent stretches are normal" >&2
(
  cd "$REPO_ROOT"
  env -i PATH="$PATH" HOME="${HOME:-/nonexistent}" LANG=C \
    "$BIN" extract . --code-only --no-viz --out "$STAGE"
) >"$STAGE/extract.log" 2>&1 || { tail -20 "$STAGE/extract.log" >&2; die "graphify extract exited non-zero."; }

GRAPH="$STAGE/graphify-out/graph.json"
[ -s "$GRAPH" ] || { tail -20 "$STAGE/extract.log" >&2; die "no graph.json was produced: nothing was built."; }

# ── audit ───────────────────────────────────────────────────────────────────────
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"

verify_graph() {
  python3 -I - "$GRAPH" "$PIN_GRAPHIFY" "$HEAD_SHA" "$MIN_NODES" "$MIN_SQL_FILES" "$MIN_SH_FILES" <<'PY'
import json, os, sys

path, pin, head, min_nodes, min_sql, min_sh = sys.argv[1:7]
min_nodes, min_sql, min_sh = int(min_nodes), int(min_sql), int(min_sh)
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

# The LLM path: semantic extraction adds non-AST edges and hyperedges.
origins = {l.get("_origin") for l in links}
if origins != {"ast"}:
    fail.append(f"edge origins {sorted(map(str, origins))} - only 'ast' is allowed (a semantic pass ran?)")
if g.get("hyperedges"):
    fail.append(f"{len(g['hyperedges']) if isinstance(g['hyperedges'], list) else g['hyperedges']} hyperedges (semantic output)")

DOC_EXT = {".md", ".mdx", ".txt", ".rst", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
           ".docx", ".xlsx", ".html", ".gdoc", ".gsheet", ".gslides"}
files = {n.get("source_file") for n in nodes if n.get("source_file")}
bad = sorted(f for f in files
             if os.path.splitext(f)[1].lower() in DOC_EXT or os.path.basename(f).startswith(".env"))
if bad:
    fail.append(f"doc/image/.env sources in graph: {bad[:5]}")
leak = sorted(f for f in files if f.startswith("docs/design/assets/"))
if leak:
    fail.append(f"excluded generated bundles are in the graph: {leak[:3]} (.graphifyignore not applied?)")

sql = {f for f in files if f.endswith(".sql")}
sh = {f for f in files if f.endswith(".sh")}
if len(nodes) < min_nodes:
    fail.append(f"{len(nodes)} nodes < floor {min_nodes}")
if len(sql) < min_sql:
    fail.append(f"{len(sql)} .sql files < floor {min_sql} (SQL grammar missing? that is the point of the tool)")
if len(sh) < min_sh:
    fail.append(f"{len(sh)} .sh files < floor {min_sh}")

if fail:
    print("; ".join(fail))
    sys.exit(1)
print(f"{len(nodes)} nodes, {len(links)} edges, {len(sql)} sql files, {len(sh)} sh files, commit {g.get('built_at_commit')}")
PY
}

summary="$(verify_graph)" || die "audit refused the graph: $summary"

# ── publish ─────────────────────────────────────────────────────────────────────
rm -rf "$REPO_ROOT/graphify-out"
mv "$STAGE/graphify-out" "$REPO_ROOT/graphify-out"
echo "build-graphify: OK - $summary -> graphify-out/graph.json"
