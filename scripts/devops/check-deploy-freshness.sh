#!/usr/bin/env bash
#
# check-deploy-freshness.sh — go RED when the newest conclusive `Deploy` run on
# `main` is a failure that has been standing for a while.
#
# WHY (incident 2026-10-13..17): `Deploy` failed on 15 consecutive runs over
# four days (apps/api/Dockerfile never built the new @crm/inference package)
# and prod silently stayed on the pre-10-13 image. The existing alert
# (.github/workflows/deploy-alert.yml) is a `workflow_run` reaction. It DID
# fire for the 6 push-triggered failures (one issue in the private telemetry
# repo, open since 10-13), but fired for NONE of the 11 failures that
# auto-merge-on-label.yml dispatched as `github-actions[bot]`
# (`workflow_dispatch`, 10-16..10-17) — and an issue in a private repo that
# nobody is looking at is not a signal anyway. This check is the missing
# second, INDEPENDENT leg: it does not depend on how a run was triggered, it
# asks the run history directly "is the newest conclusive run red?".
#
# Delivery: a failing scheduled workflow run is surfaced by GitHub itself
# (red run in the Actions UI + the "workflow failed" notification), no SMTP
# secret needed. Same channel logic as cloudflare-ips-watch.yml.
#
# What counts:
#   - Only runs with conclusion success|failure are considered. cancelled /
#     skipped / in-progress runs say nothing about the health of main (deploy.yml
#     cancels superseded pushes by design) and are ignored.
#   - Newest conclusive run is success                       -> exit 0.
#   - Newest conclusive run is failure, but the failing streak STARTED less
#     than GRACE_MINUTES ago                                 -> exit 0 (a fix
#     is probably already on its way; deploy-alert.yml covers the fresh case).
#   - Otherwise                                              -> exit 1, naming
#     the streak length, its start and the newest run URL.
#   - Cannot determine (gh/API error, no conclusive run in the window)
#                                                            -> exit 2. Fail
#     CLOSED: a monitor that cannot see must not report "all fine".
#
# Env:
#   REPO              owner/name (default: $GITHUB_REPOSITORY)
#   WORKFLOW          workflow file (default: deploy.yml)
#   BRANCH            default: main
#   GRACE_MINUTES     default: 120
#   LIMIT             how many recent runs to read (default: 50)
# TEST-ONLY (never set in the workflow):
#   DEPLOY_RUNS_JSON_FILE  read the run list from this file instead of `gh`
#   NOW_EPOCH              pretend "now" is this unix time
#
# Tests: scripts/devops/tests/test-check-deploy-freshness.sh
set -u

REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
WORKFLOW="${WORKFLOW:-deploy.yml}"
BRANCH="${BRANCH:-main}"
GRACE_MINUTES="${GRACE_MINUTES:-120}"
LIMIT="${LIMIT:-50}"

if [ -n "${DEPLOY_RUNS_JSON_FILE:-}" ]; then
  RUNS_JSON="$(cat "$DEPLOY_RUNS_JSON_FILE" 2>/dev/null)" || {
    echo "::error::cannot read DEPLOY_RUNS_JSON_FILE"
    exit 2
  }
else
  if [ -z "$REPO" ]; then
    echo "::error::REPO (or GITHUB_REPOSITORY) is not set — cannot query run history"
    exit 2
  fi
  RUNS_JSON="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" \
    --limit "$LIMIT" --json databaseId,conclusion,createdAt,event,headSha,url 2>&1)" || {
    echo "::error::gh run list failed — deploy health could not be determined: $RUNS_JSON"
    exit 2
  }
fi

printf '%s' "$RUNS_JSON" | GRACE_MINUTES="$GRACE_MINUTES" WORKFLOW="$WORKFLOW" BRANCH="$BRANCH" \
  python3 -c '
import json, os, sys, time, datetime

try:
    runs = json.load(sys.stdin)
except Exception as e:
    print("::error::unparseable run list (%s) — deploy health could not be determined" % e)
    sys.exit(2)

def ts(s):
    return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()

now = float(os.environ.get("NOW_EPOCH") or time.time())
grace = int(os.environ["GRACE_MINUTES"]) * 60
conclusive = [r for r in runs if r.get("conclusion") in ("success", "failure")]
conclusive.sort(key=lambda r: ts(r["createdAt"]), reverse=True)

if not conclusive:
    print("::error::no conclusive %s run on %s in the last %d runs — cannot say deploy is healthy" % (os.environ["WORKFLOW"], os.environ["BRANCH"], len(runs)))
    sys.exit(2)

newest = conclusive[0]
if newest["conclusion"] == "success":
    print("OK: newest conclusive %s run on %s succeeded (%s)" % (os.environ["WORKFLOW"], os.environ["BRANCH"], newest["createdAt"]))
    sys.exit(0)

streak = []
for r in conclusive:
    if r["conclusion"] != "failure":
        break
    streak.append(r)
start = streak[-1]
age_min = int((now - ts(start["createdAt"])) / 60)
by_event = {}
for r in streak:
    by_event[r.get("event", "?")] = by_event.get(r.get("event", "?"), 0) + 1

if now - ts(start["createdAt"]) < grace:
    print("OK (grace): failing streak started %d min ago, under the %d min grace" % (age_min, grace // 60))
    sys.exit(0)

print("::error::PROD DEPLOY IS RED: %d consecutive failed %s runs on %s, first failure %s (%d min ago), triggers %s. Newest: %s" % (
    len(streak), os.environ["WORKFLOW"], os.environ["BRANCH"], start["createdAt"], age_min,
    ", ".join("%s=%d" % kv for kv in sorted(by_event.items())), newest.get("url", "?")))
print("Production is NOT receiving merges from main. Open the newest run, read the failed job (gh run view <id> --log-failed).")
sys.exit(1)
'
