# Profile Pages Redesign — Design Spec

**Date:** 2026-05-20
**Scope:** `/crm/profile` + `/crm/users/:userId` (profile pages)
**Implemented in the first PR:** A+B+C+D+G (see the "Rollout" section)

---

## 1. Goal and context

The current profile pages are minimal and do not reflect the whole business logic of the CRM's role model:

- `/crm/profile` — only Telegram + phone are editable. No tech stack, avatar, requisites.
- `/crm/users/:userId` — a sparse view: avatar, name, contacts, role and creation date. Does not show finances, projects, teams, history.

**Goals:**

1. A single info-rich shell for both pages with role-aware sections.
2. Self-edit for your own profile (including requisites with a warning).
3. An Admin actions panel for managing any user.
4. An Audit log of changes (only the ADMIN sees it).
5. Replacing `walletAddress` with multi-method payment requisites (USDT ERC-20 + Bank UAH FOP).

---

## 2. Scope

### In scope (first PR)

| Code | Feature                  | Description                                                          |
| ---- | ------------------------ | -------------------------------------------------------------------- |
| A    | Tabs + per-role sections | `<UserProfileShell>` with tabs, content depends on viewer×target.    |
| B    | /profile self-edit       | displayName, telegram, phone, techStack — debounce autosave + toast. |
| C    | Payment requisites       | DB migration + UI (USDT/Bank UAH) + modal warning before saving.     |
| D    | Admin actions panel      | 8 actions (impersonate deferred).                                    |
| G    | Audit log                | New table + audit interceptor + "History" tab (only for the ADMIN).  |

### Out of scope (separate PRs)

| Code | Feature                      | Reason for deferral                                                   |
| ---- | ---------------------------- | --------------------------------------------------------------------- |
| E    | Avatar S3 upload             | Requires an S3 bucket + credentials. For now the Google avatar stays. |
| F    | Documents tab                | Phase 6 (a separate documents feature with ACL).                      |
| H    | `/crm/users` (list) refactor | Not in the current scope, the 1360-line monolith stays.               |
| —    | Hard delete from the archive | The archive page — a separate feature.                                |
| —    | Impersonate action           | Requires a separate session model.                                    |

---

## 3. Architecture

### 3.1 One shell for two pages

Both pages are one component `<UserProfileShell>` with a mode:

- `/crm/profile` → `mode='self'`, `userId=me.id`
- `/crm/users/:userId` → `mode='view'`, `userId=:id`

They differ only in which fields can be edited inline and which tabs are available (determined on the backend via `permissions`).

### 3.2 Layout: compact horizontal header (variant B + large avatar)

```
┌─ Header (scrollable) ─────────────────────────────────────────┐
│ [Avatar 128×128]  Artem Petrenko · JUNIOR                     │
│                   📧 email · 📱 phone · 🟦 telegram           │
│                                          [← To list] [⚡ Actions ▾] │
├─ Tabs row (sticky) ───────────────────────────────────────────┤
│ Overview · Finance · Projects · Team · Requisites · History   │
├─ Content area ────────────────────────────────────────────────┤
│ ... content of the active tab                                 │
└───────────────────────────────────────────────────────────────┘
```

- Avatar: 128×128 (fixed by the wish "the avatar should be large").
- The header is **not sticky** (scrolls together with the content).
- **Tabs row — sticky** (by decision): on scroll it stays on top, so there is always access to switching tabs.
- Action dropdown — on the right in the header (visible only if the viewer has `permissions.actions`).
- Tabs — a horizontal row under the header, the active tab highlighted with the accent color.

### 3.3 Tab state in the URL

```ts
validateSearch: z.object({
  tab: z
    .enum(['overview', 'finance', 'projects', 'team', 'interviews', 'requisites', 'audit'])
    .default('overview'),
})
```

- The active tab in the query: `?tab=finance`.
- An invalid value → redirect to `overview`.
- Deep links are convenient to share in chat.

---

## 4. Tabs and visibility

### 4.1 List of tabs

| Tab            | Content                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| **Overview**   | KPI cards (salary/payouts/projects/team) + tech stack + current project + latest activity |
| **Finance**    | Table of transactions/payouts with filters by period/status                               |
| **Projects**   | Active + history (cards)                                                                  |
| **Team**       | Team composition, relations (HR ↔ SENIOR ↔ JUNIOR)                                        |
| **Interviews** | Kanban data (only if target = SENIOR)                                                     |
| **Requisites** | Payment requisites: USDT ERC-20 + Bank UAH FOP                                            |
| **History**    | Audit log of changes (only the ADMIN sees it)                                             |

