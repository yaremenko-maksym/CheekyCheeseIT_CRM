# App shell v2 — Foundation (Wave 0)

> Per-screen artifact (CRM redesign v2). Coder-ready spec on our shadcn/ui + tokens. Headless agents rely
> ONLY on this file + `assets/` (no browser access). Visual and interaction language:
> `docs/design/foundation.md` v2. Program: `docs/superpowers/specs/2026-11-11-crm-redesign-v2-design.md`.
> Scoring: `docs/design/rubric-calibration.md`. The v1 shell (`app-shell.md`) is superseded by this file.
>
> **The mockups are a visual reference, not code to paste.** Build with our components per this spec.

| Field          | Value                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen         | App shell v2: mobile tab bar + More sheet + quick-add, tablet rail, desktop sidebar + header + Cmd+K + `?` sheet, shell states                      |
| Routes         | `apps/web/app/routes/__root.tsx`, `apps/web/app/routes/_authenticated/route.tsx` (`CrmLayout`) — inherited by every screen                          |
| Existing parts | `components/crm/nav-sidebar.tsx`, `components/crm/StickyPageHeader.tsx`, notifications bell, impersonation banner, `ui/command.tsx`, `ui/sheet.tsx` |
| Roles          | ADMIN · SENIOR · SENIOR without a team · JUNIOR · HR · ACCOUNTANT · DROP                                                                            |
| design-gate    | **degraded** — Playwright renders of HTML prototypes (`assets/src/`), Claude Design not driven                                                      |
| Status         | `captured` (mockups done; mockup-gate council pending)                                                                                              |
| Sample data    | invented (names, amounts, counts)                                                                                                                   |
| Contact sheets | `assets/shell-v2/_contact-sheet.png` (phones) · `assets/shell-v2/_contact-sheet-wide.png` (tablet / desktop)                                        |

---

## 1. Navigation model per role

Destinations = `route-access` ∩ the existing `NAV_ITEMS` (labels = the existing uk catalog strings). The
tab bar holds **4 destinations + «Ще»**. «Ще» holds everything else, grouped, plus the profile at the top.

| Role             | Tab 1      | Tab 2       | Tab 3      | Tab 4     | In «Ще»                                                                                                      | Context «+» (direct on the tab · menu elsewhere)                                                    |
| ---------------- | ---------- | ----------- | ---------- | --------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| ADMIN            | Фінанси    | Користувачі | Статистика | Адмін     | Дашборд · Чекають рішення · Команда · Проєкти · Співбесіди · Документи · Вакансії · Черга зовнішніх вакансій | Фінанси → Нова транзакція · Користувачі → Новий користувач · elsewhere menu of all 4                |
| SENIOR           | Дашборд    | Фінанси     | Команда    | Проєкти   | Чекають рішення · Співбесіди · Документи                                                                     | Фінанси → Нова транзакція · Співбесіди → Нова співбесіда · elsewhere menu (транзакція · співбесіда) |
| SENIOR (no team) | Дашборд    | Фінанси     | Команда    | Документи | Чекають рішення                                                                                              | Нова транзакція on every tab (one action)                                                           |
| JUNIOR           | Мій проєкт | Фінанси     | Легенда    | Документи | Чекають рішення                                                                                              | none (no «+»)                                                                                       |
| HR               | Дашборд    | Співбесіди  | Вакансії   | Команда   | Фінанси · Чекають рішення · Проєкти · Документи · Черга зовнішніх вакансій                                   | Співбесіди → Нова співбесіда · Вакансії → Нова вакансія · elsewhere menu (співбесіда · вакансія)    |
| ACCOUNTANT       | Фінанси    | Статистика  | Дашборд    | Проєкти   | Чекають рішення · Команда · Документи                                                                        | Нова транзакція on every tab (one action)                                                           |
| DROP             | Дашборд    | Фінанси     | Документи  | Команда   | Чекають рішення                                                                                              | Нова транзакція on every tab (one action)                                                           |

- **ADMIN tab 4 is «Адмін»** (`/admin`, which redirects to `/admin/contracts`, the contract-template
  editor): editing contracts is a daily owner task, the dashboard is not. «Дашборд» moves to «Ще» → Огляд.
