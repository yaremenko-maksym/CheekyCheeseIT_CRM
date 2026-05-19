#!/bin/bash

# Apply branch protection to main branch using GitHub API
# Requires ADMIN_PAT environment variable with repo + administration scopes

set -e

if [ -z "$ADMIN_PAT" ]; then
    echo "Error: ADMIN_PAT environment variable is required"
    echo "This should be a Personal Access Token with 'repo' and 'administration' scopes"
    exit 1
fi

echo "Configuring GitHub CLI with ADMIN_PAT..."
export GH_TOKEN="$ADMIN_PAT"

echo "Applying branch protection rules to main branch..."

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
      { "context": "AI Code Review" }
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

echo "Branch protection rules applied successfully!"

echo "Verifying applied settings..."
gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/branches/main/protection \
  --jq '{
    required_checks: .required_status_checks.checks[].context,
    required_reviews: .required_pull_request_reviews.required_approving_review_count,
    enforce_admins: .enforce_admins.enabled,
    dismiss_stale_reviews: .required_pull_request_reviews.dismiss_stale_reviews,
    required_conversation_resolution: .required_conversation_resolution
  }'

echo "Branch protection configuration completed!"