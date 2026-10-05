# Onboarding flow + editable contract templates — Brief

**Date:** 2026-06-03
**Author:** PM
**Status:** Approved by USER (design), pending spec review
**Related PR placeholder:** Phase 6A → 6B → 6C → 6D

---

## 1. Goal

Every employee, before starting work in the CRM, **must**:

1. Sign the MSA (Master Service Agreement) — the template depends on the role (HR / SENIOR / JUNIOR / DROP / ACCOUNTANT).
2. Accept the Terms of Service (common for all roles).

If at least one of the two is not done — the user cannot use the CRM (redirect to `/crm/onboarding`).

Additionally, the ADMIN can edit contract templates and ToS via the UI. New employees receive the current (`is_active=true`) version. Signed/accepted documents are immutable (audit trail, snapshot stored in the DB).

---

## 2. Business decisions (from USER)

| Topic                             | Decision                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| Signing mechanism                 | Click-to-sign + typed name + IP/UA + timestamp (analog of invoice signing)                   |
| Template format                   | Markdown + variables `{{var}}`                                                               |
| ToS updated for existing users    | Soft-notify (sticky banner on top, work is NOT blocked)                                      |
| Storage of signed contracts       | DB JSON snapshot (`body_markdown_snapshot` + `variables_filled`) + on-the-fly PDF            |
| Number of templates               | 5 — a separate one per role (HR / SENIOR / JUNIOR / DROP / ACCOUNTANT). ADMIN does not sign. |
| Refactor `pdf-invoice.service.ts` | **A separate phase later** (not in this scope). Backlog item.                                |
| ADMIN onboarding                  | Bypass — ADMIN does not sign a contract and does not accept ToS                              |
| RBAC of reading contracts         | ADMIN + ACCOUNTANT + the employee themselves                                                 |
| Backfill existing users           | NO backfill — force onboarding on the next login for everyone (except ADMIN)                 |
| Invoice fallback when absent      | `contract_number = NULL`, a dash in the PDF (we do not block generate)                       |
| Contract scope                    | Two-tier: MSA (onboarding) + SOW (per project, FUTURE)                                       |
| Payment requisites timing         | ADMIN fills them in when creating a user; in the MSA they are substituted as variables       |

---

## 3. Scope of this delivery

### In scope (4 phases / 4 PR)

- MSA templates per role (5 templates) + editing by the ADMIN via the UI
- ToS global + editing + versioning + soft-notify on update
- Onboarding gate (backend guard + frontend redirect)
- Sign mechanism: click-to-sign + typed name + IP/UA capture
- Audit trail: immutable snapshot, contract_number per signed contract
- Invoice integration: real `contract_number` instead of the placeholder `CHK-${userId.slice(0,8)}-${year}` in `apps/api/src/invoices/invoices.service.ts:345`

### Out of scope (backlog)

- **SOW per project** (rate, %, currency for a specific project_member) — the next phase after 6D
- **Refactor `pdf-invoice.service.ts` → generic `pdf-generation.service.ts`** — unification of the DB-snapshot + on-the-fly PDF pattern for all platform documents (invoice, contract, future receipts). Recorded in `docs/agents/memory/pm/lessons.md` as backlog.
- **PDF generation for contracts** — in Phase 6A-D the PDF is not generated. A signed contract is shown as rendered Markdown in the UI. PDF download — after the pdf-invoice refactor (part of the backlog item).

---

## 4. Data model

### 4.1. Migration `0027_onboarding.sql`

