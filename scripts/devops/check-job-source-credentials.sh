#!/usr/bin/env bash
# check-job-source-credentials.sh — proves five newly-provisioned job-board API
# credentials actually work, by making ONE minimal real request per service.
#
# WHY (task-verify-job-source-credentials, 2026-08-11): the owner created five
# repo secrets (JOOBLE_API_KEY, ADZUNA_APP_ID, ADZUNA_APP_KEY, CAREERJET_AFFID,
# RAPIDAPI_KEY) and nobody had verified any of them actually authenticate. "The
# secret exists" and "the secret works" are different claims, and the only way
# to tell them apart is a real call to the real service.
#
# Usage:
#   check-job-source-credentials.sh <jooble|adzuna|careerjet|rapidapi>
#
# Reads credentials from env (never from argv, so they never appear in `ps`):
#   jooble    -> JOOBLE_API_KEY
#   adzuna    -> ADZUNA_APP_ID, ADZUNA_APP_KEY
#   careerjet -> CAREERJET_AFFID
#   rapidapi  -> RAPIDAPI_KEY
#
# Exit codes: 0 = verified working. 2 = required secret missing (loud skip,
# NOT a silent pass — see redact()/missing_secret() below). 1 = the service
# was reachable but rejected the credential, or returned something this
# script could not make sense of. Every one of these is "the workflow step
# should be considered red"; the workflow's continue-on-error steps rely on
# the exit code alone (see .github/workflows/verify-job-source-credentials.yml)
# — the distinction between 1 and 2 is for a human reading the log, not for
# control flow.
#
# SECRET HYGIENE (hard requirement, not a nicety): the raw value of every
# credential this script reads is passed through redact() before it can reach
# stdout/stderr, on BOTH the success and failure paths, and BOTH curl's own
# error text (e.g. "could not connect to <url-with-key-in-it>") and the
# remote service's response body (some of these services put the offending
# key back in an error message). This is defence in depth: the code below
# also tries hard not to print raw bodies at all, preferring short,
# structured fields extracted by the python3 parser — but redact() runs
# regardless, so a mistake in the extraction logic cannot leak a key.
#
# Only chromium^H^H^H^H only curl + python3 + bash are used — both are on the
# ubuntu-latest runner with zero setup, and both are already required by the
# guard scripts this one sits next to (see e.g.
# check-cloudflare-ips-freshness.sh). No node/pnpm install for a script this
# small.
#
# Proven both directions (green AND red — including a fixture that echoes the
# secret back, to prove redact() actually holds) by
# scripts/devops/tests/test-check-job-source-credentials.sh, offline, via a
# curl PATH shim — see that file's header for why it cannot use the live
# services (this repo's own "no unnecessary recurring CI job" + RapidAPI's
# 200-requests-a-month hard cap; a per-PR guard-test run would burn that
# quota in days). The workflow this script backs is workflow_dispatch-only
# for the same reason — see the workflow file's own header.
set -u

SERVICE="${1:-}"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/job-source-check-XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

usage() {
  echo "Usage: $(basename "$0") <jooble|adzuna|careerjet|rapidapi>" >&2
  exit 2
}

case "$SERVICE" in
  jooble | adzuna | careerjet | rapidapi) ;;
  *) usage ;;
esac

# redact <secret>... — reads stdin, replaces every non-empty argument with
# [REDACTED], writes to stdout. Applied to anything derived from a live HTTP
# exchange before it is used in a message this script prints — see the header.
redact() {
  local out
  out="$(cat)"
  local v
  for v in "$@"; do
    [ -n "$v" ] || continue
    out="${out//$v/[REDACTED]}"
  done
  printf '%s' "$out"
}

# report <service> <OK|FAIL|SKIP> <http_code> <count> <company:yes|no|-> <reason...>
# Prints a human section AND one machine-parseable "REPORT ..." line (the
# workflow's summary step greps for that line — see its own comments for why
# a single job with continue-on-error steps was chosen over one job per
# service). The reason is redacted by the caller before it ever reaches here.
report() {
  local svc="$1" result="$2" http="$3" count="$4" company="$5"
  shift 5
  local reason="$*"
  echo
  echo "== ${svc} =="
  echo "  result:                 ${result}"
  echo "  http status:            ${http}"
  echo "  records returned:       ${count}"
  echo "  company field present:  ${company}"
  if [ -n "$reason" ]; then
    echo "  reason:                 ${reason}"
  fi
  echo "REPORT service=${svc} result=${result} http=${http} count=${count} company=${company} reason=${reason}"
}

missing_secret() {
  local svc="$1"
  shift
  report "$svc" SKIP "-" "-" "-" "$*"
  exit 2
}

