# Documents PR-2 — Unified list + status badges — Implementation Plan

> **For agentic workers:** TDD task-by-task (test → red → implement → green → commit). Checkbox steps. Spec: `docs/superpowers/specs/2026-06-05-documents-redesign-design.md` §4. Builds on PR-1 (merged 5f93c0a): `DocumentRow`/`DocumentCard`, view toggle.

**Goal:** Make `/crm/documents` the single home for all docs — uploaded files **plus** the canonical per-employee contract as a virtual entry — each with a clear status badge (contract / invoice / receipt), preserving existing RBAC. Adds a type filter and folds in the PR-1 cosmetic MED (list-mode loading skeleton).

**Architecture:** Extend the existing `documents.service.list()` to (a) attach a semantic `statusBadge` to invoice/receipt file rows (derived from the linked transaction + `invoice_signatures`), and (b) append the user's `employee_contracts` as virtual "contract" entries with their status. Backend sends semantic `{kind,state}`; frontend owns the Russian labels + tone. No new tables.

**Tech Stack:** NestJS + Drizzle (api), Zod v4 (shared), React + TanStack Query (web), Vitest, Playwright. Russian UI.

**Branch:** `feat/documents-pr2` (off main 5f93c0a). Chunked `wip:` pushes; final `ac_verified:`.

---

## Data sources (grounded against live schema)

- **Contract badge:** `employee_contracts.status` → `DRAFT`→«Драфт», `READY_TO_SIGN`→«Готово к подписи», `SIGNED`→«Подписано»; `CANCELLED` → entry hidden.
- **Invoice badge:** a `transactions` row with `invoice_document_id`; signatures in `invoice_signatures` (signer roles COMPANY + COUNTERPARTY). Both present → «Подписано»; any missing → «Готово к подписи». (`DocumentDto.invoicePendingSignature` already exists — reuse/align.)
- **Receipt badge:** the `transactions` row linked via `receipt_document_id`; `status` PENDING→«Требует подтверждения», VALIDATED→«Подтверждено», REJECTED→«Требует подтверждения».
- **Uploaded file (RESUME/SCAN, plain CONTRACT upload):** no badge.

> Read first: `apps/api/src/documents/documents.service.ts` (`list()`, `buildListWhere()`, the DTO mapping incl. the existing INVOICE `CASE` + `invoicePendingSignature`), `packages/shared/src/schemas/documents.ts`, `packages/shared/src/schemas/invoices.ts`, `apps/api/src/contracts/employee-contracts.service.ts`.

## Task 1 — Shared `DocumentDto.statusBadge`

**Files:** `packages/shared/src/schemas/documents.ts` (+ spec).

- [ ] **Step 1 — failing test:** `documentDtoSchema` accepts optional `statusBadge: { kind: 'contract'|'invoice'|'receipt', state: 'draft'|'ready'|'signed'|'pending'|'validated' } | null`; a virtual contract entry shape (kind discriminator on the document, e.g. `source: 'file'|'employee_contract'`).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** add `statusBadgeSchema` (the discriminated `{kind,state}`) + `statusBadge` (nullable optional) + `source` discriminator to `documentDtoSchema`. Keep `invoicePendingSignature` (or supersede it by `statusBadge` for invoices — pick one; document the choice; if superseding, remove `invoicePendingSignature` usages).
- [ ] **Step 4 — run, expect PASS** (`pnpm --filter @crm/shared test`).
- [ ] **Step 5 — commit** `feat(shared): DocumentDto.statusBadge + source discriminator`.

## Task 2 — Backend: badges + employee_contracts virtual entries in `list()`

**Files:** `apps/api/src/documents/documents.service.ts` (+ `.spec.ts`); new/extended integration spec.

- [ ] **Step 1 — failing tests (unit, mock db):** `list()` returns (a) INVOICE rows with `statusBadge {kind:'invoice', state:'signed'|'ready'}` from `invoice_signatures` completeness; (b) RECEIPT rows with `{kind:'receipt', state}` from the linked transaction status; (c) the actor's `employee_contracts` (non-CANCELLED) as virtual entries `source:'employee_contract'`, `statusBadge {kind:'contract', state}`; (d) RESUME/SCAN → `statusBadge: null`. RBAC preserved (a SENIOR sees only own; ADMIN sees per existing rules).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** in `list()` after building file rows: join/lookup invoice signatures (both-roles-present → signed) for INVOICE rows; lookup linked transaction status for RECEIPT rows; append employee_contracts (via `EmployeeContractsService` or a direct query) as virtual entries respecting the same owner/RBAC as A3 (ADMIN + owner). Ensure **no double-count**: uploaded CONTRACT files stay separate from the employee_contract virtual entry. Keep `buildListWhere` RBAC intact.
- [ ] **Step 4 — run, expect PASS** + `mcp__eslint__lint-files`.
- [ ] **Step 5 — commit** `feat(api): documents list — status badges + employee_contract virtual entries`.

