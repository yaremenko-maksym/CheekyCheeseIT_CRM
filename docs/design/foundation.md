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

| Class       | Width       | Navigation                                                                                                                                                                                         | Content layout                                       |
| ----------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Mobile**  | < 640 px    | Bottom **tab bar**: 4 role destinations + «Ще» (More sheet). Large title per tab root; inline title + in-app back on pushed screens. **FAB** «+» (quick-add) sits above the tab bar, bottom right. | One column, 2-line list rows, sheets for forms       |
| **Tablet**  | 640–1023 px | 80 px **navigation rail** (4 tabs + «Ще» popover), labels under icons. Quick-add is the rail's top button.                                                                                         | Two panes (list + detail) where the screen has both  |
| **Desktop** | ≥ 1024 px   | 248 px grouped **sidebar** (collapsible to a 64 px rail with tooltips), header with breadcrumb + page action, **Cmd+K** palette, **`?`** shortcut sheet.                                           | Dense tables, side panel for preview, dialog confirm |

Rules that hold in every class:

- **Tab bar = navigation only.** Create actions live in quick-add (FAB / rail button / page action),
  never as a tab. A role with one create action gets a «+» that opens it directly; a role with none
  gets no «+».
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

---

## 4. Spacing rhythm and density

Base step **4 px** (Tailwind spacing). Rhythm follows hierarchy: dense inside a block, spacious between
blocks.

| Level                      | Value                                       | Tailwind                |
| -------------------------- | ------------------------------------------- | ----------------------- |
| Page gutter                | 16 (mobile) / 24 (tablet) / 32 (desktop)    | `px-4 sm:px-6 lg:px-8`  |
| Inside a control           | 12–14 horizontal, gap 8                     | `px-3` … `px-3.5 gap-2` |
| Inside a card / sheet      | 16                                          | `p-4`                   |
| Between related items      | 8–12                                        | `gap-2` … `gap-3`       |
| Between sections           | 24 (mobile) / 32 (desktop)                  | `gap-6 lg:gap-8`        |
| **List row (mobile)**      | 56 single-line, 64 two-line; inset 16       | `min-h-14` / `min-h-16` |
| **Table row (desktop)**    | 40; header 36                               | `h-10` / `h-9`          |
| Top bar / tab bar (mobile) | 44 / 50 + safe area                         | —                       |
| Touch target               | ≥ 44 × 44 mobile; ≥ 24 × 24 desktop pointer | —                       |

**Principle:** rhythm contrast creates scannability better than one uniform padding.

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

- **One chart per mobile screen**, answer visible in 2 s. Max 3 series per chart; label series directly.
- **Negative values:** hatched fill + `−` label below the zero line. Sign, not colour, carries meaning.
- Tap (mobile) or hover (desktop) a bar for a tooltip with the exact value; the tooltip is also reachable
  by keyboard (arrow keys over a focused chart).
- Desktop charts follow the table filters on the same screen.

### 7.5 Brand-yellow discipline

Yellow marks **action or attention** only: the primary action (one per context), the active nav item
indicator, focus, the chart series in question. Never a large fill, never a decorative section
background, never body text on a yellow background other than `--primary-foreground`.

---

## 8. Containers (which surface for which job)

| Job                                       | Mobile                                        | Tablet                 | Desktop                                        |
| ----------------------------------------- | --------------------------------------------- | ---------------------- | ---------------------------------------------- |
| Short form, filters, pickers (≤ 4 fields) | Medium **detent sheet** (≈ 54% height)        | Medium sheet / popover | Popover or side panel                          |
| Long form, edit                           | Large sheet (full height, Скасувати / Готово) | Side panel 400 px      | Side panel 420 (480 at ≥ 1440)                 |
| Destructive confirm                       | **Action sheet** from the bottom              | Centred alert dialog   | Centred alert dialog 420, focus on «Скасувати» |
| Detail                                    | Pushed screen                                 | Second pane            | Side panel (preview) or page                   |
| Navigation overflow                       | More sheet                                    | Rail popover           | Sidebar (always visible)                       |

- Sheets: drag handle, drag-to-dismiss, Esc / scrim tap closes. **A dirty form asks before it closes.**
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
| 768   | tablet  | rail + two panes; touch heights (48 inputs, 44 buttons)                       |
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
  (the row appears after the server confirms) and **no resubmit offer on an unknown outcome**.
- **Two kinds of save failure, never merged.** A **definite** failure (the server answered 4xx / 5xx,
  or the app knew it was offline before sending) wrote nothing: an inline `role="alert"` above the form,
  values kept, a manual «Повторити збереження» (`primitives-v2/toast-error-definite-375.png`). An
  **unknown** outcome (timeout, connection dropped after sending) on a form without a key: the alert
  says the outcome is unknown and sends the user to the list to check before re-entering; **no retry
  button** (`primitives-v2/toast-error-unknown-375.png`).
- **Pull-to-refresh** (spec §4.2) is an in-app gesture on the list scroller only: it refetches that
  list's query, **never reloads the page**, and is **off while a sheet is open**. Wave 0 proves on the
  iOS Simulator that a sheet drag at `scrollTop` 0 and a pull on a list never reload the page.
- **Undo** only where a reversible action already exists (toast with «Скасувати», 5 s).
- **Filters live in the URL.** No saved filter views.
- **Search covers loaded data only** (and Cmd+K navigation / page actions). No cross-entity server search.
- **Uploads** are in-memory and non-blocking with a global progress indicator. Nothing survives an app
  close; the UI never claims otherwise.
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

- **Targets:** ≥ 44 × 44 on touch classes (HIG); ≥ 24 × 24 on desktop pointer (SC 2.5.8). Small icons
  get an enlarged hit area.
- **Contrast:** text 4.5:1, large text and UI parts 3:1. Measured values: §7. Do not lower them.
- **Focus:** visible 2 px yellow ring with offset on every interactive element (SC 2.4.11 / 2.4.7);
  focus never hidden under the sticky header, tab bar or a toast (SC 2.4.11).
- **Gestures:** every swipe or drag has a single-pointer alternative (SC 2.5.1 / 2.5.7): swipe actions
  are also in a long-press / «…» context menu; sheets also close by button and Esc.
- **Names:** icon-only controls have an `aria-label`; tab bar is a `nav` with `aria-current="page"`;
  badges are announced ("3 нових").
- **Live regions:** toasts and the upload indicator are `role="status"`; save errors are `role="alert"`.
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
- The FAB sits above the tab bar, not inside it. The tablet uses a rail with a popover More.
- Money create errors show inline above the form, not as a floating toast (the toast covered the
  amount field at 375).
- A 5xx counts as a definite failure (task review fix round 1, following spec §4.5b's split). If the
  Wave 1 finance spec finds an endpoint that can commit and still answer 5xx, that endpoint's 5xx moves to
  the unknown branch.
- The sidebar collapse shortcut is `[` (single key, so it sits behind the SC 2.1.4 toggle), not ⌘\.
