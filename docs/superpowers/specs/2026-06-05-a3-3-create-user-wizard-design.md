# A3-3 — Multi-step create-user wizard (with contract editor) — design

**Date:** 2026-06-05
**Status:** Design approved (brainstorming), pending spec review → plan
**Depends on:** A3-2 (contract editor components + endpoints, merged 31246bf)
**Branch:** `feat/a3-3-create-wizard` (off main)

---

## 1. Goal

Turn the single-screen create-user form into a guided 3-step wizard that produces a user **and** their contract in one flow: **Данные → Контракт → Подтверждение**. Make `legalFullName` required at creation for contract-eligible users (absorbs old task A2c). Reuse the A3-2 contract editor as-is.

## 2. Approach (decided: create-on-step-1)

The user is **created when leaving step 1** (POST /api/users → returns id); the contract editor in step 2 then operates on that real id (the A3-2 editor is API-coupled to `/api/users/:id/contract`, and the employee_contract lazy-creates on first GET). This reuses the A3-2 editor unchanged. Trade-off accepted: if the wizard is abandoned after step 1, the user already exists (with a DRAFT contract) — findable in the users list, finishable from the profile contract tab.

Scope: refactor **create-mode** of `UserDialog` into the wizard. **Edit-mode is unchanged** (single form).

## 3. Steps

### Step 1 — «Данные»

- The existing create-user form (identity / contacts / tech stack / finance / payment requisites / team assignment), unchanged in content.
- **`legalFullName` becomes required** for contract-eligible non-ADMIN roles (SENIOR/HR/JUNIOR/ACCOUNTANT/DROP) via Zod `superRefine` on `createUserSchema` (absorbs A2c). Field already exists in the dialog (ADMIN-visible for non-ADMIN targets).
- «Далее» → validate → `POST /api/users` → on success store the returned user `id`, advance to step 2. On validation/server error: stay on step 1, show the error (do not advance).

### Step 2 — «Контракт»

- Reuse A3-2 `ContractEditor` + `ContractActionBar` + `useEmployeeContract` on the new user `id`.
- `GET /api/users/:id/contract` lazy-creates the DRAFT; editing auto-saves via PATCH (DRAFT only).
- **No active template for the role** → render the existing no-template empty state («Нет активного шаблона; контракт можно создать позже»); step 2 becomes **skippable** (Далее → step 3 without a contract).
- «Назад» → step 1 in **edit mode** (the user now exists → PATCH `/api/users/:id` for any data fixes). «Далее» → step 3.

### Step 3 — «Подтверждение»

- Summary: which user was created + current contract status (DRAFT / no contract).
- Buttons:
  - **«Сохранить как черновик»** → finish: contract stays DRAFT (already saved), close dialog + success toast + refresh users list.
  - **«Сохранить и отметить готовым к подписи»** → `POST /api/users/:id/contract/ready` (DRAFT → READY_TO_SIGN; participant can then sign), close + toast + refresh. Disabled when there is no contract (no-template case).
- «Назад» → step 2.

## 4. Components

- **Stepper:** minimal new component (no existing one in the codebase) — 3 labelled steps with done/active/upcoming states; lives in the create wizard.
- **Wizard container:** new state in `UserDialog` (create-mode) tracking `currentStep` (1–3), the created user id, and per-step validity. Edit-mode bypasses the wizard.
- **Reuse:** A3-2 `ContractEditor`, `ContractActionBar`, `useEmployeeContract` (step 2); existing create mutation (step 1) + a new edit (PATCH) path for back-navigation.

## 5. Data flow

| Action              | Call                                                           | Result                              |
| ------------------- | -------------------------------------------------------------- | ----------------------------------- |
| Step 1 «Далее»      | `POST /api/users` (`createUserSchema`, legalFullName required) | store new `id` → step 2             |
| Step 2 open         | `GET /api/users/:id/contract`                                  | lazy-create DRAFT; load into editor |
| Step 2 edit         | `PATCH /api/users/:id/contract`                                | auto-save DRAFT                     |
| Step 1 «Назад»-edit | `PATCH /api/users/:id`                                         | update created user                 |
| Step 3 draft finish | (none — already saved)                                         | close + refresh                     |
| Step 3 mark ready   | `POST /api/users/:id/contract/ready`                           | READY_TO_SIGN → close + refresh     |

## 6. Edge cases & error handling

- Step-1 create failure (validation/server) → stay, show error, no advance.
- No active template for role → step 2 skippable; step-3 «Mark Ready» disabled.
- Abandon after step 1 → user persists with DRAFT contract (documented behavior; finishable from profile). Consider a small confirm on close-after-create («Пользователь уже создан; контракт останется черновиком»).
- Back-navigation after creation uses PATCH (no duplicate POST).
- legalFullName missing for contract role → Zod error on step 1 (blocks creation).

## 7. Testing

- **Unit (web):** step navigation (1↔2↔3, advance gated by step-1 success); `legalFullName`-required validation per role; step-3 button enablement (draft vs ready vs no-contract); back-edit uses PATCH.
- **Unit (api/shared):** `createUserSchema` superRefine — legalFullName required for contract roles, optional/absent for others.
- **Integration:** create → GET contract (lazy DRAFT) → PATCH → ready, on the real new id; legalFullName-required rejection.
- **E2E (live-ish, route-mocked + a real-stack pass):** full wizard — fill data → create → edit contract → Mark Ready → user appears with READY_TO_SIGN; no-template path skips contract; back-navigation edits.
- **Manual QA (live, mandatory):** full create→contract→ready flow on a real stack (per feedback_mocked_e2e_guards / feedback_mandatory_user_testing); abandon-after-step-1 behavior.

## 8. Files (high-level)

- `apps/web/app/components/users/UserDialog.tsx` — wizard refactor (create-mode only): step state, Stepper, step-1 form (existing) + legalFullName-required, step-2 contract (reuse A3-2), step-3 confirm.
- New `apps/web/app/components/users/CreateWizardStepper.tsx` (or similar).
- `packages/shared/src/schemas/users.ts` — `createUserSchema` superRefine for legalFullName-required.
- Reuse `apps/web/app/components/user-profile/contract/*` (no changes expected).
- Tests in `apps/web/app/**/__tests__/` (NOT under routes/), api specs, `apps/e2e/tests/`.

## 9. Out of scope

- Edit-mode UserDialog (unchanged).
- Per-project contracts (next feature). Documents/receipts/audit (deferred to end of plan).