```sql
-- contract_templates: editable templates
CREATE TABLE contract_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_role role NOT NULL CHECK (target_role <> 'ADMIN'),
  version INT NOT NULL,
  body_markdown TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (target_role, version)
);

CREATE UNIQUE INDEX contract_templates_one_active_per_role
  ON contract_templates(target_role) WHERE is_active = TRUE;

-- signed_contracts: immutable audit trail
CREATE SEQUENCE contract_number_seq;

CREATE TABLE signed_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  template_id UUID NOT NULL REFERENCES contract_templates(id),
  body_markdown_snapshot TEXT NOT NULL,
  variables_filled JSONB NOT NULL DEFAULT '{}'::jsonb,
  signed_typed_name TEXT NOT NULL,
  signed_ip TEXT,
  signed_user_agent TEXT,
  signed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  contract_number TEXT NOT NULL UNIQUE
);

CREATE INDEX signed_contracts_user_id_idx ON signed_contracts(user_id);

-- tos_versions: global versioned ToS
CREATE TABLE tos_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INT NOT NULL UNIQUE,
  body_markdown TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX tos_versions_one_active
  ON tos_versions((TRUE)) WHERE is_active = TRUE;

-- tos_acceptances: who accepted which version
CREATE TABLE tos_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  tos_version_id UUID NOT NULL REFERENCES tos_versions(id),
  accepted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  accepted_ip TEXT,
  accepted_user_agent TEXT,
  UNIQUE (user_id, tos_version_id)
);

CREATE INDEX tos_acceptances_user_id_idx ON tos_acceptances(user_id);
```

### 4.2. Contract number format

`CHK-{seq}-{year}` where `seq` = `nextval('contract_number_seq')`, `year` = the UTC year of signing.
Examples: `CHK-1-2026`, `CHK-2-2026`, ..., `CHK-247-2027`.

The sequence starts at 1. Monotonic, no gaps in the normal flow (a rollback may leave a gap — that is ok).

### 4.3. Variables for template interpolation

Resolved at the moment of `POST /api/contracts/sign`. Snapshot in `signed_contracts.variables_filled`.

| Variable              | Source                                                                |
| --------------------- | --------------------------------------------------------------------- |
| `{{employeeName}}`    | `users.display_name`                                                  |
| `{{employeeEmail}}`   | `users.email`                                                         |
| `{{role}}`            | translated label: Senior / Junior / HR / Drop / Accountant            |
| `{{onboardingDate}}`  | `signed_at` (UTC formatted)                                           |
| `{{companyName}}`     | hardcoded `'Cheeky Cheese IT'`                                        |
| `{{walletUsdt}}`      | `users.<USDT ERC-20 field>` (if present, otherwise `'not specified'`) |
| `{{bankUahFop}}`      | `users.<FOP fields>` (IBAN/EDRPOU forming, if present)                |
| `{{preferredMethod}}` | `users.<preferred method field>` — `crypto` or `fop`                  |

The exact names of the payment-requisites columns are resolved by the Coder in Phase 6A via `mcp__postgres__query` against the current `users` schema (migrations 0003, 0004, 0024 added them — exact column names TBD by Coder).

---

## 5. Backend (NestJS)

### 5.1. Modules

**`apps/api/src/contracts/`:**

- `contracts.module.ts`
- `contract-templates.controller.ts`
  - `GET /api/contracts/templates` — list all per the current role caller (ADMIN sees all 5)
  - `GET /api/contracts/templates/current/:role` — get the active template per role
  - `POST /api/contracts/templates` — ADMIN only: create a new version (auto-deactivate the previous active)
  - `GET /api/contracts/templates/:id` — read single (ADMIN only)
- `contract-templates.service.ts`
- `signed-contracts.controller.ts`
  - `POST /api/contracts/sign` — self-signing for the current user (resolve variables, snapshot, generate contract_number)
  - `GET /api/contracts/me` — own signed contracts
  - `GET /api/contracts/:id` — RBAC: ADMIN / ACCOUNTANT / owner
- `signed-contracts.service.ts`

**`apps/api/src/tos/`:**

- `tos.module.ts`
- `tos.controller.ts`
  - `GET /api/tos/current` — active ToS version
  - `GET /api/tos/versions` — all versions (ADMIN only)
  - `POST /api/tos` — ADMIN only: publish a new version (auto-deactivate the previous active)
  - `POST /api/tos/accept` — user accepts the current version
