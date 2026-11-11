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

| Role             | Tab 1      | Tab 2       | Tab 3      | Tab 4     | In «Ще»                                                                                                    | Quick-add «+»                                         |
| ---------------- | ---------- | ----------- | ---------- | --------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| ADMIN            | Фінанси    | Користувачі | Статистика | Дашборд   | Чекають рішення · Команда · Проєкти · Співбесіди · Документи · Вакансії · Черга зовнішніх вакансій · Адмін | menu: транзакція · користувач · співбесіда · вакансія |
| SENIOR           | Дашборд    | Фінанси     | Команда    | Проєкти   | Чекають рішення · Співбесіди · Документи                                                                   | menu: транзакція · співбесіда                         |
| SENIOR (no team) | Дашборд    | Фінанси     | Команда    | Документи | Чекають рішення                                                                                            | direct: Нова транзакція                               |
| JUNIOR           | Мій проєкт | Фінанси     | Легенда    | Документи | Чекають рішення                                                                                            | none (no «+»)                                         |
| HR               | Дашборд    | Співбесіди  | Вакансії   | Команда   | Фінанси · Чекають рішення · Проєкти · Документи · Черга зовнішніх вакансій                                 | menu: співбесіда · вакансія                           |
| ACCOUNTANT       | Фінанси    | Статистика  | Дашборд    | Проєкти   | Чекають рішення · Команда · Документи                                                                      | direct: Нова транзакція                               |
| DROP             | Дашборд    | Фінанси     | Документи  | Команда   | Чекають рішення                                                                                            | direct: Нова транзакція                               |

- **Profile** is the first row of «Ще» (avatar, name, «Профіль · <role>»), not a tab.
- **«Ще» badge** = the sum of badges of the destinations it hides (today: «Чекають рішення»).
- Quick-add actions are existing create actions only (verified against `canCreate` / route-access,
  2026-11-11). One action: «+» opens it directly. None: no «+». Several: an action menu sheet.
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
- Pushed screen: 44 px bar, back chevron (44 × 44, `aria-label="Назад"`) + centred 17/22 title.

### Quick-add FAB

- 56 px yellow circle, `aria-label` = the action name (direct) or «Створити» (menu), bottom right, 16 px
  above the tab bar. Hidden while the keyboard is open and while a sheet is open.
- Menu: a medium sheet listing the role's actions (icon, label, one-line hint). Each row 64 px.
- `quick-add-txn-keyboard-375`: «Нова транзакція» opens as a large sheet with the amount field focused,
  the decimal keyboard up, and a keyboard accessory bar (˄ ˅ previous / next field, «Готово»). The type
  toggle is the role's create set, the same as `form-money-375` (ADMIN: Витрата / Дохід / Переказ). The
  sheet content scrolls above the keyboard; the focused field is never covered. The frame is
  illustrative; the Wave 1 finance spec owns the form.
- **Save waits for the receipt upload.** While a receipt uploads, the save button is not a plain submit:
  it shows the upload progress («Зберегти · чек 62%», a progress fill, `aria-disabled` and described by
  the receipt status line). A tap arms the save: one request is sent automatically when the upload
  reaches 100%, so a form without an idempotency key still sends exactly once. Until that request is
  sent, the sheet stays dismissible (Скасувати, drag, scrim); dismissing cancels the armed save (nothing
  was sent), the upload keeps going under the global upload pill, and the draft is kept for the session.
  An upload failure disarms the save and shows its error on the receipt card; the user may replace the
  file or remove it and save without a receipt.

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
- **Offline** (`state-offline-375`): a slim `role="status"` banner under the top bar («Немає з’єднання»),
  cached content stays visible, writes queue nothing (spec §4.5b: nothing survives a close).
- **Impersonation** (`state-impersonation-375`): the existing banner, pinned under the top bar, with
  «Повернутися» (44 px); the tab bar shows the impersonated role's tabs.

---

## 3. Tablet (640–1023 px)

- 80 px **navigation rail** on the left: quick-add button on top, then the 4 role tabs and «Ще», icon over
  label. Active item on `bg-accent` with a yellow icon.
- «Ще» opens a **popover** from the rail (not a bottom sheet): same groups and rows as the More sheet.
- Content: list + detail panes where the screen has both; touch heights (inputs 48, buttons 44).