### 4.2 Visibility matrix (viewer × target → tabs)

Notation: "—" = header only (`tabs = []`). "self = …" = one's own profile.

| viewer / target →            | ADMIN                              | SENIOR                                                                      | JUNIOR                                                     | HR                                                         | ACCOUNTANT                                                 |
| ---------------------------- | ---------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| **ADMIN viewing**            | self = 6 (no Interviews, +History) | 7 (incl. Interviews, History)                                               | 6 (Overview, Finance, Projects, Team, Requisites, History) | 6 (Overview, Finance, Projects, Team, Requisites, History) | 6 (Overview, Finance, Projects, Team, Requisites, History) |
| **ACCOUNTANT viewing**       | Overview, Finance, Requisites      | Overview, Finance, Projects, Team, Requisites                               | Overview, Finance, Projects, Team, Requisites              | Overview, Team                                             | self = Overview, Finance, Projects, Team, Requisites       |
| **HR viewing (in own team)** | —                                  | Overview, Projects, Team, Interviews                                        | Overview, Projects, Team                                   | self = Overview, Finance (own), Teams, Requisites          | —                                                          |
| **SENIOR viewing**           | —                                  | self = Overview, Finance, Projects, Team, Interviews, Requisites; other = — | Overview, Projects, Team (if in a common project)          | —                                                          | —                                                          |
| **JUNIOR viewing**           | —                                  | —                                                                           | self = Overview, Projects, Team, Requisites; other = —     | —                                                          | —                                                          |

**Tabs for self (by role):**

- ADMIN self → Overview, Finance, Projects, Team, Requisites, History (everything except Interviews — the ADMIN does not have them)
- SENIOR self → Overview, Finance, Projects, Team, Interviews, Requisites
- JUNIOR self → Overview, Projects, Team, Requisites
- HR self → Overview, Finance (own salary), Teams, Requisites
- ACCOUNTANT self → Overview, Finance, Projects, Team, Requisites

History appears in the self-tabs **only for the ADMIN** (rule fixed).

**Important rules (fixed):**

- **HR does not see a senior's finances** (business rule, payroll is done by the ACCOUNTANT).
- **HR does not see requisites at all** on other profiles — even seniors of their own team.
- **JUNIOR on another's profile** sees **only the header** (name, role, contacts). `permissions.tabs = []` → the tabs row does not render at all. This also applies to cases where another viewer (for example, a JUNIOR looking at an ACCOUNTANT) has access to no tab.
- **History** — only the ADMIN, others do not even have the tab.
- **Interviews** — the tab appears only if target = SENIOR.

### 4.3 Default tab

`overview`. Can be overridden via the query-param `?tab=finance` for deep links (for example, from a notification about transaction validation).

---

## 5. Backend

### 5.1 Schema migration `0012_payment_requisites_audit_log.sql`

**Single-step migration** (user decision):

```sql
-- 1. New enum
CREATE TYPE payment_method AS ENUM ('USDT_ERC20', 'BANK_UAH_FOP');

-- 2. Add columns to users
ALTER TABLE users ADD COLUMN payment_method payment_method;
ALTER TABLE users ADD COLUMN wallet_usdt_erc20 TEXT;
ALTER TABLE users ADD COLUMN wallet_usdt_label TEXT;
ALTER TABLE users ADD COLUMN bank_uah_recipient TEXT;
ALTER TABLE users ADD COLUMN bank_uah_iban TEXT;
ALTER TABLE users ADD COLUMN bank_uah_rnokpp TEXT;
ALTER TABLE users ADD COLUMN bank_uah_bank_name TEXT;
ALTER TABLE users ADD COLUMN tech_stack TEXT[];
ALTER TABLE users ADD COLUMN archived_at TIMESTAMP;
ALTER TABLE users ADD COLUMN admin_note TEXT;

-- 3. Backfill from the legacy wallet_address
UPDATE users
SET wallet_usdt_erc20 = wallet_address,
    payment_method = 'USDT_ERC20'
WHERE wallet_address IS NOT NULL;

-- 4. DROP the legacy column
ALTER TABLE users DROP COLUMN wallet_address;

-- 5. New audit log table
CREATE TABLE user_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  target_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  changes JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_target ON user_audit_log (target_id, created_at DESC);
```

**Soft delete plan:**