- **Profile** is the first row of «Ще» (avatar, name, «Профіль · <role>»), not a tab.
- **«Ще» badge** = the sum of badges of the destinations it hides (today: «Чекають рішення»).
- Quick-add actions are existing create actions only (verified against `canCreate` / route-access,
  2026-11-11). **Context «+»:** on a tab that owns one of the role's create actions, «+» opens that
  action directly (`aria-label` = its name, «Нова транзакція»); on any other tab it opens the role's
  action menu (`aria-label` «Створити», `aria-haspopup="dialog"`). A role with one action always opens
  it directly. None: no «+».
- **Groups** (sidebar and «Ще»): Огляд · Гроші · Люди · Робота · Найм · Система. Empty groups are hidden.

---

## 2. Mobile (< 640 px)

### Tab bar

- `nav` landmark, `aria-label="Основна навігація"`; each tab is a link with `aria-current="page"` when
  active. 50 px + bottom safe area, top `border-border`, a 94% opaque near-`card` fill with a 20 px
  backdrop blur (the iOS bar convention: content scrolling under it stays legible as motion, not text).
  Under `prefers-reduced-transparency` the bar is fully opaque.
- Each tab: 24 px Lucide icon over a 10.5/13 label (10 at 320). Active: icon `text-primary`, label
  `text-foreground` **and semibold (650)**; inactive: `text-muted-foreground`, 500. The weight change is
  the non-colour cue (SC 1.4.1). Hit area = full tab cell (≥ 64 × 50).
- Badge: yellow pill (`bg-primary`, `text-primary-foreground`, 17 px), announced as part of the tab name
  ("Ще, 3 нових").
- Tab switch is **instant** (no animation). Re-tapping the active tab scrolls to top, then pops to root.

### Top bar

- Tab root: large title 28/34 that collapses into a 44 px inline bar on scroll; bell (and search where the
  screen has it) on the right.
- Pushed screen: 44 px bar, back chevron (44 × 44 `<button>`, `aria-label="Назад"`) + a 17/22 title
  **centred on the bar, not on the space left over** (iOS): the title is absolutely positioned and
  inset on both sides by the wider side, the back button or the trailing actions (`--topbar-side`,
  56 px with back only, 104 with «Зберегти», 168 with «Редагувати» + «Інші дії»), and truncates before
  it collides. The product measures the trailing slot (one `ResizeObserver`) rather than hard-coding
  the inset. A detail page has no title at rest (`primitives-v2.md` detail page).

### Quick-add FAB

- 56 px yellow circle (context «+», §1), bottom right, inset 16, 16 px above the tab bar. Hidden while
  the keyboard is open and while a sheet is open. **Never dimmed or disabled**, offline included.
- **FAB and pill on scroll.** Scrolling down slides the FAB and the upload pill out below the tab bar;
  they come back on scroll-up or after **1 s** without scrolling. Transform only (`translateY`, 200 ms
  standard easing); under `prefers-reduced-motion` they fade instead. They never hide while one of them
  holds keyboard focus (SC 2.4.11). Mid-scroll, a trailing amount that sits under the FAB slot is
  readable, and the large title has collapsed into the 44 px inline bar («Фінанси» centred, a hairline
  under the bar) (`state-scrolled-375`).
- **Floating-layer stacking:** toasts and the upload pill sit left of the FAB (inset 12 left, 80 right,
  16 above the tab bar), so neither covers the other. Tab-root lists end with 56 + 16 + 8 px of bottom
  padding above the tab bar, so the last row scrolls clear of the FAB.
- Menu (`quick-add-admin-375`, drawn from Статистика, a tab with no create action of its own;
  `quick-add-hr-320` from Дашборд): a medium sheet listing the role's actions (icon, label, one-line
  hint). Each row 64 px.
- `quick-add-txn-keyboard-375`: «Нова транзакція» opens as the canonical money form
  (`primitives-v2.md` §4; source `assets/src/money-form.mjs`): «Скасувати» top-left («Згорнути» while
  the draft is armed, failed or unknown), title centred,
  nothing top-right; the amount is focused with the decimal keyboard up and the bottom submit bar riding
  on it. The bar above the keys is **iOS Safari's own accessory bar**, drawn and labelled "system" only;
  we do not build one. The type toggle is the role's create set (ADMIN: Витрата / Дохід / Переказ); the
  optional fields sit collapsed in «Сьогодні · без проєкту · змінити». The frame is illustrative; the
  Wave 1 finance spec owns the form.