## Task 3 — Integration spec (real routes/RBAC)

**Files:** new `apps/api/src/documents/documents-unified.integration.spec.ts` (DB-skip-guard per A3-4 lesson).

- [ ] **Step 1 — tests (real Nest app + DB):** `GET /api/documents` for ADMIN vs SENIOR vs ACCOUNTANT → correct entries + badges + RBAC visibility; invoice badge reflects `invoice_signatures`; receipt badge reflects transaction status; contract virtual entry present with right status; CANCELLED contract hidden.
- [ ] **Step 2-4 — run red → ensure green → commit** `test(api): documents unified list + badges integration (DB-skip-guard)`.

## Task 4 — Frontend: badge UI + type filter + skeleton fix

**Files:** new `apps/web/app/components/documents/DocumentStatusBadge.tsx`; modify `DocumentRow.tsx` + `DocumentCard.tsx` (render badge), `routes/crm/documents/index.tsx` (type filter incl. contract/invoice/receipt/resume/scan; list-mode loading skeleton). Tests in `__tests__/`.

- [ ] **Step 1 — failing tests (web unit):** `DocumentStatusBadge` maps each `{kind,state}` → correct Russian label + tone (contract draft/ready/signed; invoice ready/signed; receipt pending/validated); `DocumentRow`/`DocumentCard` render it; documents page type-filter filters by kind; list-mode loading shows a **row** skeleton (not the grid skeleton — PR-1 MED).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** `DocumentStatusBadge` (shadcn Badge + tone per state); render in Row + Card; extend the existing filter with the type/kind options; fix the list loading skeleton to a row shape. Reuse existing search/filter wiring.
- [ ] **Step 4 — run, expect PASS** + eslint.
- [ ] **Step 5 — commit** `feat(web): document status badges + type filter + list skeleton`.

## Task 5 — E2E + full verification

**Files:** extend `apps/e2e/tests/crm/documents*.spec.ts` (or the PR-1 spec).

- [ ] **Step 1 — E2E (route-mocked + real-ish):** documents list shows badges per type (contract/invoice/receipt); employee_contract virtual entry visible with status; type filter works; both list & grid render badges; uploaded files have no badge.
- [ ] **Step 2 — RUN E2E locally 2× (start web :3000 first; kill stragglers):** green, zero-flaky.
- [ ] **Step 3 — full gate:** `pnpm typecheck` (4/4); `pnpm --filter @crm/api --filter @crm/web --filter @crm/shared test` green; `mcp__eslint__lint-files` on changed; **prettier --check on ALL branch-changed files** (`git diff --name-only origin/main...HEAD | grep -E '\.(ts|tsx|js|jsx|md|json|css)$' | xargs npx prettier --check`).
- [ ] **Step 4 — commit** `test(e2e): documents unified badges + filter` with `ac_verified:`.
- [ ] **Step 5 — push** `feat/documents-pr2`, open PR (base main), label `ai-review-ready`.

> After push: PM dispatches code-reviewer + manual-qa (live — verify badges reflect REAL backend state per the mock-guard lesson). Security-reviewer not needed (read-only aggregation; no new auth/finance mutation).

---

## Acceptance Criteria

1. `GET /api/documents` returns invoice/receipt file rows with a semantic `statusBadge` derived from real backend state (`invoice_signatures` / linked transaction `status`), and the user's non-CANCELLED `employee_contracts` as virtual `source:'employee_contract'` entries with a contract badge — RBAC preserved, no double-counting.
2. Shared `DocumentDto` has `statusBadge {kind,state}` + `source`; (`invoicePendingSignature` reconciled).
3. Frontend renders badges (correct Russian label + tone) in both list & grid; a type/kind filter is present; list-mode loading skeleton is row-shaped (PR-1 MED fixed).
4. Unit (api/web/shared) + integration (real RBAC/badges, DB-skip-guard) + E2E green (run locally 2×); manual QA passed live.

## Self-review notes

- Spec §4 coverage: aggregation+RBAC→Task 2-3; badges→Task 1/2/4; type filter→Task 4; PR-1 skeleton MED→Task 4. PR-3 (receipt lifecycle/replace) explicitly NOT here.
- Consistency: `statusBadge {kind,state}` semantic from backend, Russian labels in frontend; `source` discriminator separates uploaded CONTRACT files from the employee_contract virtual entry (no double-count).
- Risk: RBAC for employee_contract virtual entries must match A3 (ADMIN + owner) — verify against `buildListWhere`/A3 rules. Invoice signature completeness query — confirm both COMPANY+COUNTERPARTY semantics before deriving «Подписано».
