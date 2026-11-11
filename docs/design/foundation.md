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
**`tabular-nums` on every number** (money, counts, dates, IDs).

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
- **Finance writes** are sent immediately. No double submit (the submit control disables while in
  flight). **No auto-retry of money creates.** A form that already sends an idempotency key is shown
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
    «Перевірити список» opens the list as a sheet over the kept form, refetched on open. The sheet
    names what to look for («Шукаємо: −1 250,50 USD · Витрата · надіслано 14:32»), highlights the rows
    created after the send time, has a 44 px «Оновити» that refetches, and two exits under the list:
    «Є в списку — закрити чернетку» and «Немає — створити ще раз». The second is `aria-disabled` until
    a refetch that **finished at least 60 s after the send** has come back; until then it shows the
    countdown «Можна через 0:42» and the hint line says why (a late commit can still appear)
    (`primitives-v2/toast-error-unknown-375.png`, `toast-error-unknown-list-375.png`). Both exits are a provisional ruling; the owner confirms them
    at PNG approval. Reached from elsewhere, the kept form is the pinned row «Чернетка 1 250,50 USD» with
    one primary «Відкрити» (`primitives-v2/listrow-draft-375.png`).
  - App 500/503 counts as definite only for endpoints that commit in one DB transaction and swallow post-commit errors; Wave 1 verifies this per endpoint (AC + test) before the form shows a retry.
- **Offline** never disables creation: the FAB stays enabled (no dim, no `aria-disabled`). Saving while
  offline gives the inline definite alert above with every value kept.
