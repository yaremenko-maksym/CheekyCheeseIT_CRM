#!/usr/bin/env bash
#
# derive-permission-denied-allowlists.sh — the two allowlists the 42501 watch uses
# to decide which words from a production log line may be shown in a PUBLIC
# Actions log. Run on the Actions runner, against the checked-out source, every
# scan: the lists are READ at scan time, so they cannot drift from the code.
#
# WHY ALLOWLISTS. A log line is partly influenced from outside (a user-supplied
# value echoed into an error message can carry a bracketed token). A character-
# class check bounds the SHAPE of an extracted field, not its ORIGIN, so an
# attacker could still choose 60 characters that reach the world-readable log.
# A name that is ON A LIST can only ever be a name we already published in the
# repository; anything else is reported as `unknown`.
#
# `unknown` REDUCES PRECISION, IT NEVER SUPPRESSES THE ALERT. A hit whose object
# or logger is not on a list still pages: an unrecognised object is the case most
# likely to be interesting (a table added after the list was cut, a dynamic
# relation, a hostile line). Reading "not on the list" as "ignore" would turn this
# into a filter that hides the novel case. The checker never drops a hit for being
# `unknown`.
#
# SOURCES (read as data; neither is edited here)
#   tables   apps/api/src/database/privileges/privilege-classes.ts, the keys-as-
#            strings inside the PRIVILEGE_CLASSES map: the manifest is already the
#            single source of truth for which relations exist in which class.
#   loggers  every non-spec `new Logger(X.name)` / `new Logger('Name')` under
#            apps/api/src (the Nest "context" shown in brackets in a log line), plus
#            the framework contexts below.
#
# FAILS LOUDLY. An empty or implausibly small list would silently turn every field
# into `unknown` (precision lost without a sound), so a floor is enforced and the
# script exits 2 below it: the run goes red instead.
#
# Output (one line each, space-separated, for $GITHUB_OUTPUT):
#   tables=<a b c>
#   loggers=<A B C>
# Env: REPO_ROOT overrides the repository root (tests).
set -euo pipefail

ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MANIFEST="$ROOT/apps/api/src/database/privileges/privilege-classes.ts"
SRC="$ROOT/apps/api/src"
MIN_TABLES=20
MIN_LOGGERS=20

# Nest's own contexts: an unhandled controller error is logged by ExceptionsHandler,
# not by a class of ours.
FRAMEWORK_LOGGERS="ExceptionsHandler NestApplication NestFactory InstanceLoader RoutesResolver RouterExplorer"

[ -f "$MANIFEST" ] || { echo "::error::privilege manifest not found at apps/api/src/database/privileges/privilege-classes.ts" >&2; exit 2; }
[ -d "$SRC" ] || { echo "::error::apps/api/src not found" >&2; exit 2; }

tables="$(awk '/^export const PRIVILEGE_CLASSES/{f=1;next} f&&/^}/{exit} f' "$MANIFEST" \
  | grep -vE '^[[:space:]]*(//|/\*|\*)' | grep -oE "'[a-z_][a-z0-9_]*'" | tr -d "'" | sort -u | tr '\n' ' ' | sed 's/ $//')" || tables=""

# Comment lines are dropped first: a docstring that MENTIONS `new Logger(Class.name)` is
# not a logger (that put the meaningless context `Class` on the list).
loggers="$( { grep -rhE "new Logger\(" \
    --include='*.ts' --exclude='*.spec.ts' --exclude='*.test.ts' "$SRC" || true; } \
  | { grep -vE '^[[:space:]]*(//|/\*|\*)' || true; } \
  | { grep -oE "new Logger\(([A-Za-z0-9_]+\.name|'[A-Za-z0-9_.-]+')\)" || true; } \
  | sed -E "s/^new Logger\(//; s/\)$//; s/\.name$//; s/^'//; s/'$//" \
  | grep -vx 'test' | { cat; for f in $FRAMEWORK_LOGGERS; do echo "$f"; done; } \
  | sort -u | tr '\n' ' ' | sed 's/ $//')" || loggers=""  # not 'exit': under pipefail an empty grep must reach the floor check below, which says WHY

n_tables="$(printf '%s\n' "$tables" | wc -w | tr -d ' ')"
n_loggers="$(printf '%s\n' "$loggers" | wc -w | tr -d ' ')"
if [ "$n_tables" -lt "$MIN_TABLES" ]; then
  echo "::error::derived only ${n_tables} table name(s) from the privilege manifest (floor ${MIN_TABLES}); the manifest's shape changed and the watch would report every object as unknown" >&2
  exit 2
fi
if [ "$n_loggers" -lt "$MIN_LOGGERS" ]; then
  echo "::error::derived only ${n_loggers} logger name(s) (floor ${MIN_LOGGERS}); the logger convention changed and the watch would report every logger as unknown" >&2
  exit 2
fi

echo "tables=${tables}"
echo "loggers=${loggers}"
