#!/usr/bin/env bash
#
# check-deploy-freshness.sh — go RED when the newest conclusive `Deploy` run on
# `main` is a failure that has been standing for a while, OR when a path-filtered
# workflow (such as deploy-signal-plus.yml) has drifted: newest main commit
# touching PATHS is newer than the latest successful run for > GRACE_MINUTES.
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
# WHY DRIFT CHECK (incident 2026-11-23, PR #1231): `deploy-signal-plus.yml`
# filters on paths: services/signal-plus/**. Squash-merges pushed by
# GITHUB_TOKEN create no push event, and auto-merge-on-label.yml did not dispatch
# it, so it never ran after PR #1231. Because it never ran, its newest run was
# not red — it was a green run from 3 weeks earlier. When PATHS is set, this
# script compares the newest commit touching PATHS against the latest
# successful run's head commit and fails if undeployed past GRACE_MINUTES.
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
#   - When PATHS is set (drift check mode):
#     * Up-to-date (latest successful run deployed newest commit) -> exit 0.
#     * Undeployed commit, but committed within GRACE_MINUTES    -> exit 0 (grace).
#     * Undeployed commit, committed > GRACE_MINUTES ago        -> exit 1 (naming sha).
#     * No runs at all on main                                   -> exit 2.
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
#   PATHS             optional comma/space-separated path list (enables drift check)
# TEST-ONLY (never set in the workflow):
#   DEPLOY_RUNS_JSON_FILE   read the run list from this file instead of `gh`
#   NEWEST_COMMIT_JSON_FILE read the newest commit JSON ({"sha": "...", "date": "..."}) instead of git/gh
#   NOW_EPOCH               pretend "now" is this unix time
#
# Tests: scripts/devops/tests/test-check-deploy-freshness.sh
set -u

REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
WORKFLOW="${WORKFLOW:-deploy.yml}"
BRANCH="${BRANCH:-main}"
GRACE_MINUTES="${GRACE_MINUTES:-120}"
LIMIT="${LIMIT:-50}"
PATHS="${PATHS:-}"

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

NEWEST_COMMIT_JSON=""
if [ -n "$PATHS" ]; then
  if [ -n "${NEWEST_COMMIT_JSON_FILE:-}" ]; then
    NEWEST_COMMIT_JSON="$(cat "$NEWEST_COMMIT_JSON_FILE" 2>/dev/null)" || {
      echo "::error::cannot read NEWEST_COMMIT_JSON_FILE"
      exit 2
    }
  else
    # Parse paths into an array; strip trailing glob (/** or /*) for GitHub API compatibility
    CLEAN_PATHS=()
    IFS=',' read -ra RAW_PATHS <<< "${PATHS// /,}"
    for p in "${RAW_PATHS[@]}"; do
      p="$(echo "$p" | xargs)"
      [ -z "$p" ] && continue
      p="${p%\/\*\*}"
      p="${p%\/\*}"
      CLEAN_PATHS+=("$p")
    done

    IS_SHALLOW="false"
    if git rev-parse --git-dir >/dev/null 2>&1; then
      if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
        IS_SHALLOW="true"
      fi
    else
      IS_SHALLOW="true"
    fi

    # Try local git log if repository history is available and not shallow
    if [ "$IS_SHALLOW" = "false" ]; then
      GIT_LOG_OUT="$(git log -1 --format='{"sha":"%H","date":"%cI"}' "$BRANCH" -- "${CLEAN_PATHS[@]}" 2>/dev/null || true)"
      if [ -n "$GIT_LOG_OUT" ]; then
        NEWEST_COMMIT_JSON="$GIT_LOG_OUT"
      fi
    fi

    # Fall back to gh api query for each path
    if [ -z "$NEWEST_COMMIT_JSON" ]; then
      if [ -z "$REPO" ]; then
        echo "::error::REPO (or GITHUB_REPOSITORY) is not set — cannot query commit history"
        exit 2
      fi
      NEWEST_DATE=""
      NEWEST_SHA=""
      for p in "${CLEAN_PATHS[@]}"; do
        API_RESP="$(gh api "repos/$REPO/commits?path=$p&sha=$BRANCH&per_page=1" --jq '.[0] | {sha: .sha, date: .commit.committer.date}' 2>/dev/null || true)"
        if [ -n "$API_RESP" ] && [ "$API_RESP" != "null" ]; then
          CUR_DATE="$(printf '%s' "$API_RESP" | jq -r '.date // empty')"
          CUR_SHA="$(printf '%s' "$API_RESP" | jq -r '.sha // empty')"
          if [ -n "$CUR_DATE" ] && [ -n "$CUR_SHA" ]; then
            if [ -z "$NEWEST_DATE" ] || [ "$CUR_DATE" \> "$NEWEST_DATE" ]; then
              NEWEST_DATE="$CUR_DATE"
              NEWEST_SHA="$CUR_SHA"
            fi
          fi
        fi
      done
      if [ -n "$NEWEST_SHA" ]; then
        NEWEST_COMMIT_JSON="$(printf '{"sha":"%s","date":"%s"}' "$NEWEST_SHA" "$NEWEST_DATE")"
      else
        echo "::error::could not find any commit touching $PATHS on $BRANCH"
        exit 2
      fi
    fi
  fi