- `tos.service.ts`

**`apps/api/src/onboarding/`:**

- `onboarding.module.ts`
- `onboarding.controller.ts`
  - `GET /api/onboarding/status` → `{ requiresContract: bool, requiresTos: bool, contractTemplate?: {...}, tosVersion?: {...} }`
- `onboarding.service.ts`

### 5.2. OnboardingGuard

`apps/api/src/auth/onboarding.guard.ts` — NestJS global guard, runs after `JwtGuard`.

**Logic:**

```
if (req.user.role === 'ADMIN') return true;
if (req.path startswith one of bypass-paths) return true;

const needsContract = !exists(signed_contracts WHERE user_id = req.user.id AND template_id IN (active templates for user.role));
const needsTos = !exists(tos_acceptances WHERE user_id = req.user.id AND tos_version_id = active tos);

if (needsContract OR needsTos) {
  throw new ForbiddenException({ error: 'ONBOARDING_REQUIRED', missing: [...] });
}
return true;
```

**Bypass paths:**

- `/api/auth/*` (including `/api/auth/me` — the frontend reads the current user before the status check)
- `/api/onboarding/*`
- `/api/tos/current` (needed to display the text on the onboarding page)
- `/api/contracts/templates/current/:role` (needed to display the preview on the onboarding page)
- `/api/contracts/sign` and `/api/tos/accept` (the mechanism for exiting the gate)

### 5.3. Soft-notify check (separate endpoint)

`GET /api/onboarding/status` returns an additional field:

```jsonc
{
  "requiresContract": false,
  "requiresTos": false,
  "tosUpdateAvailable": true, // the user accepted an old version, but the active one is newer
  "latestTosVersion": { ... }
}
```

The frontend banner shows when `tosUpdateAvailable && !requiresTos`.

---

## 6. Frontend (Vite + TanStack Router)

### 6.1. Routes

**`apps/web/app/routes/crm/onboarding/`:**

- `route.tsx` — layout for the onboarding wizard (without sidebar)
- `index.tsx` — 2-step wizard: Step 1 Sign Contract → Step 2 Accept ToS

**`apps/web/app/routes/crm/admin/templates/`:**

- `route.tsx` — ADMIN-only layout (RBAC enforce); tab nav: Contracts / ToS
- `contracts.tsx` — list of 5 contract templates per role
- `contracts.$role.tsx` — split-view editor: CodeMirror (Markdown left) ↔ live preview (react-markdown right)
- `tos.tsx` — the current active ToS version editor + history list
- `tos.new.tsx` — publishing a new ToS version

### 6.2. Gate in `apps/web/app/routes/crm/route.tsx`

`useQuery(['onboarding-status'], fetchOnboardingStatus)` after the auth check:

- If `requiresContract || requiresTos` AND the current route != `/crm/onboarding/**` → redirect via `Navigate` to `/crm/onboarding`
- If `tosUpdateAvailable` → a sticky banner on top of the layout with the CTA "Read the new ToS version" (link to `/crm/onboarding?step=tos`)

### 6.3. Sign mechanism UI

Onboarding Step 1 (Sign Contract):

1. Render the template Markdown with the substituted variables (via react-markdown)
2. Input "Enter your name for the signature" (typed name)
3. Checkbox "I have read and confirm"
4. Button "Sign" — disabled while the typed name is empty and the checkbox is not checked
5. On click: `POST /api/contracts/sign` with `{ typed_name }` → the server resolves IP/UA from the request → creates a `signed_contracts` row → returns contract_number → the wizard moves to Step 2

Onboarding Step 2 (Accept ToS):

1. Render the ToS Markdown
2. Checkbox "I accept the Terms of Service"
3. Button "Accept" — on click `POST /api/tos/accept` → creates `tos_acceptances` → redirect to `/crm/dashboard`

