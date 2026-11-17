# Screen: Users list + add employee

| Field              | Value                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen             | Users list (`/users`) + create / edit / archive / restore of a user                                                                                                                             |
| Route / trigger    | `apps/web/app/routes/_authenticated/users/index.tsx`; components in `apps/web/app/components/users/` (`UserRow`, `UnarchiveButton`, `UserDialog` + `user-dialog/*`, `ArchiveUserConfirmDialog`) |
| Roles              | ADMIN only (see "Current → RBAC")                                                                                                                                                               |
| Claude Design URL  | none — `design-gate: degraded` (no headless Claude Design); HTML prototypes rendered with Playwright                                                                                            |
| Status             | draft — mockup council pending                                                                                                                                                                  |
| Plan task          | Wave 2, Task 2.1 (`docs/superpowers/plans/2026-11-11-crm-redesign-v2.md`)                                                                                                                       |
| Last synced commit | `11554c089` (merge-base with origin/main)                                                                                                                                                       |

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

**Direction.** A quiet, dense admin tool. People open it rarely and with a purpose: find a person, add
a person, fix a person. The list is for scanning names and roles; the create flow is long and rare, so it
is a guided form with a visible step count and an explicitly named commit point («Створити
користувача»), never a surprise POST behind «Далі». Yellow (`--primary`) stays the only accent: the
primary action, the active tab, the «Ви» marker, the stepper's done bars.

Mockups: every PNG lives in `assets/users/`. They are rendered from the HTML generators in
`assets/src/` (`users.mjs` phone, `users-wide.mjs` tablet + desktop, `users-forms.mjs` shared form
bodies). `cd assets/src && node render.mjs [name-filter]` re-renders; `HTML_OUT=<dir>` keeps the
self-contained HTML of each frame. All names, emails, phones and counts are invented.

### 2.1 Rules shared by every layout

- **No new capability, data or KPI.** Every field, action and RBAC variant of §1 is kept, nothing is
  added. The one behavioural change is where the create POST sits (see 2.5).
- **One query key for both layouts:** `['users-admin', { archived }]`, the same as today. The page mounts
  one layout through `ByDevice` (single mount); a breakpoint change does not refetch and does not
  remount the form. The edit form's `GET /users/:id` and the form's auxiliary queries keep their keys.
- **Filters.** Status (Активні · Архів · Усі, default Активні), role (one role or none), search
  (client-side over name, email, Telegram, tech stack — unchanged), sort (Ім’я · Роль · Додано, asc /
  desc). Status, role and sort go to the URL (open point 5); search stays local.
- **RBAC variants kept, in every layout.** Self row: «Ви»; archive disabled with «Не можна архівувати
  себе»; role locked in edit with «Свою роль змінити не можна». Another ADMIN's row: no edit, no archive,
  no swipe, no «⋯». Archived row: dimmed, «В архіві», «Відновити з архіву» runs at once (no confirm), edit
  still offered. Non-ADMIN roles never see the screen (redirect); the in-page «Доступ лише для
  адміністратора» panel is designed only as the fallback it is today.
- **Row → profile.** The name (and on phone the whole row) is the link to `/profile/$userId`, as today.

### 2.2 Phone (< 640) — `list-375.png`, `list-320.png`

- **Shell.** `/users` is an ADMIN tab (tab bar: Фінанси · Користувачі · Статистика · Адмін · Ще). Large
  title «Користувачі» collapsing into the top bar; bell in the top bar.
- **Sticky search** «Ім’я, email, Telegram…» (16 px input) with a 44 px clear button once typed
  (`filtered-375.png`).
- **Filter row:** status segmented control (Активні · Архів · Усі) + a «Роль» chip that opens the role
  filter sheet (`role-filter-375.png`, «Фільтр за роллю»: «Усі ролі» + all six roles, Адміністратор
  included); a chosen role turns the chip yellow-subtle with an ×. The create flow's role picker
  (`role-picker-375.png`) is a different list: it has no «Адміністратор», as today.
- **Count + sort header:** «38 користувачів» left; sort button right («↑ Ім’я»), opening the sort
  choices. Sorted by «Додано», each row shows its relative created time (`sorted-added-375.png`).
- **Rows** (`.lrow.two`, 64 px): avatar initials 40 · name (+ «Ви») · second line «Роль · email»;
  archived rows end with the archive-date pill. Tech chips and the `mailto:` / `tel:` / `t.me` links are
  not on the phone row: the row is one link to the profile, which has them (open point 11).
