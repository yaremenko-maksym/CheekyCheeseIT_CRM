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
#   LOGSCAN_BEGIN                       first line; anything before it is discarded and counted
#   LOGSCAN_API_CONTAINERS=<n>
#   LOGSCAN_CONTAINER=<name>            first api container, charset-validated
#   LOGSCAN_LINES=<n>                   log lines in the window
#   LOGSCAN_HITS=<n>                    lines in the window matching ANY pattern (contract + text)
#   LOGSCAN_CONTRACT_HITS=<n>           of those, the lines matching the contract (<= HITS)
#   LOGSCAN_UNPARSED=<n>                pino-looking records the VPS filter could not parse and DROPPED
#   LOGSCAN_HIT ts=<utc> logger=<allowlisted|unknown> object=<kind:allowlisted|kind:unknown|unknown> sqlstate=<42501|42501-by-message|unclassified> src=<contract|text>   (<=20)
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
# PATTERNS. One definition, here. `--print-pattern` (everything that pages) and
# `--print-contract-pattern` (the contract alone) hand them to the remote script.
# deploy-stack-on-vps.sh runs on the VPS without this repository, so it carries a copy of
# the full pattern; tests/test-check-api-permission-denied.sh fails if the two differ.
#
#   THE CONTRACT (primary) — the line the API's one chokepoint emits, PR #1042,
#   apps/api/src/database/privilege-denied-reporter.ts:
#       db_privilege_denied sqlstate=42501 table=<T> ctx=<C>
#   matched as `[DatabasePrivilege] db_privilege_denied` ... `sqlstate=42501`: the logger
#   context it is emitted under (part of the contract, SR-M-9), the token, then the code in
#   any order (the API's own comment says the alert may rely on those and nothing else).
#   `table=<T>` is read from that field, never parsed out of Postgres text; `table=unknown`
#   means the 42501 named no table (the same word this watch uses for a name it cannot verify). This is the line to trust: one tested place emits it,
#   instead of eight handlers' formatting.
#
#   BELT AND BRACES (secondary) — text that a privilege error carries when it did NOT pass
#   the chokepoint (a callback-style pool call it cannot wrap) or when the chokepoint is
#   not deployed yet:
#       permission denied         the message of 42501 for tables/sequences/schemas/params
#       must be owner|superuser   also 42501 (ALTER TABLE .. DISABLE TRIGGER), no such phrase
#   These are reported as `src=text`, counted apart from the contract, and they can fire
#   for the same failure as a contract line (a handler's own diagnostic line quotes the
#   Postgres message). That is two lines for one failure, stated rather than hidden: the
#   summary says "N contract, M other".
#   NOT matched, deliberately: a bare `sqlstate=42501` / `code: 42501` (too generic: it
#   also matched the diagnostic fragment `db_sqlstate=42501`, so one swallowed failure
#   paged twice, and a client can put it in a query string).
# Known noise: a non-database "Permission denied" (EACCES, ssh publickey) matches the text
# patterns too; it is reported as sqlstate=unclassified. A false page read in a minute is
# the cheaper error.
set -uo pipefail

# ANCHORED ON THE LOGGER CONTEXT (SR-M-9). The contract is emitted under the Nest logger
# context `DatabasePrivilege` (PR #1042 asserts it in its own test and treats it as part of
# the contract). Anchoring on `[DatabasePrivilege]` means request data echoed into some
# other handler's error message or log line cannot forge the primary pattern: it would
# also have to inject that bracketed context. The contract stays on Nest's TEXT
# `Logger.error`: a pino record at warn level carrying a genuine 42501 would be dropped by
# the level rule in the filter, so it must never move there.
PERMISSION_DENIED_CONTRACT_RE='\[DatabasePrivilege\] db_privilege_denied.*sqlstate=42501'
PERMISSION_DENIED_RE="${PERMISSION_DENIED_CONTRACT_RE}"'|permission denied|must be (owner|superuser)'

# PUBLISHED INTERFACE. The output of `--print-pattern` and `--print-contract-pattern` has a
# CONSUMER outside this file: PR #1042 (the API side) reads these instead of keeping its own
# copy of the pattern, and the VPS scripts receive them through the workflow. Changing either
# pattern changes what they see, so: change the two flags' output deliberately and in the same
# commit, update deploy-stack-on-vps.sh's copy, tell the API side, and update the pinned literals
# in tests/test-check-api-permission-denied.sh (they exist to make an accidental change loud).
if [ "${1:-}" = "--print-pattern" ]; then
  printf '%s\n' "$PERMISSION_DENIED_RE"
  exit 0
