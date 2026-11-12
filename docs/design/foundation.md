# CRM Redesign — Foundation v2 (visual and interaction language)

> **Status:** v2 draft for the CRM redesign v2 program (Wave 0, Task 0.8, 2026-11-11). It replaces
> the v1 foundation (Phase 0, owner 2026-06-23). The v1 identity is kept; its execution is raised.
> **Program spec (authority):** `docs/superpowers/specs/2026-11-11-crm-redesign-v2-design.md`.
> **Benchmarks:** `docs/design/research/2026-11-11-mobile-benchmarks.md`.
> **Scoring:** `docs/design/rubric-calibration.md`.
> **Reference mockups:** `screens/_foundation/shell-v2.md` (app shell) and
> `screens/_foundation/primitives-v2.md` (primitives).
> **Token source:** `apps/web/app/styles/globals.css` stays the single source. This file proposes the
> v2 values. The Wave 0 implementation task writes them into `globals.css`, once.
> **design-gate: degraded.** Claude Design was not driven for Task 0.8. The mockups are Playwright
> renders of HTML prototypes (`screens/_foundation/assets/src/`).
>
> **Rule:** this file is the single visual and interaction language. Every screen follows it.
> Reference **semantic tokens** (`bg-background`, `text-muted-foreground`, `border-border`,
> `bg-primary` …). Never raw hex / oklch in code, never generic gradients.

---

## 1. Direction (5 questions)

| Question             | Answer                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**          | Internal CRM of a recruiting / outstaffing company: teams, projects, interviews, finance, documents, contracts. A daily working tool, not marketing.                                                                                                          |
| **Audience**         | Operators in 6 roles (ADMIN / SENIOR / HR / ACCOUNTANT / JUNIOR / DROP). The owner works mostly from an **iPhone** (installed PWA); the other roles split between phone and desktop. They scan lists, statuses and money, and act often. Money needs clarity. |
| **Tone**             | **dense · quiet · scannable · professional.** On the phone: App Store-grade native feel (tab bar, sheets, large titles). On the desktop: a keyboard-first operations console (sidebar, Cmd+K, dense tables).                                                  |
| **Memorable detail** | Warm amber undertone on dark neutrals (chroma ≈ 0.004–0.012, hue 85) with brand yellow as the **only** high-energy accent: a "spotlight" of hierarchy. Money always in `tabular-nums`, sign shown by `+`/`−` and position, never by colour alone.             |
| **Constraints**      | Tailwind v4 (`@theme inline`) + shadcn/ui + Radix / Base UI Drawer · **product UI in `uk` (default) + `en`** via Lingui · WCAG 2.2 AA · **dark theme only** (owner decision 2026-08-16) · responsive 320–2560 · 3 device classes (§10).                       |

**Domain fit:** SaaS operations tool, so dense, quiet and scannable. No landing compositions
(centered hero, blob gradient, oversized CTA) on working screens.

**Light theme:** out of scope (spec §2). The `:root` light values in `globals.css` are not designed
against in v2 and are not a parity target.

---

## 2. Device classes and navigation model

Three device classes, scored separately (spec §5). Each has its own navigation container. The
routes, RBAC and labels are the same in all three.

| Class       | Width       | Navigation                                                                                                                                                                                     | Content layout                                                      |
| ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Mobile**  | < 640 px    | Bottom **tab bar**: 4 role destinations + «Ще» (More sheet). Large title per tab root; inline title + in-app back on pushed screens. **Context FAB** «+» sits above the tab bar, bottom right. | One column, 2-line list rows, sheets for forms                      |
| **Tablet**  | 640–1023 px | 80 px **navigation rail**, labels under icons: every destination that fits by height; «Ще» popover only on overflow. Quick-add is the rail's top button.                                       | One pane with push at 640–899; two panes (list + detail) from ≥ 900 |
| **Desktop** | ≥ 1024 px   | 248 px grouped **sidebar** (collapsible to a 64 px rail with tooltips), header with breadcrumb + page action, **Cmd+K** palette, **`?`** shortcut sheet.                                       | Dense tables, side panel for preview, dialog confirm                |

Rules that hold in every class:

- **Tab bar = navigation only.** Create actions live in quick-add (FAB / rail button / page action),
  never as a tab. A role with no create action gets no «+».
- **Context «+».** On a tab that owns one create action the FAB opens it directly (ADMIN: Фінанси →
  «Нова транзакція», Користувачі → «Новий користувач»; the `aria-label` names the action). On any other
  tab it opens the role's quick-add menu (`aria-label` «Створити», `aria-haspopup`).
- **Density follows the pointer, not the width.** `(pointer: coarse)` gets touch density (44 targets,
  48 inputs, 16 px input text, 52 table rows) in every class, including an iPad at 1180 that gets the
  desktop layout (`shell-v2/shell-touch-1180.png`). `(pointer: fine)` gets desktop density.
- **«Ще» carries the badge** for destinations it hides (for example «Чекають рішення»).
- **Role-aware:** every destination list is `route-access ∩ nav items` for the role. Tab sets per role,
  More contents and quick-add actions: `screens/_foundation/shell-v2.md`.
- **Sidebar / More groups:** Огляд · Гроші · Люди · Робота · Найм · Система (new headings, copy-reviewer
  gate in the Wave 0 implementation).
- **Standalone PWA has no browser back.** Every pushed screen shows an in-app back control (44 px).
- **No left-edge swipe gesture** of our own (it collides with the system back gesture). Swipe actions on
  list rows come from the trailing edge only.

---

## 3. Layout chrome

- **Top bar (mobile):** 44 px plus the safe area. Tab roots use a large title (28/34) that collapses into
  the 44 px bar on scroll. Pushed screens use the inline title (17/22, centred) with back on the left.
- **Tab bar (mobile):** 50 px plus the bottom safe area (34 px on Face ID iPhones). A 94% opaque
  near-card fill with a 20 px backdrop blur and a top `border-border` (the iOS bar convention). Blur is
  allowed only on bars that content scrolls under: the tab bar, sticky section headers (92%) and bottom
  action bars (94%). Never on cards, sheets or dialogs. Fully opaque under `prefers-reduced-transparency`. Active tab:
  yellow icon + white semibold label (weight is the non-colour cue).
- **Header (desktop):** `flex-none`, sticky, opaque, `z-20` (the `StickyPageHeader` pattern). Left:
  breadcrumb (group / page). Right: bell, then the page's primary action with its single-key hint.
- **Content width:** lists and details cap at a readable `max-w` on ≥ 1440; tables and dashboards may go
  full width. No stretched line length at 2560.
- **Safe areas:** `env(safe-area-inset-*)` on the top bar, tab bar, FAB, sheets and toasts. Nothing
  interactive sits under the home indicator.
- **PWA viewport:** `<meta name="viewport" content="…, viewport-fit=cover">`; the shell height is
  **`100dvh`, never `100vh`** (iOS counts the hidden toolbar in `vh`); the tab bar and every bottom bar
  (submit bar, sheet footer) pad by `env(safe-area-inset-bottom)`, the top bar by
  `env(safe-area-inset-top)`, and the landscape sides by the left / right insets.
- **Floating-layer stacking (mobile).** The FAB (56, inset 16) owns the bottom-right corner. Toasts and
  the upload pill sit to its left: inset 12 left, **80 right**, 16 above the tab bar. They never cover
  the FAB, and the FAB never covers them. Tab-root lists end with bottom padding **56 + 16 + 8** above
  the tab bar, so the last row scrolls clear of the FAB. Order: tab bar < FAB / toast / pill < sheet.
  With a pill showing, a toast stacks 8 px above it; at most one toast at a time
  (`primitives-v2/toast-pill-stack-375.png`).
