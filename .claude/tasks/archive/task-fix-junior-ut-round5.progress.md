# task-fix-junior-ut-round5 — progress sentinel

current_milestone: 3/3
last_commit: 1da40d6
files_done:

- packages/shared/src/schemas/projects.ts (hrContactSchema.avatarUrl)
- apps/api/src/projects/projects.service.ts (getHrContact all return-paths + avatarUrl)
- apps/api/src/projects/projects.hr-contact.integration.spec.ts (HC-1 avatarUrl check)
- apps/api/src/database/seed.ts (user_audit_log salary rows for Sofia/Yuriy/Lena)
- apps/web/app/routes/crm/project.tsx (salary card dedup + HrInline Avatar)
  files_pending: []

blast_radius:

- hrContactSchema (packages/shared): used in project.tsx useHrContact hook — updated
- getHrContact return type (projects.service): updated all 3 return-paths
- HC-1 integration spec: updated allowlist check to include avatarUrl

scratch_db_verified:

- crm_scratch_r5: schema pushed + seeded
- Sofia changedAt: 2026-02-10 12:00:00+02 (not null — CONFIRMED)

autotest_notes:

- junior-hub.spec.ts line 463-476: test 'salary-changed-at absent from DOM when changedAt is null'
  NOW BROKEN by our change — salary-changed-at always rendered (fallback text).
  Must be updated by AutoTest to: toContainText('Ставка ещё не менялась') instead of toHaveCount(0).
