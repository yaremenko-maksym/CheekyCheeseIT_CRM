# Screen: Users list + add employee

| Field              | Value                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen             | Users list (`/users`) + create / edit / archive / restore of a user                                                                                                                             |
| Route / trigger    | `apps/web/app/routes/_authenticated/users/index.tsx`; components in `apps/web/app/components/users/` (`UserRow`, `UnarchiveButton`, `UserDialog` + `user-dialog/*`, `ArchiveUserConfirmDialog`) |
| Roles              | ADMIN only (see "Current → RBAC")                                                                                                                                                               |
| Claude Design URL  | none — `design-gate: degraded` (no headless Claude Design); HTML prototypes rendered with Playwright                                                                                            |
| Status             | draft — council round 1 fixes applied (ledger §9, assumptions §10); round 2 pending                                                                                                             |
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

### 1.6 Write behaviour today (read from the code, round 1)

Each line names the symbol it was read from (`apps/web/app/components/users/` unless a path is given).

- **Create POST** (`useUserDialogMutations`, create mutation): on success it stores the new id and moves
  to «Контракт»; it **invalidates no query**. 409 shows the duplicate toast and keeps the dialog open.
  Other errors: toast «Не вдалося створити користувача — дані залишилися у формі, спробуйте ще раз».
- **Drop create** (`/users/drops`, same hook): invalidates `users-admin`, `users`, `teams`, `projects`;
  toast «Дропа створено»; closes.
- **PATCH after the POST** (`buildWizardUpdatePayload`, `user-dialog/payloads.ts`) carries name,
  Telegram, phone, tech stack, payout method + wallet or FOP fields, SENIOR share + HR + accountant,
  non-SENIOR salary. It **omits** email, personal email, role, locale, team type / drop team, project
  and the team Telegram channel. It sends legal name and registration address only when non-empty, so it
  cannot clear them. `IdentitySection` does not lock those fields once the user exists, so an edit of
  them after «Назад» is silently dropped today.
- **Drop create payload** (`buildCreateDropPayload`) sends neither personal email nor locale, although
  `IdentitySection` shows both whenever `isCreate` (DROP included). Recorded as open point 13.
- **Contract step** (`WizardStep2`): the contract editor has its **own** save button
  (`useSaveContractBody`); the footer's «Далі» on that step only moves to «Підтвердження»
  (`UserDialogFooter`). No template: «Немає активного шаблону контракту для цієї ролі» + «Контракт можна
  додати пізніше з профілю користувача.» + «Натисніть «Далі», щоб продовжити без контракту.»
- **Draft / mark ready** (`useCreateWizard`, `useUserDialogMutations`): both invalidate `users-admin` and
  `users`; toasts «Користувача створено, контракт збережено як чернетку» / «Користувача створено, контракт
  готовий до підписання»; mark-ready error «Не вдалося позначити контракт готовим до підписання».
- **Edit save** (`buildEditUpdatePayload`): invalidates `users-admin`, `users`, `teams`,
  `['user-profile', id]`; toast «Зміни збережено» (or the share-proposal toast for a SENIOR share
  change); error toast «Не вдалося зберегти зміни — дані залишилися у формі, спробуйте ще раз».
- **Archive** (`ArchiveUserConfirmDialog`): impact query `['users-archive-impact', id]`, `staleTime: 0`;
  `DELETE /users/:id`; invalidates `users-admin` (+ `teams`, `projects` for SENIOR / DROP); cannot close
  while pending; error «Не вдалося архівувати користувача — спробуйте ще раз».
- **Restore** (`useUnarchiveUser`, `apps/web/app/hooks/use-user-profile.ts`): invalidates
  `['user-profile', id]`, `users`, `users-admin` (+ `teams` for SENIOR); error «Не вдалося відновити
  користувача. Спробуйте ще раз».
- **Edit sections** (`UserDialog`, edit mode): Основне (email, name, role) · Дані для контракту
  (non-ADMIN) · Контакти · Професія · Фінанси · Реквізити для виплат · Команда (SENIOR only: HR,
  accountant, Telegram channel; JUNIOR: read-only «Активні проєкти»; HR / ACCOUNTANT / DROP: none).
  Personal email and locale are create-only (`IdentitySection`).
- **Legal name** (`ContractDataSection`, `form-defaults.ts`): **not** pre-filled from the name; its
  default is the stored value or empty. Required on create for SENIOR, HR, JUNIOR, ACCOUNTANT, DROP.

**Council "today" claims checked:** IBAN in the FOP fields, the SENIOR team Telegram channel, DROP's
USDT-or-ФОП choice, «Місячна зарплата», the email-change consequence sentence — all **confirmed**.
«≈ USD» is confirmed with a condition: it shows only when the currency is not USD
(`ui/amount-currency-input.tsx`). The claimed invalidation list (`users-admin`, `teams`, `projects`) is
right for **archive only**: plain create invalidates nothing until draft / mark-ready, and drop create and
edit also invalidate `users` (edit: `['user-profile', id]` too). **Refuted in part:** the Sonnet S4
claim, as a description of create and edit (`useUserDialogMutations`); §2.9 uses the real lists.

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
  desc).
- **URL state (M9).** All four live in the search params: `status` (`active` default, omitted · `archived`
  · `all`), `role` (role enum, omitted = all), `sort` (`name` default · `role` · `added`, with a `-`
  prefix for descending, e.g. `-added`), `q` (search text). Typing in search writes `q` with
  `replace: true` (no history entry per keystroke); status / role / sort changes push one entry. Back
  from a profile restores all four. **Old links:** `?archived=true` keeps working — the route's search
  schema maps it to `status=archived` on load and rewrites the URL with `replace: true`; the query key
  stays `['users-admin', { archived }]` (`active` / `true` / `all`), so no cache key changes.
- **Search match reason (M13).** Search also matches fields the row does not show (Telegram, tech
  stack; on phone, email is shown). A row matched only through a hidden field shows one extra line
  under the name: «Telegram: @…» or «Технології: React, …» with the matched part in
  `--foreground` (`search-match-375`, desktop: in the name cell). No highlight colour; the matched text
  is wrapped in `<mark>` with the foundation's plain style so screen readers do not announce it twice.
- **Row actions on every class (M10).** Edit, archive and restore are reachable on the list itself on
  every class, never only through the profile (Task 2.2) and never only through swipe:
  - phone and tablet: a 44 px trailing «⋯» button «Дії: {name}» on every row with actions, opening
    an action sheet «Дії з користувачем» (Редагувати · Архівувати… / Відновити з архіву · Відкрити
    профіль) — `row-actions-375`; swipe stays as a shortcut;
  - desktop: the row's pencil + «⋯» menu (unchanged).
  - VoiceOver / TalkBack: the row link and its «⋯» button are two stops in reading order; the swipe
    layer is `aria-hidden`, so a screen-reader user reaches every action through «⋯», never through a
    gesture.
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
  included); a chosen role turns the chip yellow-subtle with a 44 px «×» «Скинути роль» (never a
  chevron). The row scrolls horizontally when it does not fit (320) with a 16 px edge fade on the
  clipped side; nothing wraps (`list-320`). The create flow's role picker (`role-picker-375.png`) is a
  different list: it has no «Адміністратор», as today.
- **Count + sort header:** sentence-case `t-foot` (never the uppercase overline, which made «3 з 38»
  read as «3 3 38»): «38 користувачів» unfiltered, «3 з 38» filtered; the large-title subtitle uses the
  same filtered count. Sort button right («↑ Ім’я»), opening the sort sheet «Сортування»
  (`sort-sheet-375`: Ім’я · Роль · Додано, each with ↑ / ↓, current one checked). Sorted by «Додано»
  (newest first), each row shows its relative created time and the order is by createdAt
  (`sorted-added-375.png`).
- **Rows** (`.lrow.two`, min 64 px): avatar initials 40 · name (+ «Ви»), **wrapping to two lines** under
  640 (foundation rule), then truncating · second line «Роль · email» · a 44 px trailing «⋯» (M10).
  Archived rows show «Архівовано {date}» on the second line instead of the email, so the name keeps its
  width (M12). Tech chips and the `mailto:` / `tel:` / `t.me` links are not on the phone row (open point
  11). The list's bottom padding is FAB height + 16 so the last row's «⋯» is never under the FAB.
- **Swipe** (trailing edge, `swipe-375.png`): «Змінити» + «Архівувати» (88 px each); archived rows:
  «Змінити» + «Відновити» (88 px each). A shortcut only: «⋯» is the visible path. Self row: the swipe
  shows «Змінити» and a muted «Не можна архівувати себе» note at full `--muted-foreground` contrast in
  place of «Архівувати» (`swipe-self-375`); another ADMIN's row: no swipe, no «⋯».
- **Create:** the FAB «+» (bottom right, above the tab bar) opens a **full-height sheet** «Новий
  користувач» (`create-1-375.png`): lead «Скасувати», stepper «Крок n з N» + step title + bars, the form,
  and a fixed action bar at the bottom (Назад · primary). Steps in 2.5.
- **Edit:** the same sheet, «Редагувати», all sections of today's edit form in one scroll (field
  parity §2.10), lifecycle §2.9 (`edit-375` → `edit-loaded-375`; JUNIOR `edit-junior-375`, DROP
  `edit-drop-375`, 320 `edit-320`).
- **Archive:** a confirm sheet «Архівувати» (`role="alertdialog"`, aria-label «Архівувати
  користувача») with the impact copy, pending transactions and the typed-name field labelled «Для
  підтвердження введіть ім’я: **{name}**» (name bold); the destructive button is `aria-disabled` until
  the name matches **and** the impact has loaded (`archive-impact-loading-375` → `archive-confirm-375`
  → `archive-armed-375`). While typing, the sheet's action bar rides the keyboard (foundation
  `submitBar` with the keyboard height) and the field scrolls above it (`archive-confirm-keyboard-375`).
  Pending / failed: §2.9 (`archive-pending-375`, `archive-failed-375`).

