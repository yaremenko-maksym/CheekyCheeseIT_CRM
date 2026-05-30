# Progress: task-drop-phase1-frontend

current_milestone: 0/6 — "starting frontend; backend already merged"
last_commit: a1fd46d (backend final)
last_push: 2026-05-30T(initial — clean baseline)

## Milestones plan
1. Sidebar DROP support + dashboard guard for DROP + ROLE_LABELS/BADGE updates (+ users constants)
2. CreateDropDialog component + button on /crm/users (ADMIN only)
3. UserDialog SENIOR — RadioGroup teamMode (CREATE_NEW / JOIN_DROP_TEAM) + drop-team picker
4. /crm/team list — remove "Создать команду" button (HR keeps "Создать синьора"); badge type=DROP on cards
5. /crm/team/$teamId — DROP rendering branch + "Сменить синьора" dialog
6. Teamless senior edge — banner in profile, sidebar gate, empty states on projects/interviews; finance for DROP read-only

files_done:
files_pending:
  - apps/web/app/components/crm/nav-sidebar.tsx
  - apps/web/app/components/users/constants.ts
  - apps/web/app/components/users/CreateDropDialog.tsx (new)
  - apps/web/app/components/users/UserDialog.tsx (RadioGroup teamMode)
  - apps/web/app/components/users/RejoinTeamDialog.tsx (new)
  - apps/web/app/routes/crm/users/index.tsx
  - apps/web/app/routes/crm/team/index.tsx
  - apps/web/app/routes/crm/team/$teamId.tsx
  - apps/web/app/routes/crm/profile/index.tsx (banner for teamless senior)
  - apps/web/app/routes/crm/projects/index.tsx (empty state for teamless senior)
  - apps/web/app/routes/crm/interviews/index.tsx (empty state for teamless senior)
  - apps/web/app/routes/crm/dashboard.tsx (DROP redirect)
  - apps/web/app/hooks/use-active-team.ts (new — derives team membership)
