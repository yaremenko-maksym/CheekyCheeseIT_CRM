# A3-2 — ADMIN per-employee contract editor + contract-module hardening

**Date:** 2026-06-05
**Status:** Design approved (brainstorming), pending implementation plan
**Depends on:** A3-1 backend (PR #116, merged `dfe5e4a`)
**Wave position:** A3-2 of the onboarding contract UX series (A3-1 done → **A3-2** → A3-3 create-wizard → A3-4 onboarding integration)

---

## 1. Goal

Give ADMIN a UI to author and manage each employee's personal contract through its
lifecycle (DRAFT → READY_TO_SIGN → SIGNED), backed by the endpoints shipped in A3-1.
Plus close the contract-module correctness gaps flagged in #116 review so the lifecycle
invariants (especially "frozen when READY_TO_SIGN") are enforced server-side, not only in the UI.

This is a **fullstack** task: frontend (the editor tab) + targeted backend hardening.
It is **not** "frontend-only" — per the decision to not defer review MEDs.

## 2. Navigation & entry point

Current structure (verified on `main`):

- `/crm/users/` — users list (`apps/web/app/routes/crm/users/index.tsx`). Rows open the
  user's profile via `<Link to="/crm/profile/$userId">`.
- `/crm/profile/$userId` — `UserDetailPage` → `UserProfileShell mode="view"`
  (`apps/web/app/routes/crm/profile/$userId.tsx`). Tabbed shell; tab is a `?tab=` search param.
  Existing tabs: `overview, finance, projects, team, interviews, requisites, documents, audit`.

**Entry point (approved):** add a new **ADMIN-only** tab **`contract`** to `UserProfileShell`.

- URL: `/crm/profile/$userId?tab=contract`.
- The tab is rendered **only when the current viewer is ADMIN** (the 6 endpoints are ADMIN-only;
  backend also returns 403). Non-ADMIN viewers never see the tab.
- The tab is hidden when the **target user is ADMIN** (ADMINs do not have employee contracts —
  enforced by the A3-1 DB trigger + service guard); show nothing / no tab for ADMIN targets.
- Add `'contract'` to the `searchSchema` tab enum in `crm/profile/$userId.tsx` and to the tab
  list inside `UserProfileShell`.

Flow: **Пользователи → клик по пользователю → профиль → вкладка «Контракт»**.

## 3. Screen layout (inside the `contract` tab)

Split view (desktop), stacks vertically on narrow screens:

- **Left — Markdown editor:** CodeMirror (reuse the lazy loader pattern from
  `apps/web/app/routes/crm/admin/templates/contracts.$role.tsx`: `@uiw/react-codemirror` +
  `@codemirror/lang-markdown`). Below it: a variables hint panel listing available
  `{{placeholders}}` (reuse `CONTRACT_VARIABLE_DESCRIPTIONS_BRACED` from `@crm/shared`).
- **Right — PDF preview:** the **real backend-rendered PDF** (per decision), fetched from
  `GET /api/users/:id/contract/pdf` and shown with the PDF viewer component added in A2a (#114).
  A **«Обновить превью»** button (re)fetches it.
- **Action bar (bottom):** status-aware buttons (see §4).
- **Header:** the user name/role header comes from `UserProfileShell`. The **contract status
  badge** (DRAFT/READY_TO_SIGN/SIGNED) is rendered at the top of the `contract` tab content itself.

Mockup (DRAFT state):
`assets/a3-2-mockups` branch → `mockups/a3-2-editor-draft.jpg`.

## 4. Lifecycle & state → action matrix

Contract statuses (from A3-1, `@crm/shared` employee-contracts schema):
`DRAFT | READY_TO_SIGN | SIGNED | CANCELLED`.

| Status            | Editor                                                                        | Visible actions                                                                             | Notes                                                                                          |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **DRAFT**         | editable                                                                      | `Сохранить` (PATCH) · `Отметить готовым` (POST /ready) · `Сбросить к шаблону` (POST /reset) | Reset re-derives body from the current active template for the user's role.                    |
| **READY_TO_SIGN** | **read-only** + banner «Готов к подписи. Чтобы править — верните в черновик.» | `Вернуть в черновик` (POST /revert)                                                         | Freeze is enforced **both** in UI and backend (MED#2).                                         |
| **SIGNED**        | read-only                                                                     | `Вернуть в черновик` (POST /revert) — **destructive**                                       | Confirm dialog: «Сбросит подписанный контракт и онбординг участника (удалит ToS). Продолжить?» |
| **CANCELLED**     | n/a                                                                           | (lazy-create makes a fresh DRAFT)                                                           | A cancelled row is superseded; GET lazy-creates a new active DRAFT.                            |

PDF preview is available in every state (renders signed PDF for SIGNED, unsigned preview otherwise).

## 5. Data flow (frontend)

TanStack Query against the A3-1 endpoints (all ADMIN-only, prefix `api/users`):

| Action            | Call                                                                                | On success                                         |
| ----------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| Open tab          | `GET /api/users/:id/contract` (lazy-creates DRAFT)                                  | load `bodyMarkdown` into editor; set status        |
| Save              | `PATCH /api/users/:id/contract` `{ bodyMarkdown }` (`updateEmployeeContractSchema`) | invalidate contract query; clear dirty flag        |
| Mark ready        | `POST /api/users/:id/contract/ready`                                                | status → READY_TO_SIGN; editor locks               |
| Revert            | `POST /api/users/:id/contract/revert`                                               | status → DRAFT; editor unlocks (confirm if SIGNED) |
| Reset to template | `POST /api/users/:id/contract/reset` (DRAFT only)                                   | reload body (confirm before overwrite)             |
| Refresh preview   | `GET /api/users/:id/contract/pdf` (blob)                                            | render in PDF viewer                               |

**Preview reflects the saved contract**, not the editor buffer (the PDF endpoint renders
`employee_contract.bodyMarkdown`). Therefore **«Обновить превью» is enabled only when there are
no unsaved changes**; while dirty, show hint «Сначала сохраните, чтобы обновить превью».

## 6. Backend hardening (close #116 review MEDs)

All in `apps/api/src/contracts/`:

1. **MED#2 — freeze is real.** `EmployeeContractsService.updateBody()` must reject when status is
   not `DRAFT` (throw `ConflictException` 409 `CONTRACT_NOT_EDITABLE`). Currently it allows
   `DRAFT | READY_TO_SIGN`. After this change, editing in READY_TO_SIGN requires an explicit
   revert → DRAFT (matches the UI). Update the controller doc comment accordingly.
2. **MED#1 — atomic revert.** `EmployeeContractsService.revert()` must wrap the
   `UPDATE employee_contracts` + `DELETE tos_acceptances` in a single `db.transaction(...)` so a
   partial failure can't leave status=DRAFT with stale ToS (which would skip re-onboarding).
3. **MED#3 — snapshot read inside tx.** `SignedContractsService.sign()` should move
   `getReadyForSigning(userId)` inside the `db.transaction(...)` block so body snapshot + insert +
   `markSigned` share one snapshot. (Sign path = onboarding; included now, integration-verified in A3-4.)
4. **PDF filename sanitize.** In `employee-contracts.controller.ts` and
   `onboarding-contract.controller.ts`, the `Content-Disposition` filename interpolates
   `displayName`. Sanitize (strip/replace characters outside `[A-Za-z0-9._-]`, collapse spaces to
   `-`) so a name with quotes/newlines can't break the header. Prefer RFC 5987 `filename*` for
   non-ASCII, with an ASCII `filename` fallback.

Each hardening item needs unit coverage (see §9).

## 7. Edge cases & error handling

- **No active template for the user's role** → `GET /contract` lazy-create returns 404 →
  show «Нет активного шаблона для роли {role}. Создайте шаблон в Админ → Шаблоны контрактов.»
  with a link to `/crm/admin/templates/contracts.$role`.
- **Target user is ADMIN** → tab not shown; if reached directly, show «Контракты для ADMIN не ведутся».
- **Unsaved-changes guard** when switching tab / navigating away → confirm «Есть несохранённые изменения. Уйти без сохранения?».
- **Mutation errors** → toast (Russian) with the server message; keep editor state.
- **PDF fetch error / throttle (5/min)** → toast «Слишком часто. Подождите минуту.» and keep last preview.
- **Concurrent status change** (e.g., the row was reverted elsewhere) → on 409, refetch and reconcile UI.

## 8. RBAC

- Tab + all calls are ADMIN-only; backend enforces (`@Roles('ADMIN')` + `RolesGuard`).
- Frontend hides the tab for non-ADMIN viewers (defense-in-UX), backend is the source of truth.

## 9. Testing

- **Unit (web):** status → button/editor-enabled mapping; dirty-flag + preview-enabled logic;
  unsaved-changes guard.
- **Unit (api):** `updateBody` rejects in READY_TO_SIGN/SIGNED (MED#2); `revert()` rolls back
  both writes on failure (MED#1); `sign()` snapshot consistency (MED#3); filename sanitizer
  (quotes, spaces, non-ASCII, newlines).
- **E2E (Playwright, real stack):** ADMIN opens contract tab → edits → Save → Mark Ready
  (editor locks) → Revert → preview PDF loads. Non-ADMIN: tab absent. Seeded users:
  `dmytro.marchenko@cheekycheese.dev` (SENIOR, has READY_TO_SIGN after #116 seed).
- **Manual QA (mandatory, live stack):** full lifecycle incl. destructive SIGNED-revert dialog,
  no-template state, narrow-screen stacking, dirty-guard. (Per `feedback_mandatory_user_testing`
  - `feedback_mocked_e2e_guards` — mocked tests miss guard/boot behavior.)

## 10. Reuse (do not re-invent)

- CodeMirror lazy loader + variables hint — from `crm/admin/templates/contracts.$role.tsx`.
- `MarkdownDiff` (`apps/web/app/components/admin/MarkdownDiff.tsx`) — optional, for a
  "confirm before Reset/Mark Ready" diff if low cost; not required for MVP.
- PDF viewer component — from A2a (#114). (Coder: locate the exact component under
  `apps/web/app/components/**` — A2a added an inline PDF preview/viewer; reuse it rather than
  building a new one.)
- Types/schemas — `@crm/shared`: `EmployeeContract`, status enum, `updateEmployeeContractSchema`,
  `CONTRACT_VARIABLE_DESCRIPTIONS_BRACED`.

## 11. Files (expected)

**Frontend (apps/web):**

- `app/routes/crm/profile/$userId.tsx` — add `'contract'` to tab enum.
- `app/components/user-profile/UserProfileShell.tsx` — register the ADMIN-only `contract` tab.
- `app/components/user-profile/contract/` (new) — `ContractTab.tsx`, `ContractEditor.tsx`,
  `ContractPdfPreview.tsx`, `ContractActionBar.tsx`, query/mutation hooks.

**Backend (apps/api/src/contracts):**

- `employee-contracts.service.ts` — MED#2 (updateBody DRAFT-only), MED#1 (revert tx).
- `signed-contracts.service.ts` — MED#3 (sign snapshot inside tx).
- `employee-contracts.controller.ts`, `onboarding-contract.controller.ts` — filename sanitize
  (extract a shared helper).

## 12. Out of scope / sequencing

- **A3-3** (multi-step create-user wizard) and **A3-4** (onboarding sign integration) are separate waves.
- The employee-facing signing UI stays in onboarding; A3-2 is ADMIN-side authoring only.
- No new backend endpoints (A3-1 already provides all six).

## 13. Open decision (confirm during review)

- MED#3 (`sign()` snapshot) is included in A3-2 hardening but is exercised by the sign flow
  (A3-4). If you prefer, it can move strictly to A3-4. Default here: include now, unit-test now,
  integration-verify in A3-4.