- **Money drafts: one state model for any number of drafts.** A **draft** is a money create the user
  saved or armed that has no acknowledged result yet. Several can exist at once (an armed draft blocks
  nothing). Each draft is in exactly one state: **armed**, **in flight**, **failed**, **unknown** or
  **saved** (until acknowledged). **In flight is a UI state, not a marker phase:** the create has left
  and its response (or the client timeout) has not reached this page. Each draft has its own marker, a
  `localStorage` entry under its own key (`crm.moneyDraft.<random id>`) holding `{ t, phase: 'armed' |
'sent' }` and never an amount, a payload or a receipt. While the receipt uploads the primary reads
  «Зберегти після завантаження чека»; a tap **freezes the payload** and arms. The table below is the
  single source; every frame and every other paragraph agrees with it.

  | Event                                                                                                                                                                  | Button / pill / list show                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | What is sent; the marker                                                                                                                       | How the user leaves                                                                                                                                                                                                                                                                                                           |
  | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | **Arm** (tap the primary while the receipt uploads)                                                                                                                    | Primary «Збережеться 1 250,50 USD після чека», «чек 62%» as a `progressbar`; one announcement «Збереження заплановано». Under it the 44 px text button «Не зберігати автоматично». The leading control reads **«Згорнути»** (`shell-v2/quick-add-txn-armed-375.png`, `-320.png`). The armed primary is `aria-disabled="true"` (never `disabled`, so it keeps focus and its name); a repeat tap toggles nothing (no `aria-pressed`) and shows the hint «Чек ще завантажується. Транзакція збережеться сама, щойно він завантажиться» | Nothing yet; the payload is frozen in memory. The marker `{ t, phase: 'armed' }` is written                                                    | «Згорнути», a drag down or a scrim tap close the sheet and keep the save armed (the **Dismiss** row)                                                                                                                                                                                                                          |
  | **Send** (every money create: a plain save with the receipt already uploaded or a link, or an armed draft whose receipt reached 100%)                                  | **In flight.** Sheet open: the primary keeps its label, shows a 16 px spinner and is `aria-disabled="true"`. Sheet closed: the pill reads «Зберігаємо 1 250,50 USD…»                                                                                                                                                                                                                                                                                                                                                                | Exactly **one** create. At the moment it is sent the marker is written (plain save) or switched (armed) to `{ t: <send time>, phase: 'sent' }` | Nothing to do: discard is unavailable only now, while the request is in flight                                                                                                                                                                                                                                                |
  | **Edit** (any field, the currency included), **replacing or removing the receipt**, **«Не зберігати автоматично»**, or the receipt upload fails                        | The primary returns to «Зберегти після завантаження чека»; one announcement «Автоматичне збереження вимкнено»; the leading control reads «Скасувати» again                                                                                                                                                                                                                                                                                                                                                                          | Nothing; the upload continues. The marker is removed (no save is pending)                                                                      | Stays in the form; the draft is kept                                                                                                                                                                                                                                                                                          |
  | **Dismiss** while armed                                                                                                                                                | The sheet closes. The pill reads «Збережеться 1 250,50 USD · 62%» · «Відкрити чернетку» (`primitives-v2/upload-pill-armed-375.png`); a toast stacks above it (`toast-pill-stack-375.png`)                                                                                                                                                                                                                                                                                                                                           | Nothing until the receipt reaches 100%; then the **Send** row                                                                                  | A pill tap reopens the same draft. «+» opens a **new** form; two armed drafts read «Збережеться 2 транзакції · 1 з 2» (`upload-pill-multi-375.png`)                                                                                                                                                                           |
  | **Success**                                                                                                                                                            | Sheet open: it closes. The pill holds «Збережено 1 250,50 USD · Відкрити» **until tapped or dismissed** (a 44 px ✕ «Закрити» or a swipe; `upload-pill-saved-375.png`); one announcement «Транзакцію збережено». The row appears in the list after the server confirms                                                                                                                                                                                                                                                               | The one create, 2xx. The marker is removed                                                                                                     | The pill body opens the transaction; ✕ or a swipe only dismisses; either way the draft is gone                                                                                                                                                                                                                                |
  | **Definite failure** (422 or any definite case above)                                                                                                                  | Sheet open: the inline alert from the failure rules. Sheet closed: the pill holds «Не збережено 1 250,50 USD · Відкрити» **until tapped** (`upload-pill-failed-375.png`); one announcement «Транзакцію не збережено». Фінанси pins the draft row                                                                                                                                                                                                                                                                                    | The one create wrote nothing. The marker is removed                                                                                            | A pill or row tap reopens the draft with the alert; or an explicit discard                                                                                                                                                                                                                                                    |
  | **Unknown outcome**                                                                                                                                                    | Sheet open: the unknown alert. Sheet closed: the pill holds «Результат невідомий» · «1 250,50 USD · Відкрити» until tapped (`upload-pill-unknown-375.png`); Фінанси pins the draft row (`listrow-draft-375.png`). Inside the draft, «Перевірити список» opens the check sheet (the failure rules above; `toast-error-unknown-list-375.png`)                                                                                                                                                                                         | The one create; it may have committed. **Nothing is re-sent automatically.** The marker stays `sent`                                           | «Є в списку — закрити чернетку»: the draft closes, nothing is sent, the marker is removed. «Немає — створити ще раз» unlocks by the 60 s gate above, then the confirm «Створити 1 250,50 USD ще раз?» (`confirm-recreate-375.png`) and exactly **one** new create (the **Send** row again, a new `t`). Or an explicit discard |
  | **Page kill** (tab closed, OS kill, crash)                                                                                                                             | At the next boot: **one alert per phase**, never one per marker (the boot rules below; `state-page-kill-375.png`, `alert-pagekill-sent-375.png`). Neither names an amount: the marker holds none; `sent` **offers no resubmit**                                                                                                                                                                                                                                                                                                     | `armed`: nothing, the request never left. `sent`: the one create; it may have committed. Nothing is re-sent                                    | «Зрозуміло» removes every marker of that phase and the alert; on `sent`, «Оновити список» / «Відкрити Фінанси» also refetches the list and scrolls to the rows created after the earliest `t`                                                                                                                                 |
  | **Explicit discard**: offered for a **failed or unknown** draft (and before a new form while such a draft exists); **unavailable only while its request is in flight** | A confirm that names the amount: «Видалити чернетку 1 250,50 USD?» with «Видалити» and «Залишити» (`primitives-v2/confirm-discard-draft-375.png`). For an unknown draft the description adds «Якщо транзакцію вже збережено, вона залишиться в списку.»                                                                                                                                                                                                                                                                             | Nothing; any upload is aborted. The marker is removed                                                                                          | «Видалити»: the draft, its pill state, its row and its marker are gone. «Залишити»: back to the draft                                                                                                                                                                                                                         |
  - **One pill slot, one precedence.** The pill shows the highest state among all drafts: **unknown >
    failed > in flight > armed > saved**. It names the amount when one draft is in that state and a
    count when more: in flight «Зберігаємо 2 транзакції…»; armed «Збережеться 2 транзакції · 1 з 2»
    (receipts finished of the armed drafts, never one merged percentage); saved «Збережено 2 ·
    Відкрити». **Unresolved** drafts (failed and unknown, counted together): one shows its own pill
    («Не збережено 1 250,50 USD · Відкрити», «Результат невідомий» · «1 250,50 USD · Відкрити»); two or
    more read **«2 чернетки» · «Відкрити»**, and a tap opens Фінанси scrolled to the pinned rows
    (`drafts-two-unresolved-375.png`). «+2 чеки» counts only uploads that belong to no draft. Without a
    draft the slot shows the plain upload indicator.
  - **One pinned row per draft.** Фінанси pins one row for every draft that is not saved (armed, in
    flight, failed, unknown), newest first, each with its state line and one 44 px primary «Відкрити»
    (`drafts-two-375.png`: one failed and one armed). A lower state the pill does not show is never
    lost: its row is there.
  - **«+» and the FAB.** Armed and in-flight drafts block nothing: «+» opens a new form. **One**
    unresolved draft makes «+» (the FAB and the quick-add action) **reopen it**; a new form then opens
    only after the discard confirm, which names the amount. The FAB's accessible name is then «Відкрити
    чернетку 1 250,50 USD» and its icon is a draft (`file-pen`) with a red dot
    (`upload-pill-failed-375.png`, `listrow-draft-375.png`). **Two or more** unresolved: the FAB's
    name is «Відкрити 2 чернетки», the dot carries the count «2», and «+» opens Фінанси at the pinned
    rows; a new form opens once no unresolved draft is left.
  - **Replacing or removing the receipt disarms**, like any field edit: the frozen payload named the
    old receipt. A currency change is an edit too (the receipt and currency rules below).
  - **The result stays until acknowledged.** A sheet is **never opened automatically** over what the user
    is doing; the pill holds the result. A toast timer **pauses while the page is hidden**.
  - **No `visibilitychange` disarm:** backgrounding keeps the save armed. A page kill is **reported, not
    hidden** (the boot rules). **Finance data is never persisted client-side:** a marker is
    `{ t: <timestamp>, phase: 'armed' | 'sent' }` under a random key, never an amount, a payload or a
    receipt.
  - **A marker has one meaning everywhere.** It exists while a save is pending and a page kill could
    lose its outcome. It is written as `armed` on arm; it is **written at send for every money
    create** as `sent` (a plain save writes it then; an armed draft switches to it, `t` becoming the
    send time); «Створити ще раз» writes `sent` again with the new send time. It is removed on a
    definite result (success, definite failure), on disarm (an edit, replacing or removing the receipt),
    on «Є в списку — закрити чернетку», on an explicit discard, and when its boot alert is acknowledged.
    An unknown outcome keeps it `sent`.
  - **Boot: one alert per phase, with a count and the earliest time.** `armed`, one marker:
    «Транзакцію не збережено: застосунок закрився під час завантаження чека. Створіть її ще раз.»;
    two or more: «2 транзакції не збережено: застосунок закрився під час завантаження чеків. Створіть
    їх ще раз.». `sent`, one marker: «Застосунок закрився під час збереження транзакції о 14:32. Вона
    могла зберегтися: записи після 14:32 позначено в списку. Перевірте їх, перш ніж створювати її
    знову.»; two or more: «Застосунок закрився під час збереження 2 транзакцій, перша о 14:32. Вони
    могли зберегтися: записи після 14:32 позначено в списку. Перевірте їх, перш ніж створювати їх
    знову.». The time is the earliest `t` of that phase. Both carry «Зрозуміло»; `sent` adds, on the
    Фінанси tab, «Оновити список» (on another tab «Відкрити Фінанси»), and never a resubmit. With both
    phases present the two alerts stack, `sent` first.

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