- **FAB and pill on scroll.** Scrolling down slides the FAB and the upload pill out below the tab bar;
  they come back on scroll-up or after **1 s** without scrolling. Transform only (`translateY`, 200 ms
  standard easing); under `prefers-reduced-motion` they fade instead. They never hide while one of them
  holds keyboard focus (SC 2.4.11). Mid-scroll, a trailing amount that sits under the FAB slot is
  readable (`shell-v2/state-scrolled-375.png`).

---

## 4. Spacing rhythm and density

Base step **4 px** (Tailwind spacing). Rhythm follows hierarchy: dense inside a block, spacious between
blocks.

| Level                      | Value                                    | Tailwind                |
| -------------------------- | ---------------------------------------- | ----------------------- |
| Page gutter                | 16 (mobile) / 24 (tablet) / 32 (desktop) | `px-4 sm:px-6 lg:px-8`  |
| Inside a control           | 12–14 horizontal, gap 8                  | `px-3` … `px-3.5 gap-2` |
| Inside a card / sheet      | 16                                       | `p-4`                   |
| Between related items      | 8–12                                     | `gap-2` … `gap-3`       |
| Between sections           | 24 (mobile) / 32 (desktop)               | `gap-6 lg:gap-8`        |
| **List row (mobile)**      | 56 single-line, 64 two-line; inset 16    | `min-h-14` / `min-h-16` |
| **Table row (desktop)**    | 40; header 36 (coarse pointer: 52; 44)   | `h-10` / `h-9`          |
| Sidebar row (desktop)      | 36 (coarse pointer: 44)                  | `h-9`                   |
| Top bar / tab bar (mobile) | 44 / 50 + safe area                      | —                       |
| Touch target               | ≥ 44 × 44 coarse pointer; ≥ 24 × 24 fine | —                       |

**Principle:** rhythm contrast creates scannability better than one uniform padding.

**Coarse-pointer hit areas (binding).** Every control reachable by a coarse pointer has a hit area of
at least **44 × 44**, whatever its drawn size: segmented controls, the currency pill, filter chips,
search fields, the stats period control, «Скасувати» in the undo toast, small buttons (`.btn.sm`),
chevrons and «✕» icons. A smaller visual (a 36 px segment fill, an 18 px icon) gets padding or a
pseudo-element to reach 44. Measured in Playwright with `(pointer: coarse)` emulation.

---

## 5. Radius

The existing scale is kept (`--radius` = 10 px; `globals.css` already derives sm 6 / md 8 / lg 10 /
xl 14). One step is added for sheets.

| Token                      | Value | Use                                                  |
| -------------------------- | ----- | ---------------------------------------------------- |
| `--radius-sm`              | 6     | badges, kbd keys, small chips                        |
| `--radius-md`              | 8     | desktop buttons, desktop inputs, table toolbar chips |
| `--radius-lg`              | 10    | mobile inputs and buttons, list group containers     |
| `--radius-xl`              | 14    | cards, popovers, toasts, dialogs, inline alerts      |
| `--radius-sheet` **(NEW)** | 20    | top corners of bottom sheets and the More sheet      |

**Concentricity:** outer radius = inner radius + padding. A card (14) holding an input (10) needs
≈ 4 px padding to look concentric; with 16 px padding treat them as separate surfaces.

---

## 6. Type scale (Inter)

`--font-sans` = `'Inter', system-ui, sans-serif`. Hierarchy comes from scale and weight, not colour.
**`tabular-nums` on every number** (money, counts, dates, IDs). **Money is always `<amount> <CODE>`**
(«−1 250,50 USD», «320,00 USDT»): uk grouping and a decimal comma, U+2212 for the minus, the ISO code
after a non-breaking space; never a `$` symbol (USD and USDT would both read as `$`). This is the
product formatter `formatMoney` (`packages/shared/src/i18n/format.ts`); every frame, header and row
uses it. A compact amount (a chart total or a KPI caption with no room) keeps the code and the uk
compact word: «+25,9 тис. USD», «1,2 млн USD», never «25,9k $». Chart bars and ticks carry bare numbers
(«4,2», «8»); the chart caption states the unit once («тис. USD»).

| Role         | Mobile (size/line, weight) | Desktop (size/line, weight) | Use                                         |
| ------------ | -------------------------- | --------------------------- | ------------------------------------------- |
| Large title  | 28/34, 700                 | —                           | tab root title (collapses on scroll)        |
| Title        | 20/26, 600                 | 20/28, 600                  | sheet and dialog titles, desktop page title |
| Headline     | 17/22, 600                 | 15/22, 600                  | inline top-bar title, section heads         |
| Body         | **16/22**, 400             | **14/20**, 400              | rows, forms, text                           |
| Subhead      | 15/20, 400                 | 13/18, 400                  | row secondary line                          |
| Footnote     | 13/18, 400                 | 12/16, 400                  | hints, timestamps, helper text              |
| Caption      | 12/16, 500                 | 12/16, 500                  | chart axes, badges, meta                    |
| Tab label    | 10.5/13, 500 (10 at 320)   | —                           | tab bar and rail labels (iOS-sized)         |
| Overline     | 12/16, 600, uppercase, +4% | 11/16, 600, uppercase, +4%  | section headers in lists and the sidebar    |
| Money (hero) | 24–34, 700, tabular        | 24–28, 600, tabular         | amount field, KPI value                     |

- **Inputs are ≥ 16 px on mobile.** Under 16 px iOS Safari zooms the page on focus.
- `text-wrap: balance` on titles; `text-wrap: pretty` on short descriptions.
- Long uk labels wrap or truncate with a full-text tooltip / accessible name; never overflow.

---

## 7. Colour

### 7.1 Surface ladder (dark only)

Depth comes from surface steps and borders, not shadows. Each step is +0.03–0.04 L.

| Step  | Token          | v2 value               | Use                                                     |
| ----- | -------------- | ---------------------- | ------------------------------------------------------- |
| 0     | `--background` | `oklch(0.08 0 0)`      | page canvas                                             |
| 1     | `--card`       | `oklch(0.12 0 0)`      | cards, tab bar, sheets, sidebar                         |
| 1.5   | `--popover`    | `oklch(0.13 0 0)`      | popovers, menus, Cmd+K                                  |
| 2     | `--surface`    | `oklch(0.16 0.006 85)` | inputs, grouped list rows, segmented control track      |
| 3     | `--accent`     | `oklch(0.19 0.012 85)` | **raised:** active nav item, pressed row, selected chip |
| —     | `--secondary`  | `oklch(0.2 0 0)`       | secondary button                                        |
| scrim | `--scrim` NEW  | `oklch(0 0 0 / 0.6)`   | behind sheets and dialogs                               |

### 7.2 Text, lines and brand

| Token                | v1 → v2                              | Contrast (measured)                                          |
| -------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `--foreground`       | `oklch(0.97 0 0)` (unchanged)        | ≥ 16:1 on every step                                         |
| `--muted-foreground` | **0.58 → `oklch(0.64 0 0)`**         | 6.18 bg / 6.03 card / 5.77 surface / 5.38 raised             |
| `--placeholder` NEW  | `oklch(0.6 0 0)`                     | 4.92 on surface (input background)                           |
| `--border`           | `oklch(0.22 0.004 85)` (unchanged)   | decorative separation only                                   |
| `--separator` NEW    | `oklch(0.2 0.004 85)`                | hairline between list rows (inset 16)                        |
| `--input-border` NEW | `oklch(0.52 0.006 85)`               | 3.77 bg / 3.68 card / 3.52 surface / 3.29 raised (SC 1.4.11) |
| `--primary`          | `oklch(0.84 0.183 85.3)` (unchanged) | 12.6 on bg; `--primary-foreground` 0.08 on it 12.6           |
| `--yellow-muted`     | unchanged                            | hover rings                                                  |
| `--yellow-subtle`    | unchanged                            | selected-row tint; yellow text on it 10.5                    |
| `--ring`             | = `--primary`, 2 px + 2 px offset    | focus indicator ≥ 3:1 on every step                          |

