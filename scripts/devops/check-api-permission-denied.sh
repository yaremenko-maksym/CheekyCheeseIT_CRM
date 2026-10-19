#!/usr/bin/env bash
#
# check-api-permission-denied.sh — verdict for the standing `permission denied` /
# SQLSTATE 42501 watch over the API's logs. Measure 2 of the least-privilege ADR
# (docs/architecture/2026-10-17-db-least-privilege-roles.md, "What step 4 does not
# reach"), a PREREQUISITE of switching the API to `crm_app`.
#
# WHY IT EXISTS. Six of eight cron services test against a fully mocked
# DatabaseService, so a table misclassified in the privilege manifest is found not
# by CI but by the first cron fire as a 42501 inside a handler that swallows its
# errors. This is what shortens that exposure to "until the next scan".
#
# COVERAGE DEPENDS ON THE API LOGGING THE CODE. A Drizzle query error's message is
# `Failed query: ...`; the SQLSTATE and "permission denied" live only on `.cause`.
# Until the API logs the SQLSTATE from `.cause` on the swallow-and-log paths, this
# watch sees nothing there. "Detection in place, coverage pending" — not "measure 2
# satisfied". The pattern below is written for the format that change produces:
# a labelled `sqlstate=42501` (or `code: '42501'`), plus the PG message text.
#
# THE ENVELOPE IS FIELDS ONLY. This repository and its Actions logs are PUBLIC, and
# a raw log line can carry statements, table/column names and personal identifiers.
# So the matching AND the sanitising happen ON THE VPS (the remote script in
# .github/workflows/api-permission-denied-watch.yml); nothing raw ever leaves
# production. This script is the second lock: it accepts ONLY these line shapes and
# treats any other line as BLIND without echoing it, so a remote that started
# leaking text would turn the run red instead of publishing it.
#
#   LOGSCAN_API_CONTAINERS=<n>
#   LOGSCAN_CONTAINER=<name>            first api container, charset-validated
#   LOGSCAN_LINES=<n>                   log lines in the window
#   LOGSCAN_HITS=<n>                    matching lines in the window
#   LOGSCAN_HIT ts=<utc> logger=<name> object=<kind:name> sqlstate=<42501|42501-by-message|unclassified>   (<=20)
#   LOGSCAN_END
#   (or)  LOGSCAN_FAILED=<reason>
#
# EXIT CODES (the contract the workflow and the tests rely on):
#   0  clean: the logs WERE read (envelope complete, >=1 api container), no match.
#   1  HIT. The workflow goes red; GitHub's failed-run notification is the page.
#   2  BLIND: could not see (empty/partial/garbled envelope, no api container, the
#      remote failed, an unexpected line). Red on purpose: "no output" must never
#      read as "no problem" (the deploy-freshness guard once stayed silent through
#      a three-hour outage).
#
# WHAT THE ALERT CANNOT SAY. The role: the API log does not carry it, and reading it
# means reading the credential-bearing DATABASE_URL on production, which this watch
# does not do (owner decision, see the PR). The summary says so rather than guess.
# The statement text is deliberately not carried either; Postgres' own server log
# has the ERROR/STATEMENT pair for the reported timestamps.
#
# PATTERN. One definition, here; `--print-pattern` hands it to the remote grep.
# deploy-stack-on-vps.sh runs on the VPS without this repository, so it carries a
# copy; tests/test-check-api-permission-denied.sh fails if the two differ.
#   permission denied        the message of 42501 for tables/sequences/schemas/params
#   must be owner|superuser  also 42501 (ALTER TABLE .. DISABLE TRIGGER), no such phrase
#   sqlstate/code .. 42501   the code itself, when a log prints it labelled
# Known noise: a non-database "Permission denied" (EACCES, ssh publickey) matches too;
# it is reported as sqlstate=unclassified. A false page read in a minute is the
# cheaper error.
set -uo pipefail

PERMISSION_DENIED_RE='permission denied|must be (owner|superuser)|(sqlstate|code)[^0-9a-z]{0,6}42501'

if [ "${1:-}" = "--print-pattern" ]; then
  printf '%s\n' "$PERMISSION_DENIED_RE"
  exit 0
fi

SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

blind() {
  echo "::error title=API permission-denied watch is BLIND::$1"
  {
    echo "## API permission-denied watch: BLIND"
    echo ""
    echo "$1"
    echo ""
    echo "The watch could not read the API logs, so it cannot say there is no 42501. Treated as red."
  } >>"$SUMMARY"
  exit 2
}

if [ -t 0 ]; then
  blind "no envelope on stdin (run via the workflow, or pipe a LOGSCAN envelope)"
fi
ENVELOPE="$(cat)"
[ -n "$ENVELOPE" ] || blind "empty envelope: the remote step produced no output"

RE_HIT='^LOGSCAN_HIT ts=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,20}Z|unknown) logger=[A-Za-z0-9_.-]{1,60} object=[a-z0-9_.:-]{1,100} sqlstate=(42501|42501-by-message|unclassified)$'
RE_KNOWN='^(LOGSCAN_API_CONTAINERS=[0-9]{1,4}|LOGSCAN_CONTAINER=[A-Za-z0-9_./-]{1,60}|LOGSCAN_LINES=[0-9]{1,9}|LOGSCAN_HITS=[0-9]{1,9}|LOGSCAN_END|LOGSCAN_FAILED=[A-Za-z0-9_.-]{1,40})$'

