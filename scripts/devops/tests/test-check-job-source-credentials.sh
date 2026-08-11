#!/usr/bin/env bash
# test-check-job-source-credentials.sh — proves
# scripts/devops/check-job-source-credentials.sh goes RED on a missing secret
# and on a rejected credential, for all four services, WITHOUT calling any of
# the four live APIs.
#
# WHY OFFLINE: this test file runs on every push/PR via
# scripts/devops/tests/run-guard-tests.sh (wired into ci.yml — see that
# workflow's "Guard tests" step). One of the four services this guard checks
# (RapidAPI's JSearch) has a HARD 200-requests-per-MONTH cap on the free tier
# — a guard test that made one real call per PR would burn that quota in
# days and turn an unrelated PR red for a reason nobody touched. The other
# three do not have that specific cap, but calling third-party APIs from
# every PR run is a flake generator regardless (their outage/rate-limit is
# not this repo's CI's business) and this repo's own DevOps rule is "no
# unnecessary recurring CI calls to anything metered" (see
# .github/workflows/verify-job-source-credentials.yml's header — the guard
# it backs is workflow_dispatch-only for the identical reason).
#
# `curl` is replaced by a PATH shim (same technique as
# test-check-cloudflare-ips-freshness.sh) that recognizes the four real
# hostnames the guard calls and serves canned bodies/status codes from
# fixtures below — fixtures for the FAIL cases are verbatim copies of what
# the four real services actually returned to a deliberately-wrong
# credential when this guard was written (see the task's PR description for
# the live transcript); this is not a guess at their error shape.
#
# The redaction case is the one that matters most: it makes the curl SHIM
# ECHO THE REAL SECRET VALUE back on stderr (exactly what curl's own error
# text can do when a key is baked into the URL, e.g. Jooble's
# https://jooble.org/api/<key>), and then asserts the guard's own output
# does NOT contain that value anywhere. Proving "the guard fails on a bad
# key" is not enough on its own — this repo's hard requirement is "and never
# print it while doing so".
#
# UPDATED (task-fix-jsearch-search-v2, 2026-08-11): the first real
# post-merge run of the workflow this guard backs found the guard itself
# calling the wrong RapidAPI path (/search instead of /search-v2) — a VALID
# key got HTTP 404 "Endpoint '/search' does not exist", which the guard's
# report worded almost the same as a rejected key. Fixed in the guard
# script's rapidapi branch AND in parse_response()'s failure_label(), which
# now prefixes a 404 as "ENDPOINT NOT FOUND (not a credential problem)" and
# a 401/403 as "CREDENTIAL REJECTED" so the two stop being indistinguishable
# in the report. Both directions of THAT distinction are asserted below too
# (the "RapidAPI wrong path" and "RapidAPI bad key" cases), not just "it
# goes red" — a report that goes red for the right reason vs. the wrong
# reason is the entire lesson this fix exists to encode.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-job-source-credentials.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# ── fixture bodies ──────────────────────────────────────────────────────────

cat >"$WS/jooble-ok.json" <<'EOF'
{"totalCount":1,"jobs":[{"title":"Backend Developer","location":"Berlin","company":"Acme Corp","link":"https://jooble.org/jdp/1","salary":"","source":"jooble"}]}
EOF

# Verbatim shape of what jooble.org actually returned to a garbage key when
# this guard was written: Cloudflare intercepts with an HTML bot-challenge
# page before Jooble's own API even sees the request, HTTP 403.
cat >"$WS/jooble-bad-key.html" <<'EOF'
<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>
EOF

cat >"$WS/adzuna-ok.json" <<'EOF'
{"results":[{"title":"Java Developer","company":{"display_name":"Acme Corp"},"location":{"display_name":"Warsaw"}}],"count":42}
EOF

# Result has no company sub-object at all — the EURES-shaped case the task
# explicitly cares about: "returned N records" is still true, "does a record
# carry a company name" must independently read "no".
cat >"$WS/adzuna-ok-no-company.json" <<'EOF'
{"results":[{"title":"Java Developer","location":{"display_name":"Warsaw"}}],"count":42}
EOF

# Verbatim: what api.adzuna.com actually returned to a garbage app_id/app_key
# pair, HTTP 401.
cat >"$WS/adzuna-bad-key.json" <<'EOF'
{"doc":"https://api.adzuna.com/v1/doc","display":"Authorisation failed","__CLASS__":"Adzuna::API::Response::Exception","exception":"AUTH_FAIL"}
EOF

