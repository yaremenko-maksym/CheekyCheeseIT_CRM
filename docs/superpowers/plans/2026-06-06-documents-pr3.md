# Documents PR-3 — Receipt lifecycle (one income → one receipt) — Implementation Plan

> **For agentic workers:** TDD task-by-task (test → red → implement → green → commit). Checkbox steps. Spec: `docs/superpowers/specs/2026-06-05-documents-redesign-design.md` §5. Final PR of the Documents feature. WIP-push after each task.

**Goal:** Enforce one income transaction ↔ exactly one receipt document. When a SENIOR re-submits a receipt after rejection, the OLD receipt is hard-deleted (S3 file + DB row) as the new one is attached and the transaction resets to PENDING — atomically, with no orphan / no inconsistent state.

**Architecture:** The resubmit path already exists — `TransactionsService.updateSeniorIncome` (REJECTED→PENDING, swaps `receiptDocumentId`). Today it **orphans** the old receipt. PR-3 adds a RBAC-bypassing `DocumentsService.hardDeleteInternal(docId)` (mirrors `softDeleteInternal`) and calls it from `updateSeniorIncome` when the receipt is replaced, inside the existing DB update, with best-effort S3 cleanup. Confirmation (validate→VALIDATED) + the receipt badge already shipped in PR-2 — no change there.

**Tech Stack:** NestJS + Drizzle + S3 (api), Zod v4 (shared), React (web — minimal), Vitest, Playwright. Russian UI.

**Branch:** `feat/documents-pr3` (off main, post-PR-2). Chunked `wip:` pushes; final `ac_verified:`.

> Read first: `apps/api/src/finance/transactions.service.ts` (`updateSeniorIncome` ~628, `validateTransaction`), `apps/api/src/documents/documents.service.ts` (`hardDelete` ~598, `softDeleteInternal` ~269, the RECEIPT soft-delete rule ~429), `apps/api/src/documents/s3.service.ts` (the S3 delete method), `packages/shared/src/schemas/documents.ts`.

## Task 1 — `DocumentsService.hardDeleteInternal(docId)`

**Files:** `apps/api/src/documents/documents.service.ts` (+ `.spec.ts`).

- [ ] **Step 1 — failing test:** `hardDeleteInternal(docId)` deletes the S3 object then the DB row (no actor/RBAC check — internal use); idempotent-ish (missing row → no throw or NotFound per existing `softDeleteInternal` convention); on S3-delete error it still removes the DB row OR surfaces a typed error (decide + test — see Task 2 ordering).
- [ ] **Step 2 — run, expect FAIL** (`pnpm --filter @crm/api test -- documents.service`).
- [ ] **Step 3 — implement:** mirror `hardDelete` (S3 `delete` + DB `delete`) but without the ADMIN guard (mirrors `softDeleteInternal`/`uploadInternal` internal-bypass pattern). Reuse the existing `s3.service` delete method.
- [ ] **Step 4 — run, expect PASS** + `mcp__eslint__lint-files`.
- [ ] **Step 5 — commit** `feat(api): DocumentsService.hardDeleteInternal (S3+DB, internal)`.

## Task 2 — `updateSeniorIncome` replace-with-delete (atomic)

**Files:** `apps/api/src/finance/transactions.service.ts` (+ `.spec.ts`).

- [ ] **Step 1 — failing test(s):** on resubmit (REJECTED→PENDING) when `receiptDocumentId` changes from `oldId` to `newId` (or to null): the OLD receipt doc is hard-deleted; the tx now points at `newId`; status PENDING; validatedBy/At cleared. No delete when the receipt is unchanged. When old==null (no prior receipt) → no delete. S3-delete failure does **not** leave the tx pointing at a deleted-or-missing doc nor orphan silently (assert the chosen contract).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** wrap the existing update in `db.transaction(tx => …)`: compute `oldDocId = tx.receiptDocumentId`; perform the tx UPDATE (FK→newDocId, status PENDING, clear validation); if `oldDocId && oldDocId !== nextDocId` → delete the old documents row **inside the tx** (FK now points away, safe). After commit, best-effort `s3.delete(oldS3Key)` — on failure log a warning (leftover S3 object acceptable; DB stays consistent — no orphan FK, no lost new receipt). Order chosen so a S3 failure never corrupts DB state. Use `hardDeleteInternal` where it fits, or inline the in-tx DB delete + post-commit S3 (document the ordering decision in a comment). Keep the existing XOR receipt/url logic.
- [ ] **Step 4 — run, expect PASS** + eslint.
- [ ] **Step 5 — commit** `feat(api): replace-with-delete receipt on senior-income resubmit (1:1, atomic)`.

## Task 3 — 1:1 invariant guard + RECEIPT soft-delete rule reconciliation

