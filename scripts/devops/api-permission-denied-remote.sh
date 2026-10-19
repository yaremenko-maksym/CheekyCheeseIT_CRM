#!/usr/bin/env bash
#
# api-permission-denied-remote.sh — the part of the 42501 watch that runs ON THE VPS.
# scan-api-permission-denied.sh pipes this file to `ssh host 'bash -s'` after a block of
# `export LOGSCAN_*=...` lines; it is never copied to, or installed on, the VPS.
#
# It is the FIRST publication boundary: the matching AND the sanitising happen here, so
# only validated fields leave production (this repository and its Actions logs are
# PUBLIC). The checker (check-api-permission-denied.sh) is the second lock and runs in
# the same pipe, so nothing unvalidated can reach a log. Full contract: that script's
# header. Read-only: `docker compose ps` and `docker compose logs`, nothing else.
#
# Inputs (exported by the driver): LOGSCAN_RE, LOGSCAN_SINCE, LOGSCAN_TABLES,
# LOGSCAN_LOGGERS. LOGSCAN_CRM_DIR overrides /opt/crm (tests only; the driver never
# exports it, and ssh does not forward the caller's environment).
#
# Every docker call gets `</dev/null`: this script itself arrives on stdin (`bash -s`),
# and a command that read stdin would swallow the rest of it.
set -u

# The frame (SR-M-6). A login shell can write to stdout before this script ever runs (an
# rc file that echoes, a motd-style line, BASH_ENV), and that text arrives in the same
# stream. This line is the FIRST thing the script prints; the checker discards whatever
# precedes it (and whatever follows LOGSCAN_END), reporting only a count.
echo "LOGSCAN_BEGIN"

# Fail closed on missing allowlists. Under `set -u` an unset list would kill the loop
# below mid-way while LOGSCAN_END is still printed, leaving a count with no detail.
if [ -z "${LOGSCAN_TABLES:-}" ] || [ -z "${LOGSCAN_LOGGERS:-}" ] || [ -z "${LOGSCAN_RE:-}" ] || [ -z "${LOGSCAN_CONTRACT_RE:-}" ] || [ -z "${LOGSCAN_SINCE:-}" ]; then
  echo "LOGSCAN_FAILED=inputs_missing"
  exit 0
fi

cd "${LOGSCAN_CRM_DIR:-/opt/crm}" 2>/dev/null || { echo "LOGSCAN_FAILED=no_crm_dir"; exit 0; }
dc="docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml --env-file .env.production"

# Only a line that LOOKS LIKE a compose api container name counts (`crm-api-1`, or the v1
# `crm_api_1`): any other stdout from the command (a warning, a stray line from a shell
# startup file) is not a container and is never published as one. A shape check on
# unvalidated text is not provenance; matching the naming scheme is.
names=$($dc ps --format '{{.Name}}' api 2>/dev/null </dev/null | grep -E '^[A-Za-z0-9][A-Za-z0-9.-]{0,40}[-_]api[-_][0-9]{1,3}$' || true)
n=$(printf '%s\n' "$names" | grep -c . || true)
cname=$(printf '%s\n' "$names" | head -n 1)
if ! logs=$($dc logs --no-color --timestamps --since "$LOGSCAN_SINCE" api 2>&1 </dev/null); then
  echo "LOGSCAN_FAILED=compose_logs"
  exit 0
fi

