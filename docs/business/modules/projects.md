# Module: Projects

## Status: ✅ Implemented (PHASE 3)

## Business logic

### What a project is

A CHEEKY CHEESE IT contract with a client company. Contains: company, domain, SENIOR, JUNIOR(s), rate, currency, status (ACTIVE/CLOSED).

**Critical rule:** at most 1 active JUNIOR per project — a hard constraint, enforced on the backend AND in the UI.

### Lifecycle

```
ADMIN/HR create a project (status ACTIVE) → add a JUNIOR
→ SENIOR works → transactions → financial flow
→ The project is closed: status CLOSED + endDate (soft close)
```

### RBAC — visibility

| Role              | Sees                                                      |
| ----------------- | --------------------------------------------------------- |
| ADMIN, ACCOUNTANT | All projects                                              |
| SENIOR            | Their own projects (seniorId = user.id)                   |
| HR                | Projects of the seniors from their teams                  |
| JUNIOR            | Projects where they are an active member (leftAt IS NULL) |

## DB tables

```sql
projects: id, name, companyName, domain, startDate, endDate, seniorId,
          rate, currency(USDT/USD/EUR), status(ACTIVE/CLOSED), logoUrl, notes, createdAt
project_members: id, projectId, userId, role, joinedAt, leftAt
```

## Endpoints

```
GET    /api/projects                         → list (RBAC filtered)
POST   /api/projects                         → create (ADMIN, HR)
PATCH  /api/projects/:id                     → edit (ADMIN, HR)
DELETE /api/projects/:id                     → delete (ADMIN only)
POST   /api/projects/:id/members             → add a JUNIOR
DELETE /api/projects/:id/members/:userId     → remove a JUNIOR (leftAt = now)
```