- **Armed save** (save during a receipt upload). The primary stays an active button (no
  `aria-disabled`: it acts) whose label says what a tap does: «Зберегти після завантаження чека». A tap
  **freezes the payload and arms** (`quick-add-txn-armed-375`, `quick-add-txn-armed-320`): the button
  turns into a progress fill reading «Збережеться 1 250,50 USD після чека» with «чек 62%» as a
  `progressbar` (no `aria-pressed`; only arm, disarm and result are announced). The armed primary is
  `aria-disabled="true"` (not `disabled`: it keeps focus and its name); a repeat tap toggles nothing
  and explains the wait. Disarm is the separate 44 px text button «Не зберігати автоматично» under it,
  any field edit, or replacing / removing the receipt. While armed the leading control reads **«Згорнути»**: it closes the sheet and the save stays
  armed (a drag down and a scrim tap do the same); the global upload pill then carries «Збережеться 1
  250,50 USD · 62%» / «Відкрити чернетку» (`primitives-v2/upload-pill-armed-375`). At 100% exactly one
  request is sent, so a form without an idempotency key still sends exactly once; while it is **in
  flight** the pill reads «Зберігаємо 1 250,50 USD…». The result **stays in the pill until tapped**
  («Збережено 1 250,50 USD · Відкрити», which a 44 px ✕ «Закрити» or a swipe also dismisses; «Не
  збережено 1 250,50 USD · Відкрити»; «Результат невідомий» · «1 250,50 USD · Відкрити»,
  `primitives-v2/upload-pill-unknown-375`); no sheet opens by itself. **Several drafts, one model**
  (foundation §11 is the single source): one pill slot shows the highest state, **unknown > failed >
  in flight > armed > saved**, with the amount for one draft and a count for more («Збережеться 2
  транзакції · 1 з 2»; two or more failed or unknown drafts read «2 чернетки»); «+2 чеки» counts only
  uploads that belong to no draft; Фінанси pins one row per unsaved draft (`primitives-v2/drafts-two-375`).
  An armed or in-flight draft blocks nothing: «+» opens a new form. One failed or unknown draft makes
  «+» reopen it (the FAB reads «Відкрити чернетку 1 250,50 USD» and shows the draft icon); two or more
  make «+» open Фінанси at the pinned rows (FAB «Відкрити 2 чернетки»). Discard is offered for a failed
  or unknown draft and is unavailable only while its request is in flight. Every money create writes
  its page-kill marker `{ t, phase: 'sent' }` at send (an armed one writes `armed` first);
  backgrounding does not disarm; a page kill is reported at the next boot with one alert per phase
  (`armed` and `failed`: not saved; `sent`: check the list, no resubmit). An upload failure on an armed draft makes it **failed**
  (foundation §11), never a silent disarm: the error sits on the receipt card with «Повторити» /
  «Замінити», and with the sheet closed the pill reads «Не збережено 1 250,50 USD · Відкрити»
  (`primitives-v2/form-receipt-failed-375`). A failed or unknown draft closes with «Згорнути» (a drag or
  a scrim tap does the same) and is kept; «Видалити чернетку» under the primary discards it after the
  named confirm. An unknown draft is read-only until it leaves that state. The receipt is mandatory (a file or a link; USDT: an explorer link only), so no path saves
  without one (primitives-v2 §4).

### More sheet

- Large bottom sheet, `--radius-sheet` top corners, drag handle, close button (44 px), drag-to-dismiss.
- Grouped rows (56 px) in `bg-card` group containers; section overlines; trailing chevrons; badges.

### Shell states

- **Loading** (`state-loading-375`): shell renders immediately; content area shows a layout-matching
  skeleton. The tab bar is interactive during loading.
- **Empty** (`state-empty-375`): a centred block (icon tile, title, one line) names the next step («Натисніть
  «+», щоб додати першу»); the «+» stays where it always is, so the screen has one entry point. A
  filtered-empty list is different: it offers «Скинути фільтри» (`primitives-v2/listrow-empty-error-375`).
- **Error** (`state-error-375`): `role="alert"` block «Не вдалося завантажити транзакції» + «Нічого не
  змінено» + «Спробувати ще». The retry re-runs the read query only (safe); it is never a money write.
