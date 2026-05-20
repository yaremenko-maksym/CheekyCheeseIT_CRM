# Profile Pages Redesign — Design Spec

**Дата:** 2026-05-20
**Скоуп:** `/crm/profile` + `/crm/users/:userId` (страницы профилей)
**Реализация в первом PR:** A+B+C+D+G (см. секцию «Rollout»)

---

## 1. Цель и контекст

Текущие страницы профилей минимальны и не отражают всю бизнес-логику ролевой модели CRM:

- `/crm/profile` — только Telegram + телефон редактируются. Нет техстека, аватара, реквизитов.
- `/crm/users/:userId` — sparse view: аватар, имя, контакты, роль и дата создания. Не показывает финансы, проекты, команды, историю.

**Цели:**

1. Единый info-rich shell для обеих страниц с role-aware секциями.
2. Self-edit для своего профиля (включая реквизиты с предупреждением).
3. Admin actions panel для управления любым пользователем.
4. Audit log изменений (видит только ADMIN).
5. Замена `walletAddress` на multi-method payment requisites (USDT ERC-20 + Bank UAH ФОП).

---

## 2. Scope

### In scope (первый PR)

| Код | Фича | Описание |
|---|---|---|
| A | Tabs + per-role sections | `<UserProfileShell>` с табами, контент зависит от viewer×target. |
| B | /profile self-edit | displayName, telegram, phone, techStack — debounce autosave + toast. |
| C | Payment requisites | DB-миграция + UI (USDT/Bank UAH) + modal warning перед сохранением. |
| D | Admin actions panel | 8 действий (impersonate отложен). |
| G | Audit log | Новая таблица + audit interceptor + tab «История» (только для ADMIN). |

### Out of scope (отдельные PR-ы)

| Код | Фича | Причина откладывания |
|---|---|---|
| E | Avatar S3 upload | Требует S3 bucket + credentials. Пока остаётся Google-аватар. |
| F | Documents tab | Phase 6 (отдельная фича документов с ACL). |
| H | `/crm/users` (list) refactor | Не входит в текущий scope, монолит 1360 строк остаётся. |
| — | Hard delete из архива | Архив-страница — отдельная фича. |
| — | Impersonate action | Требует отдельной модели сессии. |

---

## 3. Архитектура

### 3.1 Один shell для двух страниц

Обе страницы — это один компонент `<UserProfileShell>` с режимом:

- `/crm/profile` → `mode='self'`, `userId=me.id`
- `/crm/users/:userId` → `mode='view'`, `userId=:id`

Различаются только тем, какие поля можно редактировать inline и какие табы доступны (определяется на бэке через `permissions`).

### 3.2 Layout: компактный horizontal header (variant B + крупный аватар)

```
┌─ Header (scrollable) ─────────────────────────────────────────┐
│ [Аватар 128×128]  Артём Петренко · JUNIOR                     │
│                   📧 email · 📱 phone · 🟦 telegram           │
│                                          [← К списку] [⚡ Действия ▾] │
├─ Tabs row (sticky) ───────────────────────────────────────────┤
│ Обзор · Финансы · Проекты · Команда · Реквизиты · История    │
├─ Content area ────────────────────────────────────────────────┤
│ ... контент активного таба                                    │
└───────────────────────────────────────────────────────────────┘
```

- Аватар: 128×128 (закреплено пожеланием «аватарка должна быть крупная»).
- Header **не sticky** (скроллится вместе с контентом).
- **Tabs row — sticky** (по решению): при скролле остаётся вверху, чтоб всегда был доступ к переключению табов.
- Action dropdown — справа в header'е (видим только если у viewer есть `permissions.actions`).
- Tabs — горизонтальный ряд под header'ом, активный таб подсвечен accent-цветом.

### 3.3 Состояние таба в URL

```ts
validateSearch: z.object({
  tab: z.enum([
    'overview', 'finance', 'projects', 'team',
    'interviews', 'requisites', 'audit'
  ]).default('overview')
})
```

- Активный таб в query: `?tab=finance`.
- Невалидное значение → редирект на `overview`.
- Дип-линки удобно расшаривать в чате.

---

## 4. Табы и видимость

### 4.1 Список табов