### 6.4. Soft-notify banner

A sticky top banner in the crm layout (between header and main content), shadcn `<Alert>` variant:

```
ℹ️ A new version of the Terms of Service has been published. [Read →]
```

Button → `/crm/onboarding?step=tos` (one step of the wizard; after accept → return to the previous page).

---

## 7. Shared schemas (`packages/shared/src/schemas/`)

- `contracts.ts`:
  - `contractTargetRoleSchema` (z.enum, without ADMIN)
  - `contractTemplateSchema`
  - `createContractTemplateSchema`
  - `signedContractSchema`
  - `signContractSchema` (input: typed_name)
- `tos.ts`:
  - `tosVersionSchema`
  - `createTosVersionSchema`
  - `tosAcceptanceSchema`
- `onboarding.ts`:
  - `onboardingStatusSchema`

Export from `packages/shared/src/schemas/index.ts`.

---

## 8. Phase decomposition

### Phase 6A — Data model + Backend (1 PR)

**Branch:** `feature/onboarding-data-backend`
**Reviewer:** **MANDATORY** (migration + auth-adjacent + > 500 LOC expected)

**AC:**

1. Migration `0027_onboarding.sql` creates 4 tables + sequence (see §4.1)
2. Drizzle schema sync `apps/api/src/database/schema.ts` updated
3. `apps/api/src/contracts/` module with 2 controllers + 2 services, all endpoints (see §5.1)
4. `apps/api/src/tos/` module with 1 controller + 1 service
5. `apps/api/src/onboarding/` module with the status endpoint
6. `OnboardingGuard` created and wired globally (`AppModule.providers` via `APP_GUARD`)
7. Shared schemas (`contracts.ts`, `tos.ts`, `onboarding.ts`) + export from index
8. Unit tests (Vitest): contracts.service / tos.service / onboarding.service / onboarding.guard
9. Seed: 5 base contract_templates (one per role, body = placeholder draft Markdown) + ToS v1 (placeholder draft)
10. All endpoints verified via `mcp__postgres__query` against the real schema

**Not included:** UI, frontend changes, invoice contract_number replacement.

### Phase 6B — Onboarding UI + gate (1 PR)

**Branch:** `feature/onboarding-ui-gate`
**Reviewer:** **MANDATORY** (auth-adjacent)
**Depends on:** 6A merged

**AC:**

1. Route `/crm/onboarding` with a 2-step wizard
2. Gate in `routes/crm/route.tsx`: useQuery `/api/onboarding/status` → redirect logic
3. Sign Contract step: render Markdown preview, typed name, checkbox, sign button → POST sign
4. Accept ToS step: render Markdown, checkbox, accept button → POST accept
5. Soft-notify sticky banner when `tosUpdateAvailable`
6. After completing the wizard → `/crm/dashboard`
7. ADMIN bypass: onboarding is not shown, the gate passes immediately
8. E2E (`apps/e2e/tests/onboarding-*.spec.ts`):
   - **5 roles** (HR, SENIOR, JUNIOR, DROP, ACCOUNTANT): first login → lands on onboarding → signs the contract + accepts ToS → lands on /crm/dashboard
   - ADMIN logs in → does NOT land on onboarding
   - Onboarded user logs in → does NOT land on onboarding (idempotent)
   - Soft-notify banner shows on a new ToS version

**Not included:** ADMIN template editing UI, invoice integration.

### Phase 6C — Admin template editor (1 PR)

**Branch:** `feature/onboarding-admin-editor`
**Reviewer:** Conditional (if diff > 500 LOC)
**Depends on:** 6A merged

**AC:**