fi
if [ "${1:-}" = "--print-contract-pattern" ]; then
  printf '%s\n' "$PERMISSION_DENIED_CONTRACT_RE"
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

# THE FRAME (SR-M-6). Everything before the first LOGSCAN_BEGIN and everything after the
# first LOGSCAN_END is not ours: a login shell's rc file, a motd line or BASH_ENV can write
# to the same stream before the remote script runs. Those lines are DISCARDED and only
# COUNTED (never shown: they are unvalidated text and this log is public), instead of
# turning a genuine hit into BLIND, which is also what an ssh failure looks like. No
# LOGSCAN_BEGIN at all is still BLIND: the remote script did not run, or its output is not
# ours, and "could not see" must stay red.
total_nonempty="$(printf '%s\n' "$ENVELOPE" | grep -c . || true)"
# COUNT lines, never `grep -q` in a pipe: this script runs under `pipefail`, `grep -q` quits at
# the first match, and a writer still writing a large envelope (login-shell noise is
# unbounded) dies of SIGPIPE, which reads as "not found". See deploy-stack-on-vps.sh.
[ "$(printf '%s\n' "$ENVELOPE" | grep -cx 'LOGSCAN_BEGIN' || true)" -ge 1 ] \
  || blind "no LOGSCAN_BEGIN frame in ${total_nonempty} line(s) of output: the remote script did not run, or the session wrote something else (an ssh failure, a shell rc file)"
# EXACTLY ONE frame. A genuine run prints one BEGIN and one END. Two of either means
# something else wrote frame markers into the stream (a decoy before ours, a forged frame
# after it), and picking a winner is wrong in both directions: a first-BEGIN rule lets a
# leading decoy win, a last-BEGIN rule lets a trailing one win. So it is BLIND, red.
n_begin="$(printf '%s\n' "$ENVELOPE" | grep -cx 'LOGSCAN_BEGIN' || true)"
n_end="$(printf '%s\n' "$ENVELOPE" | grep -cx 'LOGSCAN_END' || true)"
{ [ "$n_begin" -le 1 ] && [ "$n_end" -le 1 ]; } \
  || blind "ambiguous output: ${n_begin} LOGSCAN_BEGIN and ${n_end} LOGSCAN_END lines (a genuine run prints exactly one of each); refusing to guess which frame is real"
FRAME="$(printf '%s\n' "$ENVELOPE" | awk '{ l[NR]=$0 } /^LOGSCAN_BEGIN$/ { b=NR } END { if (b) for (i=b; i<=NR; i++) { print l[i]; if (l[i]=="LOGSCAN_END") break } }')"
frame_nonempty="$(printf '%s\n' "$FRAME" | grep -c . || true)"
discarded=$((total_nonempty - frame_nonempty))
if [ "$discarded" -gt 0 ]; then
  echo "::warning::discarded ${discarded} line(s) outside the LOGSCAN_BEGIN..LOGSCAN_END frame (not shown): the VPS session prints text of its own, for example from a shell rc file"
  echo "- Discarded ${discarded} line(s) outside the frame (not shown)." >>"$SUMMARY"
fi
ENVELOPE="$FRAME"

RE_HIT='^LOGSCAN_HIT ts=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,20}Z|unknown) logger=[A-Za-z0-9_.-]{1,60} object=[a-z0-9_.:-]{1,100} sqlstate=(42501|42501-by-message|unclassified) src=(contract|text)$'
RE_KNOWN='^(LOGSCAN_BEGIN|LOGSCAN_API_CONTAINERS=[0-9]{1,4}|LOGSCAN_CONTAINER=(unknown|[A-Za-z0-9][A-Za-z0-9.-]{0,40}[-_]api[-_][0-9]{1,3})|LOGSCAN_LINES=[0-9]{1,9}|LOGSCAN_HITS=[0-9]{1,9}|LOGSCAN_CONTRACT_HITS=[0-9]{1,9}|LOGSCAN_UNPARSED=[0-9]{1,9}|LOGSCAN_END|LOGSCAN_FAILED=[A-Za-z0-9_.-]{1,40})$'