**Files:** `apps/api/src/finance/transactions.service.ts` / `apps/api/src/documents/documents.service.ts`; migration if a DB constraint is added.

- [ ] **Step 1 — failing test:** a receipt document cannot end up linked to two transactions (1:1). The RECEIPT soft-delete-forbidden rule (documents.service ~429) still blocks user soft-delete of a receipt, but the controlled replace (Task 2 hard-delete) is permitted.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** enforce 1:1 — simplest is the existing one-FK-per-tx + replace-delete (no shared receipts); optionally add a partial unique index on `transactions(receipt_document_id) WHERE receipt_document_id IS NOT NULL` (migration) for a DB-level guarantee — include only if low-risk against current data (check for existing dup links via `mcp__postgres__query` first). Confirm the RECEIPT soft-delete rule is untouched for users and doesn't block the internal replace-delete.
- [ ] **Step 4 — run, expect PASS** + eslint.
- [ ] **Step 5 — commit** `feat(api): enforce 1:1 receipt↔income + reconcile RECEIPT delete rule`.

## Task 4 — Real-backend integration spec

**Files:** new `apps/api/src/finance/receipt-replace.integration.spec.ts` (DB-skip-guard per A3-4 lesson; mock/stub S3 or use a fake S3 in test).

- [ ] **Step 1 — tests (real Nest+DB):** seed a SENIOR_INCOME REJECTED tx with receipt doc A → resubmit with receipt doc B → A's documents row is gone, tx.receiptDocumentId == B, status PENDING; resubmit RBAC (only the receiver SENIOR; not others); validate→VALIDATED still works; S3 delete invoked for A (spy/fake).
- [ ] **Step 2-4 — red → green → commit** `test(api): receipt replace-with-delete integration (DB-skip-guard)`.

## Task 5 — Frontend verify + E2E + full verification

**Files:** verify `apps/web` resubmit UI (e.g. `EditSeniorIncomeDialog`) still works (likely no change — it already calls `updateSeniorIncome`; the delete is backend). E2E in `apps/e2e/tests/crm/finance*` or a new spec.

- [ ] **Step 1 — frontend check:** confirm the rejected-transaction re-upload flow calls the same endpoint; adjust only if the 1:1/replace changes the contract. Add a web unit only if frontend logic changed.
- [ ] **Step 2 — E2E (route-mocked + real-ish):** SENIOR resubmits a rejected receipt → new receipt shown, status back to «требует подтверждения» (PENDING badge from PR-2); ACCOUNTANT validates → «подтверждено».
- [ ] **Step 3 — RUN E2E locally 2× (start web :3000; kill stragglers).**
- [ ] **Step 4 — full gate:** `pnpm typecheck` (4/4); `pnpm --filter @crm/api --filter @crm/web --filter @crm/shared test` green; integration green (DB-skip-guard); `mcp__eslint__lint-files`; **prettier --check on ALL branch-changed files**.
- [ ] **Step 5 — commit** `test(e2e): receipt resubmit + validate lifecycle` with `ac_verified:`; push; open PR (base main); label `ai-review-ready`.

> After push: PM dispatches code-reviewer + **security-reviewer** (финансовый путь + удаление файла: атомарность, no-orphan, RBAC на resubmit, S3-delete failure handling) + **manual-qa live**. This PR touches finance + file deletion — security-review is REQUIRED.

---

## Acceptance Criteria

1. SENIOR resubmit-after-rejection hard-deletes the OLD receipt (S3 + DB) as the new one is attached; status resets to PENDING; atomic — S3-delete failure never corrupts DB (no orphan FK, no lost new receipt).
2. `DocumentsService.hardDeleteInternal` exists (S3+DB, no RBAC) + unit-tested.
3. One income tx ↔ exactly one receipt document (replace-delete maintains it; RECEIPT user-soft-delete rule intact; internal replace permitted).
4. Confirmation unchanged (validate→VALIDATED; PR-2 badge reflects it).
5. Unit (api) + integration (real DB + S3 spy, DB-skip-guard) + E2E green (run locally 2×); manual QA live; security-review passed.

## Self-review notes

- Spec §5 coverage: 1:1→Task 3; replace-with-delete→Task 1-2; confirmation→already PR-2 (noted); endpoint→reuse `updateSeniorIncome` (not a new `/receipt` route — the resubmit path already exists; documented deviation from spec's suggested endpoint, cleaner).
- Risk: atomicity ordering (DB delete in-tx, S3 delete post-commit best-effort) — the one subtle correctness point; security-review must scrutinize. Verify no existing dup `receipt_document_id` links before any unique-index migration.
- Финансовый/файловый путь → security-review обязателен.
