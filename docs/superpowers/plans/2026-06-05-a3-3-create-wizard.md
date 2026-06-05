# A3-3 Create-User Wizard — Implementation Plan

> **For agentic workers:** Implement task-by-task with TDD (test first → fail → implement → pass → commit). Checkbox (`- [ ]`) steps. Spec: `docs/superpowers/specs/2026-06-05-a3-3-create-user-wizard-design.md`.

**Goal:** Refactor create-mode UserDialog into a 3-step wizard (Данные → Контракт → Подтверждение) that creates a user then their contract, reusing the A3-2 editor; make legalFullName required at creation.

**Architecture:** Create-on-step-1 (POST /users → id), then A3-2 contract editor on that id in step 2, finalize in step 3. Mostly frontend + one shared-schema change. Edit-mode UserDialog unchanged.

**Tech Stack:** React + TanStack Form/Query + Zod v4 (web), NestJS (api validation via shared schema), Vitest, Playwright. Russian UI.

**Branch:** `feat/a3-3-create-wizard` (off main 31246bf). Chunked wip pushes, final `ac_verified:`.

---

## File structure

- `packages/shared/src/schemas/users.ts` — `createUserSchema` superRefine: legalFullName required for contract roles.
- `apps/web/app/components/users/CreateWizardStepper.tsx` (new) — step indicator.
- `apps/web/app/components/users/UserDialog.tsx` — wizard state + 3 steps (create-mode only).
- `apps/web/app/components/users/__tests__/*.test.tsx` — web unit (NOT under routes/).
- Reuse `apps/web/app/components/user-profile/contract/*` (no changes).
- `apps/e2e/tests/crm/create-wizard.spec.ts` (new) — E2E in tests/crm/ so the misc CI shard runs it.

> Regression guards: web tests in `__tests__/` only (TSR auto-discovery); E2E under `tests/crm/` so CI runs it (the `misc` shard globs `tests/crm`).

## Task 1 — legalFullName required at create (shared schema)

**Files:** Modify `packages/shared/src/schemas/users.ts`; Test `packages/shared/src/schemas/__tests__/users.spec.ts` (or existing users schema test).