| Tab | Контент |
|---|---|
| **Обзор** | KPI cards (зарплата/выплаты/проекты/команда) + tech stack + текущий проект + последняя активность |
| **Финансы** | Таблица транзакций/выплат с фильтрами по периоду/статусу |
| **Проекты** | Активные + история (карточки) |
| **Команда** | Состав команды, связи (HR ↔ SENIOR ↔ JUNIOR) |
| **Собеседования** | Kanban-данные (только если target = SENIOR) |
| **Реквизиты** | Payment requisites: USDT ERC-20 + Bank UAH ФОП |
| **История** | Audit log изменений (только ADMIN видит) |

### 4.2 Матрица видимости (viewer × target → tabs)

Обозначения: «—» = header only (`tabs = []`). «self = …» = свой собственный профиль.

| viewer / target → | ADMIN | SENIOR | JUNIOR | HR | ACCOUNTANT |
|---|---|---|---|---|---|
| **ADMIN viewing** | self = 6 (no Собеседования, +История) | 7 (вкл. Собеседования, История) | 6 (Обзор, Финансы, Проекты, Команда, Реквизиты, История) | 6 (Обзор, Финансы, Проекты, Команда, Реквизиты, История) | 6 (Обзор, Финансы, Проекты, Команда, Реквизиты, История) |
| **ACCOUNTANT viewing** | Обзор, Финансы, Реквизиты | Обзор, Финансы, Проекты, Команда, Реквизиты | Обзор, Финансы, Проекты, Команда, Реквизиты | Обзор, Команда | self = Обзор, Финансы, Проекты, Команда, Реквизиты |
| **HR viewing (in own team)** | — | Обзор, Проекты, Команда, Собеседования | Обзор, Проекты, Команда | self = Обзор, Финансы (own), Команды, Реквизиты | — |
| **SENIOR viewing** | — | self = Обзор, Финансы, Проекты, Команда, Собеседования, Реквизиты; other = — | Обзор, Проекты, Команда (если в общем проекте) | — | — |
| **JUNIOR viewing** | — | — | self = Обзор, Проекты, Команда, Реквизиты; other = — | — | — |

**Tabs для self (по ролям):**
- ADMIN self → Обзор, Финансы, Проекты, Команда, Реквизиты, История (всё, кроме Собеседования — у ADMIN их нет)
- SENIOR self → Обзор, Финансы, Проекты, Команда, Собеседования, Реквизиты
- JUNIOR self → Обзор, Проекты, Команда, Реквизиты
- HR self → Обзор, Финансы (own salary), Команды, Реквизиты
- ACCOUNTANT self → Обзор, Финансы, Проекты, Команда, Реквизиты

История появляется в self-табах **только у ADMIN** (правило закреплено).

**Важные правила (закреплены):**