cat >"$WS/careerjet-ok.json" <<'EOF'
{"type":"JOBS","hits":10,"jobs":[{"title":"PHP Developer","company":"Acme Corp","locations":"Berlin"}]}
EOF

# Verbatim: what public.api.careerjet.net actually returned to a garbage
# affid (with a Referer header present), HTTP 401 — Careerjet has been
# steering this legacy endpoint towards its v4 API, so this exact message
# does not distinguish "wrong affid" from "endpoint closed to non-legacy
# accounts"; either way the guard must treat it as a failed credential, not
# a pass.
cat >"$WS/careerjet-bad-key.json" <<'EOF'
{"error":"The legacy Job Search API is only accessible for authenticated legacy users. Please use the new API (v4) instead: https://www.careerjet.com/partners/api","type":"ERROR"}
EOF

# A shape that DOES echo an affid back in its error text (Careerjet's real
# error for a missing affid does this: "Your Careerjet affiliate ID needs to
# be supplied..." — this fixture goes one step further and puts a
# recognizable value inline) — the redaction test below feeds this fixture
# while also making the affid env var equal that exact same string, so a
# leak would show up as a plain substring match.
cat >"$WS/careerjet-echoes-key.json" <<'EOF'
{"error":"Unknown affid: SECRET-AFFID-LEAK-CANARY","type":"ERROR"}
EOF

cat >"$WS/rapidapi-ok.json" <<'EOF'
{"status":"OK","request_id":"abc-123","data":[{"job_title":"Data Engineer","employer_name":"Acme Corp","job_country":"DE"}]}
EOF

# Verbatim: what jsearch.p.rapidapi.com actually returned to a garbage
# x-rapidapi-key, HTTP 403 — the RapidAPI gateway itself rejects the key
# before the request is proxied to JSearch, which is also WHY this rejection
# does not consume any of the 200-requests-a-month quota (confirmed live).
cat >"$WS/rapidapi-bad-key.json" <<'EOF'
{"message":"You are not subscribed to this API."}
EOF

# Verbatim: what jsearch.p.rapidapi.com returned when this guard called the
# WRONG path (/search instead of /search-v2) with a perfectly VALID,
# subscribed key — task-fix-jsearch-search-v2's whole reason for existing.
# The gateway 404s a route it doesn't recognize independent of credential
# validity; a report that reads this the same as a rejected key sends
# whoever's on call to reissue a working key instead of fixing the URL,
# which is exactly what nearly happened here.
cat >"$WS/rapidapi-wrong-path.json" <<'EOF'
{"message":"Endpoint '/search' does not exist"}
EOF

# ── shape-mismatch fixtures (task-fix-credential-check-self-diagnosing,
# 2026-08-11) ────────────────────────────────────────────────────────────────
# Each of these is a plausible "the service renamed/restructured its response"
# body: valid JSON, HTTP 200, but not shaped the way this guard's parser
# expects (no 'jobs'/'results'/'data' array under the name it looks for, or —
# for careerjet — no recognizable 'type' field at all). The guard must still
# go red on every one of these AND now must also name the fields it actually
# found, so a human does not have to reproduce the request by hand to learn
# them. The distinctive values below (company names, job titles) exist ONLY
# to prove the guard prints field NAMES and never VALUES — see the
# --not-contains assertions on these fixtures further down.
cat >"$WS/jooble-shape-mismatch.json" <<'EOF'
{"totalCount":3,"vacancies":[{"job_title":"Senior Kotlin Engineer","employer":"NordicPay Ltd"}]}
EOF

cat >"$WS/adzuna-shape-mismatch.json" <<'EOF'
{"listings":[{"role":"Java Developer","org":"Acme Global Systems"}],"total":42}
EOF

cat >"$WS/careerjet-shape-mismatch.json" <<'EOF'
{"status":"success","postings":[{"position":"PHP Developer","employer_name":"Riverside Tech"}]}
EOF

# The realistic case this whole change exists for: status=OK (so the guard's
# first check passes) but the array moved from 'data' to 'results' — exactly
# the class of surprise RapidAPI's real /search-v2 handed this guard once
# already (see check-job-source-credentials.sh's rapidapi branch comment).
cat >"$WS/rapidapi-shape-mismatch.json" <<'EOF'
{"status":"OK","request_id":"9f31-fixture","results":[{"job_title":"Data Engineer","company_name":"BrightWave Analytics"}]}
EOF

# Top level is not even a JSON object — a bare array. Proves shape_hint()'s
# non-dict branch, not just its "wrong key inside a dict" branch.
cat >"$WS/jooble-bare-array.json" <<'EOF'
[{"title":"Backend Developer","company":"Quantum Analytics"}]
EOF

