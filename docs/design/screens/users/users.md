# Screen: Users list + add employee

| Field              | Value                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen             | Users list (`/users`) + create / edit / archive / restore of a user                                                                                                                             |
| Route / trigger    | `apps/web/app/routes/_authenticated/users/index.tsx`; components in `apps/web/app/components/users/` (`UserRow`, `UnarchiveButton`, `UserDialog` + `user-dialog/*`, `ArchiveUserConfirmDialog`) |
| Roles              | ADMIN only (see "Current → RBAC")                                                                                                                                                               |
| Claude Design URL  | none — `design-gate: degraded` (no headless Claude Design); HTML prototypes rendered with Playwright                                                                                            |
| Status             | draft — mockup council pending                                                                                                                                                                  |
| Plan task          | Wave 2, Task 2.1 (`docs/superpowers/plans/2026-11-11-crm-redesign-v2.md`)                                                                                                                       |
| Last synced commit | origin/main at branch creation (`docs/design-screen-users`)                                                                                                                                     |

> Built only from `docs/design/foundation.md` v2 and the primitives in `docs/design/screens/_foundation/`
> (`primitives-v2.md`, `shell-v2.md`). Where a needed primitive is missing it is listed under
> "Open points", never invented here.

---

## 1. Current

Captured from the code on origin/main. Device baseline captures (iOS Simulator Safari 375, Android
emulator, desktop 1440) and the `recordNetwork` baseline: **pending** — this machine has no iOS
Simulator or Android emulator, and the baseline belongs to the Capture step run by Master
(`assets/baseline/` is not created by this PR).

### 1.1 RBAC — what each role may see and do today (kept unchanged)

| Role                           | `/users` today                                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADMIN                          | Opens the screen. Lists, searches, filters, sorts; creates every role except ADMIN (create role list = SENIOR, JUNIOR, HR, ACCOUNTANT, DROP); edits; archives; restores.                                                                                                                                                        |
| SENIOR, JUNIOR, HR, ACCOUNTANT | No nav entry (`navRolesFor('/users')` = ADMIN). `route-access` maps the `/users` prefix to ADMIN only; the authenticated layout redirects a disallowed role to its role home (`resolveRoleHome`, `replace`). The page's own fallback panel «Доступ лише для адміністратора» is only reachable if that redirect has not run yet. |
| DROP                           | Same as above; additionally `useRoleGuard` on the page redirects DROP.                                                                                                                                                                                                                                                          |

Variants **inside** ADMIN that the design must keep:

- **Self row** — a «Ви» marker after the name; the row is tinted; archive is shown **disabled** with the
  reason «Не можна архівувати себе»; edit is available, but in the edit form the role is locked with
  «Свою роль змінити не можна».
- **Another ADMIN's row** — no edit and no archive action at all (an ADMIN cannot edit another ADMIN).
- **Archived row** — dimmed, an «В архіві» badge, the trailing action is «Відновити з архіву» (edit is
  still offered); restore runs at once, no confirm (`useUnarchiveUser`, senior-pair handling inside).
- `UserDialog` has an `hrOnly` prop (HR creating a SENIOR only). It has **no caller** outside
  `components/users/`, and HR cannot open `/users`, so no HR variant is designed.

### 1.2 Blocks

1. **Header** — title, count «{filtered} з {total}» plus « · архів» / « · усі» for the non-default tab;
   primary button «Додати користувача» (`users-create-button`).
2. **Status tabs** — `SegmentedToggle variant="tabs"`: Усі / Активні / Архів (`users-toggle-archived`).
   Default «Активні». Only «Архів» is held in the URL (`?archived=true`); «Усі» / «Активні» are local
   state.
3. **Toolbar card** — search «Пошук за ім’ям, email, Telegram, технологіями…» (client-side over
   name, email, Telegram, tech stack); role select («Усі ролі» + every role); sort-key select «За ім’ям /
   За роллю / За датою додавання» (`users-sort-key`); sort-direction icon button
   (`users-sort-direction`, «Напрямок сортування: за зростанням / за спаданням»). All filtering and
   sorting is client-side over the loaded list.