# do_curl <secret-to-redact...> -- <curl args...>
# Runs curl, capturing body + HTTP status code + stderr separately, and
# ALWAYS redacts every given secret out of stderr before it is readable by
# the rest of this script. Sets HTTP_CODE / CURL_EXIT / BODY_FILE / ERR_TEXT.
HTTP_CODE=""
CURL_EXIT=0
BODY_FILE=""
ERR_TEXT=""
do_curl() {
  local secrets=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    secrets+=("$1")
    shift
  done
  shift # drop --

  BODY_FILE="$WORKDIR/body-$$-$RANDOM"
  local err_file="$WORKDIR/err-$$-$RANDOM"

  # This script never sets -e itself, but do_curl is written defensively
  # anyway: capture curl's exit status explicitly rather than relying on it
  # propagating "correctly" through a command substitution under whatever
  # shell options happen to be active when this runs.
  local had_e=0
  case "$-" in *e*) had_e=1 ;; esac
  set +e
  HTTP_CODE="$(curl -sS --max-time 20 -o "$BODY_FILE" -w '%{http_code}' "$@" 2>"$err_file")"
  CURL_EXIT=$?
  [ "$had_e" = "1" ] && set -e

  ERR_TEXT="$(redact "${secrets[@]+"${secrets[@]}"}" <"$err_file")"

  # curl writes "000" (or nothing at all, on some failure modes) when it never
  # got an HTTP response at all — treat both the same: no code, no exchange.
  if [ "$CURL_EXIT" -ne 0 ] || [ -z "$HTTP_CODE" ] || [ "$HTTP_CODE" = "000" ]; then
    HTTP_CODE="${HTTP_CODE:-000}"
  fi
}

# parse_response <service> <http_code> <body_file>
# Shared python3 parser for all four response shapes. Emits exactly four
# lines (RESULT=/COUNT=/COMPANY=/REASON=) on stdout for the caller to read —
# never the raw body itself, and REASON is truncated + single-line so it is
# safe to fold into the one-line REPORT record above.
parse_response() {
  local svc="$1" http="$2" body="$3"
  python3 - "$svc" "$http" "$body" <<'PY'
import json
import sys

svc, http, path = sys.argv[1], sys.argv[2], sys.argv[3]

try:
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        raw = f.read()
except OSError:
    raw = ""


def emit(result, count, company, reason):
    reason = " ".join(str(reason or "").split())[:200]
    print(f"RESULT={result}")
    print(f"COUNT={count}")
    print(f"COMPANY={company}")
    print(f"REASON={reason}")


def first_reason(d):
    # Common "why did this fail" keys across these four APIs' error envelopes.
    for key in ("error", "display", "message", "Message", "exception", "errorMessage"):
        v = d.get(key)
        if v:
            return v
    return None


# failure_label(http) — task-fix-jsearch-search-v2 (2026-08-11): a 404 and a
# 401/403 both used to land in the same generic "HTTP <code>: <reason>"
# bucket, and that cost real time once — this script's own RapidAPI request
# had the wrong PATH (/search instead of /search-v2), the gateway 404'd it
# with "Endpoint '/search' does not exist", and the report read close enough
# to a credential rejection that reissuing the key was the first instinct,
# not fixing the URL. A 404 from any of these four gateways means "this
# request does not map to a real route" — true independent of whether the
# credential is valid, wrong, or missing; a 401/403 means the gateway (or the
# service behind it) evaluated the credential and rejected it. Different
# causes, different fixes — so the REASON text now says which, up front, not
# just the bare HTTP code.
def failure_label(http_code):
    if http_code == "404":
        return "ENDPOINT NOT FOUND (not a credential problem — check the request path/config)"
    if http_code in ("401", "403"):
        return "CREDENTIAL REJECTED"
    return None


if http != "200":
    body_hint = raw.strip()
    reason = body_hint if body_hint else "empty response body"
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            reason = first_reason(data) or reason
    except (json.JSONDecodeError, TypeError):
        pass
    label = failure_label(http)
    if label:
        emit("FAIL", "-", "-", f"HTTP {http} — {label}: {reason}")
    else:
        emit("FAIL", "-", "-", f"HTTP {http}: {reason}")
    sys.exit(0)

try:
    data = json.loads(raw)
except json.JSONDecodeError:
    # HTTP 200 with a non-JSON body is exactly what a bot-challenge / captcha
    # / HTML error page looks like from here — never treat 200 as success
    # without a body shaped like the documented response.
    emit("FAIL", "-", "-", "HTTP 200 but the body is not JSON (bot-challenge page? wrong endpoint?)")
    sys.exit(0)

if not isinstance(data, dict):
    emit("FAIL", "-", "-", "HTTP 200 but the body is not a JSON object")
    sys.exit(0)

if svc == "jooble":
    jobs = data.get("jobs")
    if not isinstance(jobs, list):
        emit("FAIL", "-", "-", first_reason(data) or "response has no 'jobs' array")
        sys.exit(0)
    count = len(jobs)
    company = "yes" if jobs and isinstance(jobs[0], dict) and jobs[0].get("company") else "no"
    emit("OK", count, company, f"totalCount={data.get('totalCount', '?')}")

elif svc == "adzuna":
    results = data.get("results")
    if not isinstance(results, list):
        emit("FAIL", "-", "-", first_reason(data) or "response has no 'results' array")
        sys.exit(0)
    count = len(results)
    company = "no"
    if results and isinstance(results[0], dict):
        comp = results[0].get("company")
        if isinstance(comp, dict) and comp.get("display_name"):
            company = "yes"
    emit("OK", count, company, f"count={data.get('count', '?')}")

elif svc == "careerjet":
    if data.get("type") != "JOBS":
        emit("FAIL", "-", "-", first_reason(data) or f"type={data.get('type')!r} (expected JOBS)")
        sys.exit(0)
    jobs = data.get("jobs")
    if not isinstance(jobs, list):
        emit("FAIL", "-", "-", "type=JOBS but no 'jobs' array")
        sys.exit(0)
    count = len(jobs)
    company = "yes" if jobs and isinstance(jobs[0], dict) and jobs[0].get("company") else "no"
    emit("OK", count, company, f"hits={data.get('hits', '?')}")

elif svc == "rapidapi":
    if data.get("status") != "OK":
        emit("FAIL", "-", "-", first_reason(data) or f"status={data.get('status')!r} (expected OK)")
        sys.exit(0)
    items = data.get("data")
    if not isinstance(items, list):
        emit("FAIL", "-", "-", "status=OK but no 'data' array")
        sys.exit(0)
    count = len(items)
    company = "yes" if items and isinstance(items[0], dict) and items[0].get("employer_name") else "no"
    emit("OK", count, company, f"request_id={data.get('request_id', '?')}")

else:
    emit("FAIL", "-", "-", f"unknown service {svc!r} — parser was not taught its response shape")
PY
}

# run_service <service> <secret-for-redaction...> -- <curl args...>
# Wires do_curl -> parse_response -> report, and turns the parsed RESULT
# into this script's exit code.
run_service() {
  local svc="$1"
  shift
  local secrets=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    secrets+=("$1")
    shift
  done
  shift # drop --

  do_curl "${secrets[@]+"${secrets[@]}"}" -- "$@"

  if [ "$CURL_EXIT" -ne 0 ] && [ "$HTTP_CODE" = "000" ]; then
    report "$svc" FAIL "$CURL_EXIT" "-" "-" "curl could not complete the request: ${ERR_TEXT:-no output}"
    exit 1
  fi

  local parsed
  parsed="$(parse_response "$svc" "$HTTP_CODE" "$BODY_FILE")"
  # Belt-and-suspenders: redact the secrets out of whatever the parser
  # extracted too, in case a response body ever echoes a key back inside a
  # field the parser surfaces as REASON.
  parsed="$(printf '%s' "$parsed" | redact "${secrets[@]+"${secrets[@]}"}")"

  local result count company reason
  result="$(printf '%s\n' "$parsed" | sed -n 's/^RESULT=//p')"
  count="$(printf '%s\n' "$parsed" | sed -n 's/^COUNT=//p')"
  company="$(printf '%s\n' "$parsed" | sed -n 's/^COMPANY=//p')"
  reason="$(printf '%s\n' "$parsed" | sed -n 's/^REASON=//p')"

  report "$svc" "$result" "$HTTP_CODE" "$count" "$company" "$reason"
  [ "$result" = "OK" ]
}

