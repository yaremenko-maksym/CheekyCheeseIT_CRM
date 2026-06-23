# Progress: task-redesign-app-shell

current_milestone: 1/3
last_commit: (none yet)
last_push: (none yet)

## Milestones

- [ ] M1 — restyle nav-sidebar.tsx (desktop aside + mobile Sheet) → flat, active warm bg + left primary border + primary icon, dense rhythm.
- [ ] M2 — restyle route.tsx CrmLayout (glassy header, brand, search/bell/user-menu, ambient harmonize, loading skeleton, dense content chrome) + notifications-bell visual polish.
- [ ] M3 — verify: eslint + typecheck + E2E green + playwright visual fidelity (Mode B) at 320/768/1024/1440.

files_done: []
files_pending:

- apps/web/app/components/crm/nav-sidebar.tsx
- apps/web/app/routes/\_authenticated/route.tsx
- apps/web/app/components/layout/notifications-bell.tsx (only if visual polish needed)

## blast_radius (exported symbols being restyled — NO signature/behavior change)

- `NavSidebar` (nav-sidebar.tsx:106) — 1 caller: route.tsx. Props UNCHANGED (user/collapsed/onToggle/mobileOpen/onMobileClose). Visual-only.
- `NotificationsBell` (notifications-bell.tsx:75) — 1 caller: route.tsx. Props UNCHANGED (enabled). Visual-only.
- `CrmLayout` (route.tsx) — internal, no external callers. Visual-only.
- `BrandMark`, `UserAvatar`, `TosUpdateBanner` — REUSED as-is (no edits to those files).

## E2E contracts to preserve (must NOT break)

- `aside a[href="..."]` desktop sidebar links (navigation.spec clickSidebarLink) — keep `<aside>` + `<Link to>`.
- `junior-nav` / `drop-nav` testids on `<nav>`.
- nav labels plain text inside nav (`nav.getByText('Команда')` etc.) — flat list, no section headers.
- notifications-bell-trigger/badge/dropdown/empty/list/mark-all-read/notification-item-\* testids.
- header-user-menu-trigger/role-badge/profile/logout testids.
- tos-update-banner / tos-update-banner-link testids.
- shell brand text `CheekyCheeseIT` (NOT `CheekyCheeseIT CRM` — that's login page).
- mobile Sheet sr-only Title "Навигация" + Description.

## Reuse note

Restyle of EXISTING blocks only. No new components, no new tokens, no new deps.
Header name+email shown next to avatar on lg+ = re-presentation of data already in
the user-menu dropdown label (not new functionality).