fi

printf '%s' "$RUNS_JSON" | GRACE_MINUTES="$GRACE_MINUTES" WORKFLOW="$WORKFLOW" BRANCH="$BRANCH" \
  PATHS="$PATHS" NEWEST_COMMIT_JSON="$NEWEST_COMMIT_JSON" \
  python3 -c '
import json, os, sys, time, datetime, subprocess

try:
    runs = json.load(sys.stdin)
except Exception as e:
    print("::error::unparseable run list (%s) — deploy health could not be determined" % e)
    sys.exit(2)

def ts(s):
    s = s.replace("Z", "+00:00")
    return datetime.datetime.fromisoformat(s).timestamp()

now = float(os.environ.get("NOW_EPOCH") or time.time())
grace = int(os.environ["GRACE_MINUTES"]) * 60
workflow = os.environ["WORKFLOW"]
branch = os.environ["BRANCH"]
paths = os.environ.get("PATHS", "").strip()

conclusive = [r for r in runs if r.get("conclusion") in ("success", "failure")]
conclusive.sort(key=lambda r: ts(r["createdAt"]), reverse=True)

if not conclusive:
    print("::error::no conclusive %s run on %s in the last %d runs — cannot say deploy is healthy" % (workflow, branch, len(runs)))
    sys.exit(2)

if paths:
    commit_json_str = os.environ.get("NEWEST_COMMIT_JSON", "").strip()
    if not commit_json_str:
        print("::error::no commit information available for monitored paths %s — cannot determine deploy drift" % paths)
        sys.exit(2)
    try:
        commit_info = json.loads(commit_json_str)
        if not isinstance(commit_info, dict) or "sha" not in commit_info:
            raise ValueError("missing sha")
    except Exception as e:
        print("::error::unparseable newest commit data (%s) — cannot determine deploy drift" % e)
        sys.exit(2)

    commit_sha = commit_info["sha"]
    commit_date_str = commit_info.get("date")
    if not commit_date_str:
        print("::error::newest commit %s has no date" % commit_sha)
        sys.exit(2)
    commit_ts = ts(commit_date_str)

    successful_runs = [r for r in conclusive if r.get("conclusion") == "success"]
    if not successful_runs:
        print("::error::no successful %s runs on %s — undeployed commit %s" % (workflow, branch, commit_sha))
        sys.exit(1)

    latest_success = successful_runs[0]
    deployed_sha = latest_success.get("headSha", "")
    deployed_ts = ts(latest_success["createdAt"])

    is_deployed = False
    if commit_sha and deployed_sha and commit_sha == deployed_sha:
        is_deployed = True
    elif deployed_ts >= commit_ts:
        is_deployed = True
    elif commit_sha and deployed_sha:
        try:
            rc = subprocess.run(
                ["git", "merge-base", "--is-ancestor", commit_sha, deployed_sha],
                capture_output=True,
            ).returncode
            if rc == 0:
                is_deployed = True
        except Exception:
            pass

    if is_deployed:
        print("OK: %s is up-to-date on %s (latest successful run deployed %s at %s >= newest commit %s at %s)" % (
            workflow, branch, deployed_sha[:10], latest_success["createdAt"], commit_sha[:10], commit_date_str))
        sys.exit(0)

    drift_sec = now - commit_ts
    drift_min = int(drift_sec / 60)
    if drift_sec <= grace:
        print("OK (grace): undeployed commit %s touching %s is %d min old, within %d min grace" % (
            commit_sha, paths, drift_min, grace // 60))
        sys.exit(0)

    print("::error::DEPLOY DRIFT: newest commit %s touching %s (%s, %d min ago) has not been deployed by a successful %s run on %s for more than grace window (%d min). Latest successful run: %s at %s (deployed head %s)." % (
        commit_sha, paths, commit_date_str, drift_min, workflow, branch, grace // 60,
        latest_success.get("url", "?"), latest_success["createdAt"], deployed_sha))
    sys.exit(1)

newest = conclusive[0]
if newest["conclusion"] == "success":
    print("OK: newest conclusive %s run on %s succeeded (%s)" % (workflow, branch, newest["createdAt"]))
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
    len(streak), workflow, branch, start["createdAt"], age_min,
    ", ".join("%s=%d" % kv for kv in sorted(by_event.items())), newest.get("url", "?")))
print("Production is NOT receiving merges from main. Open the newest run, read the failed job (gh run view <id> --log-failed).")
sys.exit(1)
'