4. **List** (`users-list`, no column headers). Per row (`UserRow`, grid `3fr 1.4fr 64px`):
   - avatar 40 px; name as a link to `/profile/$userId` whose hit area stretches over the whole row;
     «Ви» marker;
   - second line: `mailto:` email · Telegram (validated `t.me` link) · `tel:` phone — each its own link;
   - up to 5 tech-stack chips + «+N»;
   - right column: «В архіві» badge, role badge (`ROLE_VARIANT` colour), relative created time;
   - trailing actions (40 % opacity until row hover): «Відновити з архіву» (archived only),
     «Редагувати {name}», «Архівувати {name}» (destructive; disabled for self).
5. **States** — loading: 6 skeleton rows; empty: «Користувачів поки немає»; filtered empty: «Нічого не
   знайдено — скиньте фільтри». Entrance animations via Framer Motion.

### 1.3 Modals / sheets

| Container                  | Content today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UserDialog mode="create"` | Centred dialog `sm:max-w-lg`, «Новий користувач». **Wizard** (`CreateWizardStepper`): «Дані» → «Контракт» → «Підтвердження». Step «Дані» is one scroll of sections: Основне (email, personal email — optional, invite goes there at once; name; role; interface language) · Дані для контракту (non-ADMIN role: legal name, registration address FOP) · Контакти (Telegram, phone) · Професія (tech stack) · Фінанси (SENIOR share %, DROP share % default 5, otherwise monthly salary + currency) · Реквізити для виплат (SENIOR/ADMIN: USDT ERC-20 only; others: USDT or ФОП UAH with wallet / FOP fields) · Команда (SENIOR: create own team with HR multiselect + accountant + Telegram channel, or join a drop team; DROP: drop team HR + accountant + channel; JUNIOR: optional project). «Далі» on «Дані» **POSTs the user** (invite sent); «Назад» → edit → «Далі» PATCHes, never POSTs twice. «Контракт»: CodeMirror contract editor seeded from the role's template, or «Немає активного шаблону контракту для цієї ролі». «Підтвердження»: «Користувача створено» + «Зберегти чернетку» / «Позначити готовим до підписання». **DROP** goes through the dedicated drop endpoint and closes after «Дані» (toast «Дропа створено»); it has no contract steps. |
| `UserDialog mode="edit"`   | Same dialog, «Редагувати користувача», all sections in one scroll, footer «Скасувати» / «Зберегти». Opens from the slim list row, then loads the full profile (`GET /users/:id`) and re-seeds the form (requisites, salary, FOP data are not in the list). An email change asks first (`EmailChangeWarningDialog`: «Змінити email?», old / new, «Підтвердити зміну»).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ArchiveUserConfirmDialog` | «Архівувати користувача»: «{name} більше не зможе увійти в CRM. Профіль можна відновити з архіву.»; an impact summary (`UserArchiveImpact`) and the user's pending transactions; on failure «Не вдалося порахувати наслідки архівації»; **typed confirmation** «Для підтвердження введіть ім’я: {name}»; «Скасувати» / «Архівувати».                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 1.4 Dual-mount pairs

`grep -nE "hidden (sm|md|lg):(block|flex|grid)|(sm|md|lg):hidden"` over
`routes/_authenticated/users/` and `components/users/`: **0 matches**. Nothing to convert to
`ByDevice` from the old screen; the new screen introduces `ByDevice` for the first time here.

### 1.5 Data

- List: `useQuery({ queryKey: ['users-admin', { archived: 'active' | 'true' | 'all' }] })` →
  `GET /users` (`?archived=true` / `?archived=all`), `placeholderData: keepPreviousData`. One request per
  tab; no pagination.
- Create / edit auxiliary data (`useUserDialogData`): HR users, accountants, teams, vacant drop teams,
  junior projects, exchange rates — fetched only while the form is open.
- Edit: `GET /users/:id` for the full profile.

---

## 2. Design

_Pending — next commit._

## 3. States

_Pending — next commit._

## 4. Self-score

_Pending._

## 5. Open points

_Pending._