---

## 4. Desktop (≥ 1024 px)

### Sidebar

- 248 px, `bg-card`, grouped (overlines), 36 px rows, active row `bg-accent` + yellow icon + 2 px yellow
  leading bar. Footer: user row (avatar, name, role) opening the profile menu.
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

---

## 5. Frames (all PNG under `assets/shell-v2/`)

| Frame                                | Width | Shows                                         |
| ------------------------------------ | ----: | --------------------------------------------- |
| `tabbar-admin-375.png`               |   375 | ADMIN tab bar, «Ще» badge, «+»                |
| `tabbar-senior-375.png`              |   375 | SENIOR tab bar, own-project rows only         |
| `tabbar-senior-teamless-375.png`     |   375 | SENIOR without a team (Документи in slot 4)   |
| `tabbar-junior-375.png`              |   375 | JUNIOR (no «+»), own salary rows only         |
| `tabbar-hr-375.png`                  |   375 | HR                                            |
| `tabbar-accountant-375.png`          |   375 | ACCOUNTANT                                    |
| `tabbar-drop-375.png`                |   375 | DROP, drop income and payout rows only        |
| `tabbar-admin-320.png`               |   320 | ADMIN at the narrowest width (labels fit)     |
| `tabbar-hr-320.png`                  |   320 | HR at 320 (longest labels)                    |
| `more-sheet-admin-375.png`           |   375 | More sheet, ADMIN (8 destinations)            |
| `more-sheet-junior-375.png`          |   375 | More sheet, JUNIOR (short)                    |
| `more-sheet-admin-320.png`           |   320 | More sheet at 320                             |
| `quick-add-admin-375.png`            |   375 | Quick-add action menu (4 actions)             |
| `quick-add-hr-320.png`               |   320 | Quick-add menu at 320                         |
| `quick-add-txn-keyboard-375.png`     |   375 | Keyboard + accessory bar, save waits (62%)    |
| `state-loading-375.png`              |   375 | Shell + skeleton                              |
| `state-empty-375.png`                |   375 | Empty tab root                                |
| `state-error-375.png`                |   375 | Load error with a safe re-fetch               |
| `state-offline-375.png`              |   375 | Offline banner                                |
| `state-impersonation-375.png`        |   375 | Impersonation banner                          |
| `tablet-rail-768.png`                |   768 | Rail + two panes                              |
| `tablet-rail-more-768.png`           |   768 | Rail «Ще» popover                             |
| `desktop-sidebar-1024.png`           |  1024 | Sidebar + header + dense table                |
| `desktop-sidebar-collapsed-1024.png` |  1024 | Collapsed rail with tooltip                   |
| `desktop-sidebar-1440.png`           |  1440 | Wide: extra table column                      |
| `desktop-cmdk-1440.png`              |  1440 | Cmd+K palette                                 |
| `desktop-cmdk-1024.png`              |  1024 | Cmd+K at the narrowest desktop                |
| `desktop-shortcuts-1440.png`         |  1440 | `?` shortcut sheet with the single-key toggle |

Re-render: `node assets/src/render.mjs shell [filter]`, then `assets/src/contact-sheet.sh shell`.

---

## 6. A11y critical paths

- Focus order (mobile): top bar → content → FAB → tab bar. Desktop: skip link → sidebar → header → main.
- Tab bar and rail are `nav` landmarks; sidebar is `nav` with group headings as `h2` (visually overlines).
- More sheet and Cmd+K trap focus, close on Esc and scrim, and return focus to the trigger.
- Every target ≥ 44 × 44 on touch classes; desktop rows 36 px with full-row hit area.
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
- Tablet uses a rail with a popover «Ще», not a bottom sheet.
- Sidebar collapse shortcut `[` and the `G <letter>` navigation shortcuts are proposals for the
  implementation task. `[` was chosen over ⌘\ (task review fix round 1) and is guarded like every
  single-key shortcut.
- Finance rows in the role frames are role-plausible sample data (SENIOR: own project; DROP: drop income
  and payouts; JUNIOR: own salary). What each role really sees is the existing RBAC, unchanged by v2.
- The armed save after an upload and the session-scoped draft are proposals; the Wave 1 finance spec
  confirms them per form.
