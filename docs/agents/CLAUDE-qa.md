# QA — Agent Notes

## Приложение в CI (уже запущено)

- Web: `http://localhost:3000`
- API: `http://localhost:3001/api`
- Health: `http://localhost:3001/api/health`
- DB: PostgreSQL (seed применён)

## Seed пользователи

Логин через Google OAuth невозможен в CI — используй прямые API запросы или Playwright для проверки UI-состояний.
Тестовые пользователи из `apps/api/src/database/seed.ts`:

| Email | Роль |
|-------|------|
| admin@cheekyit.com | ADMIN |
| senior1@cheekyit.com | SENIOR |
| senior2@cheekyit.com | SENIOR |
| junior1@cheekyit.com | JUNIOR |
| hr@cheekyit.com | HR |
| accountant@cheekyit.com | ACCOUNTANT |

## RBAC матрица (что тестировать)

| Модуль | ADMIN | SENIOR | JUNIOR | HR | ACCOUNTANT |
|--------|-------|--------|--------|----|------------|
| Команды — создать/редактировать | ✓ | — | — | ✓(своих) | — |
| Проекты — создать | ✓ | — | — | ✓ | — |
| Interviews — видеть | ✓(все) | ✓(своя) | — | ✓(своих) | — |
| Finance — транзакции | ✓(все) | ✓(свои) | — | — | ✓(все,validate) |
| Профиль — редактировать | ✓ | ✓(свой) | ✓(свой) | ✓(свой) | ✓(свой) |

## Активные модули для тестирования

1. **Auth** — `/login` → Google кнопка, redirect
2. **Teams** `/crm/team` — список, создание, состав
3. **Projects** `/crm/projects` — карточки, фильтры, детальная страница
4. **Interviews** `/crm/interviews` — Kanban DnD, `?seniorId=` параметр
5. **Finance** `/crm/finance` — транзакции, инвойсы, выплаты
6. **Profile** `/crm/profile`, `/crm/users/:id`

## Playwright MCP — ключевые инструменты

- `browser_navigate` — перейти на URL
- `browser_snapshot` — получить DOM дерево (используй вместо screenshot для проверок)
- `browser_click` — клик по элементу
- `browser_fill_form` — заполнить форму
- `browser_wait_for` — дождаться элемента/состояния
- `browser_network_requests` — проверить API вызовы

## Postgres MCP — проверка данных

Используй для верификации что данные действительно сохранились:
```sql
SELECT * FROM transactions WHERE senior_id = '...' LIMIT 10;
SELECT * FROM team_members WHERE team_id = '...';
```