- **Offline** (`state-offline-375`): a slim `role="status"` banner under the top bar («Немає з’єднання.
  Показано останні завантажені дані; збереження не пройде, введене залишиться у формі.»), cached content
  stays visible, the FAB stays enabled, writes queue nothing (spec §4.5b: nothing survives a close). A
  save attempt shows the definite inline alert with every value kept (`primitives-v2/toast-error-offline-375`).
- **Impersonation** (`state-impersonation-375`): the existing banner, pinned under the top bar, with
  «Повернутися» (44 px); the tab bar shows the impersonated role's tabs.

---

## 3. Tablet (640–1023 px)

- 80 px **navigation rail** on the left: quick-add button on top, then **every role destination that
  fits by height** (the tab-bar set first, then the rest in sidebar group order), icon over label, the
  avatar (profile) at the bottom. Active item on `bg-accent` with a yellow icon. At 768 × 1024 all 12
  ADMIN destinations fit (`tablet-rail-768`).
- «Ще» appears **only on overflow** (a short window: Split View, Stage Manager, landscape) and opens a
  **popover** from the rail with the destinations that did not fit (`tablet-rail-more-768`, a 768 × 700
  window). The fit is a height budget (status 24 + brand and «+» 120 + avatar 64 + home indicator 20);
  Wave 0 measures the real row heights.
- **Panes:** one pane at 640–899 (the list takes the full width; the detail pushes; no selected-row
  highlight); list + detail side by side only from **≥ 900** (`tablet-two-pane-1000`: rail 80, list
  360, detail 560 at 1000, the selected row `bg-raised` + `aria-current`). Touch heights (inputs 48, buttons 44): density follows `(pointer: coarse)`,
  not width.
- **The detail pane at ≥ 900 is the pushed detail page body**, not a second layout: the same
  component renders both (`primitives-v2/detail-txn-375` and the right pane of
  `tablet-two-pane-1000`). One field set (Тип, Платник, Отримувач, Дата, Проєкт, Створив) and **one
  status-pill slot under the amount** («Оплачено», «Очікує», …); the type is a field, never a second
  pill. The pane keeps the page's top bar without the back button: title «Транзакція» + «Редагувати» +
  «Інші дії». Under 900 the same body is pushed as a page.
- **The list pane scrolls as one block** (search, chips, section heads and group cards in one
  scroller): a group card never shrinks to the pane height and never clips its last row.

---

## 4. Desktop (≥ 1024 px)

### Sidebar

- 248 px, `bg-card`, grouped (overlines), 36 px rows (one value; `primitives-v2.md` §3 agrees), active
  row `bg-accent` + yellow icon + 2 px yellow leading bar. Footer: user row (avatar, name, role) opening
  the profile menu.
- **Table selected row** uses the same cue: `bg-accent` + a 2 px yellow leading bar + `aria-selected`
  (`desktop-sidebar-1440`).
- **Touch density** (`shell-touch-1180`, an iPad in landscape): the layout follows the width (sidebar,
  header, table), the density follows `(pointer: coarse)`: sidebar rows 44, table rows 52 / header 44,
  filter chips, bell and page action 44, search 48 with 16 px text.
- **Collapsible** to a 64 px icon rail (toggle at the top, or the single key `[`, which the SC 2.1.4 toggle in the `?` sheet can turn off and
  which never fires inside a text field; the `?` sheet lists the same key); every icon gets a tooltip with the
  label and its `G` shortcut («Фінанси G F»). State stored on the device.

### Header

- Breadcrumb «Група / Сторінка», bell, the page's primary action as a yellow button with its single-key
  hint (for example «Нова транзакція» `C`).

### Command palette (Cmd+K)

- `ui/command.tsx` in a centred dialog (640 px; 560 at 1024). Groups: **Дії** (page and quick-add actions),
  **Перейти** (role destinations), **На цій сторінці** (search over the loaded rows only).
- **No cross-entity server search** (spec §4.5b). Each row shows its shortcut keys. Footer shows ↑↓ / ↵ / Esc.

### Shortcut sheet (`?`)

- 880 px dialog, three columns: Загальні · Перехід · Списки. Top: a switch «Однолітерні скорочення»
  (single-key shortcuts on/off), stored on the device (SC 2.1.4). With it off, only modifier shortcuts work.

### Money drafts per size (one model, three placements)

