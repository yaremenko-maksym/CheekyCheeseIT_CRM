# Documents page redesign + audit-journal removal — design

**Date:** 2026-06-05 (refreshed against main a173151)
**Status:** Design approved (brainstorming) — refreshed audit-removal scope vs current main; pending PR-1 plan
**Depends on:** A3 (employee_contracts statuses), finance (transactions/receipts/invoices), existing `documents` table + S3
**Branch:** `feat/documents-pr1` (PR-1, off main a173151); later PRs branch off main in turn

---

## 1. Goal

Make the Documents page the single home for all of a user's documents — uploaded files, per-employee contracts, invoices, and receipts — each with a clear status badge, in a switchable list/grid view. Remove the standalone audit-journal (user-facing page + profile tab; the server-side audit **interceptor/logging** stays). ToS acceptance becomes a profile marker. Enforce a one-income-one-receipt data invariant.

## 2. Decomposition (3 PRs — built in order)

- **PR-1 — Audit removal + ToS marker + view toggle.** Mostly frontend + targeted backend removal. Independent.
- **PR-2 — Unified document list + status badges.** Aggregation endpoint + frontend badges.
- **PR-3 — Receipt lifecycle.** One-income-one-receipt + delete-on-replace + confirmation. Backend (finance) + frontend wiring.

Backlog debts folded into this phase (separate small tasks): **#15** (AuditInterceptor PII mask) and **#21** (USER_LEGAL_NAME_CHANGED audit log) — see §7.

## 3. PR-1 — Audit removal + ToS marker + view toggle

**Remove — user-facing audit journal (full surface on current main, reconciled):**

_Frontend:_

- Top-level page: `apps/web/app/routes/crm/audit-log/index.tsx` + `route.tsx`.
- Top-level component: `apps/web/app/components/audit-log/AuditLogTab.tsx`.
- Profile tab route: `apps/web/app/routes/crm/profile/audit.tsx`.
- Profile tab component: `apps/web/app/components/user-profile/tabs/AuditLogTab.tsx`.
- Test: `apps/web/app/__tests__/audit-accordion.test.tsx`.
- Nav entry: the «Аудит-журнал» → `/crm/audit-log` item in `apps/web/app/components/crm/nav-sidebar.tsx` (~ln 93-98).
- `audit` from the profile tab enum in `crm/profile/$userId.tsx` + `crm/profile/index.tsx`; remove `AuditLogTab` wiring from `UserProfileShell`.
- routeTree.gen regenerated (audit routes gone).

_Backend:_

- `apps/api/src/audit/` module: `audit.controller.ts`, `audit.module.ts`, `audit.service.ts`, `audit.service.spec.ts` (endpoints `GET /me/audit-trail`, `GET /audit/all`). Unwire from `app.module.ts`. Remove the audit-log **shared schema** if only used here.

**KEEP (do NOT remove) — server-side audit logging layer:**

- `apps/api/src/common/interceptors/audit.interceptor.ts` (the structured audit-LOG interceptor) and its usages in `transactions.service.ts`, `users.controller.ts`/`users.module.ts`. This is distinct from the removed journal and is the target for #15/#21.
- `tos_acceptances` table (source for the ToS marker).

**ToS marker (profile):** on `/crm/profile/$userId`, ADMIN-visible (self may see own): «Пользовательское соглашение принято: <дата>, v<версия>» (or «не принято»). Place in the **overview** tab/header. Data: latest `tos_acceptances` row for the user, added to the user-profile endpoint (`tosAcceptedAt`, `tosVersion`).

**View toggle:** list/grid switch on `/crm/documents`. **Default = list.** Persist via `?view=` search param (fallback localStorage). Grid = existing `DocumentCard`; list = new compact `DocumentRow` (icon + name + type + badge + date + actions). Existing filters/search unchanged.

## 4. PR-2 — Unified list + status badges

**Aggregating read:** extend `GET /documents` (or new `GET /documents/unified`) to merge, preserving existing RBAC/`TAB_VISIBILITY`:

1. `documents`-table rows (RESUME/SCAN/CONTRACT/RECEIPT/INVOICE uploads) — file entries.
2. **employee_contracts** as virtual entries (the canonical "contracts") — distinct from uploaded CONTRACT-category files. Open → contract editor (ADMIN) / PDF.

**Badges:**
| Type | Source | States |
|---|---|---|
| Contract | `employee_contracts.status` | Драфт (DRAFT) · Готово к подписи (READY_TO_SIGN) · Подписано (SIGNED); CANCELLED → hidden |
| Invoice | invoice doc + signatures (via `transactions.invoice_document_id`) | Готово к подписи (counterparty sig missing) · Подписано (both sigs) |
| Receipt | receipt doc + linked `transactions.status` | Требует подтверждения (PENDING) · Подтверждено (VALIDATED) |
| Uploaded file | — | (no status badge) |

