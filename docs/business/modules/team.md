# Module: Teams

## Status: ✅ Implemented (PHASE 2)

## Business logic

### Team structure

- HR(s) + SENIOR(s) + ACCOUNTANT (shared) + JUNIOR (a derived state)
- A JUNIOR in a team is **derived**: taken from `project_members` WHERE `leftAt IS NULL` AND `project.seniorId` = the team's senior
- A JUNIOR is not stored in `team_members` directly
- ADMIN is excluded from all teams (manages, but is not a member)
- At most 10 teams for the whole company

### Deletion protection

- Cannot be deleted: a SENIOR (the whole team must be deleted), the last HR, the last ACCOUNTANT

### RBAC

| Action              | ADMIN    | HR       | SENIOR   | JUNIOR   | ACCOUNTANT |
| ------------------- | -------- | -------- | -------- | -------- | ---------- |
| Create a team       | ✅       | ✅       | ❌       | ❌       | ❌         |
| Edit                | ✅       | ✅ (own) | ❌       | ❌       | ❌         |
| Delete              | ✅       | ❌       | ❌       | ❌       | ❌         |
| Add/remove a member | ✅       | ✅ (own) | ❌       | ❌       | ❌         |
| View                | ✅ (all) | ✅ (own) | ✅ (own) | ✅ (own) | ✅ (all)   |

## DB tables

```sql
teams: id, name, createdAt
team_members: id, teamId, userId, joinedAt
-- Stores only: HR, SENIOR, ACCOUNTANT. NOT JUNIOR.
-- An HR's "own team" = a team where they are in team_members
```

### JUNIOR RBAC — filtering the roster

- `GET /api/teams/:id` — if `viewer.role === 'JUNIOR'`: the server removes all other JUNIORs from `members[]` before responding
- All other roles get the full list of participants

### SENIOR/JUNIOR — auto-redirect

- `GET /api/teams` for SENIOR/JUNIOR returns a single team → the frontend redirects to `/crm/team/:id`
- ADMIN, HR, ACCOUNTANT stay on the list page

## UI

- **Team list** (`/crm/team`): cards with the avatars of the first 4 participants + "+N", the number of active projects, a hover effect → a click opens `/crm/team/:id`
- **Detail page** (`/crm/team/:id`): the name + creation date, a list of participants with avatar/name/role, management buttons (only ADMIN and the HR-owner)

## Endpoints

```
GET    /api/teams                       → list (ADMIN/ACCOUNTANT: all, HR: own, SENIOR/JUNIOR: own)
POST   /api/teams                       → create (ADMIN, HR)
PATCH  /api/teams/:id                   → edit (ADMIN, HR-owner)
DELETE /api/teams/:id                   → delete (ADMIN only)
GET    /api/teams/:id                   → team details (all authenticated roles)
GET    /api/users                       → users for select
POST   /api/teams/:id/members           → add a participant
DELETE /api/teams/:id/members/:userId   → remove a participant
```
