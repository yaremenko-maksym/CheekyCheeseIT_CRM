# task-admin-as-senior progress

current_milestone: 5/5
last_commit: f6c4f6b
last_push: feature/admin-as-senior
files_done:

- packages/shared/src/schemas/projects.ts (profileNavigable field added)
- apps/api/src/legends/legends.service.ts (canAccess reorder: ADMIN before subject-exclusion)
- apps/api/src/projects/projects.service.ts (mapProject seniorId masking + computeEffectiveTeam email/profileNavigable)
- apps/api/src/projects/admin-as-senior.rbac.integration.spec.ts (ADMIN-SR-1..8 real DB)
- apps/api/src/projects/admin-as-senior.unit.spec.ts (UNIT-1..9 mocked)
- apps/api/src/database/seed.ts (2 admin-projects + legends)
- apps/web/app/components/users/ProfileNameLink.tsx (nonNavigable prop)
- apps/web/app/components/users/ProfileNameLink.spec.tsx (PNL-1..6)
- apps/web/app/routes/crm/projects/$projectId.tsx (senior-row + EffectiveTeamCard)
  files_pending: []

blast_radius:

- ProfileNameLink: used in $projectId.tsx (senior-row), documents pages
  (checked — nonNavigable=false default preserves existing behavior)
- mapProject: called by findOne/findAll/create/update — JUNIOR masking unchanged,
  new branch only fires when senior.role='ADMIN'
- computeEffectiveTeam: called by findOne for non-JUNIOR — profileNavigable=true default

ac_verified: 1,2,3,4,5,6,7,8