- **Swipe** (trailing edge, `swipe-375.png`): «Змінити» + «Архівувати» (88 px each); archived rows:
  «Змінити» + «Відновити» (88 px each). The visible alternative to the swipe is the profile's own actions. Self row: no
  «Архівувати» in the swipe; another ADMIN's row: no swipe.
- **Create:** the FAB «+» (bottom right, above the tab bar) opens a **full-height sheet** «Новий
  користувач» (`create-1-375.png`): lead «Скасувати», stepper «Крок n з N» + step title + bars, the form,
  and a fixed action bar at the bottom (Назад · primary). Steps in 2.5.
- **Edit:** the same sheet, «Редагувати», all sections in one scroll, «Зберегти» disabled until the
  profile has loaded (`edit-375.png` → `edit-loaded-375.png`).
- **Archive:** a confirm sheet «Архівувати» (`role="alertdialog"`, aria-label «Архівувати
  користувача») with the impact copy, pending transactions and the typed-name field; the destructive
  button is `aria-disabled` until the name matches (`archive-confirm-375.png` → `archive-armed-375.png`).

### 2.3 Tablet (640–1023) — `list-768.png`, `list-960.png`

- **Shell:** the 80 px rail with the «+» create button (52) at its top; touch density (44 targets,
  16 px inputs, 52 px rows).
- **< 900, one pane:** the phone list in a wider column (search, filters, count/sort, rows). Row tap
  pushes the profile.
- **≥ 900, two panes:** list 360 + a detail pane built **only from the list row** (no extra request):
  avatar 64, name, «Роль · додано …», Email / Telegram / Телефон as links (an empty contact is omitted),
  tech chips, a secondary «Відкрити профіль» button and the line «Фінанси, контракти й документи — у
  профілі.». Header: «Редагувати» + «⋯» (Архівувати… / Відновити з архіву). See open point 4.
- **Create / edit:** the side panel 400, touch header «Скасувати | Новий користувач», the same stepper
  and phone action bar (`create-768.png`, `create-3-768.png`). Modal: scrim, focus trap.

### 2.4 Desktop (≥ 1024) — `list-1024.png`, `list-1280.png`, `list-1440.png`

- **Shell:** sidebar (group «Люди» → «Користувачі» active), header crumb «Люди › Користувачі», primary
  CTA «Додати користувача» with the «C» key hint. Content max-width 1280 at ≥ 1440.
- **Toolbar:** search (`/` focuses it) · status tabs Активні · Архів · Усі · role filter chip «+ Роль»
  (chosen: «Роль: Сеньйор ×», `filtered-1440.png`) · count «38 користувачів» right (`role="status"`).
- **Table** (foundation dense table: th 36, td 40; `table-layout: fixed`, Email is the one flexible
  column, so «Додано» and the actions never leave the viewport — `long-1024.png`, `long-1440.png`):
  - 1024–1279: Користувач · Роль · Email · Додано · actions;
  - 1280–1439: + Технології (2 chips + «+N») before Додано;
  - ≥ 1440: + Telegram after Email (at 1280 it would squeeze Email below a readable width).
  - Email cells are `mailto:` links, Telegram cells `t.me` links; the name cell links to the profile.
  - Телефон is not a column (detail pane / profile), as the search does not cover it either.
  - Sorting by the column headers Користувач / Роль / Додано (`aria-sort`) replaces today's sort-key
    select + direction button: same capability, one control.
- **Row actions** (visible on hover and `:focus-within`, always in the tab order): pencil «Редагувати
  {name}» + «⋯» menu (Відкрити профіль · Редагувати · Архівувати…) — `row-menu-1440.png`. Self:
  «Архівувати…» disabled with «Не можна архівувати себе» shown in the menu (`row-menu-self-1440.png`).
  Archived: the pencil is replaced by «Відновити з архіву {name}» and the «⋯» menu holds Відкрити
  профіль · Редагувати (`archive-1440.png`). Another ADMIN's row has no row actions, as today. Under
  `(pointer: coarse)` at desktop width the actions are always visible at 44 px and rows are 52
  (`touch-1024.png`).
- **Create / edit panel** (primitives-v2 side panel): 1024–1439 **modal 420** with scrim
  (`create-1-1024.png`); ≥ 1440 **non-modal 480**, no scrim, table stays usable (`create-1-1440.png`).
  Fields 40 px / 14 px (fine pointer only). Footer: «Назад» left; «Скасувати» + primary with «⌘↵» right.
  On «Підтвердження» the two outcome buttons fill the footer, so the «⌘↵» hint is dropped there
  (`create-5-1440.png`); the shortcut still triggers the primary.
  Esc closes (a dirty form asks first, `dirty-close-1440.png`).
