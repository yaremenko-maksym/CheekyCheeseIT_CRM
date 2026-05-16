# Модуль: Проекты (Projects)

## Статус: ✅ Реализован (PHASE 3)

## Бизнес-логика

### Что такое проект

Контракт CHEEKY CHEESE IT с компанией-клиентом. Содержит: компанию, домен, SENIOR, JUNIOR(ов), ставку, валюту, статус (ACTIVE/CLOSED).

**Критичное правило:** максимум 1 активный JUNIOR на проект — hard constraint, enforced на backend И в UI.

### Жизненный цикл

```
ADMIN/HR создают проект (статус ACTIVE) → добавляют JUNIOR
→ SENIOR работает → транзакции → финансовый поток
→ Проект закрывается: статус CLOSED + endDate (soft close)
```

### RBAC — видимость

| Роль | Видит |
|------|-------|
| ADMIN, ACCOUNTANT | Все проекты |
| SENIOR | Свои проекты (seniorId = user.id) |
| HR | Проекты синьоров из своих команд |
| JUNIOR | Проекты где активный member (leftAt IS NULL) |

## Таблицы БД

```sql
projects: id, name, companyName, domain, startDate, endDate, seniorId,
          rate, currency(USDT/USD/EUR), status(ACTIVE/CLOSED), logoUrl, notes, createdAt
project_members: id, projectId, userId, role, joinedAt, leftAt
```

## Endpoints

```
GET    /api/projects                         → список (RBAC filtered)
POST   /api/projects                         → создать (ADMIN, HR)
PATCH  /api/projects/:id                     → редактировать (ADMIN, HR)
DELETE /api/projects/:id                     → удалить (ADMIN only)
POST   /api/projects/:id/members             → добавить JUNIOR
DELETE /api/projects/:id/members/:userId     → убрать JUNIOR (leftAt = now)
```
