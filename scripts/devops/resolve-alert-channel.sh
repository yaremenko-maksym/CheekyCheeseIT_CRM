#!/usr/bin/env bash
#
# resolve-alert-channel.sh — pick the "CI/Deploy is red" alert channel.
#
# Extracted from ci.yml's `post_merge_alert` job (task-infra-post-merge-ci,
# 2026-07-27) so a second alert workflow (deploy-alert.yml,
# task-infra-silent-failures, 2026-08-01) can reuse the EXACT SAME probe
# instead of re-implementing it inline a second time — two divergent copies
# of a security-sensitive token-probe is how this kind of check silently
# drifts (one gets a fix the other doesn't).
#
# Channel is chosen by whether TELEMETRY_ISSUES_PAT actually WORKS against
# the private telemetry repo, not merely whether it is set: a fine-grained
# PAT past its expiry date is a non-empty string, so a bare `-n "$PAT"`
# check would wrongly pick the private repo, the subsequent `gh issue list`
# in the caller would 401, and under `set -euo pipefail` the alert would be
# lost in silence — exactly the failure mode this whole mechanism exists to
# prevent. See scripts/devops/post-merge-ci-runbook.md §4 for the incident.
#
# Required env:
#   PRIVATE_REPO   owner/name of the private telemetry repo
#   PUBLIC_REPO    owner/name fallback (normally github.repository)
# Optional env:
#   PAT            candidate token for PRIVATE_REPO (may be empty/unset)
#
# Writes to $GITHUB_OUTPUT:
#   repo      the chosen owner/name
#   use_pat   true|false — whether PAT was used (caller needs this to pick
#             the right GH_TOKEN for the actual issue create/comment/close)
set -euo pipefail

for var in PRIVATE_REPO PUBLIC_REPO; do
  if [ -z "${!var:-}" ]; then
    echo "::error::resolve-alert-channel.sh: required env \$$var is empty" >&2
    exit 2
  fi
done

use_pat=false
if [ -z "${PAT:-}" ]; then
  echo "::warning::TELEMETRY_ISSUES_PAT is not set — falling back to an issue on $PUBLIC_REPO."
elif GH_TOKEN="$PAT" gh issue list --repo "$PRIVATE_REPO" --limit 1 >/dev/null 2>&1; then
  use_pat=true
else
  echo "::warning::TELEMETRY_ISSUES_PAT is set but cannot reach $PRIVATE_REPO (expired / revoked / insufficient scope) — falling back to an issue on $PUBLIC_REPO. See post-merge-ci-runbook.md §2.2 / telemetry-digest-runbook.md §2.2 (rotation)."
fi

if [ "$use_pat" = "true" ]; then
  echo "repo=$PRIVATE_REPO" >> "$GITHUB_OUTPUT"
else
  echo "repo=$PUBLIC_REPO" >> "$GITHUB_OUTPUT"
fi
echo "use_pat=$use_pat" >> "$GITHUB_OUTPUT"
echo "Alert channel: use_pat=$use_pat"
