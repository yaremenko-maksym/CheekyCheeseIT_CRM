# Progress: task-drop-phase2-frontend

current_milestone: 1/6 — "shared schemas + backend acceptance done"
last_commit: pending wip1
last_push: pending

files_done: []
files_pending:

- packages/shared/src/schemas/projects.ts (add dropId to create/update + dropSharePercent to drop)
- packages/shared/src/schemas/users.ts (verify dropSharePercent exposed)
- apps/api/src/projects/projects.service.ts (handle dropId in create/update; map dropSharePercent on drop)
- apps/web/app/routes/crm/projects/index.tsx (Drop select in create form)
- apps/web/app/routes/crm/projects/$projectId.tsx (Drop badge, distribution breakdown, drop in effective team)
- apps/web/app/components/user-profile/tabs/FinanceTab.tsx (Add Drop income button for DROP role)
- apps/web/app/routes/crm/finance/components/KpiCards.tsx (drop balances panel)
- apps/web/app/routes/crm/finance/index.tsx (DROP role visibility)

milestones:

- 1/6 — shared schema dropId + backend acceptance
- 2/6 — Drop Select in create/edit project form
- 3/6 — Project detail: Drop badge + distribution breakdown
- 4/6 — DROP profile Финансы tab: «Добавить приход» dialog
- 5/6 — /crm/finance: drop balances panel + DROP visibility
- 6/6 — typecheck + lint + tests green + push
  </content>
  </invoke>