# ── Drop what an anonymous client can write into the log (SR-H-5) ─────────────────────
# Production logs requests with Fastify's own logger (pino JSON, apps/api/src/main.ts),
# and `req.url` reaches it verbatim with its query string, so `GET /api/health?code=42501`
# is a line the pattern matches. Measured against the REAL Fastify logger (see
# tests/lib/real-fastify-request-log.ts): it is not only the `req` object. Fastify's own
# 404 record has NO req/res key and still echoes the path in its `msg`
# ("Route GET:/x/sqlstate=42501 not found"). So the rule is by record, not by key:
#   - a pino record below level 50 (info/warn: request lifecycle, 404, 4xx) is never
#     evidence of a database error, and is dropped;
#   - a record at level 50+ is kept, with `req`, `res` and `reqId` removed (a genuine 500
#     keeps its `err`, the client's URL is gone);
#   - anything that is not a whole-line pino record (Nest's text Logger) is kept as is.
# Only a line that STARTS as a JSON object (after docker's `service | timestamp ` prefix)
# is touched, so an attacker cannot get a genuine text line dropped by echoing `{...}`.
#
# FAIL-OPEN IS THE WRONG DIRECTION FOR A FILTER THAT REMOVES ATTACKER TEXT (SR-H-7).
# Docker's json-file driver splits a log line over 16384 bytes and `--timestamps` stamps
# EACH chunk, inline: a 16.5 KB pino record arrives with a second timestamp inside it. A
# stamp that lands between JSON tokens made `json.loads` raise, and the old code kept the
# line verbatim, `req.url` included; the client chooses where it lands (pino doubles each
# `"` it escapes, so the byte count is theirs to tune). So:
#   1. the level is read from the TEXT (`{"level":NN`), never from a parse: below 50 the
#      record is dropped before json.loads is even tried;
#   2. a record that will not parse has its embedded stamps stripped and is parsed again
#      (a split record then parses);
#   3. one that still will not, but LOOKS like pino (`{"level":`), is DROPPED, never kept,
#      and counted: the count is written to the file named in argv[1] and surfaces as
#      LOGSCAN_UNPARSED so the discard is visible rather than silent.
#
# Fail closed: no python3 (a documented VPS dependency already, see check-backup-freshness.sh),
# a crash, a python3 that exits 0 and prints nothing, or one that just copies its input
# (a broken shim or version-manager wrapper) is LOGSCAN_FAILED, never "nothing found".
# The last two are caught by a CANARY pushed through the same invocation (below).
# KEEP THE PYTHON IDENTICAL IN deploy-stack-on-vps.sh (tests/test-check-api-permission-denied.sh
# fails on drift).
# --- BEGIN LOGSCAN_REQ_FILTER
read -r -d '' LOGSCAN_REQ_FILTER <<'PYEOF' || true
import json, re, sys
pre = re.compile(r"^((?:[^|{]{0,60}\| )?(?:\d{4}-\d\d-\d\dT[0-9:.]{8,20}Z )?)(\{.*)$")
lvl = re.compile(r'^\{"level":(\d{1,3})(?![0-9])')
stamp = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z ")
unparsed = 0
for raw in sys.stdin.buffer:
    line = raw.decode("utf-8", "replace").rstrip("\r\n")
    looks = False
    out = line
    try:
        m = pre.match(line)
        if m:
            head, rest = m.group(1), m.group(2)
            looks = rest.startswith('{"level":')
            lm = lvl.match(rest)
            if lm and int(lm.group(1)) < 50:
                out = None
            else:
                rec = None
                for cand in (rest, stamp.sub("", rest)):
                    try:
                        rec = json.loads(cand)
                        break
                    except Exception:
                        pass
                if isinstance(rec, dict):
                    for k in ("req", "res", "reqId"):
                        rec.pop(k, None)
                    out = head + json.dumps(rec, separators=(",", ":"))
                elif looks:
                    out = None
                    unparsed += 1
    except Exception:
        if looks:
            out = None
            unparsed += 1
    if out is not None:
        print(out)
if len(sys.argv) > 1:
    with open(sys.argv[1], "w") as f:
        f.write(str(unparsed))
PYEOF
# --- END LOGSCAN_REQ_FILTER
command -v python3 >/dev/null 2>&1 || { echo "LOGSCAN_FAILED=no_python3"; exit 0; }
# The canary (SR-M-8, SR-M-12): four synthetic records go through the SAME invocation as
# the logs, and the filter must do EVERY job it exists for, not just some:
#   keep   a level-50 record WITH a req and a reqId. It must come back EXACTLY, with both
#          removed. A python3 that only drops level 30 passes records through unchanged,
#          so the req survives and the exact-line check fails (SR-M-12);
#   drop   a level-30 record. It must NOT come back;
#   cut    a truncated level-50 pino record. It must NOT come back AND must be counted as
#          unparsed, which proves the drop-and-count path runs;
# plus an empty-output or copy-input python3, which returns the wrong set altogether.
# Matched as whole lines: the canaries are injected un-prefixed, which no real log line
# (always prefixed by compose) can equal.
canary_keep_in='{"level":50,"reqId":"req-canary","req":{"method":"GET","url":"/canary?LOGSCAN_CANARY_REQ"},"msg":"LOGSCAN_CANARY"}'
canary_keep='{"level":50,"msg":"LOGSCAN_CANARY"}'
canary_drop='{"level":30,"msg":"LOGSCAN_CANARY_DROP"}'
canary_cut='{"level":50,"reqId":"req-canary","req":{"method":"GET","url":"/canary?LOGSCAN_CANARY_CUT"'
countfile=$(mktemp 2>/dev/null) || { echo "LOGSCAN_FAILED=req_filter"; exit 0; }
if ! filtered_all=$( { printf '%s\n%s\n%s\n' "$canary_keep_in" "$canary_drop" "$canary_cut"; printf '%s\n' "$logs"; } | python3 -c "$LOGSCAN_REQ_FILTER" "$countfile" 2>/dev/null); then
  rm -f "$countfile"
  echo "LOGSCAN_FAILED=req_filter"
  exit 0
fi
unparsed=$(cat "$countfile" 2>/dev/null)
rm -f "$countfile"
if ! printf '%s\n' "$filtered_all" | grep -qxF "$canary_keep" \
  || printf '%s\n' "$filtered_all" | grep -qxF "$canary_keep_in" \
  || printf '%s\n' "$filtered_all" | grep -qxF "$canary_drop" \
  || printf '%s\n' "$filtered_all" | grep -qxF "$canary_cut"; then
  echo "LOGSCAN_FAILED=req_filter_canary"
  exit 0