- **Archive:** centred `alertdialog` 520 «Архівувати користувача» with the same body and typed-name
  field (`archive-confirm-1440.png`, `archive-armed-1440.png`). Email change: centred 420
  (`email-change-1440.png`). Dirty close: centred 420, focus on «Залишитися».

### 2.5 Create flow (all layouts)

Today's three wizard stages stay; the long «Дані» stage is split into three screens so no step is a
two-screen scroll on a phone. Steps: **Особа → Роль і команда → Оплата → Контракт → Підтвердження**
(DROP: the first three only, via the drop endpoint as today).

| Step           | Content (all fields from today's form)                                                                                                                                                                              | Frames                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Особа          | Ім’я та прізвище · Email · Особистий email (необов’язково, invite hint) · Мова інтерфейсу (Українська / English) · Контакти: Telegram, Телефон                                                                      | `create-1-375`, `create-1-1440`, `create-1-1024`, `create-768`              |
| Роль і команда | Роль (picker) · SENIOR: Тип команди (Своя команда / Команда дропа), HR + «Додати HR», Бухгалтер, Telegram-канал · JUNIOR: Проєкт (optional) · DROP: drop team fields · Професія → Технології                        | `create-2-375`, `create-2-junior-375`, `create-2-drop-375`, `create-2-1440` |
| Оплата         | Дані для контракту (Юридичне ПІБ, Адреса реєстрації ФОП) · Фінанси (SENIOR share / DROP share / salary + currency) · Реквізити (SENIOR: USDT ERC-20 only; others: USDT or ФОП UAH). Primary: «Створити користувача» | `create-3-375`, `create-3-junior-375`, `create-3-1440`, `create-3-768`      |
| Контракт       | «Користувача створено. Контракт можна додати зараз або пізніше з профілю користувача.» + contract text with highlighted placeholders, or «Немає активного шаблону контракту для цієї ролі»                          | `create-4-375`, `create-4-none-375`, `create-4-1440`                        |
| Підтвердження  | Summary (Ім’я, Роль, Email, Контракт: Чернетка) · «Зберегти чернетку» / «Позначити готовим до підписання»                                                                                                           | `create-5-375`, `create-5-1440`                                             |

- **The POST is on «Створити користувача»** (end of «Оплата»), not on a generic «Далі»; the invite is
  sent at that moment, to the personal email when given (as today). Steps 1–2 only validate locally.
  After the POST, «Назад» edits and PATCHes (never a second POST), and the lead becomes «Закрити».
- **Pending:** the primary shows a spinner and is `aria-disabled`; the form stays readable; no overlay
  spinner (`create-pending-375.png`).
- **409 USER_EMAIL_EXISTS:** jumps back to «Особа» with the error under Email «Ця електронна адреса вже
  зайнята. Введіть іншу», focus on the field (`create-error-375.png`).
- **Failed (server answered with an error):** alert «Не вдалося створити користувача» / «Сервер
  відхилив запит. Нічого не створено — введене залишилось у формі.» (`create-failed-375.png`).
- **Unknown outcome (timeout / network drop):** alert «Невідомо, чи користувача створено» / «Відповідь
  не надійшла. Введене залишилось у формі. Повторити безпечно: двічі одного користувача система не
  створить.»; the primary becomes «Спробувати ще раз» (`create-unknown-375.png`,
  `create-unknown-1440.png`). Never an automatic retry. A retry answered 409 on the same email refetches
  `['users-admin', …]`; if that email is in the list, the user counts as created and the flow continues
  at «Контракт».
- **Dirty close:** «Вийти без збереження?» / «Введені дані буде втрачено.» · «Вийти» / «Залишитися»
  (`dirty-close-375.png`); after the POST, closing never asks (the user exists).

### 2.6 Interaction and motion

Foundation motion only: sheet slide-up and panel slide-in with the foundation durations; dialogs fade +
scale; the stepper bars fill with a 150 ms colour change. Row entrance animations of today are dropped
(a list of 40 rows that animates in reads as lag). `prefers-reduced-motion`: every transition becomes
a fade. Keyboard (desktop): `C` opens create, `/` focuses search, `⌘↵` submits the current step, `Esc`
closes the panel / dialog (focus inside), arrow keys move through the «⋯» menu.

### 2.7 Accessibility (WCAG 2.2 AA)

- Targets ≥ 44 px wherever `(pointer: coarse)` holds (phone, tablet, touch at desktop width); 32 px
  icon buttons only under a fine pointer. Inputs 16 px on touch; 14 px only in the fine-pointer panel.
- Desktop list is a real `<table>` with `<th scope="col">` and `aria-sort` on the sortable headers; the
  actions header has a visually hidden «Дії». Phone list is a `<ul>` of links.
- Every icon-only button names its object: «Редагувати {name}», «Відновити з архіву {name}», «Дії:
  {name}», «Очистити пошук».
- Status: segmented `radiogroup` «Статус»; role chip `aria-haspopup="listbox"`; count `role="status"`.
- Stepper: `role="group"` with aria-label «Крок n з N: {title}»; the step change moves focus to the
  step title.
- Errors: text under the field, `aria-invalid` + `aria-describedby`, focus to the first invalid field;
  never colour alone. Create failure / unknown: `role="alert"`; pending: `role="status"`.
- Archive: `alertdialog` with `aria-describedby` on the impact text; the destructive button stays
  focusable with `aria-disabled` until the name matches. Dirty / email confirms: focus starts on the safe
  button.
- Modal panels and dialogs trap focus and return it to the trigger; the ≥ 1440 panel is non-modal (no
  trap), Esc works when focus is inside it.
- Contrast from foundation tokens; dimmed archived rows keep `--muted-foreground` (≥ 4.5:1 on `--card`).

### 2.8 Strings (uk → en)

Existing strings keep their catalog msgids (en from `packages/shared/src/i18n/locales/en/messages.po`).
**New** strings need catalog entries in both languages.

| uk                                                                                                                   | en                                                                                                              | Status                                                                                                |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Користувачі                                                                                                          | Users                                                                                                           | existing                                                                                              |
| Додати користувача                                                                                                   | Add user                                                                                                        | existing                                                                                              |
| Новий користувач / Редагувати користувача                                                                            | New user / Edit the user                                                                                        | existing                                                                                              |
| Активні / Архів / Усі                                                                                                | Active / Archived / All                                                                                         | existing                                                                                              |
| Роль / Додано / Дії / Телефон                                                                                        | Role / Added / Actions / Phone                                                                                  | existing                                                                                              |
| Ви / В архіві                                                                                                        | You / Archived                                                                                                  | existing                                                                                              |
| Відновити з архіву / Архівувати користувача                                                                          | Restore from archive / Archive user                                                                             | existing                                                                                              |
| Не можна архівувати себе / Свою роль змінити не можна                                                                | Can't archive yourself / You can't change your own role                                                         | existing                                                                                              |
| Нічого не знайдено — скиньте фільтри / Скинути фільтри                                                               | No matches — clear the filters / Reset filters                                                                  | existing                                                                                              |
| Очистити пошук                                                                                                       | Clear search                                                                                                    | existing                                                                                              |
| Доступ лише для адміністратора                                                                                       | Admin access only                                                                                               | existing                                                                                              |
| Змінити email? / Підтвердити зміну                                                                                   | Change the email? / Confirm the change                                                                          | existing                                                                                              |
| Користувача створено / Зберегти чернетку / Позначити готовим до підписання                                           | User created / Save draft / Mark ready to sign                                                                  | existing                                                                                              |
| Немає активного шаблону контракту для цієї ролі                                                                      | No active contract template for this role                                                                       | existing                                                                                              |
| Контракт / Підтвердження / Далі / Назад / Зберегти / Закрити / Спробувати ще раз                                     | Contract / Confirmation / Next / Back / Save / Close / Try again                                                | existing                                                                                              |
| Скасувати (closing a form)                                                                                           | Cancel                                                                                                          | existing (the plain msgid, not the «undo a hide» context)                                             |
| Вийти без збереження? / Введені дані буде втрачено. / Вийти / Залишитися                                             | Leave without saving? / What you entered will be lost. / Leave / Stay                                           | new (foundation dirty-close confirm); «Вийти» needs its own context — the plain msgid means «Log out» |
| Створити користувача                                                                                                 | Create user                                                                                                     | new                                                                                                   |
| Крок {n} з {total}                                                                                                   | Step {n} of {total}                                                                                             | new                                                                                                   |
| Особа / Роль і команда / Оплата                                                                                      | Person / Role and team / Pay                                                                                    | new                                                                                                   |
| Своя команда                                                                                                         | Own team                                                                                                        | new                                                                                                   |
| Додати HR                                                                                                            | Add HR                                                                                                          | new                                                                                                   |
| Невідомо, чи користувача створено                                                                                    | We don't know whether the user was created                                                                      | new                                                                                                   |
| Відповідь не надійшла. Введене залишилось у формі. Повторити безпечно: двічі одного користувача система не створить. | No response came back. Your input is still in the form. Retrying is safe: the same user is never created twice. | new                                                                                                   |
| Не вдалося створити користувача                                                                                      | Couldn't create the user                                                                                        | new                                                                                                   |
| Сервер відхилив запит. Нічого не створено — введене залишилось у формі.                                              | The server rejected the request. Nothing was created — your input is still in the form.                         | new                                                                                                   |
| Ця електронна адреса вже зайнята. Введіть іншу                                                                       | catalog value of `USER_EMAIL_EXISTS`                                                                            | existing (`packages/shared/src/schemas/api-errors/auth-users-projects.ts`)                            |
| {n} користувачів / {n} з {total} / {n} в архіві / {n} активних                                                       | {n} users / {n} of {total} / {n} archived / {n} active                                                          | new (ICU plural in uk)                                                                                |
| Немає користувачів, що відповідають пошуку «{q}» і ролі «{role}».                                                    | No users match “{q}” with the role “{role}”.                                                                    | new                                                                                                   |
| Фільтр за роллю / Усі ролі                                                                                           | Filter by role / All roles                                                                                      | new                                                                                                   |
| Адміністратор / Сеньйор / Джуніор / HR / Бухгалтер / Дроп                                                            | role labels                                                                                                     | existing (role label map)                                                                             |
| Змінити / Відновити / Архівувати (swipe actions)                                                                     | Edit / Restore / Archive                                                                                        | new (short swipe labels)                                                                              |
| щойно (relative time)                                                                                                | just now                                                                                                        | new (the existing «щойно» msgids are sentences)                                                       |
| Старий: / Новий:                                                                                                     | Old: / New:                                                                                                     | existing                                                                                              |
| Для підтвердження введіть ім’я:                                                                                      | To confirm, type the name:                                                                                      | existing                                                                                              |
| Archive impact copy (linked pair, «У команді … HR/бухгалтер…», «Відновлення можливе — …»)                            | catalog values                                                                                                  | existing (today's archive dialog, unchanged)                                                          |
| На цю адресу одразу піде запрошення — увійти нею співробітник зможе лише після того, як підтвердить адресу           | An invitation will be sent to this address right away — …                                                       | existing (invite hint)                                                                                |
| Мова інтерфейсу співробітника — він зможе змінити її у своєму профілі.                                               | The employee's interface language — they can change it in their own profile.                                    | existing                                                                                              |
| Можна прикріпити пізніше в розділі «Проєкти»                                                                         | You can attach one later in the Projects section                                                                | existing                                                                                              |
| Необов’язково. Канал для спілкування команди.                                                                        | Optional. A channel for the team to talk in.                                                                    | existing                                                                                              |
| Ця адреса підставляється в текст контракту                                                                           | This address is inserted into the contract text                                                                 | existing                                                                                              |
| Скільки дроп залишає собі з кожної виплати                                                                           | How much the drop keeps from each payout                                                                        | existing; the mockup's «За замовчуванням 5%» suffix is new («Default 5%»)                             |
| Для ролі «{roleLabel}» доступні лише виплати в USDT ERC-20.                                                          | Only USDT ERC-20 payouts are available for the “{roleLabel}” role.                                              | existing                                                                                              |
| Назва банку (необов’язково)                                                                                          | Bank name (optional)                                                                                            | existing                                                                                              |
| Бухгалтер (необов’язково)                                                                                            | Accountant (optional)                                                                                           | new label for the picker                                                                              |
| Не обрано / Без проєкту (picker placeholders)                                                                        | Not selected / No project                                                                                       | new; replace today's «— не обрано —» (picker sheets show plain text, no dashes)                       |
| Місто, вулиця, будинок / Наприклад, основний                                                                         | City, street, building / For example, main                                                                      | new; replace «м. Київ, вул. Хрещатик, 1» / «наприклад: основний» (a format hint, not a real address)  |
| Текст контракту / Поля в {{дужках}} заповняться з профілю користувача.                                               | Contract text / Fields in {{braces}} are filled from the user's profile.                                        | new                                                                                                   |
| «Готовий до підписання» — контракт піде на підпис. Чернетку можна доробити пізніше в профілі.                        | “Ready to sign” sends the contract for signing. A draft can be finished later in the profile.                   | new                                                                                                   |
| Не вдалося завантажити користувачів                                                                                  | Couldn't load users                                                                                             | new                                                                                                   |
| Сервер не відповів. Нічого не змінено — спробуйте ще раз.                                                            | The server didn't respond. Nothing changed — try again.                                                         | new                                                                                                   |
| В архіві нікого немає                                                                                                | Nobody is archived                                                                                              | new                                                                                                   |
| Тут з’являться архівовані користувачі. Будь-кого з них можна відновити.                                              | Archived users appear here. Any of them can be restored.                                                        | new                                                                                                   |
| Користувача створено. Контракт можна додати зараз або пізніше з профілю користувача.                                 | User created. Add the contract now, or later from the user's profile.                                           | new                                                                                                   |
| Завантажуємо профіль…                                                                                                | Loading the profile…                                                                                            | new                                                                                                   |
| Відкрити профіль                                                                                                     | Open profile                                                                                                    | new                                                                                                   |
| Фінанси, контракти й документи — у профілі.                                                                          | Finance, contracts and documents are in the profile.                                                            | new                                                                                                   |
| Дії з користувачем                                                                                                   | User actions                                                                                                    | new                                                                                                   |
| Цей розділ відкривається тільки адміністраторам. Зазвичай вас одразу переносить на ваш головний екран.               | This section is for admins only. You are normally taken straight to your home screen.                           | new                                                                                                   |

## 3. States

Every state at 375 and 1440 unless noted (`assets/users/<name>.png`).

| State                      | Phone                                                                                                                       | Desktop / tablet                                                                      | Notes                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default (main)             | `list-320`, `list-375`                                                                                                      | `list-768`, `list-960`, `list-1024`, `list-1280`, `list-1440`                         | 1440 shows the hover row with its actions                                                                                                                                                            |
| Loading                    | `loading-375`                                                                                                               | `loading-1440`                                                                        | Skeleton rows in the final row shape; toolbar stays usable; count hidden                                                                                                                             |
| Empty — archive            | `archive-empty-375`                                                                                                         | `archive-empty-1440`                                                                  | «В архіві нікого немає»                                                                                                                                                                              |
| Empty — no users at all    | —                                                                                                                           | —                                                                                     | Kept as today («Користувачів поки немає»), not drawn: practically unreachable (open point 8)                                                                                                         |
| Role filter                | `role-filter-375`                                                                                                           | `filtered-1440` (chip chosen)                                                         | «Усі ролі» + six roles; the create picker has no «Адміністратор»                                                                                                                                     |
| Filtered / no results      | `filtered-375`, `no-results-375`                                                                                            | `filtered-1440`, `no-results-1440`                                                    | «Скинути фільтри» clears search + role                                                                                                                                                               |
| Archive tab                | `archive-375`                                                                                                               | `archive-1440`                                                                        | Dimmed rows, date pill / «Відновити з архіву»                                                                                                                                                        |
| Error (list)               | `error-375`                                                                                                                 | `error-1440`                                                                          | New: today the list has no error state                                                                                                                                                               |
| Offline / unknown outcome  | `offline-375`, `create-unknown-375`                                                                                         | `create-unknown-1440`                                                                 | Foundation offline banner on the list; the create's unknown outcome keeps the input                                                                                                                  |
| Long content               | `long-320`, `long-375`                                                                                                      | `long-1024`, `long-1440`                                                              | Long name / email truncate with ellipsis; the full value is in the profile and the link's accessible name                                                                                            |
| Partial (edit loading)     | `edit-375`                                                                                                                  | `edit-1440`                                                                           | Row data shown at once; finance / requisites skeleton until `GET /users/:id`; «Зберегти» disabled                                                                                                    |
| Swipe / row menu           | `swipe-375`                                                                                                                 | `row-menu-1440`, `row-menu-self-1440`                                                 |                                                                                                                                                                                                      |
| Create steps               | `create-1…5-375`, `create-2-junior-375`, `create-2-drop-375`, `create-3-junior-375`, `create-4-none-375`, `role-picker-375` | `create-1-1440`, `create-1-1024`, `create-2/3/4/5-1440`, `create-768`, `create-3-768` |                                                                                                                                                                                                      |
| Create pending / errors    | `create-pending-375`, `create-error-375`, `create-failed-375`                                                               | —                                                                                     | Same components on desktop                                                                                                                                                                           |
| Dirty close                | `dirty-close-375`                                                                                                           | `dirty-close-1440`                                                                    |                                                                                                                                                                                                      |
| Edit / self / email change | `edit-loaded-375`, `edit-self-375`, `email-change-375`                                                                      | `email-change-1440`                                                                   |                                                                                                                                                                                                      |
| Archive confirm            | `archive-confirm-375`, `archive-armed-375`                                                                                  | `archive-confirm-1440`, `archive-armed-1440`                                          | Destructive button armed only by the typed name                                                                                                                                                      |
| Permission-limited         | `permission-375`                                                                                                            | `permission-1440`                                                                     | Fallback only; the layout redirect normally runs first. The 1440 frame shows the ADMIN sidebar only because the foundation `desktop()` generator fixes the role; a real non-admin sees their own nav |
| Touch at desktop width     | —                                                                                                                           | `touch-1024`                                                                          | 52 px rows, 44 px always-visible actions                                                                                                                                                             |

## 4. Self-score

Against `docs/design/rubric-calibration.md`, mockup gate. Data visualisation (criterion 8) does not apply;
weights renormalised over 93.

| #   | Criterion (weight)    |   Phone |  Tablet | Desktop | Why not higher                                                                                |
| --- | --------------------- | ------: | ------: | ------: | --------------------------------------------------------------------------------------------- |
| 1   | Time-to-task (15)     |       9 |       9 |     9.5 | Create is 5 screens on touch; defaults are generic (language = uk, nothing else to pre-fill)  |
| 2   | Never blocks (15)     |     9.5 |     9.5 |     9.5 | The create POST waits for the server (non-blocking pending; carve-out), no optimistic row     |
| 3   | Navigation (10)       |     9.5 |     9.5 |     9.5 | Tablet detail pane is a preview; full data needs one more push to the profile                 |
| 4   | Forms and input (10)  |       9 |       9 |       9 | Legal name is not pre-filled from «Ім’я та прізвище»; validation on step advance, not on blur |
| 5   | Lists and tables (10) |       9 |       9 |       9 | No bulk select or inline edit (not a capability today); URL filters depend on open point 5    |
| 6   | Sheets, panels (8)    |       9 |     9.5 |     9.5 | Full-height create sheet does not drag-dismiss while dirty (asks instead)                     |
| 7   | System states (10)    |       9 |       9 |       9 | Archive has a typed confirm, not an undo (open point 7)                                       |
| 9   | Platform fit (8)      |     9.5 |     9.5 |     9.5 | Not measured on a device yet (baseline pending)                                               |
| 10  | Accessibility (7)     |     9.5 |     9.5 |     9.5 | Stepper is a new pattern without a foundation primitive (open point 1)                        |
|     | **Overall**           | **9.2** | **9.3** | **9.3** |                                                                                               |

**Weakest criterion:** phone and tablet — **1 Time-to-task** (weight 15; the 5-step create on touch);
desktop — **7 System states** (archive without undo).

## 5. Open points

Each with a recommendation.

1. **No stepper primitive in foundation v2.** The create flow needs «Крок n з N» + step title + bars.
   _Recommendation:_ add it to `primitives-v2.md` as drawn here (overline in `t-foot`, not the
   uppercase `t-over`, so «Крок 1 з 5» does not read as «1 3 5»).
2. **Foundation `form-add-user-375` vs the code.** The foundation frame implies the invite goes to the
   work email; the code sends it to the personal email when given. _Recommendation:_ follow the code
   (this spec does) and correct the foundation frame in its next revision.
3. **Archive typed confirm in a sheet / dialog, not the foundation action sheet.** The action sheet
   cannot hold the impact list and a text field. _Recommendation:_ accept the confirm sheet (phone) /
   centred `alertdialog` (desktop) for destructive confirms that need typing; note it in primitives-v2.
4. **Tablet detail pane from row data only.** The full profile belongs to Task 2.2. _Recommendation:_
   keep the pane a preview with «Відкрити профіль»; replace it with the Task 2.2 profile pane when that
   lands, under the same query keys.
5. **Status, role and sort in the URL** (today only `archived`). _Recommendation (A1, reversible):_ put
   all three in the search params; search text stays local.
6. **The create POST moves from «Далі» to «Створити користувача»** (end of «Оплата»). Same request, same
   fields, PATCH-not-POST on «Назад» kept. _Recommendation:_ accept; the commit moment becomes explicit
   and the invite is no longer sent from a button labelled «Далі».
7. **No undo for archive.** Restore exists, but archive is guarded by a typed name instead of an undo
   toast. _Recommendation:_ keep the typed confirm now (archive has team-wide side effects for a SENIOR);
   revisit an undo toast once the archive impact is reversible in one call.
8. **"No users yet" is practically unreachable** (the ADMIN viewing the screen is a user).
   _Recommendation:_ keep today's text, do not design a dedicated state.
9. **«Вийти» collides with «Log out» in the catalog.** _Recommendation:_ add the dirty-close strings
   with a `msgctxt` (e.g. "leave a form") when the confirm is implemented.
10. **Телефон dropped from the desktop table columns** (kept in the detail pane and profile; the search
    never covered it). _Recommendation:_ accept; add it back at ≥ 1600 only if owners ask.
11. **Phone rows lose the inline contact links and tech chips** (today's row shows `mailto:` / `tel:` /
    `t.me` links). The phone row is one 64 px link; two or three small links inside it would be sub-44
    targets nested in a target. _Recommendation:_ accept; the contacts are one tap away in the profile
    (and in the tablet detail pane).

## 6. Components (mapping to our stack)

| Visual block                         | Our component                                                                                                                                 | New?                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Phone / tablet list row              | `ListRow` (primitives-v2) + `ui/avatar.tsx`                                                                                                   | yes — the primitives-v2 one |
| Swipe actions                        | `ListRow` swipe variant (`listrow-swipe-375`)                                                                                                 | yes — the primitives-v2 one |
| Desktop table                        | `ui/table.tsx` (table row states)                                                                                                             | no                          |
| Row «⋯» menu                         | `ui/dropdown-menu.tsx`                                                                                                                        | no                          |
| Status filter                        | `ui/segmented-toggle.tsx`                                                                                                                     | no                          |
| Role filter / role picker            | PickerSheet on touch; `ui/popover.tsx` + `ui/command.tsx` on desktop                                                                          | PickerSheet — primitives-v2 |
| Search                               | `ui/input.tsx` (search) + clear `ui/button.tsx` icon                                                                                          | no                          |
| Create / edit sheet (phone)          | Large sheet / `ResponsiveSheet` (primitives-v2)                                                                                               | yes — the primitives-v2 one |
| Create / edit panel (tablet/desktop) | Side panel on `ui/sheet.tsx` (side = right); non-modal at ≥ 1440                                                                              | no                          |
| Stepper                              | —                                                                                                                                             | yes — open point 1          |
| Form fields                          | `ui/input.tsx`, `ui/label.tsx`, `ui/amount-currency-input.tsx`, `ui/phone-input.tsx`, `ui/tech-autocomplete-input.tsx`, `ui/share-slider.tsx` | no                          |
| Archive confirm, email change, dirty | `ui/alert-dialog.tsx` (desktop); confirm sheet on phone (open point 3)                                                                        | no                          |
| Create failed / unknown              | `ui/alert.tsx` (save error inline)                                                                                                            | no                          |
| Loading                              | `ui/skeleton.tsx` in the final row / cell shape                                                                                               | no                          |
| Empty / error / permission           | foundation state block                                                                                                                        | no                          |
| Desktop / phone switch               | `ByDevice` (redesign v2; one mount, one query; first use on this screen, §1.4)                                                                | yes — the redesign v2 one   |

## 7. Token-map

Only foundation v2 tokens (`docs/design/foundation.md`; `--scrim` and `--radius-sheet` are foundation
v2 additions not yet in `apps/web/app/styles/globals.css`, the rest exist there): surfaces `--background` / `--card` /
`--popover` / `--surface`; text `--foreground` / `--muted-foreground`; accent `--primary` (CTA, active chip,
stepper bars, focus ring); `--destructive` (archive button, field errors); `--scrim` (modal panel,
sheets); `--radius-sheet` for sheet corners. Type: `t-head` (titles), `t-foot` (stepper overline, row
second line, count), body for cells. No raw hex, no new tokens.

## 8. For the coder

- Build with our components per this spec; the PNGs are the fidelity reference (Mode B compares). The
  HTML generators in `assets/src/` are a visual reference, not code to paste.
- One query key for both layouts: `['users-admin', { archived }]`; role, sort and search filter on the
  client as today. No new endpoint, field or KPI.
- RBAC unchanged: the route stays ADMIN-only (§1.1); self row and other-ADMIN row restrictions as today.
- New strings: §2.8 rows marked "new" go into both catalogs (`uk` + `en`); «Вийти» needs a `msgctxt`.
- The create POST moves to «Створити користувача» (open point 6); PATCH-not-POST after it, as today.

`design-gate: degraded` — no headless Claude Design; HTML prototypes on foundation tokens.
