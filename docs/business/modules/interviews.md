# Module: Interviews Kanban (Interviews)

## Status: ✅ Implemented (PHASE 4)

## Business logic

HR negotiates with recruiters **on behalf of a SENIOR**. Each SENIOR has a personal kanban board.

### Board access

- **ADMIN/HR**: see the boards of all/their SENIORs, switch via `?seniorId=uuid`
- **SENIOR**: sees only their own board

### Stages

```
HR_SCREEN → ENGLISH_CHECK → TECH_INTERVIEW → FINAL_INTERVIEW → CLIENT_INTERVIEW → OFFER_RECEIVED
                                                                                         ↓
                                                                             HIRED | REJECTED | ARCHIVED
```

Terminal stages are an archive, not deletion.

### Moving cards

1. Drag-and-drop via dnd-kit (`closestCenter` — mandatory for cross-column drag)
2. The "← / →" buttons in the edit dialog

`position` is renormalized on every move in both stages.

### Card data

- HR enters: company, vacancy link, call link
- SENIOR adds notes: domain, technologies, technique, team, benefits, salary revision, payment type, notes

## DB tables

```sql
interviews: id, seniorId, hrId, companyName, vacancyUrl, callUrl,
            stage, position, notes(json), corporateTech(json), createdAt, updatedAt
```

stage enum: `HR_SCREEN | ENGLISH_CHECK | TECH_INTERVIEW | FINAL_INTERVIEW | CLIENT_INTERVIEW | OFFER_RECEIVED | HIRED | REJECTED | ARCHIVED`

## Endpoints

```
GET    /api/interviews?seniorId=<uuid>   → board (RBAC filtered)
POST   /api/interviews                   → create (HR, ADMIN)
PATCH  /api/interviews/:id               → update data
PATCH  /api/interviews/:id/move          → move { stage, position }
DELETE /api/interviews/:id               → delete (ADMIN only)
```

## Frontend specifics

- `validateSearch` in TanStack Router for `?seniorId=`
- Each `KanbanColumn` is `useDroppable({ id: stage })`
- The archive section (ARCHIVED/REJECTED/HIRED) is a separate block at the bottom of the page
