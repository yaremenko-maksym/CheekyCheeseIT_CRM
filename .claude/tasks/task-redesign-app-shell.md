# Task: Redesign Phase 0 — App-shell (restyle to approved north-star)

## Design tier: 1 (north-star redesign; artifact gate passed — `approved`)

## Model: opus (foundational north-star, sets the visual language of all phases + high blast-radius — every route inherits the shell)

## Context

This is a **restyle of the existing global app-shell** to the owner-approved design (Variant A
"restrained", flat navigation). Redesign = **visual + UX, functionality 1:1**. This is screen #1
of the phased redesign program (`docs/superpowers/specs/2026-06-22-crm-redesign-program.md`).

## Artifact (the only visual source — read by absolute path from the master worktree)

The artifact is committed on branch `claude/thirsty-brattain-34ab4a`. If your worktree branch does not have these
files — read them by ABSOLUTE path:

- **Spec (coder-ready):** `/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/worktrees/thirsty-brattain-34ab4a/docs/design/screens/_foundation/app-shell.md` — FULL description of the blocks 1:1, token-map, states, owner's decision. **Read first.**
- **`design.png`** (the main fidelity reference — Variant A): `…/docs/design/screens/_foundation/assets/app-shell/design.png`
- **`design-states.png`** (4 states): `…/docs/design/screens/_foundation/assets/app-shell/design-states.png`
- **Direction:** `…/docs/design/foundation.md` (visual language: density, type-scale, color semantics, motion, a11y).

## Files (zone: apps/web/\*\* — Coder)

Source of truth of the current shell (read via codegraph/Read before editing):

- `apps/web/app/routes/_authenticated/route.tsx` — `CrmLayout`: header + body + ambient background + loading + onboarding-bare.
- `apps/web/app/components/crm/nav-sidebar.tsx` — `NavSidebar`: desktop aside + mobile Sheet.
- `apps/web/app/components/layout/notifications-bell.tsx` — bell + dropdown (if it needs a visual restyle to match the design).
- If necessary: `apps/web/app/components/crm/StickyPageHeader.tsx`. **Do NOT change** `globals.css` tokens (the restyle works on existing tokens; if it seems a new token is needed — stop, note it in `.blocked.md`).

## What we do (restyle per `design.png`)

Bring the app-shell to the look of `design.png`: glassy header, flat sidebar with an active item
(warm background + left bar `border-primary` + yellow icon), dense content area. Exact layout/
spacing/hierarchy/typography — per `design.png` + `app-shell.md` §"Real blocks" + `foundation.md`.

## Acceptance Criteria

1. **Visual = `design.png`** (Variant A): header, flat sidebar, content chrome, states (collapsed/mobile/notifications — `design-states.png`). Mode B fidelity PASS.
2. **Functionality 1:1 (CRITICAL):** ALL blocks and behavior preserved — 12 navigation items in the same order and role filter (`navRolesFor`), teamless-SENIOR gate, collapse + localStorage, mobile Sheet, NotificationsBell (polling + dropdown + mark-read + delete + empty/loading), user-menu (profile/log out/role badge), search button (placeholder — keep), TosUpdateBanner, ambient background (may be harmonized, not removed), onboarding-bare mode, loading skeleton. **Do not add/remove/rename anything.** Do NOT touch routes/RBAC/business logic.
3. **Navigation is FLAT** — no section headings (the owner rejected grouping).
4. **Only our components/tokens:** shadcn/ui + composites + semantic `globals.css` tokens. No raw hex/oklch, no generic gradients, no new dependencies. **Do NOT copy** the raw exported HTML/JSX from CD.
5. **Responsive** 320/768/1024/1440 without overflow; **a11y** WCAG 2.2 AA (visible focus, target-size ≥24px, contrast, aria-label on icon-only, focus-trap in Sheet/Dropdown).
6. **E2E:** `pnpm --filter @crm/e2e test` green locally (navigation across all sections, role filter, collapse, mobile, notifications). Zero-flaky. The app-shell touches every route — run it in full.
7. **typecheck + lint** clean (`mcp__eslint__lint-files` on changed files, `pnpm typecheck`).

## Worktree provisioning (MANDATORY)

A fresh worktree without node_modules → husky hooks fail. Before work:
`pnpm install --frozen-lockfile` + `pnpm --filter @crm/web build` (generates `routeTree.gen.ts`, gitignored).
All Edit/Write — INSIDE your own worktree; after the first edit check `git -C <worktree> status`; do NOT write
to absolute master-repo paths (the artifact is read by abs path — but do NOT write there). NOT `--no-verify`.
Push of the feature branch: `DATABASE_URL= git push`. Commit with `ac_verified:`.

## Progress / blockers

Write progress to `.claude/tasks/task-redesign-app-shell.progress.md`; blockers — `.claude/tasks/task-redesign-app-shell.blocked.md`.
On completion — a report: branch, commit SHA, which files, E2E/typecheck/lint result, and what exactly
changed visually vs the current shell (for Mode B).
