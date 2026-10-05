# App-shell — Foundation (Phase 0 north-star)

> Per-screen artifact (CRM redesign). Coder-ready spec on our shadcn/ui + tokens. Headless agents
> rely ONLY on this file + `assets/` (they have no browser access). Template: `docs/design/screens/_TEMPLATE.md`.
> Direction: `docs/design/foundation.md`. Program: `docs/superpowers/specs/2026-06-22-crm-redesign-program.md`.

| Field              | Value                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Screen             | App-shell (global shell: header + nav-sidebar + content chrome)                          |
| Route / trigger    | `apps/web/app/routes/_authenticated/route.tsx` (`CrmLayout`) — inherited by EVERY screen |
| Roles              | All 6 (ADMIN/SENIOR/JUNIOR/HR/ACCOUNTANT/DROP) — sidebar role-filtered                   |
| Claude Design URL  | `https://claude.ai/design/p/cb5277cf-5b56-44ff-9a6a-4404d8c92cea`                        |
| Status             | `approved` (owner, 2026-06-23)                                                           |
| Last synced commit | `86d72c32` (base; the redesign = a restyle of the current shell)                         |

---

## Fidelity reference

- **Claude Design project:** `https://claude.ai/design/p/cb5277cf-5b56-44ff-9a6a-4404d8c92cea` (system `CheekyCheeseIT CRM`, Opus 4.8; project "CRM глобальный каркас").
- **`design.png`** — the main fidelity reference for Mode B: a frame of **Variant A** (header + flat sidebar + dense "Пользователи" table), a faithful server render from Claude Design.
- **`design-states.png`** — all 4 states in one frame: default (Variant A) · sidebar collapsed · notifications open · mobile overlay.
- **The coder builds with OUR shadcn/ui components** per the spec below, checking visually against `design.png`. The raw Claude Design sources (generic CD classes, not our components) are **NOT committed** to the repo — to avoid copy-pasting and extra weight (3 MB runtime bundle); if needed, the full Project archive is exported from the CD project at the URL above.
- _How `design.png` was obtained:_ `/design` → Export → **Project archive** → unpack (`ditto`, unicode names) → local `http.server` → Playwright render of the showcase page (sibling resolves) → crop of Variant A. Direct rasterization of the CD render is unavailable (Chrome MCP `save_to_disk` writes no file; the print URL hangs in Playwright) — the archive path is reliable and autonomous, **with no manual screenshot from the owner**.
- **Owner decision 2026-06-23:** we go with **Variant A "restrained"**; navigation is a **FLAT list** (grouping into sections РАБОЧЕЕ ПРОСТРАНСТВО/УПРАВЛЕНИЕ/ЛИЧНОЕ was rejected).
- **Identity block in the header (owner 2026-06-23: "do everything as in the mockup"):** IMPLEMENT as in `design.png` — user name + email to the right of/as part of the user trigger, visible on desktop (≥`lg`), hidden on mobile/tablet (they remain in the dropdown). Requires updating the `ui-invariants-pr56` invariant (the email is now in 2 places) — AutoTest zone.
- **Responsive (owner 2026-06-23):** mandatory on 4 device classes (mobile/tablet/laptop/large) — `responsive-design.md`. The app-shell is the reference for mobile adaptation (sidebar→Sheet).

## Real blocks (1:1 — add NOTHING, remove NOTHING)

The source of truth is the code of `_authenticated/route.tsx` + `components/crm/nav-sidebar.tsx` +
`components/layout/notifications-bell.tsx`. The redesign = a restyle of THESE blocks, not new ones.

### A. Header (top bar) — `sticky top-0 z-40`, glassy (`bg-background/80 backdrop-blur-md`), `border-b`, `px-6 py-3`

- **Left (gap-3):**
  1. Burger button (`Menu` icon, **only ≤768px** `md:hidden`) — opens the mobile sidebar Sheet.
  2. Brand link to `/`: `BrandMark` (h-7 w-7, `text-primary`) + the text "CheekyCheeseIT" (`font-semibold tracking-tight`).
  3. `Badge variant="outline"` "CRM" (**hidden <640px**, `sm:flex`).
- **Right (gap-1):** 4. Icon button "Поиск" (`Search`, ghost, `aria-label`). _Existing placeholder block — keep as is._ 5. **NotificationsBell** — `Bell` ghost button + unread badge (round `bg-primary text-primary-foreground`, "99+" cap); dropdown w-80: header "Уведомления" + "Прочитать всё" (CheckCheck), list of rows (TypeIcon + title + body line-clamp-2 + relative time (ru) + unread dot + Trash on hover), empty state (Inbox + "Уведомлений нет"), loading skeleton. 6. **User menu** (DropdownMenu, trigger = `UserAvatar` h-8, fallback `bg-primary/20 text-primary`): label (displayName + email muted), role `Badge` (variant=role), "Профиль" (UserCircle → `/profile`), "Выйти" (LogOut).

### B. NavSidebar — `components/crm/nav-sidebar.tsx`

- **Desktop:** `<aside>` `bg-background`, `border-r border-border/60`, width **208px** (`w-52`) / collapsed **56px** (`w-14`), `transition-[width] 200ms`. No brand header (the brand is in the header). Inside:
  - `ScrollArea` → `<nav>` (`flex-col gap-0.5 p-2 pt-3`) — a flat list of role-filtered items.
  - Bottom: `border-t` + collapse toggle (ghost icon, Chevron Left/Right, tooltip "Свернуть/Развернуть").
- **Items (12, fixed order; visibility by role via `navRolesFor()`):** Мой проект (Home), Легенда (BookOpen), Дашборд (LayoutDashboard, active-exact), Пользователи (Users), Админ (Settings), Команда (UsersRound), Проекты (Briefcase), Финансы (DollarSign), Статистика (BarChart3), Собеседования (KanbanSquare), Документы (FileText), Профиль (UserCircle, last). _A teamless SENIOR hides Проекты+Собеседования._
- **Item (link):** `text-muted-foreground` → hover `bg-accent text-accent-foreground` → active `bg-accent text-accent-foreground` + left border `border-l-2 border-primary` + icon `text-primary`. Collapsed: centered icon + tooltip + active ring.
- **Mobile:** `Sheet` (side left, w-60) with ITS OWN brand header (BrandMark flat + "CheekyCheeseIT") + the same list.

### C. Content chrome

- `<main>` `flex-1 min-h-0 flex flex-col overflow-hidden`, `scrollbar-gutter: stable` → `<Outlet/>` (screen content).
- Between the header and the body — **TosUpdateBanner** (conditional: `tosUpdateAvailable && !requiresTos`).

### D. Ambient background (decorative depth, existing)

3 blurred motion blobs (`bg-primary/[0.05]`, `bg-violet-500/[0.05]`, `bg-amber-500/[0.035]`, blur 100–120px),
`fixed inset-0 -z-10 pointer-events-none`, slow drift 24–36s, **paused when the tab is hidden**. Keep the
atmosphere (it may be harmonized with the brand), do not turn it into an AI-slop blob gradient.

### E. Onboarding mode

If the path is `/onboarding*` → ONLY `<Outlet/>` is rendered (no header/sidebar). Do not touch.

---

## States

| State         | Reference                                      | Notes                                                                                      |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| default       | `assets/app-shell/design.png`                  | Variant A: ADMIN, expanded sidebar, desktop 1360px (main reference)                        |
| collapsed     | `assets/app-shell/design-states.png` (frame 2) | sidebar `w-14`, icons + tooltips                                                           |
| notifications | `assets/app-shell/design-states.png` (frame 3) | open bell dropdown (list + unread badge)                                                   |
| mobile        | `assets/app-shell/design-states.png` (frame 4) | ≤768: burger + Sheet overlay sidebar (flat list)                                           |
| role-junior   | — (not generated)                              | mechanically: `navRolesFor` nav filter → 5 JUNIOR items (as in the current code) + restyle |
| loading       | — (not generated)                              | keep the existing skeleton (the `isLoading` branch of route.tsx), the restyle is inherited |

> The generated states are in `design-states.png` (one frame, 4 sub-frames) + `design.png` (default, large).
> The design did not generate `role-junior` and `loading`: they are derived from the existing code (nav role filter + skeleton) — keep them, the restyle is inherited from the shell.

---

## Components (mapping to our stack)

Existing — do NOT introduce new ones (inventory `docs/design/assets/_design-system/inventory.md`):

| Visual block             | Our component (shadcn/ui / composite)                   | New? |
| ------------------------ | ------------------------------------------------------- | ---- |
| Header bar               | layout markup in `route.tsx` (not a separate component) | no   |
| Brand                    | `BrandMark` + text                                      | no   |
| "CRM" badge / role badge | `Badge` (outline / role variants)                       | no   |
| Search / menu triggers   | `Button` (ghost, size icon)                             | no   |
| Notifications            | `NotificationsBell` (+ `DropdownMenu`, `Skeleton`)      | no   |
| User menu                | `DropdownMenu` + `UserAvatar`                           | no   |
| Sidebar                  | `NavSidebar` (+ `ScrollArea`, `Sheet`, `Tooltip`)       | no   |
| Content scroll           | `<main>` + `Outlet`                                     | no   |
| ToS banner               | `TosUpdateBanner`                                       | no   |
| Ambient background       | `motion.div` blobs (framer-motion)                      | no   |

---

## Token-map

Only `globals.css` tokens (no raw hex). See `foundation.md` §5.

- Canvas: `bg-background` · header: `bg-background/80` + `backdrop-blur-md` + `border-border/60`.
- Sidebar: `bg-background` + `border-r border-border/60`; active item `bg-accent` + `text-accent-foreground` + `border-primary`; active icon `text-primary`; item `text-muted-foreground`.
- Brand/accents: `text-primary`; unread badge `bg-primary text-primary-foreground`.
- Avatar fallback: `bg-primary/20 text-primary`.
- Text: `text-foreground` / `text-muted-foreground`.

---

## A11y / responsive / motion

- **A11y (WCAG 2.2):** target-size ≥24px (header icon buttons); `aria-label` on Search/Bell/menu; focus ring `ring-ring` (the user trigger already has `focus-visible:ring-2`); focus-trap in Sheet/Dropdown (Radix); the sidebar Sheet carries an sr-only Title+Description.
- **Responsive:** ≤768 — sidebar→Sheet (burger in the header), the "CRM" badge is hidden <640; 1024–1440 — main desktop; the header is sticky and does not jump.
- **Motion:** sidebar width transition 200ms ease-in-out; ambient blobs 24–36s (paused on a hidden tab; `transform`/`scale` — compositor-friendly); respect `prefers-reduced-motion`. Compositor-only, no layout animations.

---

## Generation brief (Claude Design, system `CheekyCheeseIT CRM`)

**Task:** professionally redraw the GLOBAL CRM app-shell (header + left nav-sidebar + content
chrome) in the unified visual language of `foundation.md`. This is the north-star — it sets the direction for the whole application.

**Keep 1:1 (add nothing not listed):** all blocks A–E above — the same navigation items (12, role-filtered),
the same header elements (brand, CRM badge, Search, Notifications, User menu), collapse-sidebar, mobile Sheet,
ToS banner, ambient background, onboarding bare mode. **Do NOT add** new items/buttons/widgets; do NOT
rename items; do NOT change the navigation structure/routing/RBAC.

**Change ONLY:** visuals/hierarchy/spacing/density/placement per UI/UX canons — so that it is
professional, calm, scannable (a dense operations console, dark-default, brand yellow used with discipline).

**Tone / constraints:** `foundation.md` §1 (dense·quiet·scannable·professional) + Tailwind v4 + shadcn/ui +
Russian UI + WCAG 2.2 AA + responsive 320/768/1024/1440 + our 218 tokens. Anti-slop: no purple gradients,
oversized hero, cards-in-cards, yellow fills of large areas.

**States to generate:** default (ADMIN, desktop) · collapsed sidebar · JUNIOR role (5 items) ·
mobile (Sheet) · notifications dropdown open.
