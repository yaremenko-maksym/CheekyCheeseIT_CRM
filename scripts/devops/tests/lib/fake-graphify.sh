#!/usr/bin/env bash
# fake-graphify.sh — stands in for the `graphify` executable in test-build-graphify.sh.
#
# Its behaviour is read from files NEXT TO IT (the build script runs the tool under
# `env -i`, so environment variables cannot carry the scenario):
#   ver        the string `--version` prints after "graphify " (default 0.9.93)
#   mode       space-separated flags for the graph it writes on `extract`:
#                none        write no graph at all but exit 0 (the "nothing was built" case)
#                llm         edges with _origin "llm"
#                hyper       a non-empty hyperedges list
#                md          a source_file ending .md
#                env         a source_file named .env.production
#                assets      a source_file under docs/design/assets/
#                nosql       no .sql files
#                small       below the node floor
#                stalecommit built_at_commit that is not HEAD
#                oldver      graph written by a different graphify version
#                fail        exit 1 without writing
# Every `extract` call records its argv to ./argv.log and its environment to ./env.log
# beside this file.
set -u
D="$(cd "$(dirname "$0")" && pwd)"
VER="$(cat "$D/ver" 2>/dev/null || echo 0.9.93)"
MODE=" $(cat "$D/mode" 2>/dev/null) "

if [ "${1:-}" = "--version" ]; then echo "graphify $VER"; exit 0; fi
[ "${1:-}" = "extract" ] || { echo "fake-graphify: unexpected command $*" >&2; exit 64; }

echo "$*" >"$D/argv.log"
env >"$D/env.log"

OUT=""
prev=""
for a in "$@"; do
  [ "$prev" = "--out" ] && OUT="$a"
  prev="$a"
done
[ -n "$OUT" ] || { echo "fake-graphify: no --out" >&2; exit 64; }

case "$MODE" in *" fail "*) echo "fake-graphify: boom" >&2; exit 1 ;; esac
case "$MODE" in *" none "*) echo "[graphify extract] nothing to do"; exit 0 ;; esac

HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
mkdir -p "$OUT/graphify-out"
python3 -I - "$OUT/graphify-out/graph.json" "$MODE" "$HEAD_SHA" "$VER" <<'PY'
import json, sys

out, mode, head, ver = sys.argv[1:5]
has = lambda m: f" {m} " in mode
nodes = []
n_total = 800 if has("small") else 6000
for i in range(n_total):
    nodes.append({"id": f"n{i}", "label": f"sym{i}", "source_file": f"apps/api/src/f{i % 400}.ts"})
sql_files = [] if has("nosql") else [f"apps/api/drizzle/manual/m{i}.sql" for i in range(12)]
sh_files = [f"scripts/devops/s{i}.sh" for i in range(40)]
for f in sql_files + sh_files:
    nodes.append({"id": f"f_{f}", "label": f, "source_file": f})
if has("md"):
    nodes.append({"id": "doc", "label": "doc", "source_file": "docs/architecture/adr.md"})
if has("env"):
    nodes.append({"id": "envn", "label": "envn", "source_file": "apps/api/.env.production"})
if has("assets"):
    nodes.append({"id": "ds", "label": "ds", "source_file": "docs/design/assets/x/_ds_bundle.js"})
origin = "llm" if has("llm") else "ast"
links = [{"source": "n0", "target": "n1", "relation": "calls", "_origin": origin}]
g = {
    "directed": False,
    "multigraph": False,
    "graph": {"schema_version": 1, "graphify_version": "0.0.1" if has("oldver") else ver},
    "nodes": nodes,
    "links": links,
    "hyperedges": [{"id": "h"}] if has("hyper") else [],
    "built_at_commit": "deadbeef" if has("stalecommit") else head,
}
json.dump(g, open(out, "w"))
PY
echo "[graphify extract] wrote $OUT/graphify-out/graph.json"