The draft state model is the same everywhere (`foundation.md` §11 money drafts); only the placement
changes.

| Concern                                  | Phone (< 640)                                                                                                                                 | Tablet (640–1023)                                                                                       | Desktop (≥ 1024)                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Where a new draft starts                 | The FAB (on Фінанси it is «Нова транзакція»), or the quick-add menu elsewhere                                                                 | The rail «+» (top of the rail), the same action                                                         | The header primary «Нова транзакція» (`C`), or Cmd+K → Дії                                                        |
| The start control with unresolved drafts | One: the FAB reopens it («Відкрити чернетку 1 250,50 USD», `file-pen` + red dot). 2+: «Відкрити 2 чернетки», opens Фінанси at the pinned rows | Same rule on the rail «+» (name, icon and dot)                                                          | Same rule on the header button: its label becomes «Відкрити чернетку» / «Відкрити 2 чернетки», the dot sits on it |
| Form container                           | Large sheet (`quick-add-txn-*`) or the pushed page (`form-money-375`)                                                                         | Side panel, 400 px, the same `moneyBody()` (`primitives-v2/sheet-panel-768`)                            | Side panel, 420 at 1024 / 480 at 1440 (`sheet-panel-1024`, `sheet-panel-1440`)                                    |
| The pill slot                            | Above the tab bar, left of the FAB (§2 floating-layer stacking)                                                                               | The toast slot: centred 24 px above the bottom edge, 420 wide, right of the rail; toasts stack above it | The toast slot: bottom-left of the main area next to the sidebar; toasts stack above it                           |
| Pinned draft rows                        | Top of the Фінанси list                                                                                                                       | Top of the Фінанси list pane                                                                            | Top of the Фінанси table, above the first group                                                                   |
| «Перевірити список» (form is open)       | The check sheet «Нові записи» over the kept form sheet                                                                                        | A centred 560 px dialog «Нові записи» over the side panel; the panel stays mounted and keeps the draft  | The same 560 px dialog over the side panel                                                                        |
| Focus after the check closes             | Back to «Перевірити список»                                                                                                                   | Back to «Перевірити список» in the panel                                                                | Same                                                                                                              |
| Receipt switch (empty receipt)           | «Файл» / «Посилання», 44 px segmented above the tile                                                                                          | The same switch, 44 px, in the panel (`sheet-panel-768`)                                                | The same switch; 36 px on `(pointer: fine)`, 44 on `(pointer: coarse)`                                            |
| Receipt, effective currency USDT         | The explorer-link field only, no switch (`form-receipt-usdt-empty-375`)                                                                       | Same                                                                                                    | Same                                                                                                              |

---

## 5. Frames (all PNG under `assets/shell-v2/`)