Type filter (contract/invoice/receipt/resume/scan) + existing search apply to the unified list. No double-counting: employee_contracts vs uploaded CONTRACT files are separate entries with distinct affordances.

## 5. PR-3 — Receipt lifecycle (one income → one receipt)

- **Invariant:** one income transaction ↔ exactly one receipt document (`transactions.receipt_document_id`, 1:1).
- **Replace-with-delete:** when a SENIOR re-submits a receipt (after rejection), the OLD receipt document is **hard-deleted (S3 file + DB row)** as the new one is attached; transaction status resets to PENDING. Wrap delete-old + attach-new + status-reset in one DB transaction; handle S3-delete failure (no orphan / no inconsistent state). Adjust the current "RECEIPT soft-delete forbidden" rule to permit this controlled replace-delete.
- **Confirmation:** receipt is "confirmed" when ADMIN/ACCOUNTANT validates the income transaction (`PATCH /transactions/:id/validate` → VALIDATED). The receipt badge derives from the linked transaction status (PENDING → требует подтверждения; VALIDATED → подтверждено; REJECTED → требует подтверждения again — the 2-state decision).
- **Endpoint:** receipt-replace operation on the transaction (e.g., `PATCH /transactions/:id/receipt`) enforcing 1:1 + delete-old.

## 6. Edge cases & error handling

- Receipt replace: S3 delete failure must not orphan or leave inconsistent DB; transactional + compensation.
- Aggregation RBAC: preserve per-role visibility (who sees contracts/invoices/receipts/uploads).
- ToS marker: «не принято» when no acceptance row.
- Audit removal: existing links/bookmarks to `/crm/audit-log` → 404/redirect cleanly; no dangling imports; routeTree regenerated.
- Empty states per type (existing pattern).

## 7. Backlog debt folded into this phase (#15, #21)

- **#15 — AuditInterceptor PII mask:** mask PII (legalFullName, etc.) in the server-side audit/observability logs. This is the **interceptor/logging** layer (`common/interceptors/audit.interceptor.ts`), NOT the removed journal. Independent of PR-1.
- **#21 — USER_LEGAL_NAME_CHANGED audit log:** log legal-name changes via the surviving AuditInterceptor / structured log (NOT the removed journal). Coder verifies the interceptor is the right target before implementing.

Sequencing: PR-1 removes the audit JOURNAL (module + UI). #15/#21 target the SEPARATE AuditInterceptor — confirm the two are distinct (they are, per reconciliation) so removal and #21 don't collide.

## 8. Testing

- **Unit:** badge state→label mapping; receipt replace-delete (old removed, new attached, status reset); ToS-marker data; PII-mask (#15).
- **Integration (real routes):** unified endpoint (RBAC + badges); receipt replace deletes old (S3+DB); audit endpoints return 404 after removal; legal-name change writes an audit log (#21). DB-skip-guard for DB-requiring specs (CI unit job has no DB — A3-4 lesson).
- **E2E:** view toggle (default list), badges per type, receipt replace flow, audit page/tab gone (nav link absent, `/crm/audit-log` 404), ToS marker on profile.
- **Manual QA (live, mandatory):** full document flows + receipt replace + ToS marker + audit-gone.

## 9. Files (high-level)

- **Remove:** `routes/crm/audit-log/*`, `routes/crm/profile/audit.tsx`, `components/audit-log/AuditLogTab.tsx`, `components/user-profile/tabs/AuditLogTab.tsx`, `__tests__/audit-accordion.test.tsx`, nav-sidebar audit entry, `apps/api/src/audit/*`, audit-log shared schema (if only used here).
- **Profile:** `$userId.tsx` + `index.tsx` (tab enum −audit), `UserProfileShell` (−audit tab), overview (+ToS marker), user-profile endpoint (+`tosAcceptedAt`/`tosVersion`).
- **Documents:** `documents.tsx` (view toggle), new `DocumentRow`, unified endpoint (`documents.service`/`controller`), badge component(s).
- **Finance:** `transactions.service` (receipt replace-delete + 1:1), receipt-replace endpoint.
- **Audit-logging (#15/#21):** `common/interceptors/audit.interceptor.ts` (PII mask) + legal-name-change log — KEPT, separate from journal removal.

## 10. Out of scope

- Documents storage backend rework (S3 infra exists).
- Per-project / client-contract uploads (per-project contracts feature cancelled).
- Changing the finance validation flow beyond the receipt 1:1 + replace-delete.