- **HR не видит финансы синьора** (бизнес-правило, payroll делает ACCOUNTANT).
- **HR не видит реквизиты вообще** на чужих профилях — даже синьоров своей команды.
- **JUNIOR на чужом профиле** видит **только header** (имя, роль, контакты). `permissions.tabs = []` → tabs row не рендерится вовсе. Это применяется и к случаям, когда другой viewer (например, JUNIOR смотрит на ACCOUNTANT'а) не имеет доступа ни к одному табу.
- **История** — только ADMIN, у других даже таба нет.
- **Собеседования** — таб появляется только если target = SENIOR.

### 4.3 Default tab

`overview`. Можно переопределить через query-param `?tab=finance` для дип-линков (например, из уведомления о валидации транзакции).

---

## 5. Backend

### 5.1 Schema migration `0012_payment_requisites_audit_log.sql`

**Single-step миграция** (решение пользователя):

```sql
-- 1. Новый enum
CREATE TYPE payment_method AS ENUM ('USDT_ERC20', 'BANK_UAH_FOP');

-- 2. Добавляем колонки в users
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

-- 3. Backfill из legacy wallet_address
UPDATE users
SET wallet_usdt_erc20 = wallet_address,
    payment_method = 'USDT_ERC20'
WHERE wallet_address IS NOT NULL;

-- 4. DROP legacy column
ALTER TABLE users DROP COLUMN wallet_address;

-- 5. Новая таблица audit log
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
- `archived_at` — пользователь в архиве, скрыт из основного списка и UI. Может быть восстановлен.
- Hard delete (DELETE FROM users) — отдельная фича (`/crm/users/archive`), не в первом PR.
- При hard delete: CASCADE на `user_audit_log` (target_id), но это будет реализовано позже. Сейчас архивированных не удаляем.

**`admin_note`** — одно текстовое поле (по решению пользователя), перезаписывается. Не таблица заметок.

### 5.2 Endpoints

#### Self (`/users/me*`)

| Method | Path | Body | Описание |
|---|---|---|---|
| `PATCH` | `/api/users/me` | `{displayName?, phone?, telegram?, techStack?}` | Inline self-edit с debounce 800ms |
| `PATCH` | `/api/users/me/requisites` | `{paymentMethod, ...method-specific fields}` | Modal warning перед save |

#### Admin (`/users/:id*`)

| Method | Path | Body | Доступ |
|---|---|---|---|
| `GET` | `/api/users/:id` | — | Authenticated (response фильтрован по `permissions`) |
| `GET` | `/api/users/:id/audit-log?page=&limit=` | — | ADMIN only (403 для остальных) |
| `PATCH` | `/api/users/:id` | `{displayName?, phone?, telegram?, techStack?}` | ADMIN |
| `PATCH` | `/api/users/:id/role` | `{role}` | ADMIN |
| `PATCH` | `/api/users/:id/salary` | `{salary?, sharePct?}` | ADMIN |
| `PATCH` | `/api/users/:id/requisites` | `{paymentMethod, ...}` | ADMIN |
| `PATCH` | `/api/users/:id/note` | `{note}` | ADMIN |
| `POST` | `/api/users/:id/team-membership` | `{teamId, op: 'add'\|'remove'}` | ADMIN |
| `POST` | `/api/users/:id/project-reassign` | `{projectId, action}` | ADMIN |
| `DELETE` | `/api/users/:id` | — (soft delete → archived_at) | ADMIN |

### 5.3 Response shape: `permissions` block

`GET /api/users/:id` возвращает:

```ts
{
  user: User;                           // фильтрованные поля
  permissions: {
    tabs: TabKey[];                     // что viewer видит
    actions: ActionKey[];               // что viewer может делать
    fields: Record<string, boolean>;    // какие поля видны
  };
  data: {
    overview: OverviewData;
    finance?: FinanceData;              // только если в permissions.tabs
    projects?: ProjectData[];
    team?: TeamData;
    interviews?: InterviewData[];       // только если target=SENIOR
    requisites?: PaymentRequisites;
  };
}
```

**`UsersAccessService.getViewPermissions(viewer, target)`** — единая функция, определяющая `tabs`, `actions`, `fields` для пары viewer×target. RBAC-логика **в одном месте** на сервере. Фронт лишь рендерит то, что разрешено.

### 5.4 Audit interceptor (NestJS)

```ts
@AuditLog('action_name')
@Patch(':id/role')
async changeRole(@Param('id') id: string, @Body() dto: ChangeRoleDto) {
  return this.usersService.changeRole(id, dto);
}
```

**Логика интерцептора:**

1. До handler — snapshot target user (через `users.repository.findById`).
2. Выполняет handler в транзакции.
3. После успеха — snapshot ещё раз.
4. Diff'ит изменённые поля → `{ field: { before, after } }`.
5. INSERT в `user_audit_log` в той же транзакции.

**Action types** (значения `action` в логе):

- `profile_edit` — self или admin изменил displayName/phone/telegram/techStack
- `requisites_edit` — изменены реквизиты (важно для money trail)
- `role_change`
- `salary_change`
- `note_set`
- `team_membership` (add/remove)
- `project_reassignment`
- `user_archived` (soft delete)

**Хранится только diff (не полные снапшоты)** — по решению пользователя.

### 5.5 Zod schemas (в `@crm/shared`)

```ts
// payment-requisites.ts
const usdtRequisitesSchema = z.object({
  paymentMethod: z.literal('USDT_ERC20'),
  walletUsdtErc20: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  walletUsdtLabel: z.string().optional(),
});

const bankUahRequisitesSchema = z.object({
  paymentMethod: z.literal('BANK_UAH_FOP'),
  bankUahRecipient: z.string().min(3),
  bankUahIban: z.string().regex(/^UA\d{27}$/),
  bankUahRnokpp: z.string().regex(/^\d{10}$/),
  bankUahBankName: z.string().optional(),
});

const paymentRequisitesSchema = z.discriminatedUnion('paymentMethod', [
  usdtRequisitesSchema, bankUahRequisitesSchema,
]);

// audit-log.ts
const auditLogEntrySchema = z.object({
  id: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  targetId: z.string().uuid(),
  action: z.string(),
  changes: z.record(z.object({ before: z.unknown(), after: z.unknown() })),
  createdAt: z.string(),
});

// view-permissions.ts
const viewPermissionsSchema = z.object({
  tabs: z.array(z.enum(['overview','finance','projects','team','interviews','requisites','audit'])),
  actions: z.array(z.enum(['edit-profile','change-role','change-salary','change-requisites','manage-team','reassign-project','set-note','archive'])),
  fields: z.record(z.boolean()),
});
```

### 5.6 USDT rule (роли)

**Закреплено (вариант C):**

- **SENIOR, ADMIN** — только USDT ERC-20. Опция Bank UAH в UI отсутствует.
- **JUNIOR, HR, ACCOUNTANT** — выбирают radio: USDT или Bank UAH.
- **Required** при создании пользователя — backend валидация на `POST /api/users` (admin) и `PATCH /api/users/me/requisites` (self).

---

## 6. Frontend

### 6.1 Структура файлов

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
    └── RequisitesEditForm.tsx  → с modal warning
```

### 6.2 Data flow (TanStack Query)

**Queries:**

- `useUser(userId)` → `GET /api/users/:id` — возвращает `{user, permissions, data}` блок
- `useUserAuditLog(userId, {page, limit})` → `GET /api/users/:id/audit-log` (запрос делается только если `permissions.tabs.includes('audit')`)

`staleTime: 30s`. Каждый таб использует данные из `data.{tabKey}` — отдельных queries на табы не делаем (всё в одном response, кроме audit-log который пагинированный).

**Mutations:**

- `useUpdateMe()`, `useUpdateMeRequisites()`
- `useAdminUpdateUser(userId)`, `useAdminChangeRole`, `useAdminChangeSalary`, `useAdminChangeRequisites`, `useAdminNote`, `useArchiveUser`

После успеха → `queryClient.invalidateQueries(['user', userId])` + `['user-audit-log', userId]`.

### 6.3 URL state и табы

```ts
const { tab } = useSearch({ from: '/crm/users/$userId' });
const navigate = useNavigate({ from: '/crm/users/$userId' });

const handleTabChange = (next: TabKey) => navigate({ search: { tab: next } });
```

Невалидные / недоступные табы (отсутствующие в `permissions.tabs`) при попытке открыть → редирект на `overview`.

### 6.4 Inline self-edit (debounce autosave)

Поля редактируются прямо в табе «Обзор» (для self-mode). Логика (по решению пользователя):

```ts
const debouncedSave = useDebouncedCallback((data) => {
  updateMeMutation.mutate(data, {
    onSuccess: () => toast.success('Сохранено'),
    onError: (e) => toast.error(`Ошибка: ${e.message}`),
  });
}, 800);

<Input
  defaultValue={user.telegram}
  onChange={(e) => debouncedSave({ telegram: e.target.value })}
/>
```

**Очередь:** если предыдущий save ещё в полёте, следующий waits, не отменяется — иначе можно потерять последний keystroke. Использовать TanStack Query `useMutation` с `mutationKey` — он сам очередит.

### 6.5 Requisites edit (с modal warning)

Реквизиты — отдельный таб с формой. После заполнения и клика «Сохранить»:

1. Показать `<AlertDialog>`:
   > «Изменение реквизитов повлияет на следующие выплаты. Продолжить?»
2. На confirm — PATCH запрос.
3. На success — toast «Реквизиты обновлены».

### 6.6 Admin actions

`AdminActionsMenu` (shadcn `<DropdownMenu>`) в правом углу header'а. Видим только если `permissions.actions.length > 0`. Каждый action открывает свой диалог (см. файловую структуру).

**ArchiveUserDialog** — confirmation: показывает связанные записи (проекты, выплаты) и требует ввод имени пользователя для подтверждения (anti-misclick).

---

## 7. RBAC enforcement

**Три слоя:**

1. **Endpoint guards** — `@Roles('ADMIN')` декораторы NestJS на admin endpoints.
2. **Response filtering** — `UsersAccessService.getViewPermissions(viewer, target)` определяет, какие поля и табы возвращаются.
3. **UI** — рендерит только то, что есть в `permissions.tabs` / `permissions.actions`.

Server — единственный источник правды. Mutation guards остаются активными — даже если на UI можно нажать кнопку, сервер проверит `permissions.actions` ещё раз.

---

## 8. Error handling

- **Validation:** Zod errors → 400 с field errors → inline под полями (react-hook-form + zodResolver для модалок).
- **Permission errors:** 403 → toast «Нет доступа». Страница не редиректит — viewer уже на разрешённом контенте.
- **Network errors:** TanStack Query retry x1, потом toast.
- **Requisites change:** modal warning обязателен.
- **Archive user:** confirmation dialog с вводом имени.
- **Self-edit autosave:** очередь mutations, toast on each success/error.

---

## 9. Testing

### Backend (Vitest, `apps/api`)

- `users-access.service.spec.ts` — снимки `getViewPermissions` для всех 25 комбинаций viewer×target.
- `audit-interceptor.spec.ts` — diff logic, transaction atomicity.
- `users.controller.spec.ts` — guards (403 для не-ADMIN на admin endpoints).
- `migrations/0012.spec.ts` — backfill wallet_address → wallet_usdt_erc20.

### Frontend (Vitest, `apps/web`)

- `UserProfileShell.test.tsx` — render табов из permissions.
- `RequisitesEditForm.test.tsx` — switching USDT/Bank UAH, валидация IBAN/РНОКПП.
- `AuditLogTab.test.tsx` — пагинация, фильтры.
- `ProfileEditFields.test.tsx` — debounce 800ms, queueing.

### E2E (Playwright, `apps/e2e`)

- `profile-self-edit.spec.ts` — debounce autosave, toast после сохранения, refresh → данные сохранены.
- `admin-actions.spec.ts` — dropdown, изменение роли, проверка лога создаётся.
- `rbac-hr-on-senior.spec.ts` — HR логинится, идёт на `/users/:senior-id`, проверяет отсутствие табов «Финансы», «Реквизиты», «История».
- `rbac-junior-on-other.spec.ts` — JUNIOR на чужом, только header виден.
- `requisites-warning.spec.ts` — modal появляется → confirm → save.

---

## 10. Migration & rollout

### Первый PR (this spec)

- Drizzle migration 0012 (single-step) + backfill + drop wallet_address.
- Drizzle migration для `user_audit_log` (создание таблицы).
- Backend: `users-access.service`, audit interceptor, новые endpoints, Zod schemas в `@crm/shared`.
- Frontend: `UserProfileShell` + табы + admin-actions + self-edit + requisites form.
- Seed обновить: новые поля для test fixtures.
- Tests (Vitest + Playwright).

### Не в этом PR (отдельные итерации)

- **Avatar S3 upload** — требует bucket setup (env, IAM, sharp pipeline).
- **Documents tab** — Phase 6, отдельная фича документов с ACL.
- **Users list refactor** — `/crm/users/index.tsx` (1360 строк монолита) — отдельный technical-debt PR.
- **Archive page** + hard delete UI — `/crm/users/archive`.
- **Impersonate** action — требует session model изменения.

---

## 11. Open questions (для имплементации)

- Hard delete с архива: каскад на FK или soft-only forever (`deleted_forever_at`)? — обсуждается при имплементации archive-страницы.
- Audit log retention: храним вечно или auto-cleanup через N дней? — пока вечно, оптимизация позже.
- `tech_stack` UI: текстовое поле с auto-suggest (на базе уникальных значений из БД) или просто chip-input freeform? — текущее предложение: chip-input freeform.

---

**Подписано:** дизайн обсуждён через Visual Companion и итеративные clarifying questions (2026-05-20). Готов к imploplementation planning.
