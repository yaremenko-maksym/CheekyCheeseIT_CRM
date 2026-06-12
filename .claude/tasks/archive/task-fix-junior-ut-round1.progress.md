# task-fix-junior-ut-round1 progress

current_milestone: 0/6
last_commit: none
last_push: none
branch: fix/junior-ut-round1
worktree: /Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/worktrees/funny-margulis-6f55ab

blast_radius:

- legendSchema (packages/shared/src/schemas/legends.ts) → call-sites: legend.tsx, legends.service.ts
- addLegendEntrySchema → call-sites: legend.tsx, legends.service.ts
- contractMeDtoSchema → call-sites: project.tsx only (confirmed)
- useLastSalary (project.tsx) → local only, no external callers

files_done: []
files_pending:

- packages/shared/src/schemas/contracts.ts (AC1: add contractStatusSchema)
- packages/shared/src/schemas/legends.ts (AC6,7,8: defaults, eventDate)
- packages/shared/src/schemas/finance.ts (AC3,5: reuse transactionSchema)
- apps/api/src/contracts/contracts.controller.ts (AC1,2: GET /contracts/me/status)
- apps/api/src/contracts/employee-contracts.service.ts (AC1,2: getMyStatus)
- apps/api/src/contracts/contracts.module.ts (AC1,2: wire)
- apps/api/src/users/users.controller.ts (AC3,4: GET /users/me/salary-meta)
- apps/api/src/users/users.service.ts (AC3,4: getSalaryMeta)
- apps/api/src/legends/legends.service.ts (AC6,7,8: defaults + eventDate sort)
- apps/api/src/database/schema.ts (AC7: event_date column)
- apps/api/drizzle/migrations/XXXX_legend_entries_event_date.sql (AC7)
- apps/web/app/routes/crm/project.tsx (AC1,3,5,6: contract/salary hooks)
- apps/web/app/routes/crm/legend.tsx (AC6,7,8: no avatar, 1 cancel, datepicker, prefill)
- apps/api/src/contracts/contract-status.integration.spec.ts (AC2)
- apps/api/src/users/salary-meta.integration.spec.ts (AC4)
- apps/api/src/legends/legends.service.spec.ts (AC8,9: unit tests)

milestone_plan:
M1: shared schemas (contracts + legends + finance check) — 2 files
M2: API backend (employee-contracts service + controller + users service/controller) — 4 files  
 M3: DB schema + migration + legends service (eventDate + defaults) — 3 files
M4: Frontend (project.tsx + legend.tsx) — 2 files
M5: Tests (integration + unit) — 3 files
M6: typecheck/lint/verify + final commit
