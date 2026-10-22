#!/usr/bin/env bash
# fake-graphify.sh — stands in for the `graphify` executable in test-build-graphify.sh.
#
# Its behaviour is read from files NEXT TO IT (the build script runs the tool under
# `env -i`, so environment variables cannot carry the scenario):
#   ver        the string `--version` prints after "graphify " (default 0.9.93)
#   mode       space-separated flags for the graph it writes on `extract`. The graph is
#              built from the tracked files of the repo it runs in (cwd), the way the real
#              tool's coverage follows the repo:
#                none        write no graph at all but exit 0 (the "nothing was built" case)
#                fail        exit 1 without writing
#                sqlpct=N / shpct=N / codepct=N   cover only N percent of that group (default 100)
#                llm         edges with _origin "llm"
#                inferred    edges with _origin "inferred"
#                noorigin    an extra edge with no _origin key
#                nolinks     an empty edge list
#                hyper       a non-empty hyperedges list
#                md          a source_file ending .md
#                env=NAME    a source_file with basename NAME (e.g. env=prod.env)
#                assets      a source_file under docs/design/assets/
#                stalecommit built_at_commit that is not HEAD
#                oldver      graph written by a different graphify version
#                bigger=N    pad the graph with N extra nodes and N extra edges
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
git ls-files -z >"$OUT/tracked.fake.z"
python3 -I - "$OUT/graphify-out/graph.json" "$MODE" "$HEAD_SHA" "$VER" "$OUT/tracked.fake.z" <<'PY'
import json, os, re, sys

out, mode, head, ver, tracked_f = sys.argv[1:6]


def has(m):
    return f" {m} " in mode


def arg(name, default):
    m = re.search(rf" {name}=(\S+) ", mode)
    return m.group(1) if m else default


tracked = [f for f in open(tracked_f, "rb").read().decode().split("\0") if f]
GROUPS = {"sql": {".sql"}, "sh": {".sh"}, "code": {".ts", ".tsx", ".js", ".mjs", ".py"}}
nodes = []
for name, exts in GROUPS.items():
    want = [f for f in tracked if os.path.splitext(f)[1] in exts]
    keep = int(len(want) * int(arg(name + "pct", "100")) / 100)
    for f in want[:keep]:
        nodes.append({"id": "f_" + f, "label": f, "source_file": f})
if has("md"):
    nodes.append({"id": "doc", "label": "doc", "source_file": "docs/architecture/adr.md"})
envname = arg("env", "")
if envname:
    nodes.append({"id": "envn", "label": "envn", "source_file": "apps/api/" + envname})
if has("assets"):
    nodes.append({"id": "ds", "label": "ds", "source_file": "docs/design/assets/x/_ds_bundle.js"})
extra = int(arg("bigger", "0"))
for i in range(extra):
    nodes.append({"id": f"pad{i}", "label": f"pad{i}", "source_file": ""})
origin = "llm" if has("llm") else "inferred" if has("inferred") else "ast"
links = [
    {"source": nodes[0]["id"], "target": nodes[1]["id"], "relation": "calls", "_origin": origin}
    for _ in range(3)
]
if has("noorigin"):
    links.append({"source": nodes[0]["id"], "target": nodes[1]["id"], "relation": "calls"})
links += [
    {"source": f"pad{i}", "target": nodes[0]["id"], "relation": "calls", "_origin": "ast"}
    for i in range(extra)
]
if has("nolinks"):
    links = []
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
rm -f "$OUT/tracked.fake.z"
echo "[graphify extract] wrote $OUT/graphify-out/graph.json"
