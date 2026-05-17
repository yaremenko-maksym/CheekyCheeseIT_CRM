# Модуль: Собеседования Kanban (Interviews)

## Статус: ✅ Реализован (PHASE 4)

## Бизнес-логика

HR ведёт переговоры с рекрутерами **от имени SENIOR**. Каждый SENIOR — персональная канбан-доска.

### Доступ к доскам

- **ADMIN/HR**: видят доски всех/своих SENIOR, переключают через `?seniorId=uuid`
- **SENIOR**: видит только свою доску

### Стейджи

```
HR_SCREEN → ENGLISH_CHECK → TECH_INTERVIEW → FINAL_INTERVIEW → CLIENT_INTERVIEW → OFFER_RECEIVED
                                                                                         ↓
                                                                             HIRED | REJECTED | ARCHIVED
```

Терминальные стейджи — архив, не удаление.

### Перемещение карточек

1. Drag-and-drop через dnd-kit (`closestCenter` — обязательно для cross-column drag)
2. Кнопки "← / →" в диалоге редактирования

`position` ренормализуется при каждом move в обоих стейджах.

### Данные карточки

- HR вводит: компания, ссылка на вакансию, ссылка на звонок
- SENIOR вносит заметки: домен, технологии, техника, команда, бенефиты, пересмотр ЗП, тип оплаты, заметки

## Таблицы БД

```sql
interviews: id, seniorId, hrId, companyName, vacancyUrl, callUrl,
            stage, position, notes(json), corporateTech(json), createdAt, updatedAt
```

stage enum: `HR_SCREEN | ENGLISH_CHECK | TECH_INTERVIEW | FINAL_INTERVIEW | CLIENT_INTERVIEW | OFFER_RECEIVED | HIRED | REJECTED | ARCHIVED`

## Endpoints

```
GET    /api/interviews?seniorId=<uuid>   → доска (RBAC filtered)
POST   /api/interviews                   → создать (HR, ADMIN)
PATCH  /api/interviews/:id               → обновить данные
PATCH  /api/interviews/:id/move          → переместить { stage, position }
DELETE /api/interviews/:id               → удалить (ADMIN only)
```

## Frontend особенности

- `validateSearch` в TanStack Router для `?seniorId=`
- Каждый `KanbanColumn` — `useDroppable({ id: stage })`
- Архивная секция (ARCHIVED/REJECTED/HIRED) — отдельный блок внизу страницы
