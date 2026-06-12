# task-project-credentials — progress sentinel

current_milestone: 4/8 (backend complete, web next)
last_update: 2026-06-12 PR opened
last_commit: b819c1c (amended to 111bcbb) wip(credentials): shared+crypto+env+table
last_push: origin/feature/project-credentials (PR #178)
pr: 178
branch: feature/project-credentials
worktree: .claude/worktrees/agent-a71a6214e150e6dbe

## CRITICAL GOTCHA (this session)

Write/Edit with absolute path `/Users/.../CheekyCheeseIT_CRM/...` resolved to MAIN repo,
NOT the worktree (MAIN is an "additional working directory"). Contaminated MAIN once,
cleaned it. FIX: ALWAYS use full worktree path
`/Users/.../CheekyCheeseIT_CRM/.claude/worktrees/agent-a71a6214e150e6dbe/...` for every
Read/Edit/Write. Git via `git -C "$WT"`. routeTree.gen.ts copied from MAIN (gitignored).

## Milestones

- [x] M1: shared schema (credentials.ts) + index export
- [~] M2: project_credentials table + crypto service + env (DONE) | migration 0011 (PENDING)
- [ ] M3: HrAccessService (common, global) + refactor legends + projects hr-contact
- [ ] M4: credentials module (service + controller) + unit/integration tests
- [ ] M5: web hook use-credentials + ProjectCredentialsSection
- [ ] M6: integrate into project.tsx hub + $projectId.tsx
- [ ] M7: tests green (unit + integration scratch-db) + typecheck + lint
- [ ] M8: playwright screenshots + final commit ac_verified

## files_done

- packages/shared/src/schemas/credentials.ts, index.ts
- apps/api/src/credentials/credentials-crypto.service.ts (+ .spec.ts, 9 green)
- apps/api/src/config/env.ts, apps/api/.env.example
- apps/api/src/database/schema.ts (project_credentials + relations)

## files_pending

- apps/api/drizzle/migrations/0011\_\*.sql (db:generate)
- apps/api/src/common/hr-access.service.ts (+ module wiring)
- apps/api/src/credentials/{module,controller,service}.ts (+ specs)
- apps/web/app/hooks/use-credentials.ts
- apps/web/app/components/projects/ProjectCredentialsSection.tsx
- apps/web/app/routes/crm/project.tsx (hub card)
- apps/web/app/routes/crm/projects/$projectId.tsx (overview section)

## blast_radius (HrAccessService refactor)

- legends.service.ts:hrCanAccess (private) -> HrAccessService.hrSharesActiveTeamWith
  call-site: canAccess (legends.service.ts:56); pinned: legends.rbac.integration.spec.ts, legends.service.spec.ts
- projects.service.ts:hrCanAccessProject (private) -> HrAccessService.hrSharesActiveTeamWith
  call-site: getHrContact (projects.service.ts:1159); pinned: projects.hr-contact.integration.spec.ts
  NOTE: getHrSeniorIds (list builder, filters SENIOR) = DIFFERENT concern, keep as-is.

## UPDATE 2026-06-12 (backend complete)

- M3 done: HrAccessService + refactor (legends/projects), all 6+2 spec sites patched, 41 integration + 98 unit green.
- M4 done: credentials module (service/controller/module), 18 RBAC integration tests on scratch DB (AC3/AC4/AC5 verified).
- crypto: 9 unit, hr-access: 3 unit.
- pushed 2362085 (full monorepo suite green: api + web 321).
- AC1✓ AC2✓ AC3✓ AC4✓ AC5✓ AC6✓ verified on real scratch DB.
- NEXT: M5 web (use-credentials hook + ProjectCredentialsSection), M6 integrate hub+detail, M8 screenshots.
- scratch DB: crm_scratch_cred (migrated+seeded), ENC_KEY in worktree .env.

## FINAL 2026-06-12 — DONE ✅

- current_milestone: 8/8 COMPLETE
- PR #178 OPEN, final commit e13e075 (ac_verified: 1-9, vision ✓).
- All 9 AC verified on real scratch DB + live Playwright stack.
- 4 screenshots posted to PR (hosted on media/project-credentials-screenshots branch, raw URLs).
- MAIN clean (only pre-existing PM artifacts). Feature branch all in zone (31 files, apps/**+packages/**).
- Background servers stopped. MAIN's :3001 untouched.
- DevOps follow-up flagged in PR: drizzle-kit generate broken (0008/0010 snapshot collision) — pre-existing, db:migrate unaffected.
