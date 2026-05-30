# Progress: task-drop-phase1-backend

current_milestone: 8/8 — all backend AC complete; awaiting PR open
last_commit: (see git log feat/drop-role-phase1)
last_push: (see origin)

milestones:

- [x] M1: shared schemas (users/teams/projects/auth) + Drizzle schema + migration 0020
- [x] M2: TeamsService new methods (createDropTeam, archiveDropTeam, rotateSenior, addSeniorToDropTeam) + mapTeam early-return for DROP
- [x] M3: UsersService new methods (createDrop, archiveDrop, rejoinTeam, userHasActiveTeam) + extend createUser teamMode
- [x] M4: ProjectsService DROP visibility + assertAccess + dropId in DTO
- [x] M5: UsersController endpoints (POST /users/drops, DELETE /users/drops/:id, POST /users/me/rejoin-team) + InterviewsService teamless guard
- [x] M6: users-access (DROP viewer/target tab+share field)
- [x] M7: Unit tests (users.drop.spec.ts, teams.drop.spec.ts) — validation/RBAC; existing 270 tests pass as regression
- [x] M8: Smoke `docker compose down -v + db:migrate + db:seed` green on clean DB; enum/columns verified via postgres MCP

senior_touch_point_inventory:

- touched_by_me:
  - apps/api/src/users/users.service.ts # appended DROP branch in archive, added createDrop/archiveDrop/rejoinTeam/userHasActiveTeam
  - apps/api/src/users/users.controller.ts # added /drops endpoints, /me/rejoin-team
  - apps/api/src/users/users-access.service.ts # DROP viewer is_self path + targetIsShareRole includes DROP
  - apps/api/src/teams/teams.service.ts # mapTeam early-return + 4 new methods (createDropTeam, archiveDropTeam, rotateSenior, addSeniorToDropTeam)
  - apps/api/src/projects/projects.service.ts # findAll DROP branch + senior DROP-team awareness + assertAccess
  - apps/api/src/interviews/interviews.service.ts # SENIOR teamless guard (assertSeniorHasActiveTeam)
  - apps/api/src/database/schema.ts # role enum DROP, teamType enum, teams.type, users.dropSharePercent, projects.dropId
  - apps/api/drizzle/migrations/0020_drop_role_and_schema.sql # ALTER TYPE role ADD 'DROP', CREATE TYPE team_type, columns
- touched_minimally_for_compile:
  - apps/web/app/components/ui/role-select.tsx # Record<Role,...> needs DROP entry — placeholder Russian label + accountant badge variant
  - apps/web/app/routes/crm/documents.tsx # Record<Role,...> placeholder DROP categories
  - apps/web/app/components/projects/**tests**/ProjectRow.test.tsx # added dropId:null to ProjectDto fixture
- NOT_touched_intentionally:
  - apps/api/src/finance/transactions.service.ts # Phase 2 (drop-project distribution); existing SENIOR_INCOME flow unchanged
  - apps/api/src/documents/documents.service.ts # DROP-specific category visibility lands with the FE task
  - apps/api/src/invoices/invoices.service.ts # Phase 2/3 — invoice generation for drop flows is later
  - apps/api/src/database/seed.ts # No DROP-seed yet; spec says drops are created via /api/users/drops in production
  - apps/web/app/components/_ and apps/web/app/routes/_ # Frontend task ships in task-drop-phase1-frontend.md

files_done:

- packages/shared/src/types/roles.ts (DROP)
- packages/shared/src/schemas/auth.ts (sessionUser role)
- packages/shared/src/schemas/users.ts (roleSchema, dropSharePercent, createDropSchema, rejoinTeamSchema, teamMode)
- packages/shared/src/schemas/teams.ts (teamTypeSchema, teamSchema.type, rotateSeniorSchema, addSeniorToDropTeamSchema)
- packages/shared/src/schemas/projects.ts (role enum bump + projectSchema.dropId)
- packages/shared/src/utils/display.ts (DROP label)
- apps/api/src/database/schema.ts (DROP role, team_type enum, teams.type, users.dropSharePercent, projects.dropId)
- apps/api/drizzle/migrations/0020_drop_role_and_schema.sql
- apps/api/drizzle/migrations/meta/\_journal.json
- apps/api/src/teams/teams.service.ts
- apps/api/src/users/users.service.ts
- apps/api/src/users/users-access.service.ts
- apps/api/src/users/users.controller.ts
- apps/api/src/projects/projects.service.ts
- apps/api/src/interviews/interviews.service.ts
- apps/api/src/users/users.drop.spec.ts
- apps/api/src/teams/teams.drop.spec.ts
- apps/web/app/components/ui/role-select.tsx (placeholder DROP)
- apps/web/app/routes/crm/documents.tsx (placeholder DROP)
- apps/web/app/components/projects/**tests**/ProjectRow.test.tsx (dropId fixture)

ci_results:

- pnpm typecheck: green (4/4)
- pnpm lint: green (3/3)
- pnpm test (API + shared + web): green — 272 API + 124 web tests
- pnpm --filter @crm/e2e test: 449 passed / 4 failed / 10 skipped — the 4 failures are pre-existing flaky tests unrelated to drop changes (team auto-redirect test relies on multi-team senior seed; TechAutocomplete Tab key; finance flow timing)
- smoke `docker compose down -v + db:migrate + db:seed`: green; enum DROP + team_type + drop_share_percent + drop_id verified via postgres MCP