# Second lock: any line that is neither a known field line nor a valid HIT line
# is refused WITHOUT being printed.
unexpected=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  if printf '%s' "$line" | grep -Eq "$RE_KNOWN"; then continue; fi
  if printf '%s' "$line" | grep -Eq "$RE_HIT"; then continue; fi
  unexpected=$((unexpected + 1))
done <<EOF
$ENVELOPE
EOF
[ "$unexpected" -eq 0 ] || blind "${unexpected} envelope line(s) are not in the field-only format (not shown, to keep raw text out of the public log)"

field() { printf '%s\n' "$ENVELOPE" | sed -n "s/^$1=\(.*\)\$/\1/p" | head -n 1; }

failed="$(field LOGSCAN_FAILED)"
[ -z "$failed" ] || blind "the remote could not read the API logs (reason: $failed)"

containers="$(field LOGSCAN_API_CONTAINERS)"
container="$(field LOGSCAN_CONTAINER)"
lines="$(field LOGSCAN_LINES)"
hits="$(field LOGSCAN_HITS)"
[ -n "$containers" ] || blind "envelope has no LOGSCAN_API_CONTAINERS (truncated or wrong format)"
[ -n "$lines" ] || blind "envelope has no LOGSCAN_LINES (truncated or wrong format)"
[ -n "$hits" ] || blind "envelope has no LOGSCAN_HITS (truncated or wrong format)"
[ "$containers" -ge 1 ] || blind "no running api container on the VPS: nothing to watch"
printf '%s\n' "$ENVELOPE" | grep -qx 'LOGSCAN_END' || blind "envelope has no LOGSCAN_END (output truncated)"

hit_lines="$(printf '%s\n' "$ENVELOPE" | grep -E "$RE_HIT" || true)"
detail_n=0
[ -z "$hit_lines" ] || detail_n="$(printf '%s\n' "$hit_lines" | grep -c .)"
if [ "$hits" -eq 0 ] && [ "$detail_n" -gt 0 ]; then
  blind "envelope reports 0 hits but lists ${detail_n} hit line(s): inconsistent"
fi

if [ "$hits" -eq 0 ]; then
  echo "OK: read ${lines} API log line(s) from ${containers} container(s) (${container:-unknown}); no permission-denied / 42501."
  {
    echo "## API permission-denied watch: clean"
    echo ""
    echo "Read ${lines} log line(s) from ${containers} api container(s); no match."
  } >>"$SUMMARY"
  [ "$lines" -gt 0 ] || echo "::warning::the window held 0 log lines: clean, but a silent API is worth a look"
  exit 0
fi

# hits > 0 is red even if no detail line survived: the count alone is the alert.
echo "::error title=API hit permission denied (42501)::${hits} matching log line(s) in container ${container:-unknown}. The API's database role lacks a grant for something a handler just did."
{
  echo "## API permission-denied watch: HIT (${hits} line(s), container ${container:-unknown})"
  echo ""
  echo "Postgres refused a statement from the API (42501). A scheduled job that swallows its errors is the usual way this stays unseen."
  echo ""
  echo "| time (UTC) | logger | object | sqlstate |"
  echo "| --- | --- | --- | --- |"
} >>"$SUMMARY"

if [ "$detail_n" -gt 0 ]; then
  while IFS= read -r l; do
    ts="$(printf '%s' "$l" | sed -E 's/^LOGSCAN_HIT ts=([^ ]+) .*/\1/')"
    lg="$(printf '%s' "$l" | sed -E 's/.* logger=([^ ]+) .*/\1/')"
    ob="$(printf '%s' "$l" | sed -E 's/.* object=([^ ]+) .*/\1/')"
    st="$(printf '%s' "$l" | sed -E 's/.* sqlstate=([^ ]+)$/\1/')"
    echo "HIT time=${ts} logger=${lg} object=${ob} sqlstate=${st}"
    echo "| ${ts} | ${lg} | ${ob} | ${st} |" >>"$SUMMARY"
  done <<EOF
$hit_lines
EOF
fi
if [ "$hits" -gt "$detail_n" ]; then
  echo "(${hits} matching in total, ${detail_n} listed)"
fi
{
  echo ""
  echo "**Role:** not in the API log. It is the user in the API's \`DATABASE_URL\` (\`crm_user\` before ADR step 5, \`crm_app\` after). This watch does not read that variable."
  echo "**sqlstate:** \`42501\` = the code was logged; \`42501-by-message\` = inferred from Postgres' message text; \`unclassified\` = matched the words but is not a recognisable database error (a file or ssh permission, perhaps)."
  echo "**Statement:** deliberately not carried (public log). Postgres' own server log has the ERROR/STATEMENT pair for these timestamps."
  echo "**Fix:** the table's class in the privilege manifest plus the one missing grant (ADR, Rollback: a forward fix, no widen-grants file)."
} >>"$SUMMARY"
exit 1
