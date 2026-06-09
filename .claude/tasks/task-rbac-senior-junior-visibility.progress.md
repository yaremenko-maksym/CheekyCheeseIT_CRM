# task-rbac-senior-junior-visibility progress

current_milestone: 1/5
last_commit: (none yet)
last_push: (none yet)
files_done: []
files_pending:

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
