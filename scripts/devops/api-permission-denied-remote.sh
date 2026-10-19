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

echo "LOGSCAN_API_CONTAINERS=$n"
echo "LOGSCAN_CONTAINER=${cname:-unknown}"
echo "LOGSCAN_LINES=$(printf '%s\n' "$logs" | grep -c . || true)"
echo "LOGSCAN_HITS=$(printf '%s\n' "$logs" | grep -aEic -e "$LOGSCAN_RE" || true)"
printf '%s\n' "$logs" | grep -aEi -e "$LOGSCAN_RE" | tail -n 20 | while IFS= read -r l; do
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
