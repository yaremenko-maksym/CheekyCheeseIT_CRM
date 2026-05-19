# Branch Protection Setup

## Overview

This script applies branch protection rules to the `main` branch to enforce:

- Required status checks (CI, E2E, AutoTest, Code Review)
- Required pull request reviews (minimum 1 approval)
- Admin enforcement 
- Stale review dismissal
- Conversation resolution requirement
- Linear history enforcement

## Requirements

- Personal Access Token with `repo` and `administration` scopes
- GitHub CLI (`gh`) installed and authenticated

## Usage

### Local execution (for repository owner/admin)

```bash
# Set the ADMIN_PAT environment variable
export ADMIN_PAT="your_personal_access_token_here"

# Run the script
./scripts/apply-branch-protection.sh
```

### CI execution (GitHub Actions)

The script can be executed in GitHub Actions using the `ADMIN_PAT` secret:

```yaml
- name: Apply Branch Protection
  env:
    ADMIN_PAT: ${{ secrets.ADMIN_PAT }}
  run: ./scripts/apply-branch-protection.sh
```

## Branch Protection Rules Applied

- **Required Status Checks:**
  - `Typecheck · Lint · Unit Tests`
  - `E2E Tests`
  - `AutoTest`
  - `Code Review`
- **Required Pull Request Reviews:** 1 approval minimum
- **Dismiss Stale Reviews:** Enabled
- **Admin Enforcement:** Enabled
- **Require Conversation Resolution:** Enabled
- **Linear History:** Enabled
- **Force Pushes:** Disabled
- **Deletions:** Disabled

## Verification

The script automatically verifies the applied settings and displays:

- Required checks list
- Required review count
- Admin enforcement status
- Stale review dismissal setting
- Conversation resolution requirement

## Acceptance Criteria

✅ `required_status_checks` contains all 4 checks  
✅ `required_approving_review_count` = 1  
✅ `enforce_admins.enabled` = true  
✅ `dismiss_stale_reviews` = true  
✅ `required_conversation_resolution` = true  

## Related Task

`docs/specs/tasks/task-infra-branch-protection.md`