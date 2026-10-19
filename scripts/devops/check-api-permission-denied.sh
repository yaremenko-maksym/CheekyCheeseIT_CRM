#!/usr/bin/env bash
#
# check-api-permission-denied.sh — standing detector for `permission denied` /
# SQLSTATE 42501 in the API's logs. Measure 2 of the least-privilege ADR
# (docs/architecture/2026-10-17-db-least-privilege-roles.md, "What step 4 does
# not reach"), a PREREQUISITE of switching the API to `crm_app`.
#
# WHY IT EXISTS. Six of eight cron services test against a fully mocked
# DatabaseService, so a table misclassified in the privilege manifest is found
# not by CI but by the first cron fire (daily or monthly) as a 42501 inside a
# handler that deliberately swallows its errors. This detector is what shortens
# that exposure from "until somebody reads logs" to "until the next scan".
#
# WHAT IT READS. The envelope printed by .github/workflows/api-permission-denied-
# watch.yml's remote script (stdin), NOT raw logs:
#
#   LOGSCAN_API_CONTAINERS=<n>      running `api` containers on the VPS
#   LOGSCAN_LINES=<n>               log lines seen in the window
#   LOGSCAN_MATCHES_BEGIN
#   <up to 40 raw log lines the remote grep matched, `docker logs -t` format>
#   LOGSCAN_MATCHES_END
#   (or)  LOGSCAN_FAILED=<reason>   the remote could not read the logs
#
# EXIT CODES — the contract the workflow and the tests rely on:
#   0  clean: the logs WERE read (envelope complete, >=1 api container) and hold
#      no match.
#   1  HIT: at least one match. Act on it (the workflow goes red => GitHub's
#      failed-run notification is the page).
#   2  BLIND: the detector could not see (no/partial/garbled envelope, no api
#      container, remote read failed, remote and local disagree). Treated as red
#      on purpose. "No output" must never read as "no problem": the deploy-
#      freshness guard once produced no alert through a three-hour outage.
#
# LOG HYGIENE (load-bearing — this repository and its Actions logs are PUBLIC).
# Raw log lines are never printed. Only fields that survive a strict charset
# check are emitted: timestamp, logger context, and the object name out of
# `permission denied for <kind> <name>`. A log line is attacker-influenced (a
# request path can contain the words "permission denied"), so nothing from it
# is echoed that was not validated, which also rules out `::error::` workflow-
# command injection through a crafted line.
#
# WHAT THE LOG DOES NOT SAY. Postgres' client-side message carries the object,
# not the role and not the statement text; those live in the Postgres server log
# (ERROR/STATEMENT lines, user in log_line_prefix). The role is whatever
# DATABASE_URL names — `crm_user` today, `crm_app` after ADR step 5. The summary
# says so rather than inventing a role.
#
# PATTERN. One definition, here. `--print-pattern` is how the workflow gets it
# (passed to the remote grep). deploy-stack-on-vps.sh runs on the VPS without
# this repository, so it carries a copy; tests/test-check-api-permission-denied.sh
# fails if the two differ.
#   permission denied     the message of 42501 for tables/sequences/schemas/params
#   must be owner|superuser  also 42501 ("ALTER TABLE ... DISABLE TRIGGER"), whose
#                         text does not contain "permission denied"
#   SQLSTATE/code .. 42501   the code itself, when a log prints it labelled
# Known noise: a non-database "Permission denied" (EACCES on a file, an ssh
# publickey failure) matches too. A false page that is read in a minute is the
# cheaper error here.
set -uo pipefail

PERMISSION_DENIED_RE='permission denied|must be (owner|superuser)|(sqlstate|code)[^0-9a-z]{0,6}42501'

if [ "${1:-}" = "--print-pattern" ]; then
  printf '%s\n' "$PERMISSION_DENIED_RE"
  exit 0
fi

MAX_HITS_SHOWN=20
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

blind() {
  echo "::error title=API permission-denied watch is BLIND::$1"
  {
    echo "## API permission-denied watch: BLIND"
    echo ""
    echo "$1"
    echo ""
    echo "The detector could not read the API logs, so it cannot say there is no 42501. Treated as red."
  } >>"$SUMMARY"
  exit 2
}

if [ -t 0 ]; then
  blind "no envelope on stdin (run via the workflow, or pipe a LOGSCAN envelope)"
fi
ENVELOPE="$(cat)"

if [ -z "$ENVELOPE" ]; then
  blind "empty envelope: the remote step produced no output"
fi

failed="$(printf '%s\n' "$ENVELOPE" | sed -n 's/^LOGSCAN_FAILED=\([A-Za-z0-9_.-]\{1,40\}\).*/\1/p' | head -n 1)"
if [ -n "$failed" ]; then
  blind "the remote could not read the API logs (reason: $failed)"
fi

