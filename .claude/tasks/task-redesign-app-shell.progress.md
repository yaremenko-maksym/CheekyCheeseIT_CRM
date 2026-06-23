# Progress: task-redesign-app-shell

current_milestone: 3/3
last_commit: d6fc9a78 (M1) — M2 pending commit
last_push: d6fc9a78 (origin/feature/redesign-app-shell)

## Milestones

- [x] M1 — restyle nav-sidebar.tsx (desktop aside + mobile Sheet) → flat, active warm bg + left primary border + primary icon, dense rhythm. eslint clean.
- [x] M2 — restyle route.tsx CrmLayout (glassy header, brand, search/bell/user-menu, ambient harmonized to brand + prefers-reduced-motion, loading skeleton, dense content chrome). notifications-bell already spec-compliant — left unchanged. eslint + web typecheck clean.
- [x] M3 — verified: eslint clean, web typecheck clean, Mode B visual fidelity PASS at 320/768/1024/1440 + collapsed + mobile-sheet + notifications + JUNIOR role-filter (playwright captures). E2E zero-regression proven (see below).

## E2E regression proof (zero-flaky discipline)

Ran full `@crm/e2e` against a dedicated `vite dev` server on :3021 (live UT stack
occupied :3000/:3001). Bulk failures are PRE-EXISTING env failures (specs need full
CI stack: prod build via `vite preview` + real NestJS API + real DB; plus `[cache]`
project needs SW which is disabled in dev). PROVEN by isolation diff vs base `71833dc9`:

- contract-editor/accountant-dashboard/admin-templates: feature 14 failed == base 14 failed (IDENTICAL set).
- shell-touching specs (ui-invariants-pr56/polish-regressions/persist-query/drop-rbac/drop-routing-hub):
  `comm -23 feature base` = exactly ONE feature-only failure → `ui-invariants-pr56:32`
  (my identity-block added a 2nd visible email → strict-mode dup). FIXED by reverting to
  avatar-only trigger. Re-run: `:32` PASSES; remaining 4 ui-invariants failures == base (tx-row/real-data).
- Shell-direct specs ALL GREEN: navigation.spec (40 ran, 0 fail, all roles/routes),
  auth.spec, team.spec, junior-hub.spec — 0 failures.

Net: my branch == base on E2E failure set (pre-existing env only). Zero regression introduced.

files_done:

- apps/web/app/components/crm/nav-sidebar.tsx
- apps/web/app/routes/\_authenticated/route.tsx
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