: >"$WS/empty.txt"

# ── curl shim ────────────────────────────────────────────────────────────────
# Understands: -o <path> (capture target) and one arg starting with http(s)://
# (the request URL — for careerjet, the guard uses -G so the URL arg has no
# query string; matching on hostname substring is enough for all four).
read -r -d '' SHIM_BODY <<'SHIM' || true
#!/bin/sh
out=""
url=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  case "$a" in http://*|https://*) url="$a" ;; esac
  prev="$a"
done

if [ "${SHIM_CURL_FAIL:-0}" = "1" ]; then
  # Simulates curl's OWN error text echoing back the request URL — which,
  # for Jooble, has the raw key baked into the path. This is what the
  # redaction test proves the guard scrubs before it can reach stdout.
  echo "curl: (7) Failed to connect to $url" >&2
  exit 7
fi

case "$url" in
  *jooble.org*) body="$SHIM_JOOBLE_BODY"; code="$SHIM_JOOBLE_CODE" ;;
  *adzuna.com*) body="$SHIM_ADZUNA_BODY"; code="$SHIM_ADZUNA_CODE" ;;
  *careerjet.net*) body="$SHIM_CAREERJET_BODY"; code="$SHIM_CAREERJET_CODE" ;;
  *rapidapi.com*) body="$SHIM_RAPIDAPI_BODY"; code="$SHIM_RAPIDAPI_CODE" ;;
  *) echo "shim: unrecognized url: $url" >&2; exit 3 ;;
esac

[ -n "$out" ] || { echo "shim: no -o output path seen in args" >&2; exit 4; }
cat "$body" >"$out"
printf '%s' "$code"
SHIM
guard_test_shim "$WS" curl "$SHIM_BODY"

# run_jooble/adzuna/careerjet/rapidapi <secret-env-value-or-empty> <fixture> <code> [curl-fail]
run_jooble() {
  local key="$1" fixture="$2" code="$3" fail="${4:-0}"
  PATH="$WS/bin:$PATH" JOOBLE_API_KEY="$key" \
    SHIM_JOOBLE_BODY="$fixture" SHIM_JOOBLE_CODE="$code" SHIM_CURL_FAIL="$fail" \
    bash "$GUARD" jooble
}
run_adzuna() {
  local id="$1" key="$2" fixture="$3" code="$4"
  PATH="$WS/bin:$PATH" ADZUNA_APP_ID="$id" ADZUNA_APP_KEY="$key" \
    SHIM_ADZUNA_BODY="$fixture" SHIM_ADZUNA_CODE="$code" \
    bash "$GUARD" adzuna
}
run_careerjet() {
  local affid="$1" fixture="$2" code="$3"
  PATH="$WS/bin:$PATH" CAREERJET_AFFID="$affid" \
    SHIM_CAREERJET_BODY="$fixture" SHIM_CAREERJET_CODE="$code" \
    bash "$GUARD" careerjet
}
run_rapidapi() {
  local key="$1" fixture="$2" code="$3"
  PATH="$WS/bin:$PATH" RAPIDAPI_KEY="$key" \
    SHIM_RAPIDAPI_BODY="$fixture" SHIM_RAPIDAPI_CODE="$code" \
    bash "$GUARD" rapidapi
}

echo "== test-check-job-source-credentials.sh =="
echo

# ── usage / unknown service ───────────────────────────────────────────────────
assert_red "no service argument -> red (not a silent success)" \
  --contains "Usage:" \
  -- bash "$GUARD"

assert_red "unknown service name -> red" \
  --contains "Usage:" \
  -- bash "$GUARD" indeed

# ── missing secret -> loud SKIP, non-zero, never a silent pass ────────────────
assert_red "JOOBLE_API_KEY unset -> SKIP, not a silent pass" \
  --contains "result:                 SKIP" \
  --contains "JOOBLE_API_KEY is not set" \
  -- run_jooble "" "$WS/jooble-ok.json" 200

assert_red "ADZUNA_APP_ID and ADZUNA_APP_KEY both unset -> SKIP" \
  --contains "result:                 SKIP" \
  --contains "both not set" \
  -- run_adzuna "" "" "$WS/adzuna-ok.json" 200

assert_red "ADZUNA_APP_KEY alone unset -> SKIP (half a credential pair is not a credential)" \
  --contains "result:                 SKIP" \
  --contains "ADZUNA_APP_KEY is not set" \
  -- run_adzuna "some-id" "" "$WS/adzuna-ok.json" 200

