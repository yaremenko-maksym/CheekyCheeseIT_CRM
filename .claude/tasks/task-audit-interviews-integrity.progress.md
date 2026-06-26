# Progress: fix/audit-interviews-integrity

current_milestone: 4/4
last_commit: tests (integration RBAC + move-transaction); all 3 findings fixed + typecheck/eslint/integration green
last_push: BLOCKED — pre-push prettier hook evaluates session branch (infra/e2e-money-shard, 10 unformatted .design-sync files) not my worktree; my diff is clean. See report.
verify: pnpm --filter @crm/api typecheck PASS; eslint PASS; 166 interviews+projects integration tests PASS (crm_qa)

## Findings → fixes

1. HIGH — arbitrary stage via PATCH. Remove `stage` from updateInterviewSchema + drop `updateData.stage` in service.update().
2. HIGH — move() not transactional. Wrap whole move() in this.db.db.transaction(tx); thread tx into renormalization + createFromInterview (add tx param).
3. MEDIUM — ex-HR keeps board access. Add isNull(teamMembers.leftAt) in getAccessibleSeniorIds + filter team.members by leftAt === null.

## blast_radius

- `updateInterviewSchema` (packages/shared/src/schemas/interviews.ts:47) — callers: interviews.controller.ts update(), interviews-rbac.integration.spec.ts. Removing `stage` field: update() must not write stage. Pinned by new integration test (PATCH stage → ignored).
- `update()` (interviews.service.ts:171) — caller: controller. Drop `updateData.stage`.
- `move()` (interviews.service.ts:214) — caller: controller. Wrap in transaction. E2E interviews.spec.ts moves to HIRED via UI — must stay green.
- `createFromInterview()` (projects.service.ts:1147) — 1 caller: move(). Add optional tx param (back-compat). No other callers.
- `getAccessibleSeniorIds()` (interviews.service.ts:70) — callers: findBySenior, create, remove, assertUpdateAccess. Tighten with leftAt. Mirrors getHrSeniorIds (projects.service.ts:313) which already filters leftAt.

## files_pending

- packages/shared/src/schemas/interviews.ts
- apps/api/src/interviews/interviews.service.ts
- apps/api/src/projects/projects.service.ts (createFromInterview tx param)
- apps/api/src/interviews/interviews-rbac.integration.spec.ts (or new spec)

## files_done

(none yet)

## tests

- PATCH /interviews/:id with stage → rejected/ignored (Zod strips/rejects)
- move() with createFromInterview failure → interview stays in OLD stage (rollback)
- ex-HR (leftAt set) → no board access (findBySenior 403 / empty)
- E2E interviews.spec.ts stays green (move to HIRED works)
