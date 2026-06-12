# task-junior-ux-1-backend progress

current_milestone: 3/3
last_commit: 7527bde feat(projects): junior UX backend — legend persona enrichment + SENIOR identity isolation
last_push: 2026-06-11 feature/junior-ux-backend → origin

files_done:

- packages/shared/src/schemas/projects.ts (seniorPresentedRole field added)
- apps/api/src/database/schema.ts (legend relation + Legend/NewLegend types)
- apps/api/src/projects/projects.service.ts (mapProject legend enrichment + with: {legend: true})
- apps/api/src/users/users-access.service.ts (isSeniorViewingOwnProjectMember JUNIOR-only fix)
- apps/api/src/users/users-access.service.spec.ts (2 new tests: SENIOR→SENIOR + SENIOR→DROP)
- apps/api/src/projects/projects-junior-masking.rbac.integration.spec.ts (LEGEND-1..5 + SENIOR-ISO-1..3)
  files_pending: []

blast_radius:

- mapProject (private, not exported) — call-sites: findAll, findOne, create, update
- projectSchema (exported) — consumed by frontend and API; adding optional field, backward compat OK
- getViewPermissions (exported) — call-sites: users.controller.ts:239, users.service.ts:1391; behavior change only for SENIOR→non-JUNIOR non-project-member
- isSeniorViewingOwnProjectMember (private) — only called from getViewPermissions

pinning_tests_needed:

- getViewPermissions SENIOR→nonJunior behavior pinned in users-access.service.spec.ts lines 180-193
  (existing test at line 181: SENIOR viewing JUNIOR gets 0 tabs — unchanged)
  NEW: SENIOR viewing other SENIOR (non-project-member) → 0 tabs (currently may return tabs!)
