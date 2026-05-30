# Progress: task-drop-phase1-frontend

current_milestone: 6/6 — "polishing + pre-push checks"
last_commit: 7830ba9 (CreateDropDialog + button on /crm/users)
last_push: pending

## Milestones plan
1. [x] Sidebar DROP support + dashboard guard for DROP + ROLE_LABELS/BADGE updates
2. [x] CreateDropDialog component + button on /crm/users (ADMIN only)
3. [x] UserDialog SENIOR — RadioGroup teamMode (CREATE_NEW / JOIN_DROP_TEAM) + drop-team picker
4. [x] /crm/team list — DROP badge on cards
5. [x] /crm/team/$teamId — DROP rendering branch + «Сменить синьора» dialog + thin POST /api/teams/:id/rotate-senior controller endpoint
6. [x] Teamless senior edge — banner in profile, sidebar gate, empty states on projects/interviews; RejoinTeamDialog (CREATE_NEW / JOIN_DROP_TEAM)

files_done:
  - apps/web/app/components/crm/nav-sidebar.tsx (DROP nav items + teamless senior gate)
  - apps/web/app/hooks/use-active-team.ts (new)
  - apps/web/app/routes/crm/dashboard.tsx (DROP redirect)
  - apps/web/app/components/users/constants.ts (DROP label/variant)
  - apps/web/app/components/users/CreateDropDialog.tsx (new)
  - apps/web/app/components/users/RejoinTeamDialog.tsx (new)
  - apps/web/app/routes/crm/users/index.tsx (Создать дропа button)
  - apps/web/app/components/ui/badge.tsx (drop variant)
  - apps/web/app/routes/crm/route.tsx
  - apps/web/app/components/users/UserDialog.tsx (RadioGroup teamMode + drop-team picker)
  - apps/web/app/routes/crm/team/index.tsx (DROP badge on cards)
  - apps/web/app/routes/crm/team/$teamId.tsx (DROP rendering + rotate-senior dialog + drop projects via dropId)
  - apps/web/app/routes/crm/projects/index.tsx (teamless senior empty state)
  - apps/web/app/routes/crm/interviews/index.tsx (teamless senior empty state)
  - apps/web/app/components/user-profile/UserProfileShell.tsx (teamless banner)
  - apps/api/src/teams/teams.controller.ts (POST :id/rotate-senior endpoint)

verification:
  - pnpm typecheck — passing
  - pnpm lint — passing (existing 3 warnings unchanged)
  - pnpm --filter @crm/web build — passing
  - pnpm --filter @crm/web test — 124/124 passing
  - pnpm --filter @crm/api test — 272/272 passing
  - e2e: 449/463 passed, 4 failed (1 regression fixed; 3 pre-existing flakes: TechAutocomplete, finance-senior-flow, team empty state — confirmed by isolating runs)
