#!/usr/bin/env bash
# check-cloudflare-ai-plan.sh - prints which Workers plan the Cloudflare account is on, nothing else.
# Owner-run on the server (docs/runbooks/extraction-worker.md, "Cloudflare quota and billing").
#
# Usage:
#   check-cloudflare-ai-plan.sh [env-file]        default env file: /opt/crm/.env.extraction-worker
#   check-cloudflare-ai-plan.sh --classify <http-status> <body-file>   (the self-test's entry)
#
# How: one call to a model Cloudflare serves on Workers Paid only (since 2026-07-28), with
# max_tokens 1. Workers Free refuses it with error 5035 and bills nothing. Workers Paid answers, and
# that call is billed (a negligible amount) once the day's 10 000 free Neurons are used up, so on
# Paid it prints a warning not to run it in a loop. The prod token is scoped to Workers AI and
# cannot read billing, so this refusal is the only plan signal it can get.
#
# Reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN from the env file by name (never sources it).
# The token goes to curl on stdin, never in argv. Never prints the token, the account id or the
# response body. Probe model override: CF_PLAN_PROBE_MODEL.
#
# Exit: 0 Workers Free, 3 Workers Paid, 1 could not tell, 2 usage or bad input.
set -euo pipefail

PROBE_MODEL="${CF_PLAN_PROBE_MODEL:-@cf/zai-org/glm-5.2}"

classify() {
  local status="$1" body="$2" codes
  codes="$(grep -oE '"code"[[:space:]]*:[[:space:]]*[0-9]+' "$body" | grep -oE '[0-9]+$' | tr '\n' ' ' || true)"
  if [ "$status" = 200 ]; then
    echo "PLAN: Workers Paid. The paid-only probe model answered. Workers AI use over 10 000 Neurons/day is billed, with no cap. WARNING: each run of this check is a billable call once the day's free Neurons are used; do not run it in a loop."
    return 3
  fi
  case "$status" in
    4??)
      case " $codes" in
        *" 5035 "*)
          echo "PLAN: Workers Free. The paid-only probe model was refused (5035). Workers AI use over 10 000 Neurons/day fails (3036); nothing is billed."
          return 0
          ;;
      esac
      ;;
  esac
  echo "PLAN: UNKNOWN. HTTP ${status}, error codes: ${codes:-none}. Check the token, the account id and the probe model."
  return 1
}

if [ "${1:-}" = --classify ]; then
  [ $# -eq 3 ] && [ -r "$3" ] || { echo "usage: $0 --classify <http-status> <body-file>" >&2; exit 2; }
  classify "$2" "$3" && exit 0 || exit $?
fi

ENV_FILE="${1:-/opt/crm/.env.extraction-worker}"
[ -r "$ENV_FILE" ] || { echo "ERROR: cannot read $ENV_FILE" >&2; exit 2; }
# The last assignment wins, as in an env_file; surrounding quotes are dropped.
value_of() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
ACCOUNT_ID="$(value_of CLOUDFLARE_ACCOUNT_ID)"
TOKEN="$(value_of CLOUDFLARE_AI_TOKEN)"
# The id goes into a URL and the token into a curl config line: both are refused unless plain.
[[ "$ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "ERROR: CLOUDFLARE_ACCOUNT_ID in $ENV_FILE is missing or not 32 lower-case hex" >&2; exit 2; }
[[ "$TOKEN" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ERROR: CLOUDFLARE_AI_TOKEN in $ENV_FILE is missing or has unexpected characters" >&2; exit 2; }
[[ "$PROBE_MODEL" =~ ^@cf/[a-z0-9][a-z0-9_-]*/[a-z0-9][a-z0-9._-]*$ ]] || { echo "ERROR: CF_PLAN_PROBE_MODEL is not a @cf/<org>/<model> id" >&2; exit 2; }

BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT
if ! STATUS="$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -sS -K - -o "$BODY" -w '%{http_code}' \
  --max-time 30 -X POST -H 'content-type: application/json' \
  --data '{"messages":[{"role":"user","content":"ok"}],"max_tokens":1}' \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${PROBE_MODEL}")"; then
  echo "PLAN: UNKNOWN. The request to Cloudflare did not complete (see the curl error above)."
  exit 1
fi
classify "$STATUS" "$BODY" && exit 0 || exit $?
