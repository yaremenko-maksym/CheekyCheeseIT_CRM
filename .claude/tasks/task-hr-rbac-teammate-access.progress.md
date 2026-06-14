# Progress: task-hr-rbac-teammate-access

branch: feature/hr-rbac-teammate-access
current_milestone: 1/3
last_update: 2026-06-14

## Milestones

- [x] M1 — production code: isHrInTargetTeam (ACCOUNTANT/HR shared-team branch) +
      getViewPermissions HR-branch (overview+team only for ACCOUNTANT/HR target).
      typecheck + eslint clean.
- [ ] M2 — unit tests: isHrInTargetTeam all branches + getViewPermissions HR→ACCOUNTANT/HR.
- [ ] M3 — integration test (real DB): HR→ACCOUNTANT teammate=200 masked, other-team=403,
      SENIOR teammate=200 regression. scratch-DB run green.

## blast_radius (getViewPermissions / isHrInTargetTeam)

- getViewPermissions — 1 caller: UsersService.buildProfileView (users.service.ts:1389).
  Behaviour preserved for all non-HR viewers + HR→SENIOR/JUNIOR; pinned by existing
  users-access.service.spec.ts (regression suite) + new HR-peer tests.
- isHrInTargetTeam — 1 caller: getViewPermissions (same file). Previously NO covering
  tests (audit REFACTOR-L2) → new unit describe block pins all branches.
- buildProfileView masking: financial/PII fields gated by permissions.fields.\* flags;
  HR-peer path leaves salary/share/requisites/fopPii/legalName at false default → null
  in response. Pinned by integration spec asserting masked fields.

## reuse

- Reused existing shared-team membership query (was SENIOR-only) — generalized the role
  guard instead of adding a new helper. No new helper/duplication.