assert_red "CAREERJET_AFFID unset -> SKIP" \
  --contains "result:                 SKIP" \
  --contains "CAREERJET_AFFID is not set" \
  -- run_careerjet "" "$WS/careerjet-ok.json" 200

assert_red "RAPIDAPI_KEY unset -> SKIP" \
  --contains "result:                 SKIP" \
  --contains "RAPIDAPI_KEY is not set" \
  -- run_rapidapi "" "$WS/rapidapi-ok.json" 200

# ── positive: a working credential is reported OK with real counts ────────────
assert_green "Jooble valid key -> OK, 1 record, company present" \
  --contains "result:                 OK" \
  --contains "records returned:       1" \
  --contains "company field present:  yes" \
  -- run_jooble "dummy-valid-key" "$WS/jooble-ok.json" 200

assert_green "Adzuna valid key -> OK, 1 record, company present" \
  --contains "result:                 OK" \
  --contains "records returned:       1" \
  --contains "company field present:  yes" \
  -- run_adzuna "dummy-id" "dummy-key" "$WS/adzuna-ok.json" 200

assert_green "Adzuna result WITHOUT a company sub-object -> OK but company=no (EURES-shaped case)" \
  --contains "result:                 OK" \
  --contains "company field present:  no" \
  -- run_adzuna "dummy-id" "dummy-key" "$WS/adzuna-ok-no-company.json" 200

assert_green "Careerjet valid affid -> OK, type=JOBS, company present" \
  --contains "result:                 OK" \
  --contains "company field present:  yes" \
  -- run_careerjet "dummy-affid" "$WS/careerjet-ok.json" 200

assert_green "RapidAPI JSearch valid key -> OK, status=OK, company present" \
  --contains "result:                 OK" \
  --contains "company field present:  yes" \
  -- run_rapidapi "dummy-key" "$WS/rapidapi-ok.json" 200

# ── negative: THE CASE THAT MATTERS — a wrong credential must go red ──────────
# Every fixture below is a verbatim copy of what the real service returned to
# a deliberately-wrong credential (see this file's header).
assert_red "Jooble bad key (Cloudflare bot-challenge, HTTP 403) -> red" \
  --contains "result:                 FAIL" \
  --contains "http status:            403" \
  -- run_jooble "dummy-invalid-key" "$WS/jooble-bad-key.html" 403

assert_red "Adzuna bad app_id/app_key (HTTP 401, Authorisation failed) -> red" \
  --contains "result:                 FAIL" \
  --contains "Authorisation failed" \
  -- run_adzuna "bad-id" "bad-key" "$WS/adzuna-bad-key.json" 401

assert_red "Careerjet bad affid (HTTP 401) -> red" \
  --contains "result:                 FAIL" \
  --contains "legacy users" \
  -- run_careerjet "bad-affid" "$WS/careerjet-bad-key.json" 401

assert_red "RapidAPI bad key (HTTP 403, gateway rejects before proxying — no quota spent) -> red, labeled CREDENTIAL REJECTED" \
  --contains "result:                 FAIL" \
  --contains "not subscribed" \
  --contains "CREDENTIAL REJECTED" \
  --not-contains "ENDPOINT NOT FOUND" \
  -- run_rapidapi "bad-key" "$WS/rapidapi-bad-key.json" 403

# task-fix-jsearch-search-v2 regression case: a 404 (wrong path — this guard
# itself briefly shipped with /search instead of /search-v2, against a VALID
# key) must NOT be reported the same way as a rejected credential. This is
# the distinction that would have saved the "is the key even right?" detour.
assert_red "RapidAPI wrong path (HTTP 404, even with a valid key) -> red, labeled ENDPOINT NOT FOUND not a credential problem" \
  --contains "result:                 FAIL" \
  --contains "http status:            404" \
  --contains "ENDPOINT NOT FOUND" \
  --contains "does not exist" \
  --not-contains "CREDENTIAL REJECTED" \
  -- run_rapidapi "a-perfectly-valid-key" "$WS/rapidapi-wrong-path.json" 404

# ── HTTP 200 but not the documented shape (e.g. a challenge/HTML page slipping
# through with a 200) must never be treated as success ─────────────────────────
assert_red "HTTP 200 but body is not JSON at all -> red, never a silent pass" \
  --contains "result:                 FAIL" \
  --contains "not JSON" \
  -- run_jooble "dummy-key" "$WS/jooble-bad-key.html" 200