fi
case "$unparsed" in '' | *[!0-9]*) echo "LOGSCAN_FAILED=req_filter"; exit 0 ;; esac
# The cut canary MUST have been counted: zero means the drop-and-count path did not run.
[ "$unparsed" -ge 1 ] || { echo "LOGSCAN_FAILED=req_filter_canary"; exit 0; }
unparsed=$((unparsed - 1))
filtered=$(printf '%s\n' "$filtered_all" | grep -vxF "$canary_keep")

echo "LOGSCAN_API_CONTAINERS=$n"
echo "LOGSCAN_CONTAINER=${cname:-unknown}"
echo "LOGSCAN_LINES=$(printf '%s\n' "$logs" | grep -c . || true)"
echo "LOGSCAN_HITS=$(printf '%s\n' "$filtered" | grep -aEic -e "$LOGSCAN_RE" || true)"
echo "LOGSCAN_CONTRACT_HITS=$(printf '%s\n' "$filtered" | grep -aEic -e "$LOGSCAN_CONTRACT_RE" || true)"
echo "LOGSCAN_UNPARSED=$unparsed"
printf '%s\n' "$filtered" | grep -aEi -e "$LOGSCAN_RE" | tail -n 20 | while IFS= read -r l; do
  # `docker compose logs` prefixes every line with `<service>-<n>  | ` and, with
  # --timestamps, the RFC3339 time follows the pipe. Accept both that and the bare
  # `docker logs` shape. (Measured against the real format: the first version of this
  # regex assumed a bare line, so the time was always `unknown`.)
  ts=$(printf '%s' "$l" | sed -nE 's/^([^|]{0,60}\| )?([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,20}Z) .*/\2/p')

  # ALLOWLIST, not a pattern: a log line is partly attacker-influenced, so a name is
  # shown only if it is ON a list derived from the repository (LOGSCAN_LOGGERS /
  # LOGSCAN_TABLES, see derive-permission-denied-allowlists.sh). Anything else becomes
  # `unknown`. `unknown` REDUCES PRECISION, IT NEVER SUPPRESSES THE HIT: the line was
  # already counted and is still emitted, so it still pages. An unrecognised object is
  # the case most likely to be interesting.
  lg=$(printf '%s' "$l" | sed -nE 's/.*(ERROR|WARN|FATAL) *\[([A-Za-z0-9_.-]{1,60})\].*/\2/p' | head -n 1)
  case " $LOGSCAN_LOGGERS " in *" $lg "*) [ -n "$lg" ] || lg=unknown ;; *) lg=unknown ;; esac
  if printf '%s' "$l" | grep -Eqi -e "$LOGSCAN_CONTRACT_RE"; then
    # THE CONTRACT (primary): `db_privilege_denied sqlstate=42501 table=<T> ctx=<C>`, the
    # one line the API's chokepoint emits. The table is read from its own `table=` field,
    # never parsed out of Postgres text; the API writes the literal `unknown` when the 42501
    # names no table. That is the same word this script uses when it cannot verify a name
    # against the manifest: one word for one concept, so both come out as `table:unknown`.
    # See check-api-permission-denied.sh for which pattern is the contract and which is
    # belt and braces.
    src=contract
    st=42501
    ob=""
    tb=$(printf '%s' "$l" | sed -nE 's/.* table=([^ ]{1,70})( .*)?$/\1/p' | head -n 1)
    tb=${tb#public.}
    if [ -n "$tb" ]; then
      case " $LOGSCAN_TABLES " in *" $tb "*) ob="table:$tb" ;; *) ob="table:unknown" ;; esac
    fi
  else
  src=text
  lo=$(printf '%s' "$l" | tr 'A-Z' 'a-z')
  pre=""
  kn=$(printf '%s' "$lo" | sed -nE 's/.*permission denied for (table|sequence|schema|function|relation|view|type|database) "?([a-z_][a-z0-9_.]{0,62}).*/\1 \2/p' | head -n 1)
  if [ -z "$kn" ]; then
    pre="owner-only:"
    kn=$(printf '%s' "$lo" | sed -nE 's/.*must be owner of (table|sequence|schema|function|relation|view|type|database) "?([a-z_][a-z0-9_.]{0,62}).*/\1 \2/p' | head -n 1)
  fi
  ob=""
  if [ -n "$kn" ]; then
    kind=${kn%% *}
    nm=${kn#* }
    nm=${nm#public.}
    case " $LOGSCAN_TABLES " in *" $nm "*) ob="$pre$kind:$nm" ;; *) ob="$pre$kind:unknown" ;; esac
  fi
  if printf '%s' "$lo" | grep -Eq '(sqlstate|code)[^0-9a-z]{0,6}42501'; then
    st=42501
  elif [ -n "$ob" ]; then
    st=42501-by-message
  else
    st=unclassified
  fi
  fi
  echo "LOGSCAN_HIT ts=${ts:-unknown} logger=${lg:-unknown} object=${ob:-unknown} sqlstate=$st src=$src"
done
echo "LOGSCAN_END"
