# task-hr-dashboard-tweaks — progress

current_milestone: 4/4
last_commit: b92bc0f
last_push: pending final
files_done:

- packages/shared/src/schemas/interviews.ts
- apps/api/src/interviews/interviews.service.ts
- apps/web/app/routes/crm/routing/components/HRDashboard.tsx
- apps/web/app/routes/crm/routing/components/**tests**/HRDashboard.test.tsx
- apps/api/src/interviews/hr-summary.integration.spec.ts
  files_pending: []

blast_radius:

- useHrSummary (apps/web) — 1 caller: HRDashboard.tsx ✓ updated
- HrSummaryDto (packages/shared) — 4 callers in interviews.service.ts ✓ updated
- getHrSummary — no external callers beyond controller ✓
- salary-status.helper.ts — NOT touched (senior-summary still uses it ✓)

integration_verified: crm_qa, 16/16 tests passed
unit_verified: 9/9 tests passed (HRDashboard.test.tsx)
typecheck: 4/4 packages clean