containers="$(printf '%s\n' "$ENVELOPE" | sed -n 's/^LOGSCAN_API_CONTAINERS=\([0-9]\{1,4\}\)$/\1/p' | head -n 1)"
lines="$(printf '%s\n' "$ENVELOPE" | sed -n 's/^LOGSCAN_LINES=\([0-9]\{1,9\}\)$/\1/p' | head -n 1)"
[ -n "$containers" ] || blind "envelope has no LOGSCAN_API_CONTAINERS (truncated or wrong format)"
[ -n "$lines" ] || blind "envelope has no LOGSCAN_LINES (truncated or wrong format)"
[ "$containers" -ge 1 ] || blind "no running api container on the VPS: nothing to watch"
printf '%s\n' "$ENVELOPE" | grep -qx 'LOGSCAN_MATCHES_BEGIN' || blind "envelope has no LOGSCAN_MATCHES_BEGIN"
printf '%s\n' "$ENVELOPE" | grep -qx 'LOGSCAN_MATCHES_END' || blind "envelope has no LOGSCAN_MATCHES_END (output truncated)"

block="$(printf '%s\n' "$ENVELOPE" | sed -n '/^LOGSCAN_MATCHES_BEGIN$/,/^LOGSCAN_MATCHES_END$/p' | sed '1d;$d')"

# Re-apply the pattern locally: the remote filter is not trusted to be right.
matched="$(printf '%s\n' "$block" | grep -aEi -e "$PERMISSION_DENIED_RE" || true)"

if [ -n "$block" ] && [ -z "$matched" ]; then
  blind "the remote sent match lines that the local pattern rejects: remote and local filters disagree"
fi

if [ -z "$matched" ]; then
  echo "OK: read ${lines} API log line(s) from ${containers} container(s); no permission-denied / 42501."
  {
    echo "## API permission-denied watch: clean"
    echo ""
    echo "Read ${lines} log line(s) from ${containers} api container(s); no match."
  } >>"$SUMMARY"
  [ "$lines" -gt 0 ] || echo "::warning::the window held 0 log lines: clean, but a silent API is worth a look"
  exit 0
fi

total="$(printf '%s\n' "$matched" | grep -c .)"
echo "::error title=API hit permission denied (42501)::${total} matching log line(s) in the window. The API role lacks a grant for something a handler just did."
{
  echo "## API permission-denied watch: HIT (${total} line(s))"
  echo ""
  echo "Postgres refused a statement from the API with 42501. A scheduled job that swallows its errors is the usual way this stays unseen."
  echo ""
  echo "| time (UTC) | logger | object |"
  echo "| --- | --- | --- |"
} >>"$SUMMARY"

shown=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  shown=$((shown + 1))
  [ "$shown" -le "$MAX_HITS_SHOWN" ] || continue

  ts="$(printf '%s' "$line" | sed -n 's/^\([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}T[0-9:.]\{8,20\}Z\) .*/\1/p')"
  [ -n "$ts" ] || ts="unknown"

  ctx="$(printf '%s' "$line" | sed -n 's/.*\(ERROR\|WARN\|FATAL\) *\[\([A-Za-z0-9_.-]\{1,60\}\)\].*/\2/p' | head -n 1)"
  [ -n "$ctx" ] || ctx="unknown"

  obj="$(printf '%s' "$line" | sed -n 's/.*[Pp]ermission denied for \(table\|sequence\|schema\|function\|relation\|view\|type\|database\) "\{0,1\}\([A-Za-z_][A-Za-z0-9_.]\{0,62\}\).*/\1 \2/p' | head -n 1)"
  if [ -z "$obj" ]; then
    obj="$(printf '%s' "$line" | sed -n 's/.*[Mm]ust be owner of \(table\|sequence\|schema\|function\|relation\|view\|type\|database\) "\{0,1\}\([A-Za-z_][A-Za-z0-9_.]\{0,62\}\).*/owner-only: \1 \2/p' | head -n 1)"
  fi
  [ -n "$obj" ] || obj="not parsed (see the VPS logs)"

  echo "HIT time=${ts} logger=${ctx} object=${obj}"
  echo "| ${ts} | ${ctx} | ${obj} |" >>"$SUMMARY"
done <<EOF
$matched
EOF

if [ "$shown" -gt "$MAX_HITS_SHOWN" ]; then
  echo "(+$((shown - MAX_HITS_SHOWN)) more not listed)"
fi
{
  echo ""
  echo "**Role:** the log does not name it; it is the user in the API's \`DATABASE_URL\` (\`crm_user\` before ADR step 5, \`crm_app\` after)."
  echo "**Statement:** not in the API log. Postgres' own server log has the ERROR/STATEMENT pair for these timestamps."
  echo "**Fix:** the table's class in the privilege manifest plus the one missing grant (ADR, Rollback: a forward fix, no widen-grants file)."
} >>"$SUMMARY"
exit 1