# Second lock: any line that is neither a known field line nor a valid HIT line
# is refused WITHOUT being printed.
#
# ALLOWLIST (AC7). A shape check bounds what a field LOOKS like, not where it CAME
# FROM, and a log line is partly attacker-influenced. So `logger` and the name part of
# `object` must be ON the lists derive-permission-denied-allowlists.sh builds from the
# repository (LOGSCAN_LOGGERS / LOGSCAN_TABLES), or be `unknown`. The remote already
# does this; this is the lock for the day it stops.
# `unknown` REDUCES PRECISION, IT NEVER SUPPRESSES THE ALERT: an `unknown` HIT is
# counted and pages exactly like a known one. A hit that fails the allowlist check is
# BLIND (red), not dropped. The natural reading of "not on the list" is "ignore it";
# that would be a filter hiding the novel case, which is the most interesting one.
[ -n "${LOGSCAN_TABLES:-}" ] && [ -n "${LOGSCAN_LOGGERS:-}" ] \
  || blind "allowlists not provided (LOGSCAN_TABLES / LOGSCAN_LOGGERS): cannot verify which names may be shown"
on_list() { case " $2 " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
unexpected=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  if printf '%s' "$line" | grep -Eq "$RE_KNOWN"; then continue; fi
  if printf '%s' "$line" | grep -Eq "$RE_HIT"; then
    h_lg="$(printf '%s' "$line" | sed -E 's/.* logger=([^ ]+) .*/\1/')"
    h_ob="$(printf '%s' "$line" | sed -E 's/.* object=([^ ]+) .*/\1/')"
    if [ "$h_lg" != "unknown" ] && ! on_list "$h_lg" "$LOGSCAN_LOGGERS"; then unexpected=$((unexpected + 1)); continue; fi
    # The WHOLE object field is validated, not its last segment (SR-M-2): a value like
    # `jane.doe.example.com-380501234567:unknown` ends in a legal word and used to pass.
    # Accepted: `unknown`, or [owner-only:]<kind>:<name> with <kind> from the fixed set
    # and <name> either `unknown` or ON the table list.
    if [ "$h_ob" != "unknown" ]; then
      h_rest="${h_ob#owner-only:}"
      h_kind="${h_rest%%:*}"
      h_nm="${h_rest#*:}"
      case "$h_kind" in
        table | sequence | schema | function | relation | view | type | database) ;;
        *) unexpected=$((unexpected + 1)); continue ;;
      esac
      [ "$h_rest" != "$h_kind" ] || { unexpected=$((unexpected + 1)); continue; }
      if [ "$h_nm" != "unknown" ] && ! on_list "$h_nm" "$LOGSCAN_TABLES"; then unexpected=$((unexpected + 1)); continue; fi
    fi
    continue
  fi
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
contract_hits="$(field LOGSCAN_CONTRACT_HITS)"
unparsed="$(field LOGSCAN_UNPARSED)"
[ -n "$unparsed" ] || blind "envelope has no LOGSCAN_UNPARSED (truncated, or a remote script older than this checker)"
# A record the VPS filter could not read is DROPPED, never kept (keeping it was the fail-open
# direction, SR-H-7), and the drop is made visible here instead of being silent.
if [ "$unparsed" -gt 0 ]; then
  echo "::warning::${unparsed} pino-looking api log record(s) could not be parsed and were dropped from the scan (not shown); a genuine error inside one would be missed"
  echo "- ${unparsed} pino-looking record(s) could not be parsed and were dropped (not shown)." >>"$SUMMARY"
fi
[ -n "$containers" ] || blind "envelope has no LOGSCAN_API_CONTAINERS (truncated or wrong format)"
[ -n "$lines" ] || blind "envelope has no LOGSCAN_LINES (truncated or wrong format)"
[ -n "$hits" ] || blind "envelope has no LOGSCAN_HITS (truncated or wrong format)"
[ -n "$contract_hits" ] || blind "envelope has no LOGSCAN_CONTRACT_HITS (truncated, or a remote script older than this checker)"
[ "$contract_hits" -le "$hits" ] || blind "envelope reports ${contract_hits} contract hits out of ${hits} hits: inconsistent"
[ "$containers" -ge 1 ] || blind "no running api container on the VPS: nothing to watch. Expected for a few minutes while a deploy recreates it (the deploy's own scan covers that window); anything longer is a real problem"
[ "$(printf '%s\n' "$ENVELOPE" | grep -cx 'LOGSCAN_END' || true)" -ge 1 ] || blind "envelope has no LOGSCAN_END (output truncated)"