1. Route `/crm/admin/templates` with tab nav: Contracts / ToS — ADMIN only (redirect for non-ADMIN)
2. `contracts.tsx` — list of 5 templates per role with the current active version, link to the editor
3. `contracts.$role.tsx` — split-view editor (CodeMirror Markdown left + react-markdown preview right). Save → POST new version (auto-deactivate the previous active)
4. `tos.tsx` — editor for the current active version + list of historical versions (read-only view)
5. `tos.new.tsx` — publishing a new version
6. Variables hint in the editor: a hint listing the available `{{vars}}`
7. RBAC enforcement: non-ADMIN sees a 403/redirect to `/crm/dashboard`
8. E2E:
   - ADMIN updates the SENIOR contract template → a new SENIOR user sees the new body on onboarding
   - ADMIN publishes a new ToS → an existing onboarded user sees the soft-notify banner
   - non-ADMIN visits `/crm/admin/templates` → does not see the UI

### Phase 6D — Invoice contract_number replacement (1 PR)

**Branch:** `feature/invoice-real-contract-number`
**Reviewer:** **MANDATORY** (finance touch)
**Depends on:** 6A merged

**AC:**

1. `apps/api/src/invoices/invoices.service.ts:337-345` — the placeholder formula is removed
2. New logic: `contract_number = signed_contracts.contract_number` (lookup by user_id and target_role)
3. Fallback: if the signed_contracts row is not found → `contract_number = NULL`
4. `apps/api/src/invoices/invoice-pdf.service.ts` — when `contract_number === null` renders a dash ("—")
5. Unit tests updated (tests in `invoices.service.spec.ts:895-899` + `invoice-pdf.service.spec.ts:460-588` — all references to `CHK-deadbeef-2026` replaced)
6. E2E:
   - Onboarded user generates an invoice → the PDF contains the real contract_number from their signed_contracts
   - User without a signed_contract (theoretical legacy case) → the PDF shows a dash (does not fail)

**Not included:** Refactor the invoice-pdf service to a unified pattern (backlog).

---

## 9. Backlog (after 6A-D, separate features)

1. **SOW per project** — Statement of Work with rate/%/currency, signed when a user is added to `project_members`. Templates are edited by the ADMIN. Link invoice ↔ SOW for a specific project_member.
2. **Refactor `pdf-invoice.service.ts` → `pdf-generation.service.ts`** — a generic service that takes a Markdown snapshot + variables and renders a PDF. Used by both invoice and signed_contracts download.
3. **PDF download for signed contracts** (needed after backlog item #2).
4. **Audit log endpoint for ACCOUNTANT** — a summary list of signed_contracts with filters.

---

## 10. Open items for review

1. **Template bodies for the seed** — PM will generate a draft of 5 contracts + ToS as a starting placeholder in the Phase 6A seed script. ADMIN then edits them via the UI (Phase 6C ready). If USER wants a specific text — attach it to the 6A task file.
2. **Exact names of the payment-requisites columns in `users`** — the Coder resolves them via `mcp__postgres__query` at the start of Phase 6A. If the `users` structure does not cover USDT/FOP/preferredMethod in the needed way — the Coder creates a `.blocked.md`.
3. **Language of the onboarding interface** — `CLAUDE.md` requires **Russian** UI language for all texts (buttons, headings). Contract templates may be in any language of the ADMIN's choice (they write the body themselves), but the UI wrapper (Step 1/2, the "Sign", "Accept" buttons) — in Russian.

---

## 11. Link to docs/agents/

- After the merge of each PR — PM appends lessons to `docs/agents/memory/pm/lessons.md` (per RULES §6).
- After all 4 PRs — `docs/agents/project-state.md` is updated: Phase 6 → in progress / partial (5A-D done, SOW pending), new tables are added to §5.1.
- `CLAUDE.md` — update the current status in the final summary section.

---

## 12. Approval status

- [x] Design approved by USER (2026-06-03 chat session)
- [ ] Spec doc reviewed by USER (this file)
- [ ] Implementation plan written (next step: `superpowers:writing-plans` skill)
- [ ] Phase 6A task file created
