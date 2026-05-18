#!/bin/bash
set -e

# Обновление branch protection для main через ADMIN_PAT
export GH_TOKEN="${ADMIN_PAT}"

echo "Обновляю branch protection для main..."

gh api \
  --method PUT \
  repos/yaremenko-maksym/CheekyCheeseIT_CRM/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "Typecheck · Lint · Unit Tests" },
      { "context": "E2E Tests" },
      { "context": "AutoTest" },
      { "context": "Code Review" }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
EOF

echo "Проверяю применение настроек..."

gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/branches/main/protection \
  --jq '{
    required_checks: .required_status_checks.checks[].context,
    required_reviews: .required_pull_request_reviews.required_approving_review_count,
    enforce_admins: .enforce_admins.enabled,
    dismiss_stale_reviews: .required_pull_request_reviews.dismiss_stale_reviews,
    conversation_resolution: .required_conversation_resolution
  }'

echo "Branch protection обновлен успешно!"