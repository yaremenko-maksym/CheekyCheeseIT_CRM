# CRM Redesign — Foundation (visual language)

> **Status:** approved direction (Phase 0, owner 2026-06-23) — north-star app-shell = `screens/_foundation/app-shell.md` (Variant A "restrained", flat navigation). The language was confirmed by generation; no direction changes were needed.
> **Applies to:** all redesign phases (`docs/superpowers/specs/2026-06-22-crm-redesign-program.md`).
> **Token source:** `apps/web/app/styles/globals.css` (single source) + `docs/design/assets/_design-system/inventory.md`.
> **Rule:** this file is the single visual language. Every screen follows it → consistency.
> Always reference **semantic tokens** (`bg-background`, `text-muted-foreground`, `border-border`,
> `bg-primary` …), NEVER raw hex/oklch and NEVER generic gradients.

---

## 1. Direction (5 questions)

| Question             | Answer                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Purpose**          | Internal CRM of a recruiting/outstaffing company: teams, projects, interviews, finance, documents, contracts. A daily working tool, not marketing.                                                                                   |
| **Audience**         | Power-user operators across 6 roles (ADMIN/SENIOR/HR/ACCOUNTANT/JUNIOR/DROP). They scan tables, KPIs, statuses; they act quickly and often. The money path is sensitive and requires clarity and confirmations.                      |
| **Tone**             | **dense · quiet · scannable · professional.** A "calm operations console". NOT editorial, NOT playful, NOT marketing-hero. Quiet by default, energy only where action/attention is needed.                                           |
| **Memorable detail** | A warm amber undertone on dark neutrals (chroma ≈0.04–0.06 hue 85 in `surface`/`border`/`accent`) + brand yellow as the ONLY high-energy accent against deep blacks → a "spotlight" of hierarchy, not a motley dashboard.            |
| **Constraints**      | Tailwind v4 (`@theme inline`) + shadcn/ui + Radix · Russian UI · WCAG 2.2 AA · responsive 320–1440 · **dark-default** (`.dark` on `<html>`; light/dark parity) · the existing system of 218 tokens / 22 primitives / 103 composites. |

**Domain-fit:** SaaS operations tool ⇒ dense, quiet, scannable. No landing compositions
(centered hero, blob gradient, oversized CTA) on working screens.

---

## 2. Layout & page chrome (app-shell)

The global frame that EVERY screen inherits (Phase 0 north-star = its redesign):

- **Structure:** left `nav-sidebar` (role-filtered, `bg-surface`) + top header (page-context + `notifications-bell` + user menu) + main content area on `bg-background`.
- **Sidebar:** fixed width on desktop (≈240–264px), collapsible; at ≤768px — a `Sheet` overlay (trigger in the header). The active item is `bg-accent` (warm dark) + `text-accent-foreground`, left border/icon in `text-primary`. Grouped by domain, not a flat list of 12 items.
- **Header:** `flex-none`, sticky, opaque background (`bg-background`/`bg-card`), `z-20` (the `StickyPageHeader` pattern). Contains the page context (title + breadcrumbs when deep) on the left, actions/bell/avatar on the right.
- **Content area:** do NOT stretch max-width on ultra-wide screens — the content column has a sensible `max-w` (lists/details), but tables/dashboards may be full-width. Vertical rhythm of sections is a multiple of the spacing scale (§3).
- **Density:** informationally dense, but with room to breathe — priority is "how much useful content is visible without scrolling", but without claustrophobia. Do not shrink the hit area for the sake of density (§9).

---

## 3. Spacing rhythm / density

The base is Tailwind v4 spacing (4px step). Not "uniform padding everywhere" — rhythm follows the hierarchy:

| Level                           | Token (Tailwind)      | Application                |
| ------------------------------- | --------------------- | -------------------------- |
| Inside a control (button/input) | `px-3 py-2` / `gap-2` | compact, tactile           |
| Inside a card (`CardContent`)   | `p-4` … `p-6`         | by content density         |
| Between elements in a list      | `gap-2` … `gap-3`     | table-dense                |
| Between page sections           | `gap-6` … `gap-8`     | clear separation of blocks |
| Page padding (content)          | `p-4 md:p-6 lg:p-8`   | responsive                 |

**Principle:** rhythm contrast (dense inside a block, spacious between blocks) creates scannability
better than a single spacing. Radii come from the `--radius` scale (sm 4 / md 6.8 / lg 10 / xl 16.4px);
concentricity: the outer container is `rounded-lg`, the nested one is `rounded-md`.

---

## 4. Type scale (Inter)

`--font-sans` = `'Inter', system-ui, sans-serif`. Hierarchy through contrast of scale + weight, not through color.

| Role                  | Class (Tailwind)                  | Note                                                            |
| --------------------- | --------------------------------- | --------------------------------------------------------------- |
| Page title            | `text-xl font-semibold`           | one per screen; not an oversized hero                           |
| Section title         | `text-base font-semibold`         | card/section heading                                            |
| Card / KPI label      | `text-sm text-muted-foreground`   | metric caption                                                  |
| Body                  | `text-sm` (default) / `text-base` | main text; in dense tables `text-sm`                            |
| Caption / hint        | `text-xs text-muted-foreground`   | secondary info, timestamps                                      |
| **Numbers/money/IDs** | `tabular-nums` + `font-medium`    | **`tabular-nums` is mandatory** — amounts/counters don't "jump" |

Headings — `tracking-tight` for large ones; body text — normal tracking. Line-height per the
Tailwind default; in dense rows — `leading-tight`.

---

## 5. Color semantics (mapping to tokens)

Color is **semantic**, not decorative. Palette: 3 blacks (backgrounds) / 3 whites (text) / 3 yellows + system colors.

| Purpose                           | Token                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| Page canvas                       | `bg-background`                                                                                    |
| Raised surface (card)             | `bg-card` + `text-card-foreground`                                                                 |
| Sidebar/popover/inputs surface    | `bg-surface` (warm amber undertone)                                                                |
| Primary text                      | `text-foreground`                                                                                  |
| Secondary/captions                | `text-muted-foreground`                                                                            |
| **Brand / CTA / active**          | `bg-primary` + `text-primary-foreground` (near-black on yellow)                                    |
| Hover-ring / glow                 | `ring-ring` / `--yellow-muted`                                                                     |
| Active sidebar item / ghost-hover | `bg-accent` + `text-accent-foreground`                                                             |
| Borders                           | `border-border` (warm in dark)                                                                     |
| Error / deletion / debt           | `bg-destructive` / `text-destructive`                                                              |
| Status/role badges                | `Badge` variants (admin/senior/junior/hr/accountant/drop/status-active/status-closed/paid/pending) |

**Brand-yellow discipline:** only primary actions, active state, brand moments, key KPI accents.
Do NOT flood large areas with yellow, do NOT put yellow backgrounds under text (contrast), do NOT use it as a
decorative section background. Yellow = "action/attention here".

---

## 6. Elevation / depth

Depth through surfaces and borders, not heavy shadows (dark UI: shadows read poorly).

- Layers: `background` (canvas) → `card`/`surface` (raised) → `popover` (floating, `shadow` from shadcn).
- Cards: `bg-card` + `border-border` (1px) instead of a default drop-shadow; shadow only for truly floating elements (popover/dropdown/dialog) via shadcn tokens.
- NO "card in a card" (anti-pattern): nesting is done with sections/dividers (`Separator`), not double borders.

---

## 7. Motion

Compositor-friendly only (`transform`/`opacity`), high-signal, not decorative.

- Duration: 150ms (micro: hover/focus) / 200–300ms (panel transitions, tabs-pill, sheet).
- Easing: ease-out for appearance; the existing `AnimatedTabs`/`SegmentedToggle` patterns (sliding-pill) are the reference.
- Respect `prefers-reduced-motion` (the `credentials-timer-bar` pattern in globals.css).
- Do not animate layout properties (width/height/top/left). Skeleton (`animate-pulse`) for loading.

---

## 8. Component styling direction (how they should "feel")

We use the EXISTING shadcn/ui + composites (inventory) — we do not introduce a new visual language:

- **Button:** `default` = brand-yellow primary (the main action, 1 per context); `outline`/`ghost`/`secondary` — secondary; `destructive` — for deletion. Icons for familiar actions.
- **Card:** `bg-card` + `border-border`, `CardHeader` heading, `CardContent p-4/6` breathing room. The foundation of all surfaces.
- **Table:** dense rows, sticky header, `tabular-nums` in numeric columns, row hover highlight, row actions on the right (icon-button/`DropdownMenu`). This is the "bread and butter" of the CRM.
- **Dialog:** via `CrmDialog` (fixed header/body/footer, scrollable body, `max-h-[90dvh]`) — the standard for all modals.
- **Badge:** statuses/roles strictly via the ready-made variants — a single status language across the whole app.
- **Input/Select/Tabs:** shadcn defaults on our tokens; focus — a visible `ring-ring`.

---

## 9. A11y (WCAG 2.2 AA)

- **Target-size:** interactive elements ≥ 24×24px (icon buttons — an enlarged hit area even with a small icon).
- **Contrast:** text 4.5:1, large text/UI elements 3:1. The tokens are already calibrated (see the avatar-text comments in globals.css); do not lower them.
- **Focus:** a visible focus ring (`ring-ring`) on all interactive elements; logical focus order; focus trap in modals/sheet.
- **Icon-only:** `aria-label`. Semantic HTML (`nav`/`main`/`header`/tables) — not div soup.
- **Russian UI:** all strings in Russian; long labels wrap/resize, do not overflow.

---

## 10. Responsive

**Hard gate** (rule `.claude/rules/common/responsive-design.md`): EVERY screen is fully usable on
4 device classes. **Mobile-first:** the base is mobile, scale up with `sm/md/lg/xl/2xl`.

| Class      | Widths (test) | Behavior                                                                                                                                                                           |
| ---------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mobile** | 320 / 375     | single column; nav → `Sheet` (burger); dense tables → card stack OR h-scroll with a sticky 1st column; modals → full/bottom-sheet; touch targets ≥44px; no hover-only interactions |
| **Tablet** | 768           | 1–2 columns; sidebar visible/collapsible; condensed toolbars; forms 1–2 cols.                                                                                                      |
| **Laptop** | 1024 / 1280   | full desktop layout (the operators' main target)                                                                                                                                   |
| **Large**  | 1440 / 1920   | content columns with a `max-w` cap (do not stretch lines on ultra-wide); tables/dashboards full-width                                                                              |

**Mobile adaptation of components (design-system patterns — inherited by all screens):**

- **NavSidebar:** desktop `<aside>` ↔ mobile `Sheet` overlay (burger). The reference is app-shell.
- **Dense table:** desktop — a table; mobile — a card stack of rows OR horizontal scroll with a sticky first column + an indicator. Do NOT silently cut off columns.
- **Dialog / `CrmDialog`:** desktop — a centered modal; mobile — full-screen / bottom-sheet (`max-h-[90dvh]`, scroll body).
- **Filters / toolbars:** desktop — in a row; mobile — wrap or collapse into a "Фильтры" button.
- **Type-scale:** large headings — `clamp()` as needed; body readable (≥14px) on mobile.
- **Touch:** interactive elements ≥44px on mobile (larger than the a11y minimum of 24px); actions visible without hover.

- Stable toolbar/grid/counter sizes — they do not "jump" on hover / label change / device class change.
- **Verification:** Playwright at the test widths — no horizontal page overflow (`scrollWidth ≤ clientWidth`), everything reachable, touch targets OK on mobile.

---

## 11. Anti-patterns (AI-slop guardrails — Mode C catches these)

- ❌ Purple gradients, decorative blobs, oversized hero, vague marketing copy on working screens.
- ❌ Card in a card; a single radius/spacing/shadow everywhere with no hierarchy.
- ❌ Yellow as a decorative fill of large areas / a yellow background under text.
- ❌ Generic "dashboard-by-numbers" with no point of view; raw shadcn defaults passed off as a finished design.
- ❌ Raw hex/oklch in code — semantic tokens only.
- ✅ Design-quality requirement: every screen demonstrates ≥4 qualities (hierarchy via scale, rhythm, depth
  via surfaces, semantic color, designed hover/focus/active, data as part of the system).

---

## 12. Redesign principle (CRITICAL — inherited by all phases)

Redesign = **restyle of existing blocks**: the same blocks, labels, data content as on the REAL
screen. We change ONLY visuals/spacing/hierarchy/placement per UI/UX canons. **Add nothing new**
(no buttons, no KPIs, no widgets), do not remove features, do not touch business logic/API/RBAC. Each screen's brief is
capture-grounded (the real screen is captured, blocks are listed, an explicit "add nothing not listed" prohibition).
