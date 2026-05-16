# Модуль: Команды (Teams)

## Статус: ✅ Реализован (PHASE 2)

## Бизнес-логика

### Структура команды

- 1 HR (владелец) + 1-N SENIOR + ACCOUNTANT (общий) + JUNIOR (производное состояние)
- JUNIOR в команде — **производное**: берётся из `project_members` WHERE `leftAt IS NULL` AND `project.seniorId` = синьор команды
- JUNIOR не хранится в `team_members` напрямую
- ADMIN исключён из всех команд (управляет, но не является членом)
- Максимум 10 команд на всю компанию

### Защита от удаления

- Нельзя удалить: SENIOR (нужно удалять команду целиком), последнего HR, последнего ACCOUNTANT

### RBAC

| Действие | ADMIN | HR | SENIOR | JUNIOR | ACCOUNTANT |
|----------|-------|----|--------|--------|------------|
| Создать команду | ✅ | ✅ | ❌ | ❌ | ❌ |
| Редактировать | ✅ | ✅ (свою) | ❌ | ❌ | ❌ |
| Удалить | ✅ | ❌ | ❌ | ❌ | ❌ |
| Добавить/удалить члена | ✅ | ✅ (свою) | ❌ | ❌ | ❌ |
| Просмотр | ✅ (все) | ✅ (свои) | ✅ (свои) | ✅ (свои) | ✅ (все) |

## Таблицы БД

```sql
teams: id, name, hrId, createdAt
team_members: id, teamId, userId, joinedAt
-- Хранит только: HR, SENIOR, ACCOUNTANT. НЕ JUNIOR.
```

## Endpoints

```
GET    /api/teams                       → список (ADMIN: все, HR: свои)
POST   /api/teams                       → создать (ADMIN, HR)
PATCH  /api/teams/:id                   → редактировать (ADMIN, HR-owner)
DELETE /api/teams/:id                   → удалить (ADMIN only)
GET    /api/users                       → пользователи для select
POST   /api/teams/:id/members           → добавить участника
DELETE /api/teams/:id/members/:userId   → удалить участника
```
