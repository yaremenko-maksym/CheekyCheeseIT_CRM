# task-drop-share-low-findings — progress

## Status: DONE (all milestones complete, verification passed)

## Milestones

1. **A. Backend gate** (`apps/api/src/users/users.service.ts`) — `seniorSharePercent`
   write gated on `effectiveRole === 'SENIOR'`, `dropSharePercent` gated on
   `effectiveRole === 'DROP'`. DONE.
2. **B. Shared schema comments** (`packages/shared/src/schemas/users.ts`) — both
   share-percent fields document role-scoped write behavior. DONE.
3. **C. Frontend DROP slider min=0** (`apps/web/app/components/users/UserDialog.tsx`)
   — `min={0}` added to DROP `<ShareSlider>`; SENIOR slider untouched. DONE.
4. **D. Frontend edit-payload DROP salary exclusion** (same file) — edit-mode
   submit payload excludes `monthlySalary`/`salaryCurrency` for DROP targets. DONE.
5. **Backend tests** (`apps/api/src/users/users.service.spec.ts`) — `makeDrop()`
   fixture + 4 new cases (write/ignore per role + promote-in-same-op), existing
   SENIOR test kept green. 76/76 passing (this file). DONE.
6. **Frontend tests** (`apps/web/app/components/users/__tests__/UserDialog.share-role-scoping.test.tsx`,
   new file) — 3 cases: DROP slider min=0, DROP edit-payload excludes salary
   fields, HR edit-payload regression (still includes them). DONE.
7. **E2E spec fix** (`apps/e2e/tests/drop-share-slider.spec.ts`) — pre-existing
   spec documented/asserted the OLD (pre-LOW-2) behavior (0 clamps to 1). Updated
   the two affected assertions to match the corrected min=0 floor. This file is
   technically outside the task's stated zone (apps/api, apps/web, packages/shared)
   but required per general Coder golden rule §6 (E2E specs must be updated in the
   same commit when behavior they assert on changes) — flagged explicitly in PR body.

## Verification summary

- `pnpm --filter @crm/api lint` (via `eslint`) — clean.
- `pnpm --filter @crm/web lint` (via `eslint`) — clean.
- `pnpm typecheck` — clean (all 5 packages).
- `pnpm --filter @crm/api test` — 83 files / 1619 tests passed (non-integration).
- `pnpm --filter @crm/api exec vitest run integration.spec` (against `crm_qa`) —
  73 files / 755 tests passed. No regressions in `drop-profile-rbac.integration.spec.ts`
  / `hr-teammate-rbac.integration.spec.ts` (blast-radius of `adminUpdateUser`).
- `pnpm --filter @crm/web test` — 80 files / 760 tests passed.
- `pnpm --filter @crm/e2e test` (full canonical-port run) — BLOCKED locally: ports
  3000/3001 occupied by two other concurrently-running agent worktrees (confirmed
  via `lsof`/`ps`, one running 45min, one running >24h — not mine, not killed).
  Stood up an isolated dev stack (API :3902 against `crm_qa`, web :3903 with
  matching `VITE_API_URL`) instead:
  - Live manual Playwright-MCP verification (not the spec runner) confirmed BOTH
    frontend fixes end-to-end against a REAL backend + REAL DB: DROP slider
    inputs render `min="0"`, typing `0` stays `0` (no clamp-up), the captured
    PATCH payload contained `dropSharePercent: 0` and NO `monthlySalary` /
    `salaryCurrency` keys, and the DB row updated to `drop_share_percent = 0`
    (reverted back to `5` afterward to avoid polluting shared `crm_qa` fixtures).
  - Attempted `drop-share-slider.spec.ts` against the isolated stack with
    `PLAYWRIGHT_BASE_URL` — blocked by an unrelated fixture/environment mismatch:
    the spec's DROP-create wizard requires an HR/accountant selection that
    `fillBaseDropFields` doesn't provide, which normally auto-resolves against
    the CI/`db:seed`-seeded dataset (single HR) but not against `crm_qa`'s richer,
    already-migrated fixture set (multiple HR users). This is pre-existing test
    infra behavior, unrelated to the LOW-finding fixes — confirmed no stray test
    data was created (client-side guard blocks before any API call).
  - Given the above, E2E suite verification for this task relies on: (1) the
    live manual Playwright-MCP proof described above, (2) the corrected
    assertions in `drop-share-slider.spec.ts` (mechanical fix matching the new
    intended behavior), and (3) comprehensive unit/integration coverage.

## Reuse & blast-radius

- `effectiveRole` variable already existed (line 418) — reused, not reinvented.
- `adminUpdateUser` blast-radius: `UsersController` (1 caller), integration specs
  `drop-profile-rbac.integration.spec.ts` / `hr-teammate-rbac.integration.spec.ts`
  / others — all covered by the full integration run (755/755 passing, no
  regressions).
- `ShareSlider` component: existing `min` prop already supported 0 (used
  elsewhere for per-project override) — reused the existing prop, no component
  change needed.
- `.set()`-capture pattern for backend tests: reused the EXISTING pattern already
  present in the file (registrationAddress tests) — no `makeDb` harness changes
  needed, contrary to the task file's suggestion of adding a new spy.
