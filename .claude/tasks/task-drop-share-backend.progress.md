# Progress — task-drop-share-backend (DONE — backend)

current_milestone: 6/6 (complete)
branch: backend-v2 → feature/drop-share-override-and-receiver
PR: #367 (base main)

## Done — all 17 ACs

- Step 1 shared + atomicity constants.ts (173434d2) — AC1, AC2
- Step 2 schema migration + manual prod-DDL (472e0a1f) — AC3, AC4
- Step 3 Part A: resolveDropShare + override CRUD + snapshot (472e0a1f) — AC5, AC6, AC7, AC8
- Step 4 Part B: declareUsdtProjectIncome + obligations + settle drop + ledger + C4 (3f909f6e) — AC9–AC15
- Tests (fd330cc6): usdt-income-obligations integration (13, crm_qa) + AC6 (11) — AC9–AC17

## Verification

- pnpm typecheck (monorepo) — green
- pnpm --filter @crm/api test (unit, empty DATABASE_URL) — 2312 passed
- Full integration against crm_qa — all green EXCEPT 2 pre-existing company-wide
  specs (income-compliance, admin-summary) that fail ONLY in full-suite ordering
  from inter-spec DB pollution. PROVEN pre-existing: base code (my changes stashed)
  fails identically 16/16; isolated on a clean re-seed both pass 30/30; my new spec
  passes and cleans up (project-scoped) so it does not contribute.
- E2E: diff touches ZERO e2e specs + ZERO rendered UI (only 2 additive exhaustive-map
  keys). Live UT stack (:3000/:3001) runs old code vs live crm_db (no migration) —
  running E2E there tests old code + mutates live data (data-safety). Frontend + E2E
  for the new flows are separate task-files (AutoTest/frontend zone) per ADR.

## Follow-ups (owner/PM/DevOps)

- Prod-DDL apps/api/drizzle/manual/2026-07-13_payment_type_and_drop_pending_payout.sql
  → deploy.yml Step 2b; run C13 `SELECT DISTINCT payment_type FROM projects` before convert.
- Frontend task (paymentType Select, drop-share slider, admin-USDT dialog, dialog maps).
- E2E task (AutoTest) for admin-USDT declare → obligations → settle.

## Review round 1 (PR #367, both APPROVE) — fix-round findings closed

- MED-1 (code-review): 4 new real-DB RBAC visibility tests in
  `usdt-income-obligations.integration.spec.ts` — DROP sees own DROP_PENDING_PAYOUT/
  PAYOUT_DROP (findOne + findAll), SENIOR does NOT see the drop's rows, JUNIOR never,
  ACCOUNTANT/ADMIN see everything. Neither type is blacklisted in `assertReadAccess`/
  `findAll`'s inline filter (unlike PAYOUT_ADMIN/PAYOUT_CONFIRMED), so this closes
  ADR C9.
- LOW-1: `createProjectSchema`/`updateProjectSchema.paymentType` — added
  `paymentTypeStringSchema` (non-type-predicate `.refine()` against the new
  `PROJECT_PAYMENT_TYPES` const array): RUNTIME-strict membership (400 via the
  global ZodExceptionFilter on an unknown value) while the Zod-inferred TS type
  stays `string | null | undefined` — deliberately NOT narrowed to the 3-member
  union, because the current create/edit project forms in `apps/web` still submit
  free text (Select is a follow-up frontend task) and narrowing would red monorepo
  typecheck for 2 web files outside Coder's zone. New `packages/shared/src/schemas/
projects.spec.ts` (12 tests) proves both the runtime rejection and the accepted
  values. `pnpm typecheck` confirmed green after the change.
- LOW-3 (security): seed.ts USDT DropVault `domain: 'dropvault.io'` → `'Web3 / Crypto'`
  (valid `IT_DOMAINS` member). Other pre-existing seed rows with non-enum domains
  are out of scope (not touched by this task).
- LOW-2 (progress-file in diff): KEPT — `.claude/tasks/<task>.progress.md` is an
  explicitly allowed Coder zone-of-write path; documents genuine audit trail.
