# A3-2 ADMIN Contract Editor — Implementation Plan

> **For agentic workers:** Implement task-by-task with TDD (test first → fail → implement → pass → commit). Steps use checkbox (`- [ ]`) syntax. Spec: `docs/superpowers/specs/2026-06-05-a3-2-admin-contract-editor-design.md`.

**Goal:** Give ADMIN a per-employee contract editor (new profile tab) over the A3-1 endpoints, and harden the contract module so the lifecycle invariants are enforced server-side.

**Architecture:** Frontend — a new ADMIN-only `contract` tab in `UserProfileShell` rendering a split markdown-editor / backend-PDF-preview with status-aware actions. Backend — four targeted hardening changes in `apps/api/src/contracts/` closing #116 review MEDs.

**Tech Stack:** NestJS 11 + Drizzle (api), React + Vite + TanStack Router/Query + Zod v4 (web), Vitest (unit), Playwright (E2E). All UI text in Russian.

**Branch:** `feat/a3-2-admin-contract-editor` (off `main` @ `dfe5e4a`). Conventional commits, chunked wip pushes, final commit with `ac_verified:`.

---

## File structure

**Backend (`apps/api/src/contracts/`):**

- `employee-contracts.service.ts` — `updateBody` DRAFT-only (MED#2); `revert` in a transaction (MED#1).
- `signed-contracts.service.ts` — move snapshot read inside `sign()` tx (MED#3).
- `contract-filename.util.ts` (new) — `safeContractFilename(displayName, status)` helper + RFC 5987.
- `employee-contracts.controller.ts`, `onboarding-contract.controller.ts` — use the helper.
- `*.spec.ts` siblings for each.

**Frontend (`apps/web/app/`):**

- `routes/crm/profile/$userId.tsx` — add `'contract'` to the tab enum.
- `components/user-profile/UserProfileShell.tsx` — register ADMIN-only `contract` tab.
- `components/user-profile/contract/` (new): `ContractTab.tsx`, `ContractEditor.tsx`, `ContractPdfPreview.tsx`, `ContractActionBar.tsx`, `useEmployeeContract.ts` (query+mutations).
- `components/user-profile/contract/__tests__/*.test.tsx` — web unit tests (NOT under `routes/`).

> Regression guard: web test files go in `__tests__/`, NEVER under `apps/web/app/routes/` (TanStack Router auto-discovers route files → build break, see #115/#117).

---

## Task 1: Backend MED#2 — `updateBody` editable only in DRAFT

**Files:** Modify `apps/api/src/contracts/employee-contracts.service.ts`; Test `apps/api/src/contracts/employee-contracts.service.spec.ts`.

- [ ] **Step 1 — failing test:** add a test that `updateBody` throws `ConflictException` (409) when the contract status is `READY_TO_SIGN` and when `SIGNED`, and still succeeds in `DRAFT`. Assert the error code/message `CONTRACT_NOT_EDITABLE`.
- [ ] **Step 2 — run, expect FAIL** (`pnpm --filter @crm/api exec vitest run src/contracts/employee-contracts.service.spec.ts`).
- [ ] **Step 3 — implement:** in `updateBody`, after loading the contract, `if (contract.status !== 'DRAFT') throw new ConflictException('CONTRACT_NOT_EDITABLE')`. Remove the previous allowance of `READY_TO_SIGN`.
- [ ] **Step 4 — run, expect PASS.** Update the controller doc-comment in `employee-contracts.controller.ts` (PATCH now DRAFT-only).
- [ ] **Step 5 — commit** `fix(api): employee contract body editable only in DRAFT (close MED#2)`.

## Task 2: Backend MED#1 — atomic `revert()`

**Files:** Modify `employee-contracts.service.ts`; Test same spec.

- [ ] **Step 1 — failing test:** test that when reverting a `SIGNED` contract, both the `employee_contracts` UPDATE (→DRAFT, signedContractId=null) and the `tos_acceptances` DELETE happen; and that they run in one `db.transaction` (simulate the delete throwing → status must remain unchanged / rolled back). Use the existing DB-mock pattern in the spec.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** wrap the UPDATE + conditional `tos_acceptances` DELETE in `this.db.db.transaction(async (tx) => { ... })`, using `tx` for both writes; return the updated row.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `fix(api): revert employee contract in a single transaction (close MED#1)`.

## Task 3: Backend MED#3 — `sign()` snapshot inside tx

**Files:** Modify `apps/api/src/contracts/signed-contracts.service.ts`; Test `signed-contracts.service.spec.ts`.

- [ ] **Step 1 — failing test:** assert `sign()` reads the READY_TO_SIGN contract snapshot **inside** the transaction (the inserted `signed_contracts.bodyMarkdownSnapshot` matches the contract body read within the same tx; `markSigned` re-check still 409s if status changed). Adapt existing sign tests.
- [ ] **Step 2 — run, expect FAIL** (or refactor existing test to assert ordering).
- [ ] **Step 3 — implement:** move `getReadyForSigning(userId)` from before `db.transaction(...)` to inside the tx callback (after `tx.query.users.findFirst`), using `tx`. Keep the `markSigned` re-check.
- [ ] **Step 4 — run, expect PASS.** Confirm full sign happy-path test still green.
- [ ] **Step 5 — commit** `fix(api): read sign snapshot inside transaction (close MED#3)`.

## Task 4: Backend — safe PDF filename helper

**Files:** Create `apps/api/src/contracts/contract-filename.util.ts` + `contract-filename.util.spec.ts`; Modify `employee-contracts.controller.ts`, `onboarding-contract.controller.ts`.

- [ ] **Step 1 — failing test:** `safeContractFilename('Иван "Quote"\nИванов', 'SIGNED')` → ASCII-safe `filename` (no quotes/newlines, only `[A-Za-z0-9._-]`) AND an RFC 5987 `filename*` UTF-8 form for the original. Test empty/edge names.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the helper returning `{ asciiName, contentDisposition }` (`inline; filename="<ascii>"; filename*=UTF-8''<percent-encoded>`).
- [ ] **Step 4 — implement usage:** replace the inline filename interpolation in both controllers' `Content-Disposition` with the helper.
- [ ] **Step 5 — run unit + boot check** (`pnpm --filter @crm/api build && node dist/main` → `curl /api/health` 200) to confirm no DI/boot regression.
- [ ] **Step 6 — commit** `fix(api): sanitize contract PDF filename (RFC 5987)`.

## Task 5: Frontend — data hooks

**Files:** Create `apps/web/app/components/user-profile/contract/useEmployeeContract.ts` + `__tests__/useEmployeeContract.test.tsx`.

- [ ] **Step 1 — failing test:** test the query key + a pure helper `contractActionState(status)` returning `{ editable, showSave, showMarkReady, showReset, showRevert, revertDestructive }` for each status (`DRAFT`/`READY_TO_SIGN`/`SIGNED`).
- [ ] **Step 2 — run, expect FAIL** (`pnpm --filter @crm/web test -- useEmployeeContract`).
- [ ] **Step 3 — implement:** `contractActionState` per the §4 matrix in the spec; a `useEmployeeContract(userId)` query (`GET /api/users/:id/contract`) and mutations `useSaveBody` (PATCH), `useMarkReady`, `useRevert`, `useReset`, all invalidating the contract query; a `useContractPdf(userId)` that fetches the PDF blob on demand. Import types from `@crm/shared`.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(web): employee-contract query/mutation hooks + action-state helper`.

## Task 6: Frontend — editor / preview / action bar components

**Files:** Create `ContractEditor.tsx`, `ContractPdfPreview.tsx`, `ContractActionBar.tsx` in `components/user-profile/contract/`.

- [ ] **Step 1 — failing test (action bar):** render `ContractActionBar` with each status; assert the right buttons appear and that in non-DRAFT the editor is read-only (drive via `contractActionState`). Confirm dialog appears for SIGNED revert.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:**
  - `ContractEditor` — lazy CodeMirror (reuse loader from `routes/crm/admin/templates/contracts.$role.tsx`), `readOnly` when `!editable`, variables hint via `CONTRACT_VARIABLE_DESCRIPTIONS_BRACED`.
  - `ContractPdfPreview` — reuse the A2a PDF viewer component (locate under `apps/web/app/components/**`); «Обновить превью» button disabled while dirty with hint «Сначала сохраните».
  - `ContractActionBar` — status-aware buttons wired to the Task 5 mutations; SIGNED-revert behind a confirm dialog «Сбросит подписанный контракт и онбординг участника. Продолжить?».
  - Use `frontend-design` skill for polish; follow shadcn/Tailwind tokens; Russian text.
- [ ] **Step 4 — run, expect PASS** + `mcp__eslint__lint-files` on new files.
- [ ] **Step 5 — commit** `feat(web): contract editor, PDF preview, status-aware action bar`.

## Task 7: Frontend — register the ADMIN-only `contract` tab

**Files:** Modify `routes/crm/profile/$userId.tsx` (tab enum), `components/user-profile/UserProfileShell.tsx`; Create `ContractTab.tsx`.

- [ ] **Step 1 — failing test:** test that the `contract` tab is present for an ADMIN viewer and absent for a non-ADMIN viewer, and absent when the target user is ADMIN. (Render `UserProfileShell` with mocked auth/user.)
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** add `'contract'` to the `searchSchema` tab enum in `$userId.tsx`; in `UserProfileShell`, conditionally include the `contract` tab when `viewer.role === 'ADMIN' && target.role !== 'ADMIN'`; `ContractTab` composes editor+preview+action bar + the status badge + no-template empty state (link to `/crm/admin/templates/contracts.$role`).
- [ ] **Step 4 — run, expect PASS** + eslint.
- [ ] **Step 5 — commit** `feat(web): ADMIN-only contract tab in user profile`.

## Task 8: Frontend — dirty guard + edge states

**Files:** Modify `ContractTab.tsx` / hooks; tests in `__tests__/`.

- [ ] **Step 1 — failing test:** unsaved-changes guard fires on tab change/navigation when dirty; no-template (404) renders the empty state; PDF 429 surfaces the throttle toast.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the dirty guard (block tab switch / route leave with a confirm), 404→empty state, 429→toast, generic mutation error→toast (Russian).
- [ ] **Step 4 — run, expect PASS** + eslint.
- [ ] **Step 5 — commit** `feat(web): contract tab dirty-guard and edge-state handling`.

## Task 9: E2E + verification

**Files:** Create `apps/e2e/tests/contract-editor.spec.ts`.

- [ ] **Step 1 — write E2E (real stack):** ADMIN logs in → opens a SENIOR user's profile → `contract` tab → edits body → Save → Mark Ready (editor locks, Save hidden) → Revert (editor unlocks) → «Обновить превью» shows a PDF. Assert non-ADMIN never sees the tab. Use `data-testid`s; follow `playwright-patterns` skill; seeded `dmytro.marchenko@cheekycheese.dev`.
- [ ] **Step 2 — run locally against a real booted stack** (`pnpm --filter @crm/e2e exec playwright test contract-editor`), zero-flaky.
- [ ] **Step 3 — full verification:** `pnpm typecheck` + `pnpm --filter @crm/api test` + `pnpm --filter @crm/web test` all green; real API boots (`node dist/main` + `/api/health`).
- [ ] **Step 4 — commit** `test(e2e): ADMIN contract editor happy path` with `ac_verified:` covering all ACs.
- [ ] **Step 5 — push** `feat/a3-2-admin-contract-editor`, open PR, label `ai-review-ready`.

> After push: PM dispatches code-reviewer + (auth/finance? no — but contracts touch onboarding) security-reviewer, and **manual-qa on the live stack** (mandatory — mocked tests miss guard/boot behavior).

---

## Acceptance Criteria

1. ADMIN-only `contract` tab at `/crm/profile/$userId?tab=contract`; hidden for non-ADMIN and for ADMIN targets.
2. Editor loads/saves body (lazy-create DRAFT on open); Save = PATCH.
3. Mark Ready / Revert / Reset wired to endpoints; status-aware buttons per §4 matrix.
4. Editor frozen in READY_TO_SIGN/SIGNED (UI) **and** backend rejects PATCH outside DRAFT (MED#2).
5. `revert()` atomic (MED#1); `sign()` snapshot inside tx (MED#3); PDF filename sanitized.
6. PDF preview = real backend PDF; refresh disabled while dirty.
7. Edge states: no-template empty state, dirty guard, PDF throttle toast.
8. Unit (web + api per MED) + E2E happy-path green; real API boots; manual QA passed.

## Self-review notes

- Spec coverage: §2 entry→Task 7; §3 layout→Tasks 6–7; §4 lifecycle→Tasks 5–6; §5 data flow→Task 5; §6 hardening→Tasks 1–4; §7 edges→Task 8; §9 testing→Tasks 1–9. No gaps.
- No placeholders; type names (`contractActionState`, hook names) consistent across Tasks 5–8.
- Web test files in `__tests__/` only (regression guard).