- `archived_at` — the user is in the archive, hidden from the main list and UI. Can be restored.
- Hard delete (DELETE FROM users) — a separate feature (`/crm/users/archive`), not in the first PR.
- On hard delete: CASCADE on `user_audit_log` (target_id), but this will be implemented later. For now we do not delete archived ones.

**`admin_note`** — a single text field (user decision), overwritten. Not a notes table.

### 5.2 Endpoints

#### Self (`/users/me*`)

| Method  | Path                       | Body                                            | Description                          |
| ------- | -------------------------- | ----------------------------------------------- | ------------------------------------ |
| `PATCH` | `/api/users/me`            | `{displayName?, phone?, telegram?, techStack?}` | Inline self-edit with debounce 800ms |
| `PATCH` | `/api/users/me/requisites` | `{paymentMethod, ...method-specific fields}`    | Modal warning before save            |

#### Admin (`/users/:id*`)

| Method   | Path                                    | Body                                            | Access                                             |
| -------- | --------------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| `GET`    | `/api/users/:id`                        | —                                               | Authenticated (response filtered by `permissions`) |
| `GET`    | `/api/users/:id/audit-log?page=&limit=` | —                                               | ADMIN only (403 for the rest)                      |
| `PATCH`  | `/api/users/:id`                        | `{displayName?, phone?, telegram?, techStack?}` | ADMIN                                              |
| `PATCH`  | `/api/users/:id/role`                   | `{role}`                                        | ADMIN                                              |
| `PATCH`  | `/api/users/:id/salary`                 | `{salary?, sharePct?}`                          | ADMIN                                              |
| `PATCH`  | `/api/users/:id/requisites`             | `{paymentMethod, ...}`                          | ADMIN                                              |
| `PATCH`  | `/api/users/:id/note`                   | `{note}`                                        | ADMIN                                              |
| `POST`   | `/api/users/:id/team-membership`        | `{teamId, op: 'add'\|'remove'}`                 | ADMIN                                              |
| `POST`   | `/api/users/:id/project-reassign`       | `{projectId, action}`                           | ADMIN                                              |
| `DELETE` | `/api/users/:id`                        | — (soft delete → archived_at)                   | ADMIN                                              |

### 5.3 Response shape: the `permissions` block

`GET /api/users/:id` returns:

```ts
{
  user: User;                           // filtered fields
  permissions: {
    tabs: TabKey[];                     // what the viewer sees
    actions: ActionKey[];               // what the viewer can do
    fields: Record<string, boolean>;    // which fields are visible
  };
  data: {
    overview: OverviewData;
    finance?: FinanceData;              // only if in permissions.tabs
    projects?: ProjectData[];
    team?: TeamData;
    interviews?: InterviewData[];       // only if target=SENIOR
    requisites?: PaymentRequisites;
  };
}
```

**`UsersAccessService.getViewPermissions(viewer, target)`** — a single function determining `tabs`, `actions`, `fields` for a viewer×target pair. The RBAC logic is **in one place** on the server. The front only renders what is allowed.

### 5.4 Audit interceptor (NestJS)

```ts
@AuditLog('action_name')
@Patch(':id/role')
async changeRole(@Param('id') id: string, @Body() dto: ChangeRoleDto) {
  return this.usersService.changeRole(id, dto);
}
```

**Interceptor logic:**

1. Before the handler — snapshot the target user (via `users.repository.findById`).
2. Executes the handler in a transaction.
3. After success — snapshot once more.
4. Diffs the changed fields → `{ field: { before, after } }`.
5. INSERT into `user_audit_log` in the same transaction.

**Action types** (values of `action` in the log):

- `profile_edit` — self or admin changed displayName/phone/telegram/techStack
- `requisites_edit` — requisites changed (important for the money trail)
- `role_change`
- `salary_change`
- `note_set`
- `team_membership` (add/remove)
- `project_reassignment`
- `user_archived` (soft delete)

**Only the diff is stored (not full snapshots)** — user decision.

### 5.5 Zod schemas (in `@crm/shared`)