| Frame                                | Width | Shows                                                 |
| ------------------------------------ | ----: | ----------------------------------------------------- |
| `tabbar-admin-375.png`               |   375 | ADMIN tab bar (tab 4 «Адмін»), «Ще» badge, «+»        |
| `tabbar-senior-375.png`              |   375 | SENIOR tab bar, own-project rows only                 |
| `tabbar-senior-teamless-375.png`     |   375 | SENIOR without a team (Документи in slot 4)           |
| `tabbar-junior-375.png`              |   375 | JUNIOR (no «+»), own salary rows only                 |
| `tabbar-hr-375.png`                  |   375 | HR                                                    |
| `tabbar-accountant-375.png`          |   375 | ACCOUNTANT                                            |
| `tabbar-drop-375.png`                |   375 | DROP, drop income and payout rows only                |
| `tabbar-admin-320.png`               |   320 | ADMIN at the narrowest width (labels fit)             |
| `tabbar-hr-320.png`                  |   320 | HR at 320 (longest labels)                            |
| `more-sheet-admin-375.png`           |   375 | More sheet, ADMIN (8; «Дашборд» in Огляд)             |
| `more-sheet-junior-375.png`          |   375 | More sheet, JUNIOR (short)                            |
| `more-sheet-admin-320.png`           |   320 | More sheet at 320                                     |
| `quick-add-admin-375.png`            |   375 | Quick-add menu from Статистика (4 actions)            |
| `quick-add-hr-320.png`               |   320 | Quick-add menu at 320                                 |
| `quick-add-txn-keyboard-375.png`     |   375 | Canonical money form, decimal keys + system bar       |
| `quick-add-txn-armed-375.png`        |   375 | Save armed: «Згорнути», separate disarm, 62%          |
| `quick-add-txn-armed-320.png`        |   320 | Armed at 320: 1 250 000,50 UAH, label wraps           |
| `state-loading-375.png`              |   375 | Shell + skeleton                                      |
| `state-scrolled-375.png`             |   375 | Scrolled: inline title, FAB slid out, amount readable |
| `state-empty-375.png`                |   375 | Empty tab root                                        |
| `state-error-375.png`                |   375 | Load error with a safe re-fetch                       |
| `state-offline-375.png`              |   375 | Offline banner, FAB stays enabled                     |
| `state-impersonation-375.png`        |   375 | Impersonation banner                                  |
| `tablet-rail-768.png`                |   768 | Rail with every destination, one pane                 |
| `tablet-rail-more-768.png`           |   768 | 768 × 700 window: overflow «Ще» popover               |
| `tablet-two-pane-1000.png`           |  1000 | ≥ 900: rail 80 · list 360 · detail 560 (detail body)  |
| `desktop-sidebar-1024.png`           |  1024 | Sidebar + header + dense table                        |
| `desktop-sidebar-collapsed-1024.png` |  1024 | Collapsed rail with tooltip                           |
| `desktop-sidebar-1440.png`           |  1440 | Wide: extra column, selected-row bar                  |
| `shell-touch-1180.png`               |  1180 | iPad landscape: desktop layout, touch density         |
| `desktop-cmdk-1440.png`              |  1440 | Cmd+K palette                                         |
| `desktop-cmdk-1024.png`              |  1024 | Cmd+K at the narrowest desktop                        |
| `desktop-shortcuts-1440.png`         |  1440 | `?` shortcut sheet with the single-key toggle         |

Re-render: `node assets/src/render.mjs shell [filter]`, then `assets/src/contact-sheet.sh shell`.

---

## 6. A11y critical paths

- Focus order (mobile): top bar → content → FAB → tab bar. Desktop: skip link → sidebar → header → main.
- Tab bar and rail are `nav` landmarks; sidebar is `nav` with group headings as `h2` (visually overlines).
- More sheet and Cmd+K trap focus, close on Esc and scrim, and return focus to the trigger.
- Every coarse-pointer target ≥ 44 × 44, whatever the width; fine-pointer desktop rows 36 px with a
  full-row hit area.
- Badge counts are in the accessible name; the offline banner is `role="status"`.
- Single-key shortcuts can be turned off (SC 2.1.4); they never fire inside text fields.

## 7. Edge cases

- Role with ≤ 4 destinations besides profile: still 4 tabs + «Ще» (profile lives there); no empty slot.
- Long uk labels at 320: labels truncate with ellipsis; the accessible name keeps the full label.
- Impersonation of a role with no quick-add: the FAB disappears with the role.
- Badge > 99: «99+».

## 8. Assumptions (A1, Task 0.8)

- SENIOR without a team loses `/projects`, so «Документи» takes tab slot 4.
- Tab labels reuse the existing nav strings («Дашборд» for Home). «Ще» and the six group headings are
  new strings (copy-reviewer gate in the Wave 0 implementation).
- The FAB sits above the tab bar, not inside it (tab bar = navigation only).
- Tablet uses a rail listing every destination that fits, with a popover «Ще» only on overflow, not a
  bottom sheet.
- ADMIN tab 4 = «Адмін» (contract editing) and «Дашборд» in «Ще» (council R1 ruling).
- Sidebar collapse shortcut `[` and the `G <letter>` navigation shortcuts are proposals for the
  implementation task. `[` was chosen over ⌘\ (task review fix round 1) and is guarded like every
  single-key shortcut.
- Finance rows in the role frames are role-plausible sample data (SENIOR: own project; DROP: drop income
  and payouts; JUNIOR: own salary). What each role really sees is the existing RBAC, unchanged by v2.
- The armed save after an upload (frozen payload, kept across a sheet dismiss, carried by the pill)
  and the in-memory draft are proposals; the Wave 1 finance spec confirms them per form. The draft row
  is drawn (`primitives-v2/listrow-draft-375`). The two unknown-outcome exits are a provisional ruling;
  the owner confirms them at PNG approval.