case "$SERVICE" in
  jooble)
    [ -n "${JOOBLE_API_KEY:-}" ] || missing_secret jooble "JOOBLE_API_KEY is not set — this credential was never exercised this run."
    # CORRECTED 2026-08-11 (task-fix-jsearch-search-v2, an unrelated fix that
    # surfaced this): the very first version of this script called a bad key
    # "possibly a Cloudflare bot-challenge against the CI runner, not
    # necessarily the key" (see this script's own git history / PR #509),
    # because a garbage key returned an HTML "Just a moment..." challenge
    # page over HTTP 403. That reading turned out to be wrong: the FIRST real
    # run against a real GH Actions runner, with a VALID key, got a clean
    # HTTP 200 with real job data — no challenge at all. So the 403+challenge
    # page IS jooble.org's rejection for a bad key specifically (Cloudflare
    # fronting an auth failure, not fingerprinting the runner as a bot).
    # Recorded here so nobody re-inherits the original, disproven suspicion.
    run_service jooble "$JOOBLE_API_KEY" -- \
      -X POST "https://jooble.org/api/${JOOBLE_API_KEY}" \
      -H "Content-Type: application/json" \
      -H "User-Agent: Mozilla/5.0 (compatible; CheekyCheeseIT-CredCheck/1.0; +https://app.cheekycheese.tech)" \
      -d '{"keywords":"developer","location":"Berlin","ResultOnPage":1}'
    ;;

  adzuna)
    if [ -z "${ADZUNA_APP_ID:-}" ] && [ -z "${ADZUNA_APP_KEY:-}" ]; then
      missing_secret adzuna "ADZUNA_APP_ID and ADZUNA_APP_KEY are both not set — this credential pair was never exercised this run."
    fi
    [ -n "${ADZUNA_APP_ID:-}" ] || missing_secret adzuna "ADZUNA_APP_ID is not set — this credential was never exercised this run."
    [ -n "${ADZUNA_APP_KEY:-}" ] || missing_secret adzuna "ADZUNA_APP_KEY is not set — this credential was never exercised this run."
    # Ukraine is not in Adzuna's country coverage; `pl` (Poland) is the
    # nearest covered market and doubles as a plausible real search for this
    # CRM's candidate pool. results_per_page=1: the cheapest non-empty call.
    run_service adzuna "$ADZUNA_APP_ID" "$ADZUNA_APP_KEY" -- \
      "https://api.adzuna.com/v1/api/jobs/pl/search/1?app_id=${ADZUNA_APP_ID}&app_key=${ADZUNA_APP_KEY}&results_per_page=1&what=developer&content-type=application/json"
    ;;

  careerjet)
    [ -n "${CAREERJET_AFFID:-}" ] || missing_secret careerjet "CAREERJET_AFFID is not set — this credential was never exercised this run."
    # public.api.careerjet.net only answers on plain HTTP (their host refuses
    # :443 outright — verified by hand, not an oversight here) and 403s any
    # request with no Referer at all, independent of affid validity, so both
    # are supplied to reach the affid check itself. See this script's own
    # test file / the workflow's header for what a currently-live response
    # looks like — Careerjet has been nudging this legacy endpoint towards
    # their v4/Basic-Auth API, so a FAIL here can mean "this affid was never
    # valid" OR "the legacy endpoint no longer accepts anyone"; the reason
    # text this script prints is the API's own message either way.
    run_service careerjet "$CAREERJET_AFFID" -- \
      -H "Referer: https://app.cheekycheese.tech/jobs" \
      -G "http://public.api.careerjet.net/search" \
      --data-urlencode "affid=${CAREERJET_AFFID}" \
      --data-urlencode "keywords=developer" \
      --data-urlencode "location=Berlin" \
      --data-urlencode "locale_code=en_GB" \
      --data-urlencode "pagesize=1" \
      --data-urlencode "user_ip=203.0.113.10" \
      --data-urlencode "user_agent=CheekyCheeseIT-CredCheck/1.0" \
      --data-urlencode "url=https://app.cheekycheese.tech/jobs"
    ;;

  rapidapi)
    [ -n "${RAPIDAPI_KEY:-}" ] || missing_secret rapidapi "RAPIDAPI_KEY is not set — this credential was never exercised this run."
    # ONE call. RapidAPI's free JSearch tier is capped at 200 requests per
    # MONTH, hard — see the workflow's own comment on this step for why that
    # number means this whole workflow stays workflow_dispatch-only forever.
    #
    # /search-v2, not /search (task-fix-jsearch-search-v2, 2026-08-11): the
    # endpoint is versioned IN THE PATH, and the plain /search path this
    # script used to call does not exist. The gateway checks the credential
    # BEFORE it checks the route: an invalid key 403s on /search AND on
    # /search-v2 alike (verified live — both say "You are not subscribed to
    # this API", no route ever gets evaluated), so that half of this bug was
    # never visible against a bad key. It only showed up against the real,
    # VALID key — which passed the auth check, reached route-matching, and
    # got "Endpoint '/search' does not exist" as a 404. That is exactly why
    # this read as "the key is broken" at first, when the key was the one
    # thing that was fine: a 404 route error and a 403 credential rejection
    # both used to land in this script's generic "non-200 -> FAIL" bucket —
    # see parse_response()'s http-code framing below, added for precisely
    # this reason. Params (query/num_pages/country/date_posted) match the
    # vendor's own dashboard example for this endpoint verbatim — search-v2
    # uses cursor pagination, not the old page= param.
    run_service rapidapi "$RAPIDAPI_KEY" -- \
      -H "x-rapidapi-key: ${RAPIDAPI_KEY}" \
      -H "x-rapidapi-host: jsearch.p.rapidapi.com" \
      "https://jsearch.p.rapidapi.com/search-v2?query=developer&num_pages=1&country=us&date_posted=all"
    ;;
esac
