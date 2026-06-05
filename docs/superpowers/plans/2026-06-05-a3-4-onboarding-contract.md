# A3-4 Onboarding Personal-Contract Sign — Implementation Plan

> **For agentic workers:** Implement task-by-task with TDD (write test → run red → implement → run green → commit). Steps use checkbox (`- [ ]`). Spec: `docs/superpowers/specs/2026-06-05-a3-4-onboarding-contract-design.md`.

**Goal:** Make the onboarding contract step operate on the user's personal `employee_contract` — preview via the self endpoint, sign READY_TO_SIGN → SIGNED, and show a "Контракт готовится" wait screen when no READY_TO_SIGN contract exists.

**Architecture:** Backend redefines `OnboardingService.requiresContract` off the personal contract's SIGNED state (the already-correct `sign()` path is untouched). Frontend points the existing preview at `/api/onboarding/contract/pdf` and renders Wait vs Sign by `contractReady`. No shared-schema field added.

**Tech Stack:** NestJS + Drizzle (api), Zod v4 (shared), React + TanStack Query (web), Vitest, Playwright. Russian UI.

**Branch:** `feat/a3-4-onboarding-contract` (off main 6109a17). Chunked `wip:` pushes; final commit `ac_verified:`.

---

## Planning refinements vs spec

- **Do NOT reuse `ContractPdfPreview`** (spec §5.1 floated it): its `fetchContractPdfBlob` is hardcoded to the ADMIN endpoint `/api/users/:id/contract/pdf` (403 for a self onboarding user), and its `isDirty`/refresh UI is editor-specific. Instead fix `SignContractStep`'s own iframe block to call `/api/onboarding/contract/pdf`.
- **No new `OnboardingStatusDto` field**: reuse `requiresContract` (redefined) + `contractReady`.

## File structure

- `apps/api/src/contracts/employee-contracts.service.ts` — add `hasSignedContract(userId)`.
- `apps/api/src/onboarding/onboarding.service.ts` — `requiresContract` from personal SIGNED state.
- `apps/api/src/onboarding/onboarding.service.spec.ts` — update unit matrix.
- `apps/api/src/onboarding/onboarding-contract.integration.spec.ts` (new) — real-backend status + sign + guard.
- `packages/shared/src/schemas/onboarding.ts` — update `requiresContract` doc comment only (no shape change).
- `apps/web/app/components/onboarding/SignContractStep.tsx` — PDF URL → `/onboarding/contract/pdf`; copy.
- `apps/web/app/components/onboarding/ContractWaitScreen.tsx` (new) — "Контракт готовится".
- `apps/web/app/routes/crm/onboarding/index.tsx` — contract branch Wait vs Sign + status poll while waiting.
- `apps/web/app/components/onboarding/__tests__/*.test.tsx` — web units (in `__tests__/`, NOT under routes/).
- `apps/e2e/tests/onboarding-flow.spec.ts`, `onboarding-regression-pr110.spec.ts` — real endpoints + wait path.

---

## Task 1 — `hasSignedContract` (api)

**Files:** Modify `apps/api/src/contracts/employee-contracts.service.ts`; Test `apps/api/src/contracts/employee-contracts.service.spec.ts` (or the existing service spec).

- [ ] **Step 1 — failing test:** `hasSignedContract(userId)` returns `true` when the user has a `SIGNED` employee_contract, `false` otherwise (DRAFT/READY_TO_SIGN/none).
- [ ] **Step 2 — run, expect FAIL** (`pnpm --filter @crm/api test -- employee-contracts.service`).
- [ ] **Step 3 — implement** (mirror `hasReadyContract`, status `'SIGNED'`):

```ts
/** Boolean existence check — used by OnboardingService.requiresContract (A3-4). */
async hasSignedContract(userId: string): Promise<boolean> {
  const result = await this.db.db
    .select({ exists: sql<boolean>`true` })
    .from(employeeContracts)
    .where(and(eq(employeeContracts.userId, userId), eq(employeeContracts.status, 'SIGNED')))
    .limit(1)
  return result.length > 0
}
```

- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(api): EmployeeContractsService.hasSignedContract`.

## Task 2 — `requiresContract` off personal contract (api)

**Files:** Modify `apps/api/src/onboarding/onboarding.service.ts`; Test `apps/api/src/onboarding/onboarding.service.spec.ts`.

- [ ] **Step 1 — failing test(s):** update/add `getStatus` cases for a non-ADMIN contract role:
  - SIGNED personal contract → `requiresContract=false`.
  - READY_TO_SIGN (no SIGNED) → `requiresContract=true`, `contractReady=true`.
  - no contract / DRAFT only → `requiresContract=true`, `contractReady=false`.
  - ADMIN → `requiresContract=false`, `contractReady=false` (unchanged).
  - (mock `employeeContracts.hasSignedContract` + `hasReadyContract`).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** replace the role-template `requiresContract` computation with:

```ts
// A3-4: the contract requirement is driven by the personal employee_contract,
// not the role template. The user must complete the contract step until their
// personal contract is SIGNED. `contractReady` (READY_TO_SIGN) distinguishes
// "ready to sign" from "still being prepared by ADMIN" (wait screen).
const [hasSigned, contractReady] = await Promise.all([
  this.employeeContracts.hasSignedContract(userId),
  this.employeeContracts.hasReadyContract(userId),
])
const requiresContract = !hasSigned
```

Keep `activeTemplate` fetch + `contractTemplate` population as-is (still used by the ToS/template admin surfaces; unused by the new contract step — documented follow-up). Remove the now-dead `signedContracts.findFirst` template check. Update the `requiresContract` doc comment in `packages/shared/src/schemas/onboarding.ts` to the new semantics.

- [ ] **Step 4 — run, expect PASS** + `mcp__eslint__lint-files` on changed `.ts`.
- [ ] **Step 5 — commit** `feat(api,shared): onboarding requiresContract from personal contract SIGNED state`.

## Task 3 — Real-backend integration spec (api)

**Files:** Create `apps/api/src/onboarding/onboarding-contract.integration.spec.ts` (mirror the pattern in `apps/api/src/contracts/contract-controllers.integration.spec.ts`).

- [ ] **Step 1 — tests (real Nest app, real DB, NOT mocked HTTP):**
  - non-ADMIN with READY_TO_SIGN: `GET /api/onboarding/status` → `requiresContract:true, contractReady:true`; `GET /api/onboarding/contract/pdf` → 200 PDF (guard bypass works mid-onboarding); `POST /api/contracts/sign` (valid `typedName`) → 201/200 → status now `requiresContract:false`.
  - non-ADMIN with no READY contract → `POST /api/contracts/sign` → 409 `CONTRACT_NOT_READY`; status `requiresContract:true, contractReady:false`.
  - the OnboardingGuard: a guarded endpoint (e.g. `GET /api/teams`) for an un-onboarded user → 403 `ONBOARDING_REQUIRED` (the real-guard assertion the mock-E2E missed).
- [ ] **Step 2 — run, expect FAIL** (before Task 2 wiring is complete it may already pass for sign; ensure the status assertions are red first if logic absent).
- [ ] **Step 3 — make green** (logic already in Task 2; this task is the real-stack guard/sign safety net).
- [ ] **Step 4 — run, expect PASS** (`pnpm --filter @crm/api test -- onboarding-contract.integration`).
- [ ] **Step 5 — commit** `test(api): onboarding personal-contract status+sign+guard integration`.

## Task 4 — `SignContractStep`: personal PDF + copy (web)

**Files:** Modify `apps/web/app/components/onboarding/SignContractStep.tsx`; Test `apps/web/app/components/onboarding/__tests__/SignContractStep.test.tsx`.

- [ ] **Step 1 — failing test:** SignContractStep fetches the preview from `/onboarding/contract/pdf` (assert the axios GET url), renders the sign form, sign posts `/contracts/sign`; `legalFullName`-missing disables the sign button + shows alert.
- [ ] **Step 2 — run, expect FAIL** (`pnpm --filter @crm/web test -- SignContractStep`).
- [ ] **Step 3 — implement:** change the preview fetch URL from the removed `'/contracts/preview-pdf'` to `'/onboarding/contract/pdf'` (responseType blob, unchanged otherwise). Replace "MSA-контракт"/"MSA" copy with "персональный контракт" (heading, iframe titles, checkbox label, sr-note). Keep confirm-checkbox, signature block, `legalFullName` guard, success toast with `contractNumber`.
- [ ] **Step 4 — run, expect PASS** + eslint.
- [ ] **Step 5 — commit** `fix(web): onboarding sign step previews personal contract (/onboarding/contract/pdf)`.

## Task 5 — Wait screen + step orchestration (web)

**Files:** Create `apps/web/app/components/onboarding/ContractWaitScreen.tsx`; Modify `apps/web/app/routes/crm/onboarding/index.tsx`; Test `apps/web/app/components/onboarding/__tests__/ContractWaitScreen.test.tsx` + extend onboarding index test if present.

- [ ] **Step 1 — failing test:** `ContractWaitScreen` renders heading «Контракт готовится» + explanation + `data-testid="contract-wait"`, and NO sign button. Index test: when `requiresContract && !contractReady` → renders `contract-wait`; when `requiresContract && contractReady` → renders `sign-contract-form`; when `!requiresContract && requiresTos` → ToS step.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:**
  - `ContractWaitScreen.tsx` — centered icon (e.g. `Clock`/`FileClock`) + «Контракт готовится» + «Администратор готовит ваш персональный контракт. Эта страница обновится автоматически, когда контракт будет готов к подписи.» (Russian), `data-testid="contract-wait"`. Include a `<DialogDescription>`-equivalent only if inside a dialog (it is a full-page step, so plain semantic markup).
  - `index.tsx` — in the `contract` branch render `status.contractReady ? <SignContractStep onSuccess=…/> : <ContractWaitScreen/>`. Add `refetchInterval` to the `onboarding-status` query so the wait screen auto-advances:

```ts
const { data: status } = useQuery<OnboardingStatusDto>({
  queryKey: ['onboarding-status'],
  queryFn: async () => (await api.get<OnboardingStatusDto>('/onboarding/status')).data,
  enabled: !!user,
  staleTime: 0,
  // A3-4: poll while waiting for ADMIN to mark the personal contract READY.
  refetchInterval: (q) => {
    const s = q.state.data
    return s && s.requiresContract && !s.contractReady ? 15_000 : false
  },
})
```

- Keep the existing step state machine; the contract step now has two visual modes. Progress-indicator label can stay "Подписать контракт".
- [ ] **Step 4 — run, expect PASS** + eslint.
- [ ] **Step 5 — commit** `feat(web): onboarding "Контракт готовится" wait state + auto-advance poll`.

## Task 6 — E2E: real endpoints + wait path

**Files:** Modify `apps/e2e/tests/onboarding-flow.spec.ts` + `apps/e2e/tests/onboarding-regression-pr110.spec.ts` (and fixtures if they mock the removed `/contracts/preview-pdf`).

- [ ] **Step 1 — update mocks/spec:** replace any mock of the removed `/api/contracts/preview-pdf` with `/api/onboarding/contract/pdf`; ensure `/onboarding/status` mock returns `contractReady`. Add a wait-path case: status `requiresContract:true, contractReady:false` → `contract-wait` visible, no `sign-button`. Happy path: `contractReady:true` → preview loads (mock `/onboarding/contract/pdf`) → sign (mock `/contracts/sign`) → ToS → dashboard.
- [ ] **Step 2 — RUN E2E locally (mandatory — start web first):** `pnpm --filter @crm/web start` (:3000) bg, then `pnpm --filter @crm/e2e exec playwright test tests/onboarding-flow.spec.ts tests/onboarding-regression-pr110.spec.ts` → green, run 2×, zero-flaky.
- [ ] **Step 3 — commit** `test(e2e): onboarding personal-contract real endpoints + wait path`.

## Task 7 — Full verification + handoff

- [ ] **Step 1:** `pnpm typecheck` (4/4) + `pnpm --filter @crm/api --filter @crm/web --filter @crm/shared test` green + `mcp__eslint__lint-files` on all changed.
- [ ] **Step 2:** `pnpm prettier --write` changed files; `--check` clean.
- [ ] **Step 3:** final commit (no `wip:`) with `ac_verified:`; push `feat/a3-4-onboarding-contract`; open PR (base main) + label `ai-review-ready`.

> After push: PM dispatches code-reviewer + **manual-qa on a live stack (mandatory — the mock-guard lesson)**: verify all three states (wait / sign / done) against the real backend, the personal PDF actually renders via `/onboarding/contract/pdf`, and an un-onboarded user is really 403-gated. Security-reviewer not required (no new auth/finance surface; reuses existing sign + guard).

---

## Acceptance Criteria

1. `OnboardingService.requiresContract` is derived from the personal contract's SIGNED state (not the role template); ADMIN bypass intact; backward-compatible for already-SIGNED users.
2. `EmployeeContractsService.hasSignedContract` exists + unit-tested.
3. Onboarding sign step previews the personal contract via `/api/onboarding/contract/pdf` (the removed `/contracts/preview-pdf` call is gone).
4. Three states render correctly: wait («Контракт готовится», no sign button) / sign (preview + sign) / done (→ ToS); wait auto-advances via status poll.
5. Copy references the personal contract (no "MSA"); success toast shows the contract number.
6. Real-backend integration spec covers status + sign + the OnboardingGuard 403; E2E updated to real endpoints incl. wait path, run locally 2× green.
7. typecheck + unit (api/web/shared) + E2E green; manual-QA passed live.

## Self-review notes

- Spec coverage: §4 backend→Tasks 1-2; §5.1 PDF→Task 4; §5.2 states→Task 5; §8 testing→Tasks 3,6,7; §7 edges (wait/legalName/already-signed/admin)→Tasks 2,4,5 + integration. No gaps.
- Consistency: `hasSignedContract`, `requiresContract`, `contractReady`, `contract-wait`, `/onboarding/contract/pdf` used consistently across tasks.
- Refinement logged: ContractPdfPreview reuse rejected (endpoint coupling) — Task 4 fixes the URL in place instead.
- Web tests under `__tests__/`; E2E under existing onboarding specs (CI runs them).