Why `--muted-foreground` moves: at 0.58 it measured below 4.5:1 on the raised step, and v2 puts
secondary text on raised rows and sheets. Why `--input-border` is new: `--border` (0.22) is under
3:1 against every surface, so input outlines failed SC 1.4.11 (non-text contrast).

### 7.3 Semantic status

| Token            | Value                   | Contrast on card | Use                                              |
| ---------------- | ----------------------- | ---------------- | ------------------------------------------------ |
| `--destructive`  | `oklch(0.65 0.21 22.2)` | 5.67             | errors, delete, debt                             |
| `--positive` NEW | `oklch(0.76 0.14 160)`  | 10.0             | income amounts (always with `+`), success states |
| `--warning` NEW  | `oklch(0.78 0.15 55)`   | 9.7              | pending, needs attention                         |
| `--info` NEW     | `oklch(0.74 0.11 245)`  | 8.9              | neutral notices, in-progress                     |

**Status is never colour alone** (SC 1.4.1): every status carries a sign, icon or word.

### 7.4 Chart palette

| Token              | Value                  | Role                                                  |
| ------------------ | ---------------------- | ----------------------------------------------------- |
| `--chart-1` NEW    | = `--primary`          | the series the question is about (one per chart)      |
| `--chart-2` NEW    | `oklch(0.7 0.14 250)`  | comparison series (blue: safe against yellow for CVD) |
| `--chart-3` NEW    | `oklch(0.75 0.12 175)` | third series                                          |
| `--chart-4` NEW    | `oklch(0.68 0.17 40)`  | fourth series                                         |
| `--chart-5` NEW    | `oklch(0.62 0 0)`      | "other" / baseline / previous period                  |
| `--chart-grid` NEW | `oklch(0.22 0 0)`      | gridlines and zero line                               |

All five series colours are ≥ 4.97:1 on every surface step. Chart rules:

