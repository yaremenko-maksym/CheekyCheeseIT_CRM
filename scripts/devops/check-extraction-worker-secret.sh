#!/usr/bin/env bash
# check-extraction-worker-secret.sh - deploy.yml preflight for the optional GitHub secret
# EXTRACTION_WORKER_SECRET (docs/runbooks/extraction-worker.md). Runs on the GitHub runner, before
# the SSH step writes /opt/crm/.env.production.
#
# Unset or empty: no worker, exit 0 (Deploy also runs on push and on schedule).
# Set: the API's isUsableWorkerSecret rule (apps/api/src/extraction-worker/link-contract.ts) must
# hold - at least 32 characters, at least 8 distinct - and the value must be one line with no
# whitespace, so it cannot corrupt the env file. Otherwise the deploy is refused: an unusable secret
# would make api treat the worker as misconfigured. Never prints the value or its length.
set -u

S="${EXTRACTION_WORKER_SECRET:-}"
[ -z "$S" ] && { echo "extraction worker secret: unset (no worker)"; exit 0; }

refuse() {
  echo "ERROR: EXTRACTION_WORKER_SECRET is set but $1. Fix the GitHub secret (openssl rand -hex 32) or remove it." >&2
  exit 1
}
case "$S" in *[[:space:]]*) refuse "contains whitespace or a line break" ;; esac
[ "${#S}" -ge 32 ] || refuse "is shorter than 32 characters"
distinct="$(printf '%s' "$S" | fold -w1 | sort -u | wc -l | tr -d ' ')"
[ "$distinct" -ge 8 ] || refuse "has fewer than 8 distinct characters"
echo "extraction worker secret: set, usable"
