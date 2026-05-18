# Teams UI Redesign — Design Spec

**Date:** 2026-05-18  
**Status:** Approved

---

## Scope

Редизайн двох сторінок: список команд (`/crm/team`) і сторінка команди (`/crm/team/$teamId`).  
Також: нова міграція БД для полів `telegram` і `notes` на таблиці `teams`.

---

## 1. DB Migration

Новий файл: `apps/api/drizzle/migrations/0002_team_telegram_notes.sql`

```sql
ALTER TABLE "teams" ADD COLUMN "telegram" varchar(500);
ALTER TABLE "teams" ADD COLUMN "notes" text;
```

Оновити `apps/api/src/database/schema.ts` — додати поля `telegram` і `notes` до таблиці `teams`.  
Оновити `packages/shared/src/schemas/teams.ts` — додати опціональні поля у `teamSchema` та `updateTeamSchema`.  
Оновити `apps/api/src/teams/teams.service.ts` — прийняти `telegram` і `notes` у `update()`.

---

## 2. Список команд (`/crm/team/index.tsx`)

### Що прибрати
- Підзаголовок сторінки (`<p>Состав и роли сотрудников</p>`)
- Кнопки `UserPlus` (добавити учасника) і `Trash2` (видалити команду) з карточок

### Тулбар (новий)
Над списком: пошук по назві + фільтр (Всі / Senior / HR / Junior) + сортировка (Ім'я ↑/↓ / Учасники / Проекти).

### Вид списку
Замість сітки карточок — вертикальний список рядків. Кожен рядок фіксована висота `56px`:

```
[аватарки -space-x] | [Назва команди / HR: Ім'я, Ім'я…] | [N уч.] [N проекти] [✏]
```

- Аватарки: перші 4 з `-space-x-2`, потім `+N`
- HR-підзаголовок: `text-ellipsis overflow-hidden whitespace-nowrap` → ніколи не впливає на висоту
- Пілюля проектів: зелена якщо > 0, сіра якщо 0
- Кнопка ✏ (rename): тільки для `canManage` (ADMIN або HR-власник команди)
- Анімація: staggered motion як зараз

### RBAC на список
- ADMIN: бачить всі команди, кнопка ✏
- HR: бачить свої команди, кнопка ✏
- SENIOR / JUNIOR / ACCOUNTANT: view-only, без ✏

---

## 3. Сторінка команди (`/crm/team/$teamId.tsx`)

### Що прибрати
- Весь сайдбар "Статистика" (member counts by role)
- Картка "Активність" (active projects count у сайдбарі)
- Кнопка `UserPlus` "Добавить участника" що була без onClick

### Нова структура сторінки (single column)

**Header:**
```
[← Назад] [Назва команди]    [👤+ Додати]  [✏ Редагувати]   ← тільки canManage
```

**Секція "Учасники"** — існуючий список по ролях (SENIOR → HR → ACCOUNTANT → JUNIOR)

**Секція "Активні проекти"** з лічильником-badge:
```
Активні проекти  [2]
─────────────────────
[logo] Назва проекту    Active  →  /crm/projects/:id
[logo] Назва проекту    Active
```

Логотип: `project.logoUrl` якщо є, інакше emoji-placeholder 🏢.  
Кожен рядок — клікабельний Link до `/crm/projects/:id`.

---

## 4. RBAC на сторінці команди

| Роль | Учасники | Проекти | Кнопки |
|------|----------|---------|--------|
| ADMIN | Всі | Всі активні команди | ✏ Редагувати + 👤+ Додати |
| HR | Всі | Всі активні команди | ✏ Редагувати + 👤+ Додати |
| SENIOR | Всі (включно з усіма джунами) | Всі активні команди | — |
| JUNIOR | Тільки Senior + HR + Accountant (інші джуни приховані) | Тільки **свій** проект | — |
| ACCOUNTANT | Всі | Всі активні команди | — |

---

## 5. Діалог «Редагувати команду»

Поля:
- **Назва** (required) — `Input`
- **Telegram** (optional) — `Input`, placeholder `https://t.me/...`, hint "Посилання на чат команди"
- **Нотатки** (optional) — `Textarea`, placeholder "Внутрішні нотатки…"

Дії: Зберегти → `PATCH /api/teams/:id` з `{ name, telegram, notes }`.

---

## 6. Діалог «Додати учасника»

**Без рядка пошуку.**

Список відсортований за алфавітом (`displayName`), розділений на дві групи:

**Доступні (checkbox):**
- HR, ACCOUNTANT — якщо не в команді
- JUNIOR — якщо не в команді І немає активного проекту (`project_members.leftAt IS NULL`)

**Недоступні (сірі, без checkbox, з поясненням праворуч):**
- ADMIN → "адмін"
- Вже в команді → "в команді"
- SENIOR (якщо в команді вже є SENIOR) → "вже є синьор"
- JUNIOR з активним проектом → "має проект"

Кнопка "Додати вибраних (N)" — активна якщо є хоча б один вибраний.

---

## 7. Файли що змінюються

| Файл | Зміни |
|------|-------|
| `apps/api/drizzle/migrations/0002_team_telegram_notes.sql` | NEW — нова міграція |
| `apps/api/src/database/schema.ts` | `+telegram`, `+notes` на таблиці teams |
| `packages/shared/src/schemas/teams.ts` | `+telegram?`, `+notes?` у teamSchema / updateTeamSchema |
| `apps/api/src/teams/teams.service.ts` | `update()` приймає telegram, notes |
| `apps/web/app/routes/crm/team/index.tsx` | Повний редизайн списку + тулбар |
| `apps/web/app/routes/crm/team/$teamId.tsx` | Новий layout + діалоги + RBAC |

---

## 8. Out of scope

- Видалення команди (лишається тільки через список — наразі кнопка прибрана, логіка не видаляється з backend)
- Notifications при додаванні учасника
- Пагінація списку команд