### 2.3 Tablet (640–1023) — `list-768.png`, `list-960.png`

- **Shell:** the 80 px rail with the «+» create button (52) at its top; touch density (44 targets,
  16 px inputs, 52 px rows).
- **< 900, one pane (`list-768`):** its own row, not the phone row stretched: avatar 40 · name (+ «Ви»)
  and role badge on line one · email on line two · a second column (Telegram, then up to 2 tech chips +
  «+N») · relative added time · 44 px «⋯». Row tap pushes the profile. Search, filters and the count /
  sort header as on phone, in one 16 px row.
- **≥ 900, two panes (`list-960`, `list-960-archived`):** list 360 + a detail pane built **only from the
  list row** (no extra request): avatar 64, name, «Роль · додано …», Email / Telegram / Телефон as links
  (an empty contact is omitted), tech chips, a secondary «Відкрити профіль» button and the line «Фінанси,
  контракти й документи — у профілі.». Header: «Редагувати» + «⋯» (Архівувати… / Відновити з архіву). An
  archived user's pane shows «Архівовано {date}», «Відновити з архіву» as the header action and keeps
  «Редагувати» in «⋯». See open point 4.
- **Create / edit:** the side panel 400, touch header as a three-column grid (lead «Скасувати» · centred
  title · empty trailing cell, foundation sheet head), the same stepper and phone action bar
  (`create-768`, `create-2-768`, `create-3-768`, `edit-768`). Modal: the scrim covers the rail too
  (rail under the scrim, M14), focus trap.
- **Dialogs:** archive confirm is the centred 520 `alertdialog` of desktop (`archive-confirm-768`); email
  change and dirty close the centred 420 confirm.
- **States:** list error (`error-768`) is the desktop state block in the single pane; loading, empty,
  no-results, offline and the unknown-create banner use the phone components in the wider column (§3).

### 2.4 Desktop (≥ 1024) — `list-1024.png`, `list-1280.png`, `list-1440.png`

- **Shell:** sidebar (group «Люди» → «Користувачі» active), header crumb «Люди › Користувачі», primary
  CTA «Додати користувача» with the «C» key hint. Content max-width 1280 at ≥ 1440.
- **Toolbar:** search (`/` focuses it) · status tabs Активні · Архів · Усі · role filter chip «+ Роль»
  (chosen: «Роль: Сеньйор ×», `filtered-1440.png`) · count «38 користувачів» right (`role="status"`).
- **Table** (foundation dense table: th 36, td 40; `table-layout: fixed`, Email is the one flexible
  column, so «Додано» and the actions never leave the viewport — `long-1024.png`, `long-1440.png`):
  - 1024–1279: Користувач · Роль (min 128, so «Бухгалтер» never clips) · Email (flexible; truncates
    with the full address in a `title` tooltip and the link's accessible name) · Додано (136, a full
    date «12 бер 2026» never clips) · actions;
  - 1280–1439: + Технології (2 chips + «+N») before Додано;
  - ≥ 1440: + Telegram after Email (at 1280 it would squeeze Email below a readable width).
  - Email cells are `mailto:` links, Telegram cells `t.me` links; the name cell links to the profile.
  - Телефон is not a column (detail pane / profile), as the search does not cover it either.
  - Sorting by the column headers Користувач / Роль / Додано (`aria-sort`) replaces today's sort-key
    select + direction button: same capability, one control.
- **Row actions** (visible on hover and `:focus-within`, always in the tab order): pencil «Редагувати
  {name}» + «⋯» menu (Відкрити профіль · Редагувати · Архівувати…) — `row-menu-1440.png`. Self:
  «Архівувати…» disabled with «Не можна архівувати себе» shown in the menu; only the item label is
  dimmed, the reason line keeps full `--muted-foreground` contrast (`row-menu-self-1440.png`).
  Archived: the pencil is replaced by «Відновити з архіву {name}» and the «⋯» menu holds Відкрити
  профіль · Редагувати (`archive-1440.png`). On the «Архів» tab (and for archived rows under «Усі») the
  table gains an «Архівовано» column (archive date) before «Додано»; «Додано» always means createdAt
  (M12). The archived state is the dimmed row plus that column — no badge inside the name cell, so the
  name keeps its width. Another ADMIN's row has no row actions, as today. Under
  `(pointer: coarse)` at desktop width the actions are always visible at 44 px, rows are 52 and the
  search input is 16 px (`touch-1024.png`).
- **Create / edit panel** (primitives-v2 side panel): 1024–1439 **modal 420** with scrim
  (`create-1-1024.png`); ≥ 1440 **non-modal 480**, no scrim, table stays usable (`create-1-1440.png`).
  While the non-modal panel is open the table reflows to the **1024 column set** (Користувач · Роль ·
  Email · Додано · actions), because the 480 px panel leaves it about 1024 wide (M11). Every 1440 panel
  frame shows that reflow.
  Fields 40 px / 14 px (fine pointer only). Footer: «Назад» left; «Скасувати» + primary with «⌘↵» right.
  On «Підтвердження» the two outcome buttons fill the footer, so the «⌘↵» hint is dropped there
  (`create-5-1440.png`); the shortcut still triggers the primary.
  Esc closes (a dirty form asks first, `dirty-close-1440.png`).
- **Archive:** centred `alertdialog` 520 «Архівувати користувача» with the same body and typed-name
  field (`archive-confirm-1440.png`, `archive-armed-1440.png`). Email change: centred 420
  (`email-change-1440.png`). Dirty close: centred 420, focus on «Залишитися».

### 2.5 Create flow (all layouts)

Today's three wizard stages stay; the long «Дані» stage is split into three screens so no step is a
two-screen scroll on a phone. Steps: **Особа → Роль і команда → Виплати → Контракт → Підтвердження**
(DROP: the first three only, via the drop endpoint as today). Every field of today's create form is on
exactly one step; §2.10 is the full field-parity table.

