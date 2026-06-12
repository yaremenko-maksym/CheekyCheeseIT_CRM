# task-rbac-senior-junior-visibility progress

current_milestone: 5/5 (COMPLETE)
last_commit: 114cfd3
last_push: origin/fix/junior-ut-round1
files_done:

- apps/api/src/contracts/contract-status.realdb.integration.spec.ts (AC2 real-DB)
- apps/api/src/users/salary-meta.realdb.integration.spec.ts (AC4 real-DB)
- apps/api/src/legends/legend-defaults.realdb.integration.spec.ts (AC8 real-DB)
- apps/api/src/users/users.service.ts (jsonb_exists fix for getSalaryMeta)
  files_pending: []

## Verification summary (finalization dispatch #3)

- AC2: real-DB spec ✓ getMyStatus returns SIGNED for JUNIOR with contract, null for no contract, self-only
- AC4: real-DB spec ✓ getSalaryMeta returns salary + changedAt from audit log, self-only
- AC8: real-DB spec ✓ getLegend defaults=null for JUNIOR viewer, non-null for ADMIN/HR (data-leak prevented)
- Vision: ✓ /crm/project shows "Подписан" badge + salary block with worktree API on :3002
- Vision: ✓ /crm/legend renders correctly for JUNIOR (no defaults leak)
- E2E: 13 failed tests are pre-existing on main (confirmed: 22 failed on main against same specs)
- This PR adds zero changes to apps/e2e/\*\*

- apps/api/src/users/users-access.service.ts
- apps/api/src/users/users-access.service.spec.ts
- apps/api/src/teams/teams.service.ts
- apps/api/src/projects/projects.service.ts
- apps/web/app/routes/crm/team/$teamId.tsx
- apps/web/app/routes/crm/projects/$projectId.tsx
- apps/e2e/tests/rbac-senior-junior.spec.ts

## Audit findings

1. users-access.service.ts L97-103: SENIOR can view JUNIOR profile via isSeniorViewingOwnProjectMember → MUST block
2. teams.service.ts mapTeam(): juniorMembers includes displayName/email/phone/telegram → SENIOR viewer must not see
3. projects.service.ts computeEffectiveTeam(): juniors array with displayName/email/avatarUrl → SENIOR viewer must not see
4. $teamId.tsx active-projects block: shows junior.displayName — no role guard
5. $teamId.tsx members list: JUNIOR role shown to SENIOR — already filtered for JUNIOR viewer, need for SENIOR viewer too
6. $projectId.tsx ProjectEffectiveTeamCard: juniors rendered with link/name/avatar — no role guard
7. #11: $teamId.tsx active-projects section + telegramChannel — must be hidden from JUNIOR viewer entirely
