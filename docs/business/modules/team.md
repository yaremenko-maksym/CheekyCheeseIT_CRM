# Модуль: Команды (Teams)

## Статус: ✅ Реализован (PHASE 2)

## Бизнес-логика

### Структура команды

- HR(ы) + SENIOR(ы) + ACCOUNTANT (общий) + JUNIOR (производное состояние)
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
teams: id, name, createdAt
team_members: id, teamId, userId, joinedAt
-- Хранит только: HR, SENIOR, ACCOUNTANT. НЕ JUNIOR.
-- "Своя команда" HR = команда где он есть в team_members
```

### JUNIOR RBAC — фильтрация состава

- `GET /api/teams/:id` — если `viewer.role === 'JUNIOR'`: сервер убирает из `members[]` всех остальных JUNIOR-ов перед ответом
- Все остальные роли получают полный список участников

### SENIOR/JUNIOR — авто-редирект

- `GET /api/teams` для SENIOR/JUNIOR возвращает одну команду → frontend делает redirect на `/crm/team/:id`
- ADMIN, HR, ACCOUNTANT остаются на странице списка

## UI

- **Список команд** (`/crm/team`): карточки с аватарами первых 4 участников + "+N", количество активных проектов, hover-эффект → клик открывает `/crm/team/:id`
- **Детальная страница** (`/crm/team/:id`): название + дата создания, список участников с аватаром/именем/ролью, кнопки управления (только ADMIN и HR-owner)

## Endpoints

```
GET    /api/teams                       → список (ADMIN/ACCOUNTANT: все, HR: свои, SENIOR/JUNIOR: свои)
POST   /api/teams                       → создать (ADMIN, HR)
PATCH  /api/teams/:id                   → редактировать (ADMIN, HR-owner)
DELETE /api/teams/:id                   → удалить (ADMIN only)
GET    /api/teams/:id                   → детали команды (все аутентифицированные роли)
GET    /api/users                       → пользователи для select
POST   /api/teams/:id/members           → добавить участника
DELETE /api/teams/:id/members/:userId   → удалить участника
```
