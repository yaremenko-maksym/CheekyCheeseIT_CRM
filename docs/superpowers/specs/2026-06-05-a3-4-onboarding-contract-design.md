# A3-4 — Onboarding signs the personal contract — design

**Date:** 2026-06-05
**Status:** Design approved (brainstorming), pending spec review → plan
**Depends on:** A3-1 (per-employee contract backend + `/api/onboarding/contract` + `contractReady`), A3-2 (ADMIN editor + `ContractPdfPreview`), A3-3 (create wizard). All merged.
**Branch:** `feat/a3-4-onboarding-contract` (off main 6109a17)

---

## 1. Goal

Make the onboarding **contract step** operate on the new-employee's **personal** `employee_contract` (DRAFT → READY_TO_SIGN → SIGNED) instead of the legacy role-template flow, and add a **"Контракт готовится"** wait state when no `READY_TO_SIGN` contract exists yet. This finishes the A3 series: ADMIN prepares the personal contract (A3-2/A3-3) → the employee reviews & signs it during onboarding (A3-4).

## 2. Background — current state (what's broken / misaligned)

The **backend sign path already uses the personal contract**: `POST /api/contracts/sign` → `SignedContractsService.sign()` → `EmployeeContractsService.getReadyForSigning()` transitions the user's `READY_TO_SIGN` `employee_contract` → `SIGNED` (409 `CONTRACT_NOT_READY` if none ready). `/api/onboarding/contract` + `/pdf` (self, bypass-listed) and `OnboardingStatusDto.contractReady` already exist (A3-1).

The **onboarding frontend lagged behind**:

1. **Broken PDF preview.** `SignContractStep` fetches `GET /api/contracts/preview-pdf`, an endpoint **deleted in A3-1**. On a real stack this 404s → the step shows "Не удалось загрузить предварительный просмотр контракта" and signing is blocked. The breakage is masked by route-mocked E2E (the `feedback_mocked_e2e_guards` lesson — mocks return 200 for a route the real backend no longer serves).
2. **Wrong gate.** `OnboardingService.getStatus.requiresContract` is computed from the **role template** (active template exists AND no `signed_contracts` row for it), not from the personal contract. So the step shows/hides based on the template, while signing acts on the personal contract — a mismatch.
3. **No wait state.** If a contract-role user has no `READY_TO_SIGN` personal contract (ADMIN hasn't prepared/marked it), the UI would push them at a sign action that 409s. There is no "contract being prepared" screen.
4. **Stale copy.** The step says "MSA-контракт"; it should reference the personal contract + its number (CHK-…).

## 3. Approach (decided)

Align the onboarding contract step end-to-end with the **personal** `employee_contract`. Do **not** touch the already-correct `sign()` backend path. Redefine the contract gate off the personal contract's `SIGNED` state and drive a three-state UI from `requiresContract` + `contractReady`.

Decided in brainstorming:

- **Scope:** sign the personal contract in onboarding (not just preview; not the broader profile-fields gating).
- **No ready contract → block** with a "Контракт готовится" wait screen (do not enter CRM, do not fall back to the role template).

## 4. Backend — `OnboardingService.getStatus`

Redefine the contract requirement around the personal contract:

- **`requiresContract`** = user is a non-ADMIN contract-eligible role AND has **no `SIGNED`** `employee_contract`. (Replaces the role-template `signed_contracts` check.)
- **`contractReady`** (already present) = user has a `READY_TO_SIGN` `employee_contract`.

This yields three derivable states for any non-ADMIN contract-role user:

| `requiresContract` | `contractReady` | Meaning                                           | UI                                   |
| ------------------ | --------------- | ------------------------------------------------- | ------------------------------------ |
| `true`             | `false`         | personal contract not yet ready (ADMIN preparing) | **Wait screen** «Контракт готовится» |
| `true`             | `true`          | personal contract READY_TO_SIGN                   | **Sign step** (preview + sign)       |
| `false`            | —               | personal contract already SIGNED                  | contract step **done** → ToS         |

**Backward compatibility:** the 17 already-onboarded users have `SIGNED` personal contracts (A3-1 migration) → `requiresContract=false` → unaffected.

- `contractTemplate` in the DTO becomes unused by the contract step (the personal PDF replaces template rendering). Leave the field in place (out of scope to remove; the ToS/template admin surfaces still use templates). Note it as a follow-up cleanup candidate.
- `OnboardingGuard` already bypasses `/api/onboarding/contract*` and `/api/contracts/sign` — **no guard change**. The guard delegates to `getStatus`; once `requiresContract` keys off the personal contract, the guard's gate follows automatically.
- `sign()` / `getReadyForSigning()` — **unchanged** (already correct).

Add an explicit `OnboardingStatusDto` field only if needed for clarity; preferred minimal change is to reuse `requiresContract` + `contractReady` (no shared-schema field addition). Decide during planning after re-reading `onboarding.ts`.

## 5. Frontend — `SignContractStep` + `routes/crm/onboarding/index.tsx`

### 5.1 PDF preview source

Replace the deleted `GET /api/contracts/preview-pdf` with **`GET /api/onboarding/contract/pdf`** (personal, self, bypass-listed). Prefer reusing the A3-1/A3-2 `ContractPdfPreview` component (already handles blob fetch + AbortController + download button + error state) instead of the hand-rolled iframe block, to keep one PDF-preview implementation.

### 5.2 Three-state contract step

Driven by `status.requiresContract` + `status.contractReady`:

- **Wait — «Контракт готовится»** (`requiresContract && !contractReady`): a dedicated screen (icon + heading + explanation that ADMIN is preparing the contract), **no sign button** (so no 409), and a background refetch of `/onboarding/status` (interval poll, e.g. 15s, or refetch-on-focus) so the user advances automatically once ADMIN marks it READY.
- **Sign** (`requiresContract && contractReady`): the current sign UI but with the personal PDF, the existing confirm-checkbox + read-only signature block + `legalFullName` guard, and `POST /api/contracts/sign`.
- **Done** (`!requiresContract`): skip contract → ToS step (existing orchestration in `index.tsx`).

`index.tsx` step orchestration already routes `contract` vs `tos` from status; extend the `contract` branch to render Wait vs Sign based on `contractReady`.

### 5.3 Copy

Replace "MSA-контракт" wording with "персональный контракт"; on success keep the toast with the contract number (`CHK-…`, already returned by `sign()`).

## 6. Data flow

| Action            | Call                                    | Result                                                           |
| ----------------- | --------------------------------------- | ---------------------------------------------------------------- |
| Onboarding load   | `GET /api/onboarding/status`            | `requiresContract` + `contractReady` → pick state                |
| Sign-step preview | `GET /api/onboarding/contract/pdf`      | personal unsigned PDF in viewer                                  |
| Wait-screen poll  | `GET /api/onboarding/status` (interval) | auto-advance when `contractReady` flips true                     |
| Sign              | `POST /api/contracts/sign`              | READY_TO_SIGN → SIGNED; toast w/ number; invalidate status → ToS |

## 7. Edge cases & error handling

- **No READY_TO_SIGN contract** → Wait screen (decided). No sign button, no 409.
- **`legalFullName` missing** → keep the existing destructive alert + disabled sign (sign would 422 `LEGAL_NAME_REQUIRED`).
- **Already SIGNED (re-entry)** → `requiresContract=false` → contract step skipped → ToS/done.
- **ADMIN** → guard bypass; onboarding never shown.
- **PDF fetch fails** (network) → existing error state ("обратитесь к администратору").
- **ADMIN reverts SIGNED→DRAFT after onboarding** (A3-2 revert) → deletes ToS acceptances + clears link → `requiresContract` true again → user re-onboards (Wait until re-marked READY). Confirm this path still coheres.

## 8. Testing

- **Unit (api):** `getStatus` — `requiresContract` true/false by personal-contract SIGNED state; `contractReady` passthrough; ADMIN bypass; the three-state matrix.
- **Integration (api, real backend — not mocked):** un-onboarded contract-role user → status reflects wait vs ready vs signed; `/api/onboarding/contract/pdf` returns PDF for self mid-onboarding (guard bypass); `POST /contracts/sign` from READY_TO_SIGN → SIGNED → status flips. Explicitly covers the guard (the `feedback_mocked_e2e_guards` gap).
- **Unit (web):** SignContractStep renders Wait vs Sign vs nothing by `requiresContract`/`contractReady`; preview hits `/onboarding/contract/pdf`; sign posts `/contracts/sign`; `legalFullName`-missing disables sign.
- **E2E (real endpoints, not stale mocks):** full onboarding — ready → preview loads (real `/onboarding/contract/pdf`) → sign → ToS → dashboard; wait-state path (no READY contract) shows «Контракт готовится» and no sign button. Update `onboarding-flow.spec.ts` + `onboarding-regression-pr110.spec.ts` to the real endpoints.
- **Manual QA (live stack, mandatory):** all three states on a real backend (per `feedback_mandatory_user_testing` + `feedback_mocked_e2e_guards`); revert→re-onboard path.

## 9. Files (high-level)

- `apps/api/src/onboarding/onboarding.service.ts` — `requiresContract` from personal contract SIGNED state; `.spec.ts` updated.
- `apps/api/src/onboarding/onboarding.service.spec.ts` + a real-backend integration spec (status + sign + guard).
- `packages/shared/src/schemas/onboarding.ts` — only if an explicit field is added (prefer none).
- `apps/web/app/components/onboarding/SignContractStep.tsx` — personal PDF source (reuse `ContractPdfPreview`), wait state, copy.
- `apps/web/app/routes/crm/onboarding/index.tsx` — contract branch renders Wait vs Sign by `contractReady`.
- `apps/e2e/tests/onboarding-flow.spec.ts`, `onboarding-regression-pr110.spec.ts` — real endpoints + wait-state coverage.

## 10. Out of scope

- Profile required-fields gating (USDT wallet etc.) in onboarding — not this feature.
- Per-project contracts (next feature).
- Documents/receipts/audit (deferred to end of plan).
- Removing the now-unused `contractTemplate` status field / legacy template preview — follow-up cleanup, not A3-4.