assert_red "HTTP 200 JSON but missing the documented envelope key -> red" \
  --contains "result:                 FAIL" \
  -- run_rapidapi "dummy-key" "$WS/empty.txt" 200

# ── shape diagnostics: on a mismatch, the report names the fields it ACTUALLY
# got — for every service, not just RapidAPI — and never their values ────────
# This is the behaviour task-fix-credential-check-self-diagnosing added: the
# old report said only "response has no 'jobs' array" and left "so what IS it
# called now" to a human re-running the request by hand. Every case below
# proves both halves: the guard still goes red (nothing here should ever
# start passing), AND the field names it found are now in the report, AND the
# values from those fields are not.
assert_red "Jooble: array renamed to 'vacancies' -> red, reports the real field names" \
  --contains "result:                 FAIL" \
  --contains "top-level fields: totalCount, vacancies" \
  --contains "first array field is 'vacancies'" \
  --contains "job_title, employer" \
  --not-contains "Senior Kotlin Engineer" \
  --not-contains "NordicPay Ltd" \
  -- run_jooble "dummy-key" "$WS/jooble-shape-mismatch.json" 200

assert_red "Adzuna: array renamed to 'listings' -> red, reports the real field names" \
  --contains "result:                 FAIL" \
  --contains "top-level fields: listings, total" \
  --contains "first array field is 'listings'" \
  --contains "role, org" \
  --not-contains "Java Developer" \
  --not-contains "Acme Global Systems" \
  -- run_adzuna "dummy-id" "dummy-key" "$WS/adzuna-shape-mismatch.json" 200

assert_red "Careerjet: no 'type' field at all -> red, reports the real field names" \
  --contains "result:                 FAIL" \
  --contains "top-level fields: status, postings" \
  --contains "first array field is 'postings'" \
  --contains "position, employer_name" \
  --not-contains "PHP Developer" \
  --not-contains "Riverside Tech" \
  -- run_careerjet "dummy-affid" "$WS/careerjet-shape-mismatch.json" 200

# The motivating case: status=OK, but the array is called 'results', not
# 'data'. This is precisely the kind of surprise that used to require a
# person to re-run the request by hand to learn.
assert_red "RapidAPI: status=OK but array renamed to 'results' -> red, reports the real field names" \
  --contains "result:                 FAIL" \
  --contains "top-level fields: status, request_id, results" \
  --contains "first array field is 'results'" \
  --contains "job_title, company_name" \
  --not-contains "Data Engineer" \
  --not-contains "BrightWave Analytics" \
  -- run_rapidapi "dummy-key" "$WS/rapidapi-shape-mismatch.json" 200

assert_red "top level is not even a JSON object (bare array) -> red, still reports field names, not values" \
  --contains "result:                 FAIL" \
  --contains "JSON array" \
  --contains "title, company" \
  --not-contains "Backend Developer" \
  --not-contains "Quantum Analytics" \
  -- run_jooble "dummy-key" "$WS/jooble-bare-array.json" 200

# ── curl itself cannot complete the request (network down, DNS, timeout) ──────
assert_red "curl transport failure -> red, not silently skipped" \
  --contains "result:                 FAIL" \
  --contains "could not complete the request" \
  -- run_jooble "dummy-key" "$WS/jooble-ok.json" 200 1

# ── THE REQUIREMENT THAT MATTERS MOST: secret values never reach stdout ───────
# The shim above, when SHIM_CURL_FAIL=1, echoes the REQUEST URL to stderr —
# which for Jooble contains the raw key (https://jooble.org/api/<key>). Proves
# do_curl()'s redact() actually strips it before the guard's own report is
# built, not just "the API didn't happen to echo it back this time".
assert_red "secret baked into the failing URL is REDACTED from the guard's own output" \
  --contains "result:                 FAIL" \
  --contains "REDACTED" \
  --not-contains "MOST-SECRET-VALUE-EVER" \
  -- run_jooble "MOST-SECRET-VALUE-EVER" "$WS/jooble-ok.json" 200 1

# A body that itself echoes a credential-shaped value back must also never
# surface it verbatim (belt-and-suspenders redaction on the parsed REASON,
# independent of the do_curl-level redaction proven above).
assert_red "secret echoed inside the response BODY is also never printed verbatim" \
  --contains "result:                 FAIL" \
  --not-contains "SECRET-AFFID-LEAK-CANARY" \
  -- run_careerjet "SECRET-AFFID-LEAK-CANARY" "$WS/careerjet-echoes-key.json" 401

guard_test_summary "test-check-job-source-credentials.sh"