hit_lines="$(printf '%s\n' "$ENVELOPE" | grep -E "$RE_HIT" || true)"
detail_n=0
[ -z "$hit_lines" ] || detail_n="$(printf '%s\n' "$hit_lines" | grep -c .)"
if [ "$hits" -eq 0 ] && [ "$detail_n" -gt 0 ]; then
  blind "envelope reports 0 hits but lists ${detail_n} hit line(s): inconsistent"
fi

# The public log shows a COARSE volume, not the exact line count: the exact number is a
# traffic-volume reading nobody needs. It still proves the logs were read.
volume() {
  if [ "$1" -eq 0 ]; then echo "0"
  elif [ "$1" -lt 100 ]; then echo "under 100"
  elif [ "$1" -lt 1000 ]; then echo "under 1,000"
  elif [ "$1" -lt 10000 ]; then echo "under 10,000"
  else echo "10,000 or more"; fi
}

if [ "$hits" -eq 0 ]; then
  vol="$(volume "$lines")"
  echo "OK: read ${vol} API log line(s) from ${containers} container(s) (${container:-unknown}); no permission-denied / 42501."
  {
    echo "## API permission-denied watch: clean"
    echo ""
    echo "Read ${vol} log line(s) from ${containers} api container(s); no match."
  } >>"$SUMMARY"
  [ "$lines" -gt 0 ] || echo "::warning::the window held 0 log lines: clean, but a silent API is worth a look"
  exit 0
fi

# hits > 0 is red even if no detail line survived: the count alone is the alert.
other_hits=$((hits - contract_hits))
echo "::error title=API hit permission denied (42501)::${contract_hits} contract line(s) and ${other_hits} other matching line(s) in container ${container:-unknown}. The API's database role lacks a grant for something a handler just did."
{
  echo "## API permission-denied watch: HIT (${contract_hits} contract, ${other_hits} other; container ${container:-unknown})"
  echo ""
  echo "Postgres refused a statement from the API (42501). A scheduled job that swallows its errors is the usual way this stays unseen."
  echo ""
  echo "- **contract** (\`db_privilege_denied\`): the API's one chokepoint reported it. The table comes from its \`table=\` field."
  echo "- **text** (\`permission denied\` / \`must be owner\`): belt and braces. It can be the SAME failure seen again by a handler's own diagnostic line, or a privilege error the chokepoint cannot see. Two lines for one failure is expected, not a second incident. **Text hits are forgeable by an anonymous request** (a Nest text log line carries decoded request data, for example a Drizzle error quoting the query \`params:\`), so they are reported here and **never fail a deploy**."
  echo ""
  echo "| time (UTC) | logger | object | sqlstate | source |"
  echo "| --- | --- | --- | --- | --- |"
} >>"$SUMMARY"

if [ "$detail_n" -gt 0 ]; then
  while IFS= read -r l; do
    ts="$(printf '%s' "$l" | sed -E 's/^LOGSCAN_HIT ts=([^ ]+) .*/\1/')"
    lg="$(printf '%s' "$l" | sed -E 's/.* logger=([^ ]+) .*/\1/')"
    ob="$(printf '%s' "$l" | sed -E 's/.* object=([^ ]+) .*/\1/')"
    st="$(printf '%s' "$l" | sed -E 's/.* sqlstate=([^ ]+) src=.*/\1/')"
    sr="$(printf '%s' "$l" | sed -E 's/.* src=([^ ]+)$/\1/')"
    echo "HIT time=${ts} logger=${lg} object=${ob} sqlstate=${st} src=${sr}"
    echo "| ${ts} | ${lg} | ${ob} | ${st} | ${sr} |" >>"$SUMMARY"
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
  if printf '%s\n' "$hit_lines" | grep -Eq '^LOGSCAN_HIT ts=[0-9]'; then
    echo "**Statement:** deliberately not carried (public log). Postgres' own server log has the ERROR/STATEMENT pair near the timestamps above."
  else
    echo "**Statement:** deliberately not carried (public log). No timestamp could be read from the matching line(s) (\`unknown\`), so search Postgres' server log and the api container log (\`docker compose logs --since <window> api\`) for the window of this run."
  fi
  echo "**Fix:** the table's class in the privilege manifest plus the one missing grant (ADR, Rollback: a forward fix, no widen-grants file)."
} >>"$SUMMARY"
exit 1
