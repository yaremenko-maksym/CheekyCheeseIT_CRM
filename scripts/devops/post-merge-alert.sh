#!/usr/bin/env bash
#
# post-merge-alert.sh — open / update / close the "CI is red on main" issue.
#
# Called by the `post_merge_alert` job in .github/workflows/ci.yml after a
# post-merge validation run of `main` finishes. Extracted from the workflow so
# the alert logic can be dry-run locally (DRY_RUN=1) instead of being debugged
# by pushing commits — see scripts/devops/post-merge-ci-runbook.md §4.
#
# State model — exactly one open alert issue at a time, keyed by label:
#   RESULT=failure + no open issue  → create issue
#   RESULT=failure + open issue     → comment on it (no duplicate issue)
#   RESULT=success + open issue     → close it with a recovery comment
#   RESULT=success + no open issue  → no-op (the common, quiet path)
# Any other RESULT (cancelled / skipped) is a no-op: a run cancelled by
# `cancel-in-progress` when the next merge lands is not a red main.
#
# Required env:
#   ALERT_REPO   owner/name of the repo that receives the issue
#   GH_TOKEN     token with issues:write on ALERT_REPO
#   RESULT       failure | success | cancelled | skipped
#   COMMIT_SHA   the main commit that was validated
#   RUN_URL      link to the Actions run
# Optional env:
#   FAILED_LEGS    human list of failed jobs, e.g. "quality, e2e"
#   COMMIT_SUBJECT commit subject line (untrusted input — never eval'd)
#   LABEL          issue label (default: ci-main-broken)
#   DRY_RUN        1 → print the gh commands instead of running them
set -euo pipefail

LABEL="${LABEL:-ci-main-broken}"
DRY_RUN="${DRY_RUN:-0}"
FAILED_LEGS="${FAILED_LEGS:-unknown}"
COMMIT_SUBJECT="${COMMIT_SUBJECT:-}"

for var in ALERT_REPO RESULT COMMIT_SHA RUN_URL; do
  if [ -z "${!var:-}" ]; then
    echo "::error::post-merge-alert.sh: required env \$$var is empty" >&2
    exit 2
  fi
done

# Short SHA for titles/comments; the full SHA stays in the body.
SHORT_SHA="${COMMIT_SHA:0:8}"

run_gh() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '[dry-run] gh'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  gh "$@"
}

case "$RESULT" in
  failure | success) ;;
  *)
    echo "::notice::post-merge-alert: result='$RESULT' (not failure/success) — nothing to do."
    exit 0
    ;;
esac

# Label may not exist yet on a fresh alert repo. Non-fatal: if the token lacks
# label-create rights the subsequent issue create/list still works as long as
# the label already exists there.
run_gh label create "$LABEL" --repo "$ALERT_REPO" \
  --color "b60205" --description "CI red on main after merge" 2>/dev/null || true

if [ "$DRY_RUN" = "1" ]; then
  # Dry-run cannot query the API, so the "an alert is already open" state is
  # supplied by hand — this is what makes the dedup / auto-close branches
  # locally verifiable (runbook §4).
  OPEN="${DRY_RUN_OPEN_ISSUE:-}"
else
  OPEN=$(gh issue list --repo "$ALERT_REPO" --label "$LABEL" --state open \
    --json number --jq '.[0].number // empty')
fi
echo "post-merge-alert: repo=$ALERT_REPO result=$RESULT open_issue=${OPEN:-none}"

if [ "$RESULT" = "failure" ]; then
  # Untrusted values (commit subject) are passed as literal argv to gh — never
  # interpolated into a shell command — so a crafted commit message cannot
  # inject anything. Same reason the workflow passes them via env:.
  #
  # shellcheck disable=SC2016  # backticks below are markdown, not command
  #                            # substitution — single quotes are deliberate.
  BODY=$(
    printf '## CI упал на `main` после мержа\n\n'
    printf '**Commit:** `%s`\n' "$COMMIT_SHA"
    if [ -n "$COMMIT_SUBJECT" ]; then
      printf '**Subject:** %s\n' "$COMMIT_SUBJECT"
    fi
    printf '**Упавшие проверки:** %s\n' "$FAILED_LEGS"
    printf '**Run:** %s\n\n' "$RUN_URL"
    printf 'Это прогон **после** мержа — валидируется фактическое состояние `main`,\n'
    printf 'а не merge-коммит PR. Красный прогон здесь при зелёных PR обычно значит\n'
    printf 'семантический конфликт двух PR, каждый из которых был зелёным отдельно.\n\n'
    printf '> ⚠️ Прод деплоится сразу после мержа, параллельно с этим прогоном, —\n'
    printf '> то есть сломанное состояние, скорее всего, **уже задеплоено**.\n\n'
    printf '## Что делать\n\n'
    printf '1. Открыть run выше, найти упавшую проверку.\n'
    printf '2. Решить: откат (`git revert` последнего мержа + деплой) или хотфикс-PR.\n'
    printf '3. Issue закроется автоматически, когда следующий post-merge прогон `main` станет зелёным.\n\n'
    printf 'Подробности процесса — `scripts/devops/post-merge-ci-runbook.md`.\n'
  )

  if [ -z "$OPEN" ]; then
    run_gh issue create --repo "$ALERT_REPO" \
      --title "🚨 CI красный на main ($SHORT_SHA)" \
      --label "$LABEL" \
      --body "$BODY"
    echo "post-merge-alert: created new alert issue"
  else
    run_gh issue comment "$OPEN" --repo "$ALERT_REPO" --body "$BODY"
    echo "post-merge-alert: main still red — commented on existing issue #$OPEN"
  fi
  exit 0
fi

# RESULT=success
if [ -n "$OPEN" ]; then
  run_gh issue close "$OPEN" --repo "$ALERT_REPO" \
    --comment "✅ post-merge CI на \`main\` снова зелёный (commit \`$COMMIT_SHA\`). Run: $RUN_URL"
  echo "post-merge-alert: closed recovered alert issue #$OPEN"
else
  echo "post-merge-alert: green, no open alert — nothing to do."
fi