```ts
// payment-requisites.ts
const usdtRequisitesSchema = z.object({
  paymentMethod: z.literal('USDT_ERC20'),
  walletUsdtErc20: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  walletUsdtLabel: z.string().optional(),
})

const bankUahRequisitesSchema = z.object({
  paymentMethod: z.literal('BANK_UAH_FOP'),
  bankUahRecipient: z.string().min(3),
  bankUahIban: z.string().regex(/^UA\d{27}$/),
  bankUahRnokpp: z.string().regex(/^\d{10}$/),
  bankUahBankName: z.string().optional(),
})

const paymentRequisitesSchema = z.discriminatedUnion('paymentMethod', [
  usdtRequisitesSchema,
  bankUahRequisitesSchema,
])

// audit-log.ts
const auditLogEntrySchema = z.object({
  id: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  targetId: z.string().uuid(),
  action: z.string(),
  changes: z.record(z.object({ before: z.unknown(), after: z.unknown() })),
  createdAt: z.string(),
})

// view-permissions.ts
const viewPermissionsSchema = z.object({
  tabs: z.array(
    z.enum(['overview', 'finance', 'projects', 'team', 'interviews', 'requisites', 'audit']),
  ),
  actions: z.array(
    z.enum([
      'edit-profile',
      'change-role',
      'change-salary',
      'change-requisites',
      'manage-team',
      'reassign-project',
      'set-note',
      'archive',
    ]),
  ),
  fields: z.record(z.boolean()),
})
```

### 5.6 USDT rule (roles)

**Fixed (variant C):**

- **SENIOR, ADMIN** — only USDT ERC-20. The Bank UAH option is absent in the UI.
- **JUNIOR, HR, ACCOUNTANT** — choose via radio: USDT or Bank UAH.
- **Required** when creating a user — backend validation on `POST /api/users` (admin) and `PATCH /api/users/me/requisites` (self).

---

## 6. Frontend

### 6.1 File structure

```
apps/web/app/routes/crm/
├── profile.tsx                  → mode='self'
└── users/$userId.tsx            → mode='view'

apps/web/app/components/user-profile/
├── UserProfileShell.tsx
├── UserProfileHeader.tsx
├── tabs/
│   ├── OverviewTab.tsx
│   ├── FinanceTab.tsx
│   ├── ProjectsTab.tsx
│   ├── TeamTab.tsx
│   ├── InterviewsTab.tsx
│   ├── RequisitesTab.tsx
│   └── AuditLogTab.tsx
├── admin-actions/
│   ├── AdminActionsMenu.tsx
│   ├── EditProfileDialog.tsx
│   ├── ChangeRoleDialog.tsx
│   ├── ChangeSalaryDialog.tsx
│   ├── ChangeRequisitesDialog.tsx
│   ├── ManageTeamDialog.tsx
│   ├── ReassignProjectDialog.tsx
│   ├── AdminNoteDialog.tsx
│   └── ArchiveUserDialog.tsx
└── self-edit/
    ├── ProfileEditFields.tsx   → inline debounce autosave
    └── RequisitesEditForm.tsx  → with modal warning
```

### 6.2 Data flow (TanStack Query)

**Queries:**

- `useUser(userId)` → `GET /api/users/:id` — returns the `{user, permissions, data}` block
- `useUserAuditLog(userId, {page, limit})` → `GET /api/users/:id/audit-log` (the request is made only if `permissions.tabs.includes('audit')`)

`staleTime: 30s`. Each tab uses data from `data.{tabKey}` — we do not make separate queries per tab (everything is in one response, except audit-log which is paginated).

**Mutations:**

- `useUpdateMe()`, `useUpdateMeRequisites()`
- `useAdminUpdateUser(userId)`, `useAdminChangeRole`, `useAdminChangeSalary`, `useAdminChangeRequisites`, `useAdminNote`, `useArchiveUser`

After success → `queryClient.invalidateQueries(['user', userId])` + `['user-audit-log', userId]`.

### 6.3 URL state and tabs

```ts
const { tab } = useSearch({ from: '/crm/users/$userId' })
const navigate = useNavigate({ from: '/crm/users/$userId' })

const handleTabChange = (next: TabKey) => navigate({ search: { tab: next } })
```

Invalid / unavailable tabs (absent from `permissions.tabs`) on an attempt to open → redirect to `overview`.

### 6.4 Inline self-edit (debounce autosave)

Fields are edited right in the "Overview" tab (for self-mode). Logic (user decision):

```ts
const debouncedSave = useDebouncedCallback((data) => {
  updateMeMutation.mutate(data, {
    onSuccess: () => toast.success('Saved'),
    onError: (e) => toast.error(`Error: ${e.message}`),
  });
}, 800);

<Input
  defaultValue={user.telegram}
  onChange={(e) => debouncedSave({ telegram: e.target.value })}
/>
```

**Queue:** if the previous save is still in flight, the next one waits, is not cancelled — otherwise the last keystroke could be lost. Use TanStack Query `useMutation` with `mutationKey` — it queues on its own.

