# Team Page Refactor — Design

## Overview

Полный рефактор страниц команды: список (index.tsx) и детальная ($teamId.tsx).

**Цели:**
- Починить нерабочие кнопки на detail-странице (Add/Remove member)
- Добавить поле `telegramGroupUrl` на команду (JUNIOR не видит)
- Скрыть дату создания команды от JUNIOR
- Перенести управление участниками с list-карточек на detail-страницу
- Вынести диалоги и константы в отдельные компоненты

---

## Файловая структура

### Новые файлы
```
apps/web/app/routes/crm/team/components/
  TeamCard.tsx            ← карточка списка (только просмотр + delete для ADMIN)
  MemberRow.tsx           ← строка участника на detail-странице
  CreateSeniorDialog.tsx  ← HR создаёт синьора (перенесено из index.tsx)
  AddMemberDialog.tsx     ← добавить участника в команду (починено)
  EditTeamDialog.tsx      ← редактировать команду: имя + telegramGroupUrl
  DeleteTeamDialog.tsx    ← удалить команду (перенесено из index.tsx)

apps/web/app/lib/
  team-constants.ts       ← ROLE_LABELS, ROLE_VARIANT, getInitials (дедупликация)
```

### Изменённые файлы
```
apps/web/app/routes/crm/team/index.tsx     ← тонкий: grid + CreateSenior + DeleteTeam
apps/web/app/routes/crm/team/$teamId.tsx   ← тонкий: layout + монтирование диалогов
packages/shared/src/schemas/teams.ts       ← telegramGroupUrl в схемах
apps/api/src/teams/teams.service.ts        ← telegramGroupUrl в CRUD
apps/api/src/teams/teams.controller.ts     ← GET /teams/:id открыт всем ролям (уже есть)
apps/api/drizzle/migrations/0012_*.sql    ← ALTER TABLE teams ADD COLUMN
```

---

## DB — миграция 0012

```sql
ALTER TABLE teams ADD COLUMN telegram_group_url TEXT;
```

Опциональное поле, без NOT NULL, без дефолта.

---

## Backend

### Shared schemas (`packages/shared/src/schemas/teams.ts`)

```ts
// createTeamSchema и updateTeamSchema:
telegramGroupUrl: z.string().url().optional().nullable()

// TeamDto:
telegramGroupUrl: string | null
```

### teams.service.ts

- `createTeam`: сохранять `telegramGroupUrl` если передан
- `updateTeam`: обновлять `telegramGroupUrl`
- `findAll` / `findOne`: включать `telegramGroupUrl` в ответ

### Endpoints — без изменений