- **One chart per mobile viewport**, answer visible in 2 s. A second chart on the same screen sits below
  the fold (`primitives-v2/chart-mobile-375.png` / `chart-mobile-scrolled-375.png`). Max 3 series per
  chart; label series directly (partner series by **initials** under their bars, e.g. «ВК» / «ОШ», no
  legend; the full names are in the chart's accessible summary).
- **Negative values:** hatched fill + `−` label below the zero line. Sign, not colour, carries meaning.
- Tap (mobile) or hover (desktop) a bar for a tooltip with the exact value; the tooltip is also reachable
  by keyboard (arrow keys over a focused chart). **A bar's hit area is its full-height column band**
  (the whole slot from the top of the plot to the axis), not the painted bar, so a short bar is as
  easy to hit as a tall one. When a band is narrower than 44 px (the 12-bar «Рік» on a phone), tap
  targets give way to **drag-scrub**: a finger moving across the plot selects the band under it, and
  the value shows in a persistent line above the chart (not a tooltip under the finger).
- Desktop charts follow the table filters on the same screen.

### 7.5 Brand-yellow discipline

Yellow marks **action or attention** only: the primary action (one per context), the active nav item
indicator, focus, the chart series in question. Never a large fill, never a decorative section
background, never body text on a yellow background other than `--primary-foreground`.

---

## 8. Containers (which surface for which job)

| Job                                       | Mobile                                              | Tablet                 | Desktop                                        |
| ----------------------------------------- | --------------------------------------------------- | ---------------------- | ---------------------------------------------- |
| Short form, filters, pickers (≤ 4 fields) | Medium **detent sheet** (≈ 54% height)              | Medium sheet / popover | Popover or side panel                          |
| Long form, edit                           | Large sheet (Скасувати left, primary in bottom bar) | Side panel 400 px      | Side panel 420 (480 at ≥ 1440)                 |
| Destructive confirm                       | **Action sheet** from the bottom                    | Centred alert dialog   | Centred alert dialog 420, focus on «Скасувати» |
| Detail                                    | Pushed screen                                       | Second pane            | Side panel (preview) or page                   |
| Navigation overflow                       | More sheet                                          | Rail popover           | Sidebar (always visible)                       |

- Sheets: drag handle, drag-to-dismiss, Esc / scrim tap closes. **A dirty form asks before it closes**,
  except an armed save (§11), which is kept and carried by the upload pill.
- **Mobile form chrome (one shape).** «Скасувати» top-left, title centred, nothing top-right; the
  primary sits in a bottom bar that rides on the keyboard (it tracks `visualViewport`) or sits above the
  home indicator. A pushed form page uses the same bottom bar. Never a top-right «Готово».
- **The primary is always enabled**, except while its own request is in flight. A tap with invalid
  values validates, moves focus to the first invalid field and shows the inline errors. No "disabled
  until valid" state.
- Sheets and dialogs trap focus, restore it to the trigger on close, and are escapable (SC 2.1.2).

---

## 9. Motion

Compositor-only (`transform`, `opacity`). High-signal, never decorative. **No `transition: all`.**

| Kind                                 | Duration   | Easing                                                |
| ------------------------------------ | ---------- | ----------------------------------------------------- |
| Micro (press, hover, focus, toggle)  | 120–150 ms | ease-out                                              |
| Standard (popover, toast, row state) | 200 ms     | enter `cubic-bezier(0.2, 0, 0, 1)`                    |
| Sheet / page push                    | 280 ms     | enter `cubic-bezier(0.2, 0, 0, 1)`                    |
| Any exit                             | 150 ms     | ease-in, quieter than the enter                       |
| Drag release (sheet, swipe row)      | spring     | the only place for springs (`m.*` under `LazyMotion`) |

- **Push / back:** View Transitions (slide 30% + fade). **Tab switch: instant**, no animation.
- **Desktop:** route changes are a 150 ms crossfade; no slides.
- **`prefers-reduced-motion`:** every movement becomes a 120 ms crossfade; drag still follows the finger.
- Press feedback: `scale(0.97)` on buttons and rows, removable if it distracts.
- Loading: skeletons that match the final layout (no layout jump); no blocking spinner over content.
- Storyboard: `screens/_foundation/assets/primitives-v2/transition-storyboard.png`.

---

## 10. Responsive

**Hard gate** (`.claude/rules/common/responsive-design.md`): every screen is fully usable at the five
reference widths below. Mobile-first: the base is mobile, scale up with `sm` / `md` / `lg` / `xl`.

| Width | Class   | Check                                                                         |
| ----- | ------- | ----------------------------------------------------------------------------- |
| 320   | mobile  | nothing overflows; tab labels fit; sheets reach 36% top; long titles truncate |
| 375   | mobile  | the reference phone (iPhone 13 mini / SE 3 layout width; 812 tall frame)      |
| 768   | tablet  | rail + one pane with push (two panes from 900); touch heights (48 inputs, 44) |
| 1024  | desktop | sidebar 248 (or collapsed 64) + dense table; the narrowest desktop            |
| 1440  | desktop | wide table columns appear (≥ 1280); side panel 480; content `max-w` caps      |

- Dense tables on mobile become 2-line list rows (key value right-aligned), never silently cut columns.
- Stable toolbar, grid and counter sizes: nothing jumps on hover, label change or class change.
- **Verification:** Playwright at each width: `scrollWidth ≤ clientWidth`, everything reachable,
  touch targets measured.

---

## 11. Interaction rules (spec §4.5b, binding for every screen)

- **Never block.** Input feedback < 100 ms. Writes are optimistic where the action is reversible.
- **Finance writes** are sent immediately. No double submit (while in flight the submit control is
  `aria-disabled="true"`, never `disabled`: it ignores taps and stays announced; primitives-v2 §4). **No auto-retry of money creates.** A form that already sends an idempotency key is shown
  optimistically, with rollback and a visible error, and an unknown outcome may be resubmitted only with
  the same key.
- **Carve-out — the four forms without a key** (expense, admin-income, admin-transfer, company
  deposit) keep today's behaviour until the first Wave 1 task ships the key: **no optimistic insert**
  (the row appears after the server confirms) and **no automatic or one-tap resubmit**: the unknown
  alert itself never offers a resubmit. The one way to send the money again is a **user-confirmed new
  create after seeing the refreshed list**: «Немає — створити ще раз» under that list, then a confirm
  that names the amount, then exactly one new request (see the unknown-outcome row of the table below).
- **Save failures, never merged.**
  - **422 (the values are wrong):** an inline error on the field, focus moved there, **no retry
    button**; the primary stays «Зберегти» (`primitives-v2/toast-error-definite-375.png`).
  - **Definite, not about a field:** a 4xx other than 422, a 500 / 503 returned by the app itself, or
    the app knew it was offline before sending. Wrote nothing. An inline `role="alert"` above the form,
    values and receipt kept, a manual «Повторити збереження»
    (`primitives-v2/toast-error-offline-375.png`).
  - **Unknown** — it may have committed: a 502 / 504 from the gateway, a Cloudflare 524 (prod sits behind
    Cloudflare), a connection dropped after sending, or a client timeout. On a form without a key the
    alert reads «Відповідь не надійшла. Форма й чек залишились. Перевірте список: якщо транзакції там
    немає, її можна створити ще раз.»; the form and receipt stay; **no retry button on the alert**.
    **An unknown draft is read-only:** from send until it leaves the unknown state the form shows the
    sent values, with the line «Надіслано о 14:32 · змінити не можна»; every control is dimmed and
    `aria-disabled="true"` (shown and announced, never hidden, never the `inert` attribute). The check
    sheet, «Шукаємо: …» and «Немає — створити ще раз» use exactly the sent payload. To change a value
    the user discards the draft (`toast-error-unknown-375.png`). **A failed draft stays editable**:
    nothing was saved, so saving it again sends one new request with no gate; only an unknown draft
    carries the duplicate risk.
    «Перевірити список» is the filled primary of a locked unknown draft (the form is inert) and opens
    the **check sheet** «Нові записи» over the kept form, refetched on open.
    It names what to look for («Шукаємо: −1 250,50 USD · Витрата · без опису · надіслано 14:32»; the line carries the sent description («без опису» when it is empty), the project when one is set and the business date when it is not today, so the user can compare the field a «схожа» tag names. Row titles in the check sheet wrap to two lines and never truncate) and lists **only
    the current user's own rows created from `t − 5 хв`, newest created first** (sub-header «Лише ваші
    записи з 14:27»: ADMIN and ACCOUNTANT see every row, so a
    colleague's equal amount, a salary for example, must never read as «збіг»), without the list's
    filters or date sections; each row shows its business date and its server creation time («нова ·
    14:33»). **The bound tolerates a wrong device clock:** `t` is the device send time and `created_at`
    is server time, so a device clock that runs ahead would hide the committed row, show the empty text
    and unlock a duplicate; the query starts 5 minutes before `t`, and the sub-header names that real
    bound. **A highlight means a match, by payload and by server time:** each refetch computes `offset = server − device` from the response `Date` header, and a row is a «збіг» only when every sent field is equal (amount, currency, type, business date, project, description or recipient) **and** its `created_at >= t + offset − 5 s`; that row
    gets the full highlight (a tint, a 3 px yellow bar) and «збіг · 14:33»
    (`toast-error-unknown-match-375.png`). **«схожа» means the same type, currency and amount, with at least one other sent field different**; a row with a different type or currency is «нова», whatever its amount (so «Оплата від клієнта +1 250,50 USD · Дохід» beside a 1 250,50 USD expense draft is «нова»). A «схожа» row names the field that differs: «схожа · інший опис · 14:33» (or «інший проєкт», «інша дата», «інший отримувач»; two or more: «схожа · інші дані · 14:33»); rows never open a detail inside the sheet. A row whose every sent field matches but fails the time test reads «раніше · 14:29». On a phone a tag that names the difference takes its own line under the row's meta, so the title never truncates. A «схожа» never becomes a «збіг», so «Є в списку — закрити чернетку» keeps its named confirm. **A «схожа» after the send is a warning, not noise:** an equal-amount row that passes the time test but whose payload differs (for example, the server trimmed the description) is the likeliest real commit. It takes the warning tone (`--warning`, «схожа · інший опис · 14:33», not muted), the hint names the same field («У списку є схожа о 14:33: та сама сума, інший опис. Перевірте її, перш ніж створювати ще раз.»), the status reads «Оновлено о 14:34:01. Знайдено схожу» (never the unlock), «Є в списку — закрити чернетку» becomes the one filled primary (its named confirm stays), the close confirm reads «Закрити чернетку 1 250,50 USD? Збігу немає, але є схожа о 14:33.» instead of the base «У списку її не знайдено», and the recreate confirm adds «У списку є схожа о 14:33» (`toast-error-unknown-similar-375`, `confirm-recreate-375`). A «схожа» that fails the time test stays muted («схожа · інший опис · 14:29», `toast-error-unknown-match-375`). Without a `Date` header no row is a «збіг»: every row with the same type, currency and amount is «схожа» (naming a differing field when there is one). The query still starts at `t − 5 хв`, so a fast device clock cannot hide the row. Every other new row shows only «нова ·
    14:33» in `--muted-foreground`: only «збіг» uses the brand yellow (§7.5). With
    new rows but no match the line «Збігів немає» sits above the exits; with no new rows the body reads
    «Нових записів з 14:27 немає» (`toast-error-unknown-empty-375.png`). A 44 px «Оновити»
    refetches. **A failed refetch** (likely: an unknown outcome usually means bad connectivity) shows
    `role="alert"` «Не вдалося оновити список» with a 44 px «Повторити» in place of the status line and
    the list; it never shows the empty text or «Збігів немає», and the hint reads «Список не оновився.
    Створити транзакцію ще раз можна лише після того, як він оновиться.»
    (`toast-error-unknown-refetch-failed-375.png`). Two exits under the list: «Є в списку — закрити чернетку» and «Немає — створити ще раз». **A
    match changes their weight:** with a «збіг» row, «Є в списку — закрити чернетку» becomes the filled
    primary (`toast-error-unknown-match-375.png`), the hint names the row («Схоже, це ваша транзакція: −1 250,50 USD, створена о 14:33. Перевірте її, перш ніж створювати ще раз.») and the
    recreate confirm adds «У списку є збіг о 14:33» to its description. **Without a «збіг» row «Є в
    списку — закрити чернетку» confirms first** (the list is empty, failed to load or has no match),
    because it drops the frozen payload: «Закрити чернетку 1 250,50 USD? У списку її не знайдено» (`toast-error-unknown-empty-375.png`); with a warning «схожа» and no «збіг» it reads «Закрити чернетку 1 250,50 USD? Збігу немає, але є схожа о 14:33.». With a match
    it stays one tap.
  - **The 60 s gate counts from the moment the failure arrived**, never from the send: nginx closes an
    upstream read after 60 s (`proxy_read_timeout 60s`) and Cloudflare after 100 s, so a timeout can
    reach the client after a send-based gate has already passed while the origin may still commit.
    Until the gate, «Немає — створити ще раз» is `aria-disabled` (described by the hint line «Сервер міг
    зберегти транзакцію із запізненням. Через хвилину після помилки список оновиться сам, і тоді її
    можна буде створити ще раз.») and shows the countdown «Можна через 0:42», which is **never in a live
    region**. «Немає — створити ще раз» unlocks only after a **successful** refetch that ran at least
    60 s after the failure arrived. At the gate the sheet runs **one automatic refetch**; when it
    returns, the sheet's one
    `role="status"` announces the unlock once («Оновлено о 14:34:01. Тепер можна створити ще раз»;
    with a «збіг» the status reads «Оновлено о 14:34:01. Знайдено збіг» and never announces the unlock; the unlock text shows only when there is no match)
    (`primitives-v2/toast-error-unknown-375.png`, `toast-error-unknown-list-375.png`). Both exits are a
    provisional ruling; the owner confirms them at PNG approval. Reached from elsewhere, the kept form is
    the pinned row «1 250,50 USD» · «Результат невідомий · Витрата» with a tonal «Відкрити»
    (`primitives-v2/listrow-draft-375.png`).
  - App 500/503 counts as definite only for endpoints that commit in one DB transaction and swallow post-commit errors; Wave 1 verifies this per endpoint (AC + test) before the form shows a retry.
  - **Wave 1 AC (check sheet):** the list API takes a created-after time and returns the current
    user's rows created from it, ordered by creation time, newest first (the sheet passes `t − 5 хв`). The list response exposes `Date` (`Access-Control-Expose-Headers` if the API is cross-origin). The check-sheet fetch is a network request with `cache: 'no-store'`, excluded from every service-worker route and from the TanStack cache: a cached or service-worker fallback never unlocks the recreate and never gives the offset. Only a 2xx response counts as a successful refetch, and `offset` comes only from that response's `Date`. «збіг» compares the server-normalised values (as the list returns them), never the values the form sent. The columns exist (`transactions.created_by`,
    `transactions.created_at`, with an index on `created_at`); the API filter itself is Wave 1 work.
  - **Wave 1 AC (session; mandatory security review):** the session slides. Any authenticated request
    whose token is older than 24 h gets a fresh 7-day cookie, so an active user is never signed out, and a
    user away for 7 days is, as today (owner decision 2026-11-12). No session probe runs when a form opens:
    the renewal makes a mid-use expiry rare, and it adds no request. The 401 interceptor
    (`apps/web/app/lib/axios.ts`, today a hard `window.location.href` to `/login` on every 401) redirects
    directly only when no draft exists in any state and no form is dirty; otherwise it raises the «Сесія
    завершилася» state (the session row below). A create that got a 401 writes its marker as `failed`, and
    «Увійти знову» turns `armed` markers into `failed`.
  - **Wave 1 AC (search on paged lists):** where a list API accepts a search parameter, the search goes to
    the server and the «Шукали серед завантажених» line never appears (primitives-v2 §3).
- **Offline** never disables creation: the FAB stays enabled (no dim, no `aria-disabled`). Saving while
  offline gives the inline definite alert above with every value kept.
- **Money drafts: one state model for any number of drafts.** A **draft** is a money create the user
  saved or armed that has no acknowledged result yet. Several can exist at once (an armed draft blocks
  nothing). Each draft is in exactly one state: **armed**, **in flight**, **failed**, **unknown** or
  **saved** (until acknowledged). **In flight is a UI state, not a marker phase:** the create has left
  and its response (or the client timeout) has not reached this page. Each draft has its own marker, a
  `localStorage` entry under its own key (`crm.moneyDraft.<random id>`) holding `{ t, phase: 'armed' |
'sent' | 'failed' }` and never an amount, a payload or a receipt. While the receipt uploads the primary reads
  «Зберегти після завантаження чека»; a tap **freezes the payload** and arms. The table below is the
  single source; every frame and every other paragraph agrees with it.

  | Event                                                                                                                                                               | Button / pill / list show                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | What is sent; the marker                                                                                                                                                                                                                                                                                                                                                                       | How the user leaves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
  | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | **Arm** (tap the primary while the receipt uploads)                                                                                                                 | Primary «Збережеться 1 250,50 USD після чека», «чек 62%» as a `progressbar`; one announcement «Збереження заплановано». Under it the 44 px text button «Не зберігати автоматично». The leading control reads **«Згорнути»** (`shell-v2/quick-add-txn-armed-375.png`, `-320.png`). The armed primary is `aria-disabled="true"` (never `disabled`, so it keeps focus and its name); a repeat tap toggles nothing (no `aria-pressed`) and shows the hint «Чек ще завантажується. Транзакція збережеться сама, щойно він завантажиться»                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Nothing yet; the payload is frozen in memory. The marker `{ t, phase: 'armed' }` is written                                                                                                                                                                                                                                                                                                    | «Згорнути», a drag down or a scrim tap close the sheet and keep the save armed (the **Dismiss** row)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
  | **Send** (every money create: a plain save with the receipt already uploaded or a link, or an armed draft whose receipt reached 100%)                               | **In flight.** Sheet open: the primary keeps its label, shows a 16 px spinner and is `aria-disabled="true"`. Sheet closed: the pill reads «Зберігаємо 1 250,50 USD…» · «Відкрити», and the pinned row «Зберігаємо… · Витрата» (`primitives-v2/upload-pill-inflight-375.png`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Exactly **one** create. At the moment it is sent the marker is written (plain save) or switched (armed) to `{ t: <send time>, phase: 'sent' }`                                                                                                                                                                                                                                                 | Nothing to do: discard is unavailable only now, while the request is in flight                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
  | **Edit** of an armed draft (any field, the currency included), **replacing or removing the receipt**, or **«Не зберігати автоматично»**                             | The primary returns to «Зберегти після завантаження чека»; one announcement «Автоматичне збереження вимкнено»; the leading control reads «Скасувати» again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Nothing; the upload continues. The marker is removed (no save is pending)                                                                                                                                                                                                                                                                                                                      | Stays in the form; the draft is kept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
  | **Currency change** (an edit: everything in the Edit row applies)                                                                                                   | Switching to USDT with a file attached, uploading or armed: the file card **stays**, red, with the inline error «Для USDT потрібне посилання на транзакцію в експлорері» and two exits, «Замінити посиланням» and «Видалити чек» (`primitives-v2/form-receipt-usdt-file-375.png`). **Nothing is deleted silently.** Switching to USDT with an empty receipt: the explorer-link field directly, no «Файл» mode (`form-receipt-usdt-empty-375.png`). Leaving USDT keeps the explorer link (a link is valid for any currency)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Nothing; an upload in progress continues. The marker is removed (no save is pending)                                                                                                                                                                                                                                                                                                           | Stays in the form; a save tap focuses the card and repeats the error until the file is replaced by a link or removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
  | **Receipt upload fails while armed**                                                                                                                                | The draft becomes **failed**, never a silent disarm. Sheet open: the receipt card turns red with «Чек не завантажився: з’єднання перервалося» and «Повторити» / «Замінити»; the primary reads «Зберегти»; the leading control reads «Згорнути» (`primitives-v2/form-receipt-failed-375.png`). Sheet closed: the pill «Не збережено 1 250,50 USD · Відкрити» (`upload-pill-failed-375.png`) and a pinned row «Не збережено · Витрата»; one announcement «Транзакцію не збережено»                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Nothing was sent. The marker switches from `armed` to `failed` (the **Definite failure while hidden** row)                                                                                                                                                                                                                                                                                     | The pill or the row reopens the draft. «Повторити» re-arms it: the payload and the intent are kept, so one tap retries the upload and arms the same save again. «Замінити» restarts with a new file, then «Зберегти» (or arming again) saves. «Згорнути» keeps it; «Видалити чернетку» discards it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
  | **Dismiss** while armed                                                                                                                                             | The sheet closes. The pill reads «Збережеться 1 250,50 USD · 62%» · «Відкрити чернетку» (`primitives-v2/upload-pill-armed-375.png`); a toast stacks above it (`toast-pill-stack-375.png`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Nothing until the receipt reaches 100%; then the **Send** row                                                                                                                                                                                                                                                                                                                                  | A pill tap reopens the same draft. «+» opens a **new** form; two armed drafts read «Збережеться 2 транзакції · Відкрити», with each draft's percentage on its own pinned row (`upload-pill-multi-375.png`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
  | **Success**                                                                                                                                                         | Sheet open: it closes. The pill holds «Збережено 1 250,50 USD · Відкрити» **until tapped or dismissed** (a 44 px ✕ «Закрити» or a swipe; `upload-pill-saved-375.png`); one announcement «Транзакцію збережено». The row appears in the list after the server confirms. Under a failed or unknown pill a success shows as a normal success toast stacked above the pill; the pill keeps its own state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | The one create, 2xx. The marker is removed                                                                                                                                                                                                                                                                                                                                                     | The pill body opens the transaction; ✕ or a swipe only dismisses; either way the draft is gone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
  | **Definite failure** (422 or any definite case above)                                                                                                               | Sheet open: the inline alert from the failure rules. Sheet closed: the pill holds «Не збережено 1 250,50 USD · Відкрити» **until tapped** (`upload-pill-failed-375.png`); one announcement «Транзакцію не збережено». Фінанси pins the draft row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The one create wrote nothing. The marker switches to `{ t: <failure time>, phase: 'failed' }` (no finance data) for as long as the draft exists (the **Definite failure while hidden** row)                                                                                                                                                                                                    | A pill or row tap reopens the draft with the alert; the draft stays editable and a save sends one new request with no gate. «Згорнути» keeps it (the **Close** row); «Видалити чернетку» discards it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
  | **Definite failure while hidden** (the PWA is in the background when it arrives, or the OS kills it afterwards)                                                     | Nothing new on screen: the pill, the pinned row and the FAB dot wait for the next visible moment. After a kill the next boot shows the `failed` alert, built like the `armed` one: «Транзакцію не збережено: о 14:32 збереження не вдалося. Створіть її ще раз.» with «Зрозуміло» (`primitives-v2/alert-pagekill-failed-375.png`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Nothing is sent. The marker stays `failed` for as long as the draft exists: only a save, «Видалити чернетку» or the acknowledged boot alert removes it. Opening the draft, seeing the failure or «Згорнути» never does, so an iOS kill after «Згорнути» still raises the boot alert                                                                                                            | «Зрозуміло» removes every `failed` marker and the alert; without a kill, the pill or the row opens the draft                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
  | **Unknown outcome**                                                                                                                                                 | Sheet open: the unknown alert. Sheet closed: the pill holds «Результат невідомий» · «1 250,50 USD · Відкрити» until tapped (`upload-pill-unknown-375.png`); Фінанси pins the draft row (`listrow-draft-375.png`). Inside the draft, «Перевірити список» opens the check sheet (the failure rules above; `toast-error-unknown-list-375.png`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The one create; it may have committed. **Nothing is re-sent automatically.** The marker stays `sent`                                                                                                                                                                                                                                                                                           | «Є в списку — закрити чернетку»: one tap with a «збіг» row; without one the confirm «Закрити чернетку 1 250,50 USD? У списку її не знайдено» comes first («…? Збігу немає, але є схожа о 14:33.» when a warning «схожа» is listed). The draft closes, nothing is sent, the marker is removed. «Немає — створити ще раз» unlocks by the 60 s gate above, then the confirm «Створити 1 250,50 USD ще раз?» (`confirm-recreate-375.png`) and exactly **one** new create (the **Send** row again, a new `t`), built from the sent payload. «Згорнути» keeps the draft (the **Close** row); «Видалити чернетку» discards it                                                                                                                                                                                                                                                                                                                                                                                                  |
  | **Unknown draft: edit** (any attempt to change a field, the currency, the type or the receipt)                                                                      | Nothing changes: from send until the draft leaves the unknown state the form shows the sent values read-only, with «Надіслано о 14:32 · змінити не можна», and the optional fields expanded as read-only text (Дата, Проєкт, Опис) with no «змінити» link, so the user can recognise the row in the check sheet; every control is dimmed and `aria-disabled="true"`, still shown and announced (`primitives-v2/toast-error-unknown-375.png`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Nothing. The marker stays `sent`. The check sheet, «Шукаємо: …» and «Немає — створити ще раз» use exactly the sent payload                                                                                                                                                                                                                                                                     | To change a value the user discards the draft («Видалити чернетку») and creates a new one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
  | **Check sheet: the refetch fails** (on open, at the gate or on «Оновити»)                                                                                           | `role="alert"` «Не вдалося оновити список» with a 44 px «Повторити» replaces the status line and the list; never the empty text, never «Збігів немає». The hint reads «Список не оновився. Створити транзакцію ще раз можна лише після того, як він оновиться.»; «Немає — створити ще раз» stays `aria-disabled` with no countdown (`primitives-v2/toast-error-unknown-refetch-failed-375.png`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Nothing. The marker stays `sent`                                                                                                                                                                                                                                                                                                                                                               | «Повторити» refetches. «Немає — створити ще раз» unlocks only after a **successful** refetch that ran at least 60 s after the failure arrived. «Є в списку — закрити чернетку» stays available, always behind its confirm (no row can match)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
  | **Session expired** (any request returns 401: a save, a receipt upload, a refetch or a read; rare, because the session slides, see the Wave 1 AC)                   | Its own state «Сесія завершилася», never «Не вдалося зберегти», «Не вдалося оновити список» or «Чек не завантажився». The app goes to sign-in directly **only when no draft exists in any state (armed, in flight, failed, unknown) and no form is dirty**. Otherwise, on any tab, sheet open or closed: `role="alertdialog"` «Сесія завершилася. Увійдіть знову, щоб продовжити.» with «Увійти знову» and «Не зараз» (never «Скасувати»: the form behind it uses that word to discard). The body names each loss, one line each: a dirty form «Незбережені дані форми та вибраний чек буде втрачено.»; a draft by amount «Чернетку 86,40 USD буде втрачено.»; an unknown draft «Чернетку 1 250,50 USD та дані, надіслані о 14:32, буде втрачено.». When the body names a loss, the initial focus is on «Не зараз» and Enter does not sign in. A 401 on the receipt upload raises this alert, and the armed row reads «Сесія завершилася», never «з’єднання перервалося · Повторити». While a create is in flight, the alert waits until that request returns. An open check sheet shows this alert, never «Повторити» (`primitives-v2/alert-session-expired-375.png`) | A save that got a 401 did not commit (the server refused it before the handler): its marker becomes `failed`, never `sent`. «Увійти знову» turns every `armed` marker into `failed` (t = now), so the boot alert after sign-in reads «збереження не вдалося», never «застосунок закрився під час завантаження чека». Every marker survives the sign-in, and the boot rules pick it up after it | «Увійти знову» goes to sign-in (the named losses go; the markers stay). «Не зараз» closes the alert and keeps the screen; the next request that needs the session raises it again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
  | **Page kill** (tab closed, OS kill, crash)                                                                                                                          | At the next boot: **one alert per phase**, never one per marker (the boot rules below; `state-page-kill-375.png`, `alert-pagekill-sent-375.png`). Neither names an amount: the marker holds none; `sent` **offers no resubmit**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `armed`: nothing, the request never left. `failed`: nothing was saved. `sent`: the one create; it may have committed. Nothing is re-sent                                                                                                                                                                                                                                                       | «Зрозуміло» removes every marker of that phase and the alert (on `sent` the button reads «Закрити» and keeps the markers until the late-commit guard's refetch succeeds); on `sent`, «Оновити список» / «Відкрити Фінанси» also opens the check sheet «Нові записи» filtered from the earliest `t − 5 хв` with the same server-time test: a row created before `earliest t + offset − 5 s` reads «раніше · 14:29»; when `t` is not today every boot time carries the date («10.11 о 14:32», «з 10.11 14:27», «раніше · 10.11 14:29»); no amount is known, so no row is a «збіг» or «схожа». **Late-commit guard:** app-owned from boot, sheet open or not (the boot rules below): «Закрити» until its background refetch at `max(boot, latest sent t + 160 s)` succeeds, then «Зрозуміло». No draft form is behind it: the sheet names the time, not an amount, and offers no resubmit (`primitives-v2/check-sheet-boot-375.png`); a failed refetch there reuses the «Не вдалося оновити список» alert with «Повторити» |
  | **Close a failed or unknown draft**                                                                                                                                 | The leading control reads **«Згорнути»**; a drag down and a scrim tap do the same. No confirm: nothing is lost (`primitives-v2/toast-error-offline-375.png`, `toast-error-unknown-375.png`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Nothing. The marker is unchanged: a `failed` or `sent` marker survives a page kill, so the next boot still reports the draft                                                                                                                                                                                                                                                                   | The sheet closes and the draft stays: the pill and its pinned row reopen it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
  | **Explicit discard**: the 44 px control «Видалити чернетку» under the primary of a **failed or unknown** draft; **unavailable only while its request is in flight** | A confirm that names the amount: «Видалити чернетку 1 250,50 USD?» with «Видалити» and «Залишити» (`primitives-v2/confirm-discard-draft-375.png`). For an unknown draft the description adds «Якщо транзакцію вже збережено, вона залишиться в списку.»                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Nothing; any upload is aborted. The marker is removed                                                                                                                                                                                                                                                                                                                                          | «Видалити»: the draft, its pill state, its row and its marker are gone. «Залишити»: back to the draft                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
  - **One pill slot, one precedence.** The pill shows the highest state among all drafts: **unknown >
    failed > in flight > armed > saved**. It names the amount when one draft is in that state and a
    count when more: in flight «Зберігаємо 2 транзакції…»; armed «Збережеться 2 транзакції ·
    Відкрити» (never one merged percentage: each pinned row shows its own); saved «Збережено 2 ·
    Відкрити». **Unresolved** drafts (failed and unknown, counted together): one shows its own pill
    («Не збережено 1 250,50 USD · Відкрити», «Результат невідомий» · «1 250,50 USD · Відкрити»); two or
    more read **«2 потребують перевірки» · «Відкрити»**, and a tap opens Фінанси scrolled to the pinned rows
    (`drafts-two-unresolved-375.png`). «+2 чеки» counts only uploads that belong to no draft. Without a
    draft the slot shows the plain upload indicator.
  - **Pinned rows.** Фінанси pins a row for every draft that is not saved (armed, in flight, failed,
    unknown), ordered by the slot precedence, each with its state line and one 44 px tonal «Відкрити»
    (`drafts-two-375.png`: one failed and one armed). A lower state the pill does not show is never
    lost: its row is there. A pinned row is never a primary: its «Відкрити» is tonal (one primary per context, §7.5). The 2 px leading bar, the border and the «Відкрити» tint are `--destructive` for a failed draft and `--warning` for an unknown one; armed and in-flight rows stay muted. The phone row carries no icon tile, so the state line fits on one line at 375 beside «Відкрити»; the desktop row keeps its icon. **Up to three pinned rows** show, unresolved first by the slot precedence; the block collapses only when it saves a row: from four drafts on, two show and the rest collapse into one row «Ще N чернеток · Показати» (N ≥ 2), which expands them in place; its label then toggles to «Згорнути», it keeps `aria-expanded`, and it resets to collapsed on a route change (`drafts-two-unresolved-375`; four drafts, collapsed: `drafts-four-collapsed-375`, two rows and «Ще 2 чернетки · Показати» with `aria-expanded="false"`; the count takes the Lingui plural, «Ще 5 чернеток»). Each row has two lines: the amount alone on one line with no wrap («1 250,50 USD»), then state · type («Результат невідомий · Витрата»).
  - **«+» never blocks.** Armed and in-flight drafts change nothing: «+» opens a new form. With unresolved drafts (failed or unknown), **on Фінанси every «+» opens a new form directly** (the FAB, the rail «+», the header «Нова транзакція» and `C`): the pinned rows and the pill already show the drafts there, and `C` stays one key on the main money page. On the other pages a money draft **never hides other actions**: the drafts join the existing «+» menus and never replace them. The quick-add sheet (phone) and the rail «+» menu (tablet) keep the role's normal action list; with unresolved drafts a «Чернетки» section sits on top, each draft row in the pinned-row format (the amount, then state · type, and «Відкрити»); **any menu shows at most 2 draft rows** (the quick-add sheet, the rail «+» menu and the header compact menu): from 3 drafts, the first 2 by the slot precedence and a last row «Усі чернетки (N)», which opens Фінанси scrolled to the pinned rows, then the normal actions in `role="group"` with a visually hidden label «Дії» (the drafts group is labelled by its «Чернетки» header), «Нова транзакція» among them (`primitives-v2/quick-add-drafts-375` from Статистика and `drafts-chooser-768` from Співбесіди, both with the 4 ADMIN actions); in the rail menu «Нова транзакція», the first normal action, takes the initial focus without a drawn ring: the tablet is touch, and the ring shows only on `:focus-visible` (a keyboard). A page FAB whose action is not money (Користувачі «Новий користувач», Співбесіди «Нова співбесіда», Вакансії «Створити вакансію») never changes and gets no dot. The header «Нова транзакція» and `C`, a money trigger by name, open a compact menu: the «Чернетки» section above, «Нова транзакція» last with the initial focus, so `C` then Enter still creates (`primitives-v2/drafts-chooser-1440` on Статистика). Every menu off the phone is `role="menu"` with the trigger `aria-haspopup="menu"`; ↑ / ↓ move between the items, and Esc closes it and returns focus to the trigger; under `(pointer: coarse)` the key hints («↑ ↓», «Enter») are hidden and a draft's state line is at least 13 px. The money FAB on Фінанси and the quick-add «+» keep their «+» and gain a red dot (with the count from two); the accessible name says the count: «Нова транзакція, 1 чернетка потребує уваги» on Фінанси, «Створити, 2 чернетки потребують уваги» on the quick-add «+»
    (`upload-pill-failed-375.png`, `listrow-draft-375.png`, `drafts-two-unresolved-375.png`). No draft
    forces a wait or a discard before another expense.
  - **Replacing or removing the receipt disarms**, like any field edit: the frozen payload named the
    old receipt. **A currency change is an edit too** (the **Currency change** row above): it disarms,
    and a switch to USDT never deletes a file silently; the file card stays with the USDT error and
    the user picks «Замінити посиланням» or «Видалити чек». Leaving USDT keeps the explorer link.
  - **The result stays until acknowledged.** A sheet is **never opened automatically** over what the user
    is doing; the pill holds the result. A toast timer **pauses while the page is hidden**.
  - **No `visibilitychange` disarm:** backgrounding keeps the save armed. A page kill is **reported, not
    hidden** (the boot rules). **Finance data is never persisted client-side:** a marker is
    `{ t: <timestamp>, phase: 'armed' | 'sent' | 'failed' }` under a random key, never an amount, a
    payload or a receipt.
  - **A marker has one meaning everywhere.** It exists while a save is pending or an unsaved
    draft could be lost by a page kill. It is written as `armed` on arm; it is **written at send for every money
    create** as `sent` (a plain save writes it then; an armed draft switches to it, `t` becoming the
    send time); «Створити ще раз» writes `sent` again with the new send time. A definite failure, and a
    receipt upload that fails on an armed draft, switch it to `failed` (`t` = the failure time). It is
    removed on success, on disarm (an edit, replacing or removing the receipt), on «Є в списку — закрити
    чернетку», on an explicit discard, and when its boot alert is acknowledged. **A `failed` marker lives as long as its draft:** only a
    save, a discard or the acknowledged boot alert removes it; opening, seeing or closing the draft never
    does.
    An unknown outcome keeps it `sent`.
  - **Boot: one alert per phase, with a count and the earliest time.** `armed`, one marker:
    «Транзакцію не збережено: застосунок закрився під час завантаження чека. Створіть її ще раз.»;
    two or more: «2 транзакції не збережено: застосунок закрився під час завантаження чеків. Створіть
    їх ще раз.». `failed` reuses that pattern: one marker «Транзакцію не збережено: о 14:32 збереження не
    вдалося. Створіть її ще раз.»; two or more «2 транзакції не збережено: збереження не вдалися, перше
    о 14:32. Створіть їх ще раз.». `sent`, one marker: «Результат збереження транзакції о 14:32 невідомий. Вона могла
    зберегтися: перевірте нові записи, перш ніж створювати її знову.»; two or more: «Результат
    збереження 2 транзакцій невідомий, перша о 14:32. Вони могли зберегтися: перевірте нові записи,
    перш ніж створювати їх знову.» (neutral: it never claims that the app closed). The time is the
    earliest `t` of that phase. Every alert carries «Зрозуміло» (on `sent`, «Закрити» until the late-commit guard's refetch succeeds); `sent` adds, on the Фінанси tab,
    «Оновити список» (on another tab «Відкрити Фінанси»), and never a resubmit. **Either opens the same
    check sheet «Нові записи»** (the user's own rows, newest created first, each «нова» or «раніше»), filtered from the earliest `t − 5 хв` with the same server-time test: a row created before `earliest t + offset − 5 s` reads «раніше · 14:29»; when `t` is not today every boot time carries the date («10.11 о 14:32», «з 10.11 14:27», «раніше · 10.11 14:29»); no amount is known, so no row is a «збіг» or «схожа». **Late-commit guard (app-owned; the one definition).** The app owns the guard from boot, whether the check sheet is open or not, on any tab. It waits for the **latest** send: one background no-store refetch runs at `max(boot, latest sent t + 160 s)` (Cloudflare's 100 s origin timeout plus the in-app 60 s gate; both times come from the device, so skew does not matter). Example: markers at 14:32 and 14:40 and a boot at 14:41 refetch at 14:42:40; a boot the next morning refetches at once. While it waits, an open sheet's hint reads «Сервер міг зберегти транзакцію із запізненням. Список оновиться о 14:35:12» (`check-sheet-boot-375`). The query bound and the alert copy keep the earliest `t`. **Until that refetch succeeds, nothing clears the markers:** the boot alert's button and the sheet's footer button read «Закрити» and keep the markers, like ✕ (`check-sheet-boot-375`, `alert-pagekill-sent-375`). Its 2xx flips both to «Зрозуміло» and the sheet hint to «…створіть її знову», whether the sheet was open or not. «Зрозуміло» acknowledges the alert and removes the `sent` markers, while ✕ still closes the sheet and keeps them, so the boot alert returns on the next boot; the dated list is never scrolled. **Any 2xx no-store refetch at or after the guard time satisfies the guard**, the user's own «Оновити» or «Повторити» included. A failed or offline guard retries once the next time the app comes to the foreground and once on the `online` event (once per event, never a loop); an open sheet still offers «Повторити» through «Не вдалося оновити список», and a 401 raises «Сесія завершилася» instead. A 2xx while the boot alert is closed shows one toast «Список оновлено · Перевірити», which opens the check sheet. No draft stands
    behind it, so it has no «Шукаємо» line; its exits are ✕ and «Закрити» / «Зрозуміло». With several
    phases present the alerts stack, `sent` first, then `failed`, then `armed`.

- **Pull-to-refresh** (spec §4.2) is an in-app gesture on the list scroller only: it refetches that
  list's query, **never reloads the page**, and is **off while a sheet is open**. Wave 0 proves on the
  iOS Simulator that a sheet drag at `scrollTop` 0 and a pull on a list never reload the page.
- **Undo** only where a reversible action already exists (toast with «Скасувати», 5 s).
- **Filters live in the URL.** No saved filter views.
- **Search covers loaded data only** (and Cmd+K navigation / page actions). No cross-entity server search.
- **Uploads** are in-memory and non-blocking with a global progress indicator. Nothing survives an app
  close. An armed money save lost this way is reported at the next boot (the page-kill rows above).
- **Keyboard (desktop):** Tab order follows reading order; Enter submits; Esc closes; single-key
  shortcuts (including `[` for the sidebar collapse) can be turned off in the `?` sheet (stored on the
  device, SC 2.1.4) and never fire inside a text field.

---

## 12. Redesign principle (relaxed for v2 — spec §4.5)

v1 said "restyle existing blocks, add nothing". **For the v2 program this is relaxed:** interaction
patterns may change. Allowed: the navigation model, quick-add, sheets, inline edit, the command
palette, progressive disclosure, merged or split views.

**Still forbidden:**

- new business data or new KPIs;
- removing a capability;
- changing business rules, the API or RBAC.

Every screen brief stays capture-grounded: the real screen is captured, its blocks and actions are
listed, and anything the v2 screen shows must trace back to that list.

---

## 13. A11y (WCAG 2.2 AA)

- **Targets:** ≥ 44 × 44 for every coarse-pointer control, by pointer type, not width (HIG; §4);
  ≥ 24 × 24 for a fine pointer (SC 2.5.8). Small icons get an enlarged hit area.
- **Contrast:** text 4.5:1, large text and UI parts 3:1. Measured values: §7. Do not lower them.
- **Focus:** visible 2 px yellow ring with offset on every interactive element (SC 2.4.11 / 2.4.7);
  focus never hidden under the sticky header, tab bar or a toast (SC 2.4.11).
- **Gestures:** every swipe or drag has a single-pointer alternative (SC 2.5.1 / 2.5.7): swipe actions
  are also in the row's detail page, or, on a row without a pushed detail, a visible «…» button and a
  long-press menu; sheets also close by button and Esc.
- **Names:** icon-only controls have an `aria-label`; tab bar is a `nav` with `aria-current="page"`;
  badges are announced ("3 нових").
- **Live regions, one rule:** progress UI (the receipt ring, the upload pill, the armed fill) is
  `role="progressbar"` with `aria-valuenow`, never a live region. Each surface (a form, the floating
  pill slot) has **one** visually hidden `role="status"` that announces milestones only: started,
  finished, failed (and arm / disarm for the armed save). Toasts are `role="status"`; save errors are
  `role="alert"`.
- **Zoom** is never disabled (`user-scalable` stays on); reflow works at 320 CSS px.
- **Product language:** visible text is `uk` (default) + `en` through Lingui catalogs; no literals.

---

## 14. Anti-patterns (AI-slop guardrails — Mode C)

- Purple gradients, decorative blobs, oversized hero, glass / blur cards, marketing copy on working screens.
- Card in a card; one radius / spacing / shadow everywhere.
- Yellow as a fill of large areas or a background under text.
- A blocking full-screen spinner; a toast that covers the field it is about.
- Colour-only status or sign.
- Raw hex / oklch in code.

---

## 15. Assumptions (A1, Task 0.8)

- `--muted-foreground` 0.58 → 0.64, `--input-border` (0.52) and `--placeholder` (0.6) are new: the
  measured contrast in §7 required them. The Wave 0 coder decides whether shadcn's `border-input`
  points at `--input-border`.
- `--accent` is the "raised" step; no separate `--raised` token is added.
- Tab labels reuse the existing nav strings («Дашборд» for Home). «Ще» and the six group headings are
  new strings (copy-reviewer gate).
- The FAB sits above the tab bar, not inside it. The tablet rail shows every destination that fits by
  height and a popover «Ще» only on overflow (the fit is a height estimate; Wave 0 measures it).
- ADMIN tab 4 is «Адмін» (`/admin` redirects to `/admin/contracts`, the contract editor); «Дашборд»
  moves to «Ще» for ADMIN (council R1).
- Money create errors show inline above the form, not as a floating toast (the toast covered the
  amount field at 375).
- Status-code split (Master ruling, fix round 2, supersedes the round-1 "any 5xx is definite"):
  definite = 4xx + 500 / 503 returned by the app; unknown = 502 / 504 / 524, a drop after send, a client
  timeout. The Wave 1 client tells an app-originated 500 / 503 from a gateway one by the app's error
  envelope (a gateway page has none); without the envelope the response counts as unknown.
- The sidebar collapse shortcut is `[` (single key, so it sits behind the SC 2.1.4 toggle), not ⌘\.