### 6.5 Requisites edit (with modal warning)

Requisites — a separate tab with a form. After filling in and clicking "Save":

1. Show an `<AlertDialog>`:
   > "Changing requisites will affect the following payouts. Continue?"
2. On confirm — PATCH request.
3. On success — toast "Requisites updated".

### 6.6 Admin actions

`AdminActionsMenu` (shadcn `<DropdownMenu>`) in the right corner of the header. Visible only if `permissions.actions.length > 0`. Each action opens its own dialog (see the file structure).

**ArchiveUserDialog** — confirmation: shows the related records (projects, payouts) and requires entering the user's name to confirm (anti-misclick).

---

## 7. RBAC enforcement

**Three layers:**

1. **Endpoint guards** — `@Roles('ADMIN')` NestJS decorators on admin endpoints.
2. **Response filtering** — `UsersAccessService.getViewPermissions(viewer, target)` determines which fields and tabs are returned.
3. **UI** — renders only what is in `permissions.tabs` / `permissions.actions`.

The server is the only source of truth. Mutation guards stay active — even if a button can be pressed in the UI, the server will check `permissions.actions` once more.

---

## 8. Error handling

- **Validation:** Zod errors → 400 with field errors → inline under the fields (react-hook-form + zodResolver for modals).
- **Permission errors:** 403 → toast "No access". The page does not redirect — the viewer is already on allowed content.
- **Network errors:** TanStack Query retry x1, then toast.
- **Requisites change:** the modal warning is mandatory.
- **Archive user:** a confirmation dialog with name entry.
- **Self-edit autosave:** a queue of mutations, toast on each success/error.

---

## 9. Testing

### Backend (Vitest, `apps/api`)

- `users-access.service.spec.ts` — snapshots of `getViewPermissions` for all 25 viewer×target combinations.
- `audit-interceptor.spec.ts` — diff logic, transaction atomicity.
- `users.controller.spec.ts` — guards (403 for non-ADMIN on admin endpoints).
- `migrations/0012.spec.ts` — backfill wallet_address → wallet_usdt_erc20.

### Frontend (Vitest, `apps/web`)

- `UserProfileShell.test.tsx` — rendering tabs from permissions.
- `RequisitesEditForm.test.tsx` — switching USDT/Bank UAH, IBAN/RNOKPP validation.
- `AuditLogTab.test.tsx` — pagination, filters.
- `ProfileEditFields.test.tsx` — debounce 800ms, queueing.

### E2E (Playwright, `apps/e2e`)

- `profile-self-edit.spec.ts` — debounce autosave, toast after saving, refresh → data preserved.
- `admin-actions.spec.ts` — dropdown, role change, verify the log is created.
- `rbac-hr-on-senior.spec.ts` — HR logs in, goes to `/users/:senior-id`, verifies the absence of the "Finance", "Requisites", "History" tabs.
- `rbac-junior-on-other.spec.ts` — JUNIOR on another's, only the header is visible.
- `requisites-warning.spec.ts` — the modal appears → confirm → save.

---

## 10. Migration & rollout

### First PR (this spec)

- Drizzle migration 0012 (single-step) + backfill + drop wallet_address.
- Drizzle migration for `user_audit_log` (creating the table).
- Backend: `users-access.service`, audit interceptor, new endpoints, Zod schemas in `@crm/shared`.
- Frontend: `UserProfileShell` + tabs + admin-actions + self-edit + requisites form.
- Update the seed: new fields for test fixtures.
- Tests (Vitest + Playwright).

### Not in this PR (separate iterations)

- **Avatar S3 upload** — requires bucket setup (env, IAM, sharp pipeline).
- **Documents tab** — Phase 6, a separate documents feature with ACL.
- **Users list refactor** — `/crm/users/index.tsx` (1360 lines of monolith) — a separate technical-debt PR.
- **Archive page** + hard delete UI — `/crm/users/archive`.
- **Impersonate** action — requires a session model change.

---

## 11. Open questions (for implementation)

- Hard delete from the archive: cascade on FK or soft-only forever (`deleted_forever_at`)? — discussed when implementing the archive page.
- Audit log retention: store forever or auto-cleanup after N days? — forever for now, optimization later.
- `tech_stack` UI: a text field with auto-suggest (based on unique values from the DB) or just a chip-input freeform? — current proposal: chip-input freeform.

---

**Signed off:** the design was discussed via Visual Companion and iterative clarifying questions (2026-05-20). Ready for implementation planning.