- [ ] **Step 1 — failing test:** `createUserSchema.safeParse` fails when `role` ∈ {SENIOR,HR,JUNIOR,ACCOUNTANT,DROP} and `legalFullName` is missing/blank; passes when present; (ADMIN can't be created — already forbidden). Assert the issue path = `legalFullName`.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** add `.superRefine((val, ctx) => { if (CONTRACT_ROLES.has(val.role) && !val.legalFullName?.trim()) ctx.addIssue({ path:['legalFullName'], code:'custom', message:'ФИО обязательно для контракта' }) })` to `createUserSchema`. Keep field `.optional()` at type level; superRefine enforces conditionally.
- [ ] **Step 4 — run, expect PASS.** `pnpm --filter @crm/shared test` green.
- [ ] **Step 5 — commit** `feat(shared): require legalFullName at create for contract roles (A2c)`.

## Task 2 — Stepper component

**Files:** Create `apps/web/app/components/users/CreateWizardStepper.tsx` + `__tests__/CreateWizardStepper.test.tsx`.

- [ ] **Step 1 — failing test:** renders 3 labelled steps (Данные/Контракт/Подтверждение); marks current as active, earlier as done; `data-testid="wizard-step-{n}"` with `data-state` = done|active|upcoming.
- [ ] **Step 2 — run, expect FAIL** (`pnpm --filter @crm/web test -- CreateWizardStepper`).
- [ ] **Step 3 — implement** the stepper (props: `current: 1|2|3`); shadcn/Tailwind tokens; Russian labels; use `frontend-design` skill for polish.
- [ ] **Step 4 — run, expect PASS** + `mcp__eslint__lint-files`.
- [ ] **Step 5 — commit** `feat(web): create-wizard stepper component`.

## Task 3 — Wizard shell + Step 1 (data → create)

**Files:** Modify `apps/web/app/components/users/UserDialog.tsx`; Test `__tests__/UserDialog.create-wizard.test.tsx`.

- [ ] **Step 1 — failing test:** in create-mode, dialog shows the Stepper at step 1 + the existing form; «Далее» with valid data calls `POST /api/users` (mock) and on success advances to step 2 storing the returned id; on error stays at step 1 showing the error; legalFullName-missing (contract role) blocks. Edit-mode renders the single form (no wizard).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** add `currentStep` + `createdUserId` state (create-mode only); render Stepper; step 1 = existing form; «Далее» button submits the create mutation; onSuccess → store `id` + `setCurrentStep(2)` (do NOT close); onError → stay. Edit-mode bypasses wizard.
- [ ] **Step 4 — run, expect PASS** + eslint.
- [ ] **Step 5 — commit** `feat(web): create wizard shell + step 1 (data → POST /users → advance)`.

## Task 4 — Step 2 (contract editor on new id)

**Files:** Modify `UserDialog.tsx`; Test same/new spec.

- [ ] **Step 1 — failing test:** at step 2, renders the A3-2 contract editor for `createdUserId` (mock `GET /api/users/:id/contract` → DRAFT); «Назад» returns to step 1 (edit mode), «Далее» → step 3; when `GET /contract` is 404 (no template), shows the no-template empty state and «Далее» still advances (skippable).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** step 2 mounts `ContractEditor`/`ContractActionBar` (from `components/user-profile/contract/`) with `userId={createdUserId}`; reuse `useEmployeeContract`; auto-save PATCH on edit; handle 404 → empty state + allow skip; «Назад» → step 1 where the form now PATCHes (`/api/users/:id`) instead of POST.
- [ ] **Step 4 — run, expect PASS** + eslint.
- [ ] **Step 5 — commit** `feat(web): wizard step 2 — contract editor on created user`.

## Task 5 — Step 3 (confirm + finalize)

**Files:** Modify `UserDialog.tsx`; Test same/new spec.

- [ ] **Step 1 — failing test:** step 3 shows a summary + two buttons. «Сохранить как черновик» closes (no extra call) + fires onClose/refresh; «Сохранить и отметить готовым к подписи» calls `POST /api/users/:id/contract/ready` (mock) then closes; the ready button is disabled when there is no contract (no-template case); «Назад» → step 2.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** step 3 summary (created user + contract status); wire the two finalize buttons (draft = close+toast+invalidate users; ready = POST /ready then close+toast+invalidate); disable ready when no contract; «Назад».
- [ ] **Step 4 — run, expect PASS** + eslint.
- [ ] **Step 5 — commit** `feat(web): wizard step 3 — confirm (save draft / mark ready)`.

## Task 6 — E2E + verification

**Files:** Create `apps/e2e/tests/crm/create-wizard.spec.ts`.

- [ ] **Step 1 — E2E (route-mocked, per existing pattern):** ADMIN opens «Новый пользователь» → step 1 fill (incl legalFullName) → «Далее» (mock POST /users → id) → step 2 editor loads (mock GET/PATCH contract) → «Далее» → step 3 → «Сохранить и отметить готовым» (mock POST /ready) → dialog closes, success toast. Plus: legalFullName-missing blocks step 1; no-template path skips step 2.
- [ ] **Step 2 — RUN E2E LOCALLY (mandatory — start web first):** `pnpm --filter @crm/web start` (:3000) in background, then `pnpm --filter @crm/e2e exec playwright test tests/crm/create-wizard.spec.ts` → all green, run 2×, zero-flaky. (playwright.config has NO webServer — start :3000 yourself.)
- [ ] **Step 3 — full verification:** `pnpm typecheck` + `pnpm --filter @crm/shared --filter @crm/api --filter @crm/web test` + the new E2E all green. `mcp__eslint__lint-files` on all changed.
- [ ] **Step 4 — commit** `test(e2e): create-user wizard happy path` with `ac_verified:`.
- [ ] **Step 5 — push** `feat/a3-3-create-wizard`, open PR, label `ai-review-ready`.

> After push: PM dispatches code-reviewer + manual-qa (live stack, mandatory). Security-reviewer not needed (no new auth/finance surface; reuses A3-2 contract endpoints).

---

## Acceptance Criteria

1. Create-mode UserDialog is a 3-step wizard (Данные → Контракт → Подтверждение) with a Stepper; edit-mode unchanged.
2. Step 1 «Далее» creates the user (POST /users) and advances with the new id; errors keep you on step 1.
3. legalFullName required at create for contract roles (shared superRefine, enforced api+web).
4. Step 2 reuses the A3-2 editor on the new id (lazy DRAFT, auto-save); no-template → skippable empty state.
5. Step 3 «Сохранить как черновик» finishes (DRAFT); «Сохранить и отметить готовым» → POST /ready; ready disabled when no contract.
6. «Назад» after creation edits via PATCH (no duplicate POST).
7. Unit (shared + web) + E2E green; E2E run locally; manual QA passed live.

## Self-review notes

- Spec coverage: §3 steps→Tasks 3–5; §legalFullName→Task 1; Stepper→Task 2; §6 edges (no-template/back/error)→Tasks 3–5; §7 testing→Task 6. No gaps.
- No placeholders; `createdUserId`, `currentStep`, `CONTRACT_ROLES` consistent across tasks.
- Web tests in `__tests__/`; E2E in `tests/crm/` (CI misc shard runs it).