| Step           | Content (all fields from today's form)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Frames                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Особа          | Ім’я та прізвище · Email · Особистий email (необов’язково, invite hint) · Мова інтерфейсу (Українська / English) · Контакти: Telegram, Телефон                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `create-1-375`, `create-1-1440`, `create-1-1024`, `create-768`, `create-1-locked-375`                              |
| Роль і команда | Роль (picker) · SENIOR: Тип команди («Створити свою команду» / «Додати до команди дропа»); own team: HR chips (required) + Бухгалтер (необов’язково) + Telegram-канал команди (необов’язково); drop team: «Команда дропа» picker · JUNIOR: Проєкт (необов’язково) · DROP: «Команда дропа» — HR (required), Бухгалтер, Telegram-канал команди · HR / ACCOUNTANT: no team fields (as today) · every role: Професія → Технології                                                                                                                                                                                                                                                                               | `create-2-375`, `create-2-junior-375`, `create-2-drop-375`, `create-2-1440`, `create-2-768`, `create-2-locked-375` |
| Виплати        | Дані для контракту: Юридичне ПІБ (today's hint «Використовується в MSA-контракті замість імені та прізвища. Формат: Прізвище Ім’я По батькові.»; not pre-filled, as today), Адреса реєстрації (ФОП) · Фінанси: SENIOR «Частка сеньйора, %» (default 26) · DROP «Частка дропа, %» (default 5) · JUNIOR / HR / ACCOUNTANT «Місячна зарплата» (Сума + Валюта; «≈ {usd} USD» under it when the currency is not USD) · Спосіб виплати: SENIOR USDT ERC-20 only; JUNIOR / HR / ACCOUNTANT / DROP: USDT ERC-20 or ФОП (UAH) · USDT: Гаманець USDT (ERC-20), Мітка гаманця (необов’язково) · ФОП: ПІБ отримувача (ФОП), IBAN, РНОКПП, Банк (необов’язково). Primary: «Створити користувача»; DROP: «Створити дропа» | `create-3-375`, `create-3-junior-375`, `create-3-drop-375`, `create-3-320`, `create-3-1440`, `create-3-768`        |
| Контракт       | «Користувача створено. Контракт можна додати зараз або пізніше з профілю користувача.» + contract text with highlighted placeholders, or the no-template text (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `create-4-375`, `create-4-none-375`, `create-4-saving-375`, `create-4-save-failed-375`, `create-4-1440`            |
| Підтвердження  | Summary (Ім’я, Роль, Email — wraps, never truncates, Контракт: Чернетка / Немає) · «Зберегти чернетку» / «Позначити готовим до підписання»                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `create-5-375`, `create-5-1440`                                                                                    |

Every money and percent field carries its unit beside the value: «%» after a share, the currency code
after an amount, «USD» after the «≈» hint.

**Role variants without their own frame** (one rule each): HR and ACCOUNTANT follow `create-2-junior-375`
without the «Проєкт» field and `create-3-junior-375` as drawn (salary + USDT or ФОП); ADMIN is never
created here.

**DROP continuation.** «Створити дропа» on «Виплати» posts to the drop endpoint. Success: toast «Дропа
створено», the form closes, the list refetches (`users-admin`, `users`, `teams`, `projects`, as today).
There is no «Контракт» / «Підтвердження» for a DROP. Failure, 409 and unknown follow the rules below
with «дропа» wording.

- **The POST is on «Створити користувача»** (end of «Виплати»), not on a generic «Далі»; the invite is
  sent at that moment, to the personal email when given (as today). Steps 1–2 only validate locally.
- **After the POST is sent (M2)** — from the moment the request leaves, whatever comes back, unknown
  included — the fields the follow-up PATCH does not carry become read-only on steps 1–2: Email,
  Особистий email, Мова інтерфейсу, Роль, Тип команди / Команда дропа, Проєкт, Telegram-канал команди.
  They render as read-only fields (value on `--surface`, no chevron, lock icon) under one reason line at
  the top of the step: «Запит на створення вже надіслано, тому email, роль і команду тут не змінити.
  Потрібен інший email — закрийте форму й створіть нового користувача.» (`create-1-locked-375`,
  `create-2-locked-375`). «Назад» stays. Fields the PATCH carries stay editable; «Далі» on a step with
  changes PATCHes. Юридичне ПІБ and Адреса реєстрації stay editable but keep their required check (the
  PATCH cannot clear them).
- **Pending:** the primary shows a spinner and «Створюємо…», is `aria-disabled`, and the form stays
  readable; no overlay spinner (`create-pending-375`, `create-pending-1440`). Controls during any pending
  write: §2.9.
- **409 USER_EMAIL_EXISTS** (nothing was created, but the email is locked by M2): the alert on
  «Виплати» reads «Ця електронна адреса вже зайнята. Введіть іншу» (catalog value of
  `USER_EMAIL_EXISTS`) with one action «Почати з іншим email»: it opens a **new** create flow at «Особа»
  with every value kept except Email, which is empty and focused (`create-error-375`).
- **400 tied to a field:** the error text goes under that field, the flow moves to the step holding it,
  focus lands on the field; no generic alert.
- **Failed (any other 4xx):** alert «Не вдалося створити користувача» / «Сервер відхилив запит. Нічого не
  створено — введене залишилось у формі.» (`create-failed-375`). A 5xx is treated as unknown, because
  the server may have written the user before it failed.
- **Unknown outcome (timeout, network drop, 5xx; M3):** alert «Невідомо, чи користувача створено» /
  «Відповідь не надійшла. Введене залишилось у формі. «Спробувати ще раз» спершу перевірить, чи
  користувача вже створено.»; the primary becomes «Спробувати ще раз» (`create-unknown-375`,
  `create-unknown-1440`). Never an automatic retry. «Спробувати ще раз» first refetches
  `['users-admin', { archived: 'all' }]` and looks for a row with the same email:
  - a row whose `createdAt` is later than the first submit (client clock, minus a two-minute skew
    allowance) counts as ours: the flow continues at «Контракт» with that id;
  - an older row is **not** ours: the 409 path above, with the line «Цей email уже має користувач,
    створений раніше.» (`create-retry-older-375`);
  - no row: the POST is sent again. A retry answered 409 runs the same check once more.
  - The email alone never decides "created". An idempotency key on the create endpoint (plan Task 1.1)
    would make this exact; until then the check above is the rule (open point 12).
- **Contract step (M8).** One primary per step: «Далі» on «Контракт» **saves** the edited contract text
  and moves on (today the editor has its own save button and «Далі» only moves; the change is recorded
  under Assumptions). Untouched text: «Далі» moves without a request. Pending: «Зберігаємо…»,
  `aria-disabled` (`create-4-saving-375`). Failed: alert «Не вдалося зберегти контракт» / «Текст
  залишився в редакторі. Спробуйте ще раз або продовжте без змін.» with «Далі» kept and a secondary
  «Продовжити без змін» (`create-4-save-failed-375`). **No template** (`create-4-none-375`): today's three
  lines («Немає активного шаблону контракту для цієї ролі» · «Контракт можна додати пізніше з профілю
  користувача.» · «Натисніть «Далі», щоб продовжити без контракту.»); «Підтвердження» then shows «Контракт:
  Немає» and only one outcome button «Готово», which closes (the user already exists).
- **Dirty close** (foundation: a dirty form asks before it closes; the money-draft «Згорнути» exception
  does not apply, there is no draft queue for users). The copy names what is lost:
  - before the POST: «Вийти без збереження?» / «Користувача не створено — введені дані буде втрачено.» ·
    «Вийти» / «Залишитися» (`dirty-close-375`, `dirty-close-1440`);
  - after a successful POST with unsaved step changes: «Вийти без збереження?» / «Користувача вже
    створено. Незбережені зміни на цьому кроці буде втрачено.»;
  - after a successful POST with nothing unsaved: closes without asking.
- **Close while the outcome is unknown (M4)** asks, and says nothing is lost: «Закрити форму?» / «Ще
  невідомо, чи створено {email}. Список оновиться, а над ним залишиться нагадування, доки це не
  з’ясується.» · «Закрити» / «Залишитися» (`close-unknown-375`). On «Закрити» the list refetches and
  shows the banner below.
- **Unknown-create banner on the list (M4)** (`list-unknown-banner-375`, `list-unknown-banner-1440`):
  foundation warning banner «Невідомо, чи створено {email}» with «Перевірити» and «Приховати».
  «Перевірити» refetches and runs the M3 check: ours → «Користувача {email} створено» with «Відкрити
  профіль»; older or absent → «{email} у списку немає — схоже, користувача не створено.» with «Створити
  знову» (opens a new flow with that email filled in). The banner lives for the browser session (in
  memory); a reload drops it — the idempotency key (open point 12) removes the need for it.

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
- Row actions (M10): every phone and tablet row has a 44 px «⋯» button «Дії: {name}» that opens the
  «Дії з користувачем» sheet (focus to its first item, back to «⋯» on close). The swipe layer is
  `aria-hidden` and adds nothing a screen reader or a keyboard cannot reach through «⋯». The row link
  and «⋯» are siblings, never nested.
- Search match line (M13): part of the row link's name, so the reason is read with the name; `<mark>`
  is not the only cue (the line names the field: «Telegram: …»).
- Pending writes: the pending label lives in a `role="status"` region; the `aria-disabled` primary keeps
  focus, so focus never drops to `<body>` when a request starts. A failure or unknown alert takes focus
  (`role="alert"`, `tabindex="-1"`); a field 400 focuses the field.
- Unknown-create banner (M4): `role="status"` on appear, its two buttons in tab order before the list;
  the resolution text replaces the banner text in the same live region.
- Locked fields (M2): `readonly` + `aria-describedby` on the reason line, not `disabled`, so they stay
  readable and focusable.
- Name wraps to two lines under 640 (foundation), then truncates; the full name is in the link's
  accessible name. At 1024 the truncated email has a `title` and the full value in the accessible name.

### 2.8 Strings (uk → en)

Existing strings keep their catalog msgids (en from `packages/shared/src/i18n/locales/en/messages.po`).
**New** strings need catalog entries in both languages. `{name}`, `{email}`, `{date}` are ICU arguments.

| uk                                                                                                                                                                   | en                                                                                                                                                         | Status                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Користувачі                                                                                                                                                          | Users                                                                                                                                                      | existing                                                                                              |
| Додати користувача                                                                                                                                                   | Add user                                                                                                                                                   | existing                                                                                              |
| Новий користувач / Редагувати користувача                                                                                                                            | New user / Edit the user                                                                                                                                   | existing                                                                                              |
| Активні / Архів / Усі                                                                                                                                                | Active / Archived / All                                                                                                                                    | existing                                                                                              |
| Роль / Додано / Дії / Телефон                                                                                                                                        | Role / Added / Actions / Phone                                                                                                                             | existing                                                                                              |
| Архівовано (column) · Архівовано {date} (phone second line)                                                                                                          | Archived · Archived {date}                                                                                                                                 | new (M12; the column header and the row line)                                                         |
| Ви / В архіві                                                                                                                                                        | You / Archived                                                                                                                                             | existing                                                                                              |
| Відновити з архіву / Архівувати користувача                                                                                                                          | Restore from archive / Archive user                                                                                                                        | existing                                                                                              |
| Не можна архівувати себе / Свою роль змінити не можна                                                                                                                | Can't archive yourself / You can't change your own role                                                                                                    | existing                                                                                              |
| Нічого не знайдено — скиньте фільтри / Скинути фільтри                                                                                                               | No matches — clear the filters / Reset filters                                                                                                             | existing                                                                                              |
| Нічого не знайдено                                                                                                                                                   | No results                                                                                                                                                 | existing (the state-block title)                                                                      |
| Немає користувачів, що відповідають пошуку «{q}» і ролі «{role}».                                                                                                    | No users match “{q}” with the role “{role}”.                                                                                                               | new                                                                                                   |
| Немає користувачів, що відповідають пошуку «{q}».                                                                                                                    | No users match “{q}”.                                                                                                                                      | new (search only)                                                                                     |
| Немає користувачів із роллю «{role}».                                                                                                                                | No users have the role “{role}”.                                                                                                                           | new (role only)                                                                                       |
| Скинути роль                                                                                                                                                         | Clear the role                                                                                                                                             | new (the chip ×, `aria-label`)                                                                        |
| Очистити пошук                                                                                                                                                       | Clear search                                                                                                                                               | existing                                                                                              |
| Telegram: {handle} / Технології: {list}                                                                                                                              | Telegram: {handle} / Technologies: {list}                                                                                                                  | new (M13 match line)                                                                                  |
| Сортування / За ім’ям / За роллю / Спочатку нові / Спочатку старі                                                                                                    | Sort / By name / By role / Newest first / Oldest first                                                                                                     | new (sort sheet)                                                                                      |
| Дії: {name}                                                                                                                                                          | Actions: {name}                                                                                                                                            | new (the «⋯» button `aria-label`)                                                                     |
| Дії з користувачем                                                                                                                                                   | User actions                                                                                                                                               | new (the action sheet title)                                                                          |
| Змінити / Відновити / Архівувати (swipe actions)                                                                                                                     | Edit / Restore / Archive                                                                                                                                   | new (short swipe labels)                                                                              |
| Доступ лише для адміністратора                                                                                                                                       | Admin access only                                                                                                                                          | existing                                                                                              |
| Цей розділ відкривається тільки адміністраторам. Зазвичай вас одразу переносить на ваш головний екран.                                                               | This section is for admins only. You are normally taken straight to your home screen.                                                                      | new                                                                                                   |
| На головний екран                                                                                                                                                    | Go to the home screen                                                                                                                                      | new (permission state action)                                                                         |
| Не вдалося завантажити користувачів                                                                                                                                  | Couldn't load users                                                                                                                                        | new                                                                                                   |
| Сервер не відповів. Нічого не змінено — спробуйте ще раз.                                                                                                            | The server didn't respond. Nothing changed — try again.                                                                                                    | new                                                                                                   |
| Немає з’єднання. Показано останні завантажені дані; збереження не пройде, введене залишиться у формі.                                                                | No connection. Showing the last loaded data; saving won't go through, and what you entered stays in the form.                                              | new (foundation `offlineBanner()` text; en written with it)                                           |
| Архів порожній                                                                                                                                                       | The archive is empty                                                                                                                                       | existing (phone subtitle)                                                                             |
| В архіві нікого немає                                                                                                                                                | Nobody is archived                                                                                                                                         | new (state-block title)                                                                               |
| Тут з’являться архівовані користувачі. Будь-кого з них можна відновити.                                                                                              | Archived users appear here. Any of them can be restored.                                                                                                   | new                                                                                                   |
| {n} користувачів / {n} з {total} / {n} в архіві / {n} активних                                                                                                       | {n} users / {n} of {total} / {n} archived / {n} active                                                                                                     | new (ICU plural in uk; sentence case)                                                                 |
| Фільтр за роллю / Усі ролі                                                                                                                                           | Filter by role / All roles                                                                                                                                 | new                                                                                                   |
| Адміністратор / Сеньйор / Джуніор / HR / Бухгалтер / Дроп                                                                                                            | role labels                                                                                                                                                | existing (role label map)                                                                             |
| щойно (relative time)                                                                                                                                                | just now                                                                                                                                                   | new (the existing «щойно» msgids are sentences)                                                       |
| Створити користувача / Створити дропа                                                                                                                                | Create user / Create drop                                                                                                                                  | new                                                                                                   |
| Дропа створено                                                                                                                                                       | Drop created                                                                                                                                               | existing                                                                                              |
| Крок {n} з {total}                                                                                                                                                   | Step {n} of {total}                                                                                                                                        | new                                                                                                   |
| Особа / Роль і команда / Виплати / Контракт / Підтвердження                                                                                                          | Person / Role and team / Payouts / Contract / Confirmation                                                                                                 | new: Особа, Роль і команда, Виплати; existing: Контракт, Підтвердження                                |
| Своя команда / Додати HR                                                                                                                                             | Own team / Add HR                                                                                                                                          | new                                                                                                   |
| Бухгалтер (необов’язково)                                                                                                                                            | Accountant (optional)                                                                                                                                      | new label for the picker                                                                              |
| Не обрано / Без проєкту (picker placeholders)                                                                                                                        | Not selected / No project                                                                                                                                  | new; replace today's «— не обрано —»                                                                  |
| Місто, вулиця, будинок / Наприклад, основний                                                                                                                         | City, street, building / For example, main                                                                                                                 | new; replace «м. Київ, вул. Хрещатик, 1» / «наприклад: основний»                                      |
| На цю адресу одразу піде запрошення. Увійти з цією адресою співробітник зможе лише після її підтвердження.                                                           | An invitation goes to this address right away. The employee can sign in with it only after confirming the address.                                         | existing (`IdentitySection` invite hint, as today)                                                    |
| Мова інтерфейсу співробітника — він зможе змінити її у своєму профілі.                                                                                               | The employee's interface language — they can change it in their own profile.                                                                               | existing                                                                                              |
| Використовується в MSA-контракті замість імені та прізвища. Формат: Прізвище Ім’я По батькові.                                                                       | catalog value                                                                                                                                              | existing (legal-name hint)                                                                            |
| Можна прикріпити пізніше в розділі «Проєкти»                                                                                                                         | You can attach one later in the Projects section                                                                                                           | existing                                                                                              |
| Необов’язково. Канал для спілкування команди.                                                                                                                        | Optional. A channel for the team to talk in.                                                                                                               | existing                                                                                              |
| Ця адреса підставляється в текст контракту                                                                                                                           | This address is inserted into the contract text                                                                                                            | existing                                                                                              |
| Скільки дроп залишає собі з кожної виплати                                                                                                                           | How much the drop keeps from each payout                                                                                                                   | existing; the «За замовчуванням 5%» suffix is new («Default 5%»)                                      |
| Спосіб виплати / Місячна зарплата / Telegram-канал команди / Команда дропа                                                                                           | Payout method / Monthly salary / Team Telegram channel / Drop's team                                                                                       | existing                                                                                              |
| Гаманець USDT (ERC-20) / ПІБ отримувача (ФОП)                                                                                                                        | USDT wallet (ERC-20) / Recipient's full name (Sole proprietor)                                                                                             | existing                                                                                              |
| Використовуватиметься український банківський рахунок ФОП. / Використовуватиметься адреса гаманця в мережі Ethereum.                                                 | A Ukrainian sole-proprietor bank account will be used. / A wallet address on the Ethereum network will be used.                                            | existing                                                                                              |
| Для ролі «{roleLabel}» доступні лише виплати в USDT ERC-20.                                                                                                          | Only USDT ERC-20 payouts are available for the “{roleLabel}” role.                                                                                         | existing                                                                                              |
| Назва банку (необов’язково)                                                                                                                                          | Bank name (optional)                                                                                                                                       | existing                                                                                              |
| Запит на створення вже надіслано, тому email, роль і команду тут не змінити. Потрібен інший email — закрийте форму й створіть нового користувача.                    | The create request has already been sent, so the email, role and team can't be changed here. Need a different email? Close the form and create a new user. | new (M2 lock reason)                                                                                  |
| Створюємо… / Зберігаємо… / Архівуємо…                                                                                                                                | Creating… / Saving… / Archiving…                                                                                                                           | existing                                                                                              |
| Позначаємо…                                                                                                                                                          | Marking…                                                                                                                                                   | new (mark-ready pending)                                                                              |
| Зачекайте відповіді                                                                                                                                                  | Wait for the response                                                                                                                                      | new (lead pressed during a pending write)                                                             |
| Ця електронна адреса вже зайнята. Введіть іншу                                                                                                                       | catalog value of `USER_EMAIL_EXISTS`                                                                                                                       | existing (`packages/shared/src/schemas/api-errors/auth-users-projects.ts`)                            |
| Почати з іншим email                                                                                                                                                 | Start over with another email                                                                                                                              | new (409 action under M2)                                                                             |
| Цей email уже має користувач, створений раніше.                                                                                                                      | This email already belongs to a user created earlier.                                                                                                      | new (M3 older-row line)                                                                               |
| Не вдалося створити користувача                                                                                                                                      | Couldn't create the user                                                                                                                                   | new (alert title)                                                                                     |
| Сервер відхилив запит. Нічого не створено — введене залишилось у формі.                                                                                              | The server rejected the request. Nothing was created — your input is still in the form.                                                                    | new                                                                                                   |
| Не вдалося створити користувача — дані залишилися у формі, спробуйте ще раз                                                                                          | Could not create the user — the form keeps your data, try again                                                                                            | existing                                                                                              |
| Не вдалося створити дропа — дані залишилися у формі, спробуйте ще раз                                                                                                | Could not create the drop — the form keeps your data, try again                                                                                            | existing                                                                                              |
| Невідомо, чи користувача створено                                                                                                                                    | We don't know whether the user was created                                                                                                                 | new                                                                                                   |
| Відповідь не надійшла. Введене залишилось у формі. «Спробувати ще раз» спершу перевірить, чи користувача вже створено.                                               | No response came back. Your input is still in the form. “Try again” first checks whether the user already exists.                                          | new (replaces the round 0 «Повторити безпечно» text, which promised what the API cannot)              |
| Закрити форму?                                                                                                                                                       | Close the form?                                                                                                                                            | new                                                                                                   |
| Ще невідомо, чи створено {email}. Список оновиться, а над ним залишиться нагадування, доки це не з’ясується.                                                         | We don't know yet whether {email} was created. The list will refresh, and a reminder stays above it until we know.                                         | new (M4 close confirm)                                                                                |
| Невідомо, чи створено {email} / Перевірити / Приховати                                                                                                               | We don't know whether {email} was created / Check / Dismiss                                                                                                | new (M4 list banner)                                                                                  |
| Користувача {email} створено / Відкрити профіль                                                                                                                      | User {email} was created / Open profile                                                                                                                    | new                                                                                                   |
| {email} у списку немає — схоже, користувача не створено. / Створити знову                                                                                            | {email} isn't in the list — the user was most likely not created. / Create again                                                                           | new                                                                                                   |
| Не вдалося зберегти контракт                                                                                                                                         | Couldn't save the contract                                                                                                                                 | new (M8)                                                                                              |
| Текст залишився в редакторі. Спробуйте ще раз або продовжте без змін. / Продовжити без змін                                                                          | The text is still in the editor. Try again, or continue without the changes. / Continue without the changes                                                | new (M8)                                                                                              |
| Контракт: Немає / Готово                                                                                                                                             | Contract: None / Done                                                                                                                                      | new (no template)                                                                                     |
| Контракт можна додати пізніше з профілю користувача. / Натисніть «Далі», щоб продовжити без контракту.                                                               | The contract can be added later from the user's profile. / Press “Next” to continue without a contract.                                                    | existing                                                                                              |
| Немає активного шаблону контракту для цієї ролі                                                                                                                      | No active contract template for this role                                                                                                                  | existing                                                                                              |
| Завантажуємо контракт…                                                                                                                                               | Loading the contract…                                                                                                                                      | existing                                                                                              |
| Текст контракту / Поля в {{дужках}} заповняться з профілю користувача.                                                                                               | Contract text / Fields in {{braces}} are filled from the user's profile.                                                                                   | new                                                                                                   |
| «Готовий до підписання» — контракт піде на підпис. Чернетку можна доробити пізніше в профілі.                                                                        | “Ready to sign” sends the contract for signing. A draft can be finished later in the profile.                                                              | new                                                                                                   |
| Користувача створено / Зберегти чернетку / Позначити готовим до підписання                                                                                           | User created / Save draft / Mark ready to sign                                                                                                             | existing                                                                                              |
| Користувача створено, контракт збережено як чернетку / Користувача створено, контракт готовий до підписання                                                          | User created, the contract was saved as a draft / User created, the contract is ready to sign                                                              | existing                                                                                              |
| Не вдалося позначити контракт готовим до підписання                                                                                                                  | Could not mark the contract as ready to sign                                                                                                               | existing                                                                                              |
| Користувача створено. Контракт можна додати зараз або пізніше з профілю користувача.                                                                                 | User created. Add the contract now, or later from the user's profile.                                                                                      | new                                                                                                   |
| Контракт / Підтвердження / Далі / Назад / Зберегти / Закрити / Спробувати ще раз / Повторити                                                                         | Contract / Confirmation / Next / Back / Save / Close / Try again / Retry                                                                                   | existing                                                                                              |
| Скасувати (closing a form)                                                                                                                                           | Cancel                                                                                                                                                     | existing (the plain msgid, not the «undo a hide» context)                                             |
| Вийти без збереження? / Вийти / Залишитися                                                                                                                           | Leave without saving? / Leave / Stay                                                                                                                       | new (foundation dirty-close confirm); «Вийти» needs its own context — the plain msgid means «Log out» |
| Користувача не створено — введені дані буде втрачено.                                                                                                                | The user hasn't been created — what you entered will be lost.                                                                                              | new (dirty close before the POST)                                                                     |
| Користувача вже створено. Незбережені зміни на цьому кроці буде втрачено.                                                                                            | The user has already been created. Unsaved changes on this step will be lost.                                                                              | new (dirty close after the POST)                                                                      |
| Завантажуємо профіль…                                                                                                                                                | Loading the profile…                                                                                                                                       | new                                                                                                   |
| Не вдалося завантажити профіль                                                                                                                                       | Couldn't load the profile                                                                                                                                  | new (M6)                                                                                              |
| Дані зі списку показано, решту — ні. Зберегти можна після завантаження.                                                                                              | Data from the list is shown, the rest isn't. You can save once it loads.                                                                                   | new (M6)                                                                                              |
| Зачекайте, профіль ще завантажується                                                                                                                                 | Wait, the profile is still loading                                                                                                                         | new (pressed `aria-disabled` «Зберегти»)                                                              |
| Не вдалося зберегти зміни / Дані залишилися у формі, спробуйте ще раз.                                                                                               | Couldn't save the changes / Your data is still in the form, try again.                                                                                     | new (edit alert)                                                                                      |
| Невідомо, чи зміни збережено                                                                                                                                         | We don't know whether the changes were saved                                                                                                               | new (M6)                                                                                              |
| Відповідь не надійшла. Введене залишилось у формі. Перед повтором профіль оновиться, тож уже збережене не надішлеться вдруге.                                        | No response came back. Your input is still in the form. The profile refreshes before the retry, so nothing already saved is sent twice.                    | new (M6)                                                                                              |
| Зміни збережено                                                                                                                                                      | Changes saved                                                                                                                                              | existing                                                                                              |
| Відкрити профіль                                                                                                                                                     | Open profile                                                                                                                                               | new                                                                                                   |
| Фінанси, контракти й документи — у профілі.                                                                                                                          | Finance, contracts and documents are in the profile.                                                                                                       | new                                                                                                   |
| Змінити email? / Підтвердити зміну / Старий: / Новий:                                                                                                                | Change the email? / Confirm the change / Old: / New:                                                                                                       | existing                                                                                              |
| Зміна email може розірвати вхід через Google для <0>{displayName}</0>. Переконайтеся, що користувач знає про зміну і за потреби змінить свій обліковий запис Google. | Changing the email may break Google sign-in for <0>{0}</0>. Make sure the user knows about the change and updates their Google account if needed.          | existing (M7 consequence sentence, unchanged)                                                         |
| Для підтвердження введіть ім’я:                                                                                                                                      | To confirm, type the name:                                                                                                                                 | existing                                                                                              |
| Введіть ім’я, щоб підтвердити                                                                                                                                        | Type the name to confirm                                                                                                                                   | new (pressed `aria-disabled` «Архівувати»)                                                            |
| Archive impact copy (linked pair, «У команді … HR/бухгалтер…», «Відновлення можливе — …»)                                                                            | catalog values                                                                                                                                             | existing (today's archive dialog, unchanged)                                                          |
| Не вдалося порахувати наслідки архівації                                                                                                                             | Could not calculate the consequences of archiving                                                                                                          | existing                                                                                              |
| Не вдалося архівувати користувача — спробуйте ще раз                                                                                                                 | Could not archive the user — try again                                                                                                                     | existing                                                                                              |
| Сеньйора й команду архівовано / Дропа й команду архівовано / Користувача архівовано                                                                                  | (archive toast ICU `select`)                                                                                                                               | existing                                                                                              |
| Користувача відновлено / Не вдалося відновити користувача. Спробуйте ще раз                                                                                          | User restored / Could not restore the user. Try again                                                                                                      | existing                                                                                              |

### 2.9 Write rules (create, edit, archive, restore — M5, M6)

No write is optimistic: the list changes only after the server answers and the listed keys refetch.

| Write                        | Pending                                                                                                            | Success (toast)                                                                                   | Failure (text · where · focus)                                                                                                                                                                                           | Unknown (timeout, network, 5xx)                                                                                                                                                                                                                                                          | Invalidates                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Create POST                  | «Створюємо…», `aria-disabled`                                                                                      | none; moves to «Контракт» (`createdUserId` set)                                                   | 409 / 400 / 4xx: §2.5 · alert on «Виплати» or under the field · focus on the alert or the field                                                                                                                          | §2.5 (M3); close → M4 banner                                                                                                                                                                                                                                                             | `users-admin` (new: so the M3 check and the list see the user)                |
| Drop create                  | «Створюємо…», `aria-disabled`                                                                                      | «Дропа створено»; closes                                                                          | «Не вдалося створити дропа — дані залишилися у формі, спробуйте ще раз» · alert on «Виплати» · focus on the alert                                                                                                        | as Create POST, «дропа» wording                                                                                                                                                                                                                                                          | `users-admin`, `users`, `teams`, `projects` (today)                           |
| Wizard PATCH («Далі»)        | «Зберігаємо…», `aria-disabled`                                                                                     | none; next step                                                                                   | «Не вдалося зберегти зміни — дані залишилися у формі, спробуйте ще раз» · alert at the step top · focus on the alert                                                                                                     | the same alert with «Невідомо, чи зміни збережено»; «Спробувати ще раз» resends (a PATCH sets values, safe)                                                                                                                                                                              | `users-admin`                                                                 |
| Contract save                | «Зберігаємо…», `aria-disabled` (`create-4-saving-375`)                                                             | none; «Підтвердження»                                                                             | «Не вдалося зберегти контракт» · alert above the editor · focus on the alert (`create-4-save-failed-375`)                                                                                                                | the same alert; retry resends the text                                                                                                                                                                                                                                                   | the contract body key of `useSaveContractBody` (today)                        |
| Draft / mark ready           | «Зберігаємо…» / «Позначаємо…», `aria-disabled`                                                                     | «Користувача створено, контракт збережено як чернетку» / «…готовий до підписання»; closes         | «Не вдалося позначити контракт готовим до підписання» (today) · alert on «Підтвердження» · focus on the alert                                                                                                            | the same alert; the user exists either way, so closing never asks                                                                                                                                                                                                                        | `users-admin`, `users` (today)                                                |
| Edit load (`GET /users/:id`) | row data at once; finance / requisites / contract data / team as skeleton; «Зберегти» `aria-disabled` (`edit-375`) | sections fill in place, no layout jump                                                            | state block in place of the loading sections: «Не вдалося завантажити профіль» / «Дані зі списку показано, решту — ні. Зберегти можна після завантаження.» · «Повторити» · focus on «Повторити» (`edit-load-failed-375`) | same as failure                                                                                                                                                                                                                                                                          | —                                                                             |
| Edit save                    | «Зберігаємо…», `aria-disabled`; fields read-only (`edit-save-pending-375`)                                         | «Зміни збережено» or the SENIOR share-proposal toast; closes                                      | values kept; alert at the sheet top «Не вдалося зберегти зміни» / «Дані залишилися у формі, спробуйте ще раз.» · focus on the alert (`edit-save-failed-375`); a 400 on a field goes under the field                      | alert «Невідомо, чи зміни збережено» / «Відповідь не надійшла. Введене залишилось у формі. Перед повтором профіль оновиться, тож уже збережене не надішлеться вдруге.» · «Спробувати ще раз» reloads the profile, then sends only the fields that still differ (`edit-save-unknown-375`) | `users-admin`, `users`, `teams`, `['user-profile', id]` (today)               |
| Email change                 | the confirm's «Підтвердити зміну» starts the edit save                                                             | as Edit save                                                                                      | as Edit save                                                                                                                                                                                                             | as Edit save                                                                                                                                                                                                                                                                             | as Edit save                                                                  |
| Archive impact               | skeleton lines in the impact block; «Архівувати» `aria-disabled` (`archive-impact-loading-375`)                    | impact shown                                                                                      | «Не вдалося порахувати наслідки архівації» (today) + «Повторити»; «Архівувати» stays `aria-disabled`                                                                                                                     | same as failure                                                                                                                                                                                                                                                                          | key `['users-archive-impact', id]`, `staleTime: 0` (today)                    |
| Archive (`DELETE`)           | «Архівуємо…», `aria-disabled`; the sheet cannot close (today) (`archive-pending-375`)                              | «Користувача архівовано» / «Сеньйора й команду архівовано» / «Дропа й команду архівовано»; closes | alert in the sheet «Не вдалося архівувати користувача — спробуйте ще раз» (today's text); the typed name kept · focus on the alert (`archive-failed-375`)                                                                | the list refetches: the row archived → success toast; otherwise the failure alert                                                                                                                                                                                                        | `users-admin` (+ `teams`, `projects` for SENIOR / DROP) (today)               |
| Restore                      | the row's «Відновити» shows a spinner, `aria-disabled`                                                             | «Користувача відновлено» / «Сеньйора та команду відновлено»                                       | toast «Не вдалося відновити користувача. Спробуйте ще раз» (today) · focus stays on «Відновити»                                                                                                                          | the list refetches: the row active → success toast; otherwise the failure toast                                                                                                                                                                                                          | `['user-profile', id]`, `users`, `users-admin` (+ `teams` for SENIOR) (today) |

**Controls during a pending write (one rule).** While a write is in flight: its primary shows the pending
label and is `aria-disabled` (focusable, announced «{label}, недоступно», `role="status"` carries the
pending label); the form's fields are read-only, so what is shown is what was sent; «Назад» and the other
buttons of that step are `aria-disabled`; the sheet or panel cannot close — lead, Esc, scrim and drag do
nothing, and the lead shows the hint «Зачекайте відповіді» on press. The request's own timeout ends the
pending state as **unknown**, never as a silent close. Other screens stay usable: the shell, the tab bar
and (on the ≥ 1440 non-modal panel) the table.

### 2.10 Field parity (M1)

Every field of today's form (`UserDialog`, §1.3, §1.6), its roles, where it sits in create and in edit.
A row is drawn in the named frame or carries a rule line.

| Field                                       | Roles                                  | Create step (frame)                                                                                            | Edit section (frame)                                                                         |
| ------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Email                                       | all                                    | Особа (`create-1-375`); locked after the POST (`create-1-locked-375`)                                          | Основне (`edit-loaded-375`); a change asks first (`email-change-375`)                        |
| Ім’я та прізвище                            | all                                    | Особа (`create-1-375`)                                                                                         | Основне (`edit-loaded-375`)                                                                  |
| Особистий email                             | all                                    | Особа (`create-1-375`); DROP: open point 13                                                                    | rule: create-only, as today (`IdentitySection`)                                              |
| Мова інтерфейсу                             | all                                    | Особа (`create-1-375`)                                                                                         | rule: create-only, as today; the user changes it in their profile                            |
| Роль                                        | all (create list without ADMIN)        | Роль і команда (`create-2-375`, `role-picker-375`); locked after the POST                                      | Основне (`edit-loaded-375`); self: locked (`edit-self-375`)                                  |
| Telegram · Телефон                          | all                                    | Особа (`create-1-375`)                                                                                         | Контакти (`edit-loaded-375`)                                                                 |
| Професія → Технології                       | all, DROP included                     | Роль і команда (`create-2-375`, `create-2-drop-375`)                                                           | Професія (`edit-loaded-375`, `edit-drop-375`)                                                |
| Юридичне ПІБ · Адреса реєстрації (ФОП)      | all non-ADMIN                          | Виплати (`create-3-375`, `create-3-drop-375`)                                                                  | Дані для контракту (`edit-loaded-375`, `edit-junior-375`, `edit-drop-375`)                   |
| Частка сеньйора, %                          | SENIOR                                 | Виплати (`create-3-375`)                                                                                       | Фінанси (`edit-loaded-375`); a change becomes a proposal (today's toast)                     |
| Частка дропа, %                             | DROP                                   | Виплати (`create-3-drop-375`)                                                                                  | Фінанси (`edit-drop-375`)                                                                    |
| Місячна зарплата (Сума, Валюта, «≈ … USD»)  | JUNIOR, HR, ACCOUNTANT (ADMIN in edit) | Виплати (`create-3-junior-375`)                                                                                | Фінанси (`edit-junior-375`, `edit-self-375`)                                                 |
| Спосіб виплати                              | all; SENIOR / ADMIN USDT only (note)   | Виплати (`create-3-375` note, `create-3-junior-375`, `create-3-drop-375`)                                      | Реквізити для виплат (`edit-loaded-375` note, `edit-junior-375`, `edit-drop-375`)            |
| Гаманець USDT (ERC-20) · Мітка гаманця      | USDT                                   | Виплати (`create-3-375`, `create-3-drop-375`)                                                                  | Реквізити для виплат (`edit-loaded-375`, `edit-drop-375`)                                    |
| ПІБ отримувача (ФОП) · IBAN · РНОКПП · Банк | ФОП (not SENIOR / ADMIN)               | Виплати (`create-3-junior-375`)                                                                                | Реквізити для виплат (`edit-junior-375`)                                                     |
| Тип команди                                 | SENIOR                                 | Роль і команда (`create-2-375`); locked after the POST                                                         | rule: create-only, as today                                                                  |
| Команда дропа (join)                        | SENIOR joining a drop team             | rule: the «Команда дропа» picker replaces the HR / accountant / channel fields under «Додати до команди дропа» | rule: create-only, as today                                                                  |
| HR · Бухгалтер                              | SENIOR (own team), DROP                | Роль і команда (`create-2-375`, `create-2-drop-375`)                                                           | Команда (SENIOR, `edit-loaded-375`); DROP: no team section, as today                         |
| Telegram-канал команди                      | SENIOR (own team), DROP                | Роль і команда (`create-2-375`, `create-2-drop-375`); locked after the POST                                    | Команда (SENIOR, `edit-loaded-375`); DROP: none, as today                                    |
| Проєкт                                      | JUNIOR                                 | Роль і команда (`create-2-junior-375`); locked after the POST                                                  | Команда: «Активні проєкти», read-only + «Керувати в розділі «Проєкти» →» (`edit-junior-375`) |
| Contract text                               | all except DROP                        | Контракт (`create-4-375`, `create-4-none-375`)                                                                 | rule: not in edit; the contract lives in the profile, as today                               |

## 3. States

Every cell is a frame (`assets/users/<name>.png`) or a rule. Phone frames are 375 unless the name says
320; tablet frames are 768 (one pane) or 960 (two panes); desktop frames are 1024, 1280 or 1440.

| State                                  | Phone                                                                                                                                                                                                                          | Tablet                                                                                                | Desktop                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Default (main)                         | `list-320`, `list-375`                                                                                                                                                                                                         | `list-768`, `list-960`, `list-960-archived`                                                           | `list-1024`, `list-1280`, `list-1440` (hover row with its actions)                                   |
| Loading                                | `loading-375`                                                                                                                                                                                                                  | rule: the phone skeleton in the 768 row geometry (avatar circle, two lines, «⋯» circle), count hidden | `loading-1440`                                                                                       |
| Empty — archive                        | `archive-empty-375`                                                                                                                                                                                                            | rule: the phone state block, centred in the list pane                                                 | `archive-empty-1440`                                                                                 |
| Empty — no users at all                | rule: today's «Користувачів поки немає» in the foundation state block (open point 8)                                                                                                                                           | rule: as phone                                                                                        | rule: as phone, in the table card                                                                    |
| Role filter                            | `role-filter-375`                                                                                                                                                                                                              | rule: the same PickerSheet (touch)                                                                    | `filtered-1440` (popover; chip chosen)                                                               |
| Filtered / no results                  | `filtered-375`, `no-results-375`                                                                                                                                                                                               | rule: the phone components in the wider column                                                        | `filtered-1440`, `no-results-1440`                                                                   |
| Search match on a hidden field         | `search-match-375`                                                                                                                                                                                                             | rule: the match line under the name, as phone                                                         | rule: the match line in the name cell, under the name                                                |
| Sort                                   | `sort-sheet-375`, `sorted-added-375`                                                                                                                                                                                           | rule: the phone sort sheet                                                                            | rule: column headers with `aria-sort` (`list-1440`)                                                  |
| Archive tab                            | `archive-375`                                                                                                                                                                                                                  | `list-960-archived`                                                                                   | `archive-1440` (column «Архівовано»)                                                                 |
| Error (list)                           | `error-375`                                                                                                                                                                                                                    | `error-768`                                                                                           | `error-1440`                                                                                         |
| Offline                                | `offline-375`                                                                                                                                                                                                                  | rule: the foundation offline banner above the list pane                                               | rule: the same banner under the page header                                                          |
| Unknown create (after close, M4)       | `list-unknown-banner-375`                                                                                                                                                                                                      | rule: the phone banner above the list pane                                                            | `list-unknown-banner-1440`                                                                           |
| Long content                           | `long-320`, `long-375`                                                                                                                                                                                                         | rule: names wrap to two lines then truncate, emails truncate (phone rule)                             | `long-1024`, `long-1440`                                                                             |
| Row actions                            | `row-actions-375`, `swipe-375`, `swipe-self-375`                                                                                                                                                                               | rule: «⋯» opens the `row-actions-375` sheet; the 960 pane header has «Редагувати» + «⋯» (`list-960`)  | `row-menu-1440`, `row-menu-self-1440`, `touch-1024`                                                  |
| Create steps                           | `create-1-375`, `create-2-375`, `create-2-junior-375`, `create-2-drop-375`, `create-3-375`, `create-3-junior-375`, `create-3-drop-375`, `create-3-320`, `create-4-375`, `create-4-none-375`, `create-5-375`, `role-picker-375` | `create-768`, `create-2-768`, `create-3-768`; steps 4–5: rule — the phone bodies in the 400 panel     | `create-1-1024`, `create-1-1440`, `create-2-1440`, `create-3-1440`, `create-4-1440`, `create-5-1440` |
| Create — locked after the POST (M2)    | `create-1-locked-375`, `create-2-locked-375`                                                                                                                                                                                   | rule: the same read-only fields and reason line in the panel                                          | rule: as tablet                                                                                      |
| Create pending                         | `create-pending-375`                                                                                                                                                                                                           | rule: the phone action bar with «Створюємо…»                                                          | `create-pending-1440`                                                                                |
| Create 409 / failed / older match      | `create-error-375`, `create-failed-375`, `create-retry-older-375`                                                                                                                                                              | rule: the same alert on «Виплати», focus on it                                                        | rule: the same alert at the top of the panel body, focus on it                                       |
| Create unknown                         | `create-unknown-375`                                                                                                                                                                                                           | rule: as phone, in the panel                                                                          | `create-unknown-1440`                                                                                |
| Contract save pending / failed         | `create-4-saving-375`, `create-4-save-failed-375`                                                                                                                                                                              | rule: as phone, in the panel                                                                          | rule: as phone; the footer primary carries the pending label                                         |
| Dirty close                            | `dirty-close-375`                                                                                                                                                                                                              | rule: the centred 420 confirm                                                                         | `dirty-close-1440`                                                                                   |
| Close with unknown outcome             | `close-unknown-375`                                                                                                                                                                                                            | rule: the centred 420 confirm, same copy                                                              | rule: as tablet                                                                                      |
| Edit — loading                         | `edit-375`                                                                                                                                                                                                                     | rule: as phone, in the panel                                                                          | `edit-1440`                                                                                          |
| Edit — loaded                          | `edit-loaded-375` (SENIOR), `edit-junior-375`, `edit-drop-375`, `edit-self-375`, `edit-320`                                                                                                                                    | `edit-768`                                                                                            | rule: the `edit-loaded-375` sections in the 480 / 420 panel, 40 px fields                            |
| Edit — load failed                     | `edit-load-failed-375`                                                                                                                                                                                                         | rule: as phone, in the panel                                                                          | rule: as phone, in the panel                                                                         |
| Edit — save pending / failed / unknown | `edit-save-pending-375`, `edit-save-failed-375`, `edit-save-unknown-375`                                                                                                                                                       | rule: as phone, in the panel                                                                          | rule: as phone; the alert sits at the top of the panel body                                          |
| Email change                           | `email-change-375`                                                                                                                                                                                                             | rule: the centred 420 confirm                                                                         | `email-change-1440`                                                                                  |
| Archive — impact loading               | `archive-impact-loading-375`                                                                                                                                                                                                   | rule: as phone, in the 520 dialog                                                                     | rule: as tablet                                                                                      |
| Archive confirm                        | `archive-confirm-375`, `archive-confirm-keyboard-375`, `archive-armed-375`                                                                                                                                                     | `archive-confirm-768`                                                                                 | `archive-confirm-1440`, `archive-armed-1440`                                                         |
| Archive pending / failed               | `archive-pending-375`, `archive-failed-375`                                                                                                                                                                                    | rule: as phone, in the 520 dialog                                                                     | rule: as tablet                                                                                      |
| Restore pending / failed               | rule: the «⋯» sheet item or the swipe action shows a spinner; failure is today's toast                                                                                                                                         | rule: as phone; in the 960 pane the header «Відновити з архіву» shows the spinner                     | rule: the row's «Відновити з архіву» shows the spinner; failure is today's toast                     |
| Permission-limited                     | `permission-375`                                                                                                                                                                                                               | rule: the same state block in the single pane, with the rail                                          | `permission-1440` (fallback only; the layout redirect normally runs first)                           |
| Touch at desktop width                 | rule: not applicable — phone is always touch                                                                                                                                                                                   | rule: not applicable — tablet is always touch (44 px targets, 16 px inputs)                           | `touch-1024`                                                                                         |

The `permission-1440` frame shows the ADMIN sidebar only because the foundation `desktop()` generator
fixes the role; a real non-admin sees their own nav.

## 4. Self-score

Against `docs/design/rubric-calibration.md`, mockup gate, after council round 1. Data visualisation
(criterion 8) does not apply; weights renormalised over 93. This is the author's own score; the council
re-scores.

| #   | Criterion (weight)    |   Phone |  Tablet | Desktop | Why not higher                                                                                                  |
| --- | --------------------- | ------: | ------: | ------: | --------------------------------------------------------------------------------------------------------------- |
| 1   | Time-to-task (15)     |       9 |       9 |     9.5 | Create is 5 screens on touch; defaults are generic (language = uk, nothing else to pre-fill)                    |
| 2   | Never blocks (15)     |     9.5 |     9.5 |     9.5 | The create POST waits for the server (non-blocking pending; carve-out), no optimistic row                       |
| 3   | Navigation (10)       |     9.5 |     9.5 |     9.5 | URL params (M9) depend on open point 5                                                                          |
| 4   | Forms and input (10)  |     9.5 |     9.5 |     9.5 | Legal name is not pre-filled from «Ім’я та прізвище»; validation on step advance, not on blur                   |
| 5   | Lists and tables (10) |     9.5 |     9.5 |     9.5 | No bulk select or inline edit (not a capability today)                                                          |
| 6   | Sheets, panels (8)    |     9.5 |     9.5 |     9.5 | Full-height create sheet does not drag-dismiss while dirty (asks instead)                                       |
| 7   | System states (10)    |       9 |       9 |       9 | Archive has a typed confirm, not an undo (open point 7); an unknown create is resolved by a manual «Перевірити» |
| 9   | Platform fit (8)      |     9.5 |     9.5 |     9.5 | Not measured on a device yet (baseline pending)                                                                 |
| 10  | Accessibility (7)     |     9.5 |     9.5 |     9.5 | Stepper is a new pattern without a foundation primitive (open point 1)                                          |
|     | **Overall**           | **9.4** | **9.4** | **9.4** |                                                                                                                 |

**Below 9.5 on every class.** Phone and tablet: **1 Time-to-task** (the 5-step create on touch) and
**7 System states** (archive without undo; the unknown-create check is manual until the idempotency key,
open point 12, exists). Desktop: **7 System states** only. Both need a capability, not a mockup change.

## 5. Open points

Each with a recommendation. Foundation files are not edited by this PR (M14); every deviation from them
is listed here.

1. **No stepper primitive in foundation v2 (M14 deviation).** The create flow needs «Крок n з N» + step
   title + bars. _Recommendation:_ add it to `primitives-v2.md` as drawn here (overline in `t-foot`, not
   the uppercase `t-over`, so «Крок 1 з 5» does not read as «1 3 5»).
2. **Foundation `form-add-user-375` vs the code.** The foundation frame implies the invite goes to the
   work email; the code sends it to the personal email when given. _Recommendation:_ follow the code
   (this spec does) and correct the foundation frame in its next revision.
3. **Two control deviations from primitives-v2 (M14).** (a) The archive typed confirm sits in a confirm
   sheet (phone) / centred `alertdialog` (tablet, desktop), not the foundation action sheet, which cannot
   hold the impact list and a text field. (b) The primary is `aria-disabled` in three places where
   primitives-v2 says "always enabled except while its own request is in flight": archive until the name
   matches and the impact has loaded; edit «Зберегти» until the profile has loaded (or after it failed to
   load); and every primary during a pending write (that one is the foundation rule). _Recommendation:_
   accept (a) and (b) and note both in primitives-v2 as the destructive-confirm and the
   load-before-save variants; a pressed `aria-disabled` primary announces its reason
   («Введіть ім’я, щоб підтвердити» / «Зачекайте, профіль ще завантажується»).
4. **Tablet detail pane from row data only.** The full profile belongs to Task 2.2. _Recommendation:_
   keep the pane a preview with «Відкрити профіль»; replace it with the Task 2.2 profile pane when that
   lands, under the same query keys. Row actions no longer depend on it (M10, «⋯» on every row).
5. **List state in the URL (M9, updated).** Today only `archived` is in the URL. _Decided:_ `status`,
   `role`, `sort` and `q` are search params (§2.1); `q` writes with `replace: true`; old `?archived=true`
   links map to `status=archived` and are rewritten with `replace: true`; the query key is unchanged.
6. **The create POST moves from «Далі» to «Створити користувача» (updated).** Same request, same fields,
   PATCH-not-POST after it. New with it: the fields the PATCH cannot carry lock once the POST is sent
   (M2), and «Далі» on «Контракт» saves the contract (M8) instead of the editor's own save button.
   _Recommendation:_ accept all three; the commit moment becomes explicit, and nothing typed after the
   POST is silently dropped.
7. **No undo for archive.** Restore exists, but archive is guarded by a typed name instead of an undo
   toast. _Recommendation:_ keep the typed confirm now (archive has team-wide side effects for a SENIOR);
   revisit an undo toast once the archive impact is reversible in one call.
8. **"No users yet" is practically unreachable** (the ADMIN viewing the screen is a user).
   _Recommendation:_ keep today's text, do not design a dedicated state.
9. **«Вийти» collides with «Log out» in the catalog.** _Recommendation:_ add the dirty-close strings
   with a `msgctxt` (e.g. "leave a form") when the confirm is implemented.
10. **Телефон dropped from the desktop table columns** (kept in the detail pane and profile; the search
    never covered it). _Recommendation:_ accept; add it back at ≥ 1600 only if owners ask.
11. **Phone rows keep no inline contact links or tech chips (updated).** The phone row is one link plus
    one 44 px «⋯»; the `mailto:` / `tel:` / `t.me` links would be sub-44 targets nested in a target.
    Search still matches Telegram and tech, and shows the match on the row (M13). _Recommendation:_
    accept; contacts are one tap away in the profile and the tablet detail pane.
12. **Idempotency key for create (dependency on plan Task 1.1, not a blocker).** Without it the unknown
    outcome is resolved by the email + `createdAt` check (M3) and an in-memory list banner (M4), which a
    reload loses. _Recommendation:_ when Task 1.1 adds an idempotency key to `POST /users` and
    `POST /users/drops`, the retry sends the same key, the check and the banner become exact, and the
    skew allowance goes.
13. **DROP create drops the personal email and locale (code gap found in round 1).** `IdentitySection`
    shows both on create for every role, but `buildCreateDropPayload` sends neither. The design keeps
    both fields on «Особа» (the role is chosen on step 2). _Recommendation:_ the coder sends both in the
    drop create if `/users/drops` accepts them; if it does not, hide both once DROP is chosen and say so
    on «Роль і команда». Decided by the coder against the endpoint schema, not by this spec.

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
- The create POST moves to «Створити користувача» (open point 6); PATCH-not-POST after it, as today;
  the PATCH-less fields lock once the POST is sent (§2.5, M2).
- Writes follow §2.9 exactly (pending, failure, unknown, invalidation); field placement follows §2.10.
- URL params and the `?archived=true` mapping: §2.1 (M9).

`design-gate: degraded` — no headless Claude Design; HTML prototypes on foundation tokens.

## 9. Council round 1 ledger

Source: the consolidated round 1 findings (R1-01..R1-21). Fixed 21, rejected 0.

| Id    | Fixed by                                                                                                                                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1-01 | §2.5 M2 lock + M3 retry check; DROP continuation; frames `create-1-locked-375`, `create-2-locked-375`, `create-retry-older-375`                                                                                                                                                                        |
| R1-02 | §2.5 close-with-unknown confirm (says nothing is lost) + list banner; frames `close-unknown-375`, `list-unknown-banner-375`, `list-unknown-banner-1440`                                                                                                                                                |
| R1-03 | §2.9 write table + the pending-controls rule; frames `edit-load-failed-375`, `edit-save-pending-375`, `edit-save-failed-375`, `edit-save-unknown-375`, `archive-pending-375`, `archive-failed-375`, `archive-impact-loading-375`                                                                       |
| R1-04 | §2.5 step table + §2.10 parity (IBAN, SENIOR team channel, DROP payout method, «Створити дропа», «Дропа створено», DROP tech, «Місячна зарплата» + «≈ USD», legal name not pre-filled); frames `create-3-*` redrawn, `create-3-drop-375`, `edit-loaded-375` (full), `edit-junior-375`, `edit-drop-375` |
| R1-05 | Email-change confirm carries today's consequence sentence from the catalog (§2.8); `email-change-375`, `email-change-1440` redrawn                                                                                                                                                                     |
| R1-06 | §2.5 M8 («Далі» saves the contract, pending + failed) and the no-template variant of «Підтвердження»; frames `create-4-saving-375`, `create-4-save-failed-375`                                                                                                                                         |
| R1-07 | §2.3 tablet row with a second column; §3 three-column matrix with a frame or rule in every cell; frames `list-768` redrawn, `error-768`, `edit-768`, `archive-confirm-768`, `create-2-768`; desktop create pending `create-pending-1440`                                                               |
| R1-08 | Chip row scrolls with an edge fade; `list-320` full height; `create-3-320` with the stacked footer; `edit-320`                                                                                                                                                                                         |
| R1-09 | §2.4 1024 widths (role ≥ 128, date 136, email `title` tooltip) + M11 reflow on every 1440 panel frame                                                                                                                                                                                                  |
| R1-10 | M12 «Архівовано» column on desktop and the second line on phone; no badge in the name cell; `archive-1440`, `archive-375` redrawn                                                                                                                                                                      |
| R1-11 | §2.1 M9 URL state, `?archived=true` mapping; open point 5 updated                                                                                                                                                                                                                                      |
| R1-12 | Sentence-case count, filtered subtitle, two-line name wrap, bottom padding FAB + 16, skeleton in the final geometry; `list-375`, `filtered-375`, `loading-375` redrawn                                                                                                                                 |
| R1-13 | Name bold in the typed-confirm label; the action bar rides the keyboard; frame `archive-confirm-keyboard-375`                                                                                                                                                                                          |
| R1-14 | `permission-375` keeps the shell tab bar and gets «На головний екран»                                                                                                                                                                                                                                  |
| R1-15 | The title already sat in the centred grid column (`.sheethead`); the defect was the missing gap to «Скасувати» at 375 / 320 — fixed in the users generators; the touch panel head became the same three-column grid; the rail sits under the scrim at `create-768`                                     |
| R1-16 | §2.8 completed in uk + en: single-filter no-results, «Архів порожній», offline banner, «Виплати» / "Payouts", invite hint = today’s `IdentitySection` text (the generator already matched it), dirty-close copy naming what is lost, field 400 mapping (§2.5), HR / ACCOUNTANT rule (§2.5)             |
| R1-17 | §2.1 M13 match reason line; frame `search-match-375`                                                                                                                                                                                                                                                   |
| R1-18 | M15 fixtures (the created person is not in the list); `sorted-added-375` ordered by createdAt; frame `sort-sheet-375`                                                                                                                                                                                  |
| R1-19 | Chosen role chip ×; touch-1024 search 16 px; full-contrast self reason in `row-menu-self-1440`; frame `swipe-self-375`; open point 3 extended                                                                                                                                                          |
| R1-20 | `create-5-375` wraps the email; `list-960` pane adds Телефон; frame `list-960-archived`; screen-reader rule for the swipe row (§2.1)                                                                                                                                                                   |
| R1-21 | A unit beside every money and percent field (§2.5); `create-3-*` and edit frames redrawn                                                                                                                                                                                                               |

## 10. Assumptions

Master decisions (M1–M15) and the designer's own A1 decisions (reversible within one PR; recorded so
the PR body carries them).

- M1 — Field parity is a hard rule: §2.10 lists every field with its roles, create step and edit section; every row has a frame or a rule line.
- M2 — Once the first create POST is sent (any outcome, unknown included), the fields the PATCH does not carry (email, personal email, role, locale, team type / drop team, project, team Telegram channel) are read-only with one reason line; «Назад» stays; a different email means a new create flow.
- M3 — A retry never decides "created" from the email alone: a refetched row counts as ours only if the email matches and `createdAt` is later than the first submit; otherwise the 409 path. An idempotency key (plan Task 1.1) would make this exact: open point 12, a dependency, not a blocker.
- M4 — An unresolved create stays visible after the wizard closes: the close confirm does not say data is lost, the list refetches, and the banner «Невідомо, чи створено {email}» stays until the outcome is known or the admin dismisses it.
- M5 — One write-rules table for create, edit, archive and restore (§2.9): pending, not optimistic; failure text, toast and focus; invalidated keys, `['users-archive-impact', id]` with `staleTime: 0`.
- M6 — Edit has a full lifecycle: load pending, load failed with «Повторити», save pending, save failed (values kept, focus on the alert), save unknown.
- M7 — The email-change confirm keeps today's consequence sentence, from the catalog.
- M8 — «Контракт» has one primary: «Далі» saves the contract and has pending and failed states. This differs from today, where the editor has its own save button (`useSaveContractBody`) and the footer «Далі» only navigates (`UserDialogFooter`).
- M9 — Status, role, sort and `q` are URL search params; `q` uses `replace: true` while typing; `?archived=true` links map to `status=archived`.
- M10 — Tablet is its own class with its own row and frames; row actions have an in-screen path on every class that does not depend on the profile, and on touch swipe is never the only path.
- M11 — While the non-modal ≥ 1440 panel is open, the table reflows to the 1024 column set.
- M12 — The archive tab has its own «Архівовано» column; «Додано» always means createdAt.
- M13 — Search covers fields the row does not show; a matching row shows the match reason on one line under the name.
- M14 — Foundation files are not edited; the stepper, the typed confirm and the `aria-disabled` primaries are open points 1 and 3; where the foundation answers (centred sheet title, two-line names under 640, 16 px inputs on a coarse pointer, bars under the scrim) it is followed.
- M15 — The person created in the wizard frames is not in the list frames; invented names only.
- A1 — 409 under M2: since the email is locked, the alert offers «Почати з іншим email», a new flow with every other value kept and Email empty.
- A1 — A 5xx answer is treated as unknown, not failed: the server may have written the user before it failed.
- A1 — The M3 `createdAt` comparison uses the client time of the first submit minus a two-minute skew allowance.
- A1 — The M10 in-screen path on phone and tablet is a 44 px trailing «⋯» button opening the action sheet «Дії з користувачем»; the swipe layer is hidden from screen readers.
- A1 — During any pending write the sheet or panel cannot close (as archive does today); the request's own timeout ends the pending state as unknown.
- A1 — The plain create POST newly invalidates `users-admin` (today it invalidates nothing until draft / mark-ready), so the M3 check and the list see the new user.
- A1 — The unknown-create banner lives in memory for the browser session; a reload drops it until the idempotency key lands.
- A1 — The money-draft «Згорнути» exception is not applied: users have no draft queue, so the general dirty-close rule holds, with copy that names what is lost.
- A1 — An unknown edit save is retried by reloading the profile first and sending only the fields that still differ.
- A1 — No contract template: «Підтвердження» shows «Контракт: Немає» and a single «Готово».
- A1 — DROP keeps personal email and locale on «Особа» until open point 13 is settled against the endpoint.
- A1 — Sort in the URL is `sort=name|role|added` with a `-` prefix for descending; the default `name` is omitted.
