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

# Fail closed on missing allowlists. Under `set -u` an unset list would kill the loop
# below mid-way while LOGSCAN_END is still printed, leaving a count with no detail.
if [ -z "${LOGSCAN_TABLES:-}" ] || [ -z "${LOGSCAN_LOGGERS:-}" ] || [ -z "${LOGSCAN_RE:-}" ] || [ -z "${LOGSCAN_SINCE:-}" ]; then
  echo "LOGSCAN_FAILED=inputs_missing"
  exit 0
fi

cd "${LOGSCAN_CRM_DIR:-/opt/crm}" 2>/dev/null || { echo "LOGSCAN_FAILED=no_crm_dir"; exit 0; }
dc="docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml --env-file .env.production"

names=$($dc ps --format '{{.Name}}' api 2>/dev/null </dev/null)
n=$(printf '%s\n' "$names" | grep -c . || true)
cname=$(printf '%s\n' "$names" | head -n 1 | tr -dc 'A-Za-z0-9_./-' | cut -c1-60)
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
# Fail closed: no python3 (a documented VPS dependency already, see
# check-backup-freshness.sh) or a crash is LOGSCAN_FAILED, never "nothing found".
# KEEP THE PYTHON IDENTICAL IN deploy-stack-on-vps.sh (tests/test-check-api-permission-denied.sh
# fails on drift).
# --- BEGIN LOGSCAN_REQ_FILTER
read -r -d '' LOGSCAN_REQ_FILTER <<'PYEOF' || true
import json, re, sys
rx = re.compile(r"^((?:[^|{]{0,60}\| )?(?:\d{4}-\d\d-\d\dT[0-9:.]{8,20}Z )?)(\{.*\})$")
for raw in sys.stdin.buffer:
    line = raw.decode("utf-8", "replace").rstrip("\r\n")
    m = rx.match(line)
    if not m:
        print(line)
        continue
    try:
        rec = json.loads(m.group(2))
    except ValueError:
        print(line)
        continue
    if not isinstance(rec, dict):
        print(line)
        continue
    lvl = rec.get("level")
    if isinstance(lvl, int) and lvl < 50:
        continue
    for k in ("req", "res", "reqId"):
        rec.pop(k, None)
    print(m.group(1) + json.dumps(rec, separators=(",", ":")))
PYEOF
# --- END LOGSCAN_REQ_FILTER
command -v python3 >/dev/null 2>&1 || { echo "LOGSCAN_FAILED=no_python3"; exit 0; }
if ! filtered=$(printf '%s\n' "$logs" | python3 -c "$LOGSCAN_REQ_FILTER" 2>/dev/null); then
  echo "LOGSCAN_FAILED=req_filter"
  exit 0
fi

echo "LOGSCAN_API_CONTAINERS=$n"
echo "LOGSCAN_CONTAINER=${cname:-unknown}"
echo "LOGSCAN_LINES=$(printf '%s\n' "$logs" | grep -c . || true)"
echo "LOGSCAN_HITS=$(printf '%s\n' "$filtered" | grep -aEic -e "$LOGSCAN_RE" || true)"
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
  echo "LOGSCAN_HIT ts=${ts:-unknown} logger=${lg:-unknown} object=${ob:-unknown} sqlstate=$st"
done
echo "LOGSCAN_END"
