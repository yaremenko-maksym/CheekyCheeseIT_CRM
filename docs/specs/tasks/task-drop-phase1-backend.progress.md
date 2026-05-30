# Progress: task-drop-phase1-backend

current_milestone: 0/8 — exploring code, gathering senior touch-points
last_commit:
last_push:

files_done:
files_pending:
  - packages/shared/src/schemas/users.ts
  - packages/shared/src/schemas/teams.ts
  - packages/shared/src/schemas/projects.ts
  - packages/shared/src/index.ts
  - apps/api/src/database/schema.ts
  - apps/api/drizzle/migrations/0020_*.sql
  - apps/api/src/users/users.service.ts
  - apps/api/src/users/users.controller.ts
  - apps/api/src/users/users.module.ts
  - apps/api/src/teams/teams.service.ts
  - apps/api/src/projects/projects.service.ts
  - apps/api/src/interviews/interviews.controller.ts
  - apps/api/src/users/users.service.spec.ts (new tests)
  - apps/api/src/teams/teams.service.spec.ts (new tests)
  - apps/api/test/* unit-tests for new methods

milestones:
  - [ ] M1: shared schemas + drizzle schema + migration
  - [ ] M2: TeamsService new methods (createDropTeam, archiveDropTeam, rotateSenior, addSeniorToDropTeam) + mapTeam expand
  - [ ] M3: UsersService new methods (createDrop, archiveDrop) + extend createUser
  - [ ] M4: ProjectsService visibility (DROP branch)
  - [ ] M5: Interviews + Projects teamless guards + rejoin-team endpoint
  - [ ] M6: RBAC matrix DROP
  - [ ] M7: Unit tests
  - [ ] M8: Local CI green (typecheck/lint/test/e2e + migration smoke)