`GET /api/teams/:id` уже открыт всем аутентифицированным ролям (реализовано в PR #11).

---

## Frontend — Список команд (index.tsx)

**Что остаётся:**
- Заголовок "Команда" + кнопка HR "Создать синьора"
- Grid из `<TeamCard>` компонентов
- Авто-редирект SENIOR/JUNIOR → `/crm/team/:id`
- Монтирование `<CreateSeniorDialog>` и `<DeleteTeamDialog>`

**Что уходит:**
- Inline кнопки Edit/AddMember на карточках (переезжают на detail)
- `EditTeamDialog` из index.tsx
- `AddMemberDialog` из index.tsx
- Дублирующиеся константы

### TeamCard.tsx

```
┌─────────────────────────────────────┐
│  Команда Alpha                 [🗑]  │  ← [🗑] только ADMIN
│  HR: Мария Иванова                   │
├─────────────────────────────────────┤
│  ●●●●+2          3 участника         │
│  Активные проекты: 2                 │
└─────────────────────────────────────┘
```

- Вся карточка — кликабельный Link → `/crm/team/:id`
- Кнопка Delete ADMIN: `e.preventDefault()` + `e.stopPropagation()`, z-index выше Link
- Нет кнопок Edit/AddMember

---

## Frontend — Детальная страница ($teamId.tsx)

### Layout

```
┌──────────────────────────────────────────────────────┐
│  ← Назад    Команда Alpha          [✏ Редактировать] │  ← ADMIN/HR
│             Создана 12 мая 2025  · 🔗 Telegram        │  ← скрыто от JUNIOR
│                                    [🗑 Удалить]       │  ← только ADMIN
├──────────────────────────────────────────────────────┤
│  Участники (3)                     [+ Добавить]       │  ← ADMIN/HR
│                                                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │ ● Иван Иванов   [Синьор]          → профиль    │ │
│  │   ivan@email.com · TypeScript BE               │ │
│  └─────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────┐ │
│  │ ● Мария HR      [HR]              → профиль [✕]│ │  ← [✕] ADMIN/HR
│  │   maria@email.com                              │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  Активные проекты: 2                                 │
└──────────────────────────────────────────────────────┘
```

### Поведение

- **Список участников**: плоский, без заголовков по ролям. Порядок: SENIOR → HR → ACCOUNTANT → JUNIOR.
- **Badge роли**: на каждой карточке участника (badge variant по роли).
- **Дата создания**: скрыта если `user.role === 'JUNIOR'`.
- **Telegram ссылка**: скрыта если `user.role === 'JUNIOR'`. Если `team.telegramGroupUrl` не задан — не показываем ничего. Если задан — иконка + ссылка `target="_blank"`.
- **Кнопка "Редактировать"**: открывает `EditTeamDialog` с полями Название + Telegram URL.
- **Кнопка "Удалить"**: только ADMIN, открывает `DeleteTeamDialog`.
- **Кнопка "+ Добавить"**: ADMIN + HR-owner, открывает `AddMemberDialog`.
- **Кнопка [✕] на участнике**: ADMIN + HR-owner. НЕ рендерится если:
  - `member.role === 'SENIOR'` (нельзя удалить — нужно удалять команду)
  - `member.role === 'JUNIOR'` (производное состояние)
  - Последний HR в команде
  - Последний ACCOUNTANT в команде

### MemberRow.tsx

Props: `member`, `canManage`, `canRemove`, `onRemove`

---

## RBAC — сводная таблица

| Действие | ADMIN | HR (owner) | SENIOR | JUNIOR | ACCOUNTANT |
|----------|-------|------------|--------|--------|------------|
| Видеть список | ✅ все | ✅ свои | → redirect | → redirect | ✅ все |
| Видеть detail | ✅ | ✅ | ✅ свою | ✅ свою (без др. джунов) | ✅ |
| Видеть дату | ✅ | ✅ | ✅ | ❌ | ✅ |
| Видеть Telegram | ✅ | ✅ | ✅ | ❌ | ✅ |
| Создать синьора | ❌ | ✅ | ❌ | ❌ | ❌ |
| Редактировать команду | ✅ | ✅ | ❌ | ❌ | ❌ |
| Удалить команду | ✅ | ❌ | ❌ | ❌ | ❌ |
| Добавить участника | ✅ | ✅ | ❌ | ❌ | ❌ |
| Удалить участника | ✅ | ✅ (с правилами) | ❌ | ❌ | ❌ |
| Delete на list-карточке | ✅ | ❌ | — | — | ❌ |

---

## Acceptance Criteria

- [ ] `pnpm typecheck` и `pnpm lint` проходят
- [ ] SENIOR/JUNIOR при открытии `/crm/team` → редирект на `/crm/team/:id`
- [ ] JUNIOR на detail-странице не видит других JUNIOR (server-side)
- [ ] JUNIOR не видит дату создания и Telegram-ссылку
- [ ] Кнопка "+ Добавить участника" на detail-странице открывает диалог и добавляет
- [ ] Кнопка [✕] на участнике открывает подтверждение и удаляет
- [ ] "Редактировать" открывает диалог с полями Название + Telegram URL
- [ ] PATCH /api/teams/:id сохраняет `telegramGroupUrl`
- [ ] Telegram-ссылка отображается на detail-странице (если задана), открывается в новой вкладке
- [ ] Карточки на list-странице кликабельны, нет inline-кнопок Edit/AddMember
- [ ] ADMIN видит кнопку Delete на list-карточке
- [ ] Дублирование ROLE_LABELS/ROLE_VARIANT/getInitials устранено (один файл `team-constants.ts`)
- [ ] Диалоги в отдельных компонентах, index.tsx < 250 строк, $teamId.tsx < 200 строк

---

## Не входит в скоуп

- Изменение бэкенд RBAC (уже реализовано)
- Загрузка фото/файлов для команды
- История изменений участников
