# task-drop-phase2-frontend

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase2 (та же)

## Зависит от: task-drop-phase2-backend (push'нут в эту ветку)

## Контекст

UI для Phase 2 — финансы drop-проекта. Backend (computeDropDistribution, PAYOUT_DROP / DROP_INCOME типы, новый endpoint createDropIncome) уже в ветке.

## Acceptance Criteria

### AC1. Форма создания проекта — поле `dropId`

- [ ] В форме создания/редактирования проекта (вероятно `apps/web/app/routes/crm/projects/index.tsx` или `apps/web/app/components/projects/...`):
  - Добавить опциональный Select «Дроп (опционально)» под Select синьора.
  - Список — все active DROP users (GET /api/users?role=DROP&active=true).
  - Если DROP'ов нет — поле скрыть.
  - Default: «— не выбран —» (значит обычный senior-проект).
- [ ] Submit:
  - Если выбран dropId → POST с body `{ ..., dropId }`. Backend сохранит в `projects.drop_id`.
  - Если не выбран → текущий запрос без поля dropId (regression — senior-projects работают как раньше).
- [ ] **Регрессия**: создание senior-проекта без dropId работает 1:1 (поле dropId optional на бэке).

### AC2. Project detail page — индикатор drop-проекта

- [ ] На `/crm/projects/:id` если `project.dropId != null`:
  - Бейдж «Drop-проект» рядом с заголовком (badge variant blue/info как у DROP в team).
  - В блоке участников секция «Дроп» с link на профиль drop user.
- [ ] Если senior-проект (без dropId) — отображение без изменений.

### AC3. Distribution breakdown — UI для drop-проекта

- [ ] На `/crm/projects/:id` в финансовой секции (или новой) для drop-проектов показать формулу распределения:
  ```
  Распределение прихода (пример $1000):
    Доля синьора (26%):       $260
    Доля дропа (5%):          $50
    Партнёрам (50/50):        $345 / $345
  ```
- [ ] Значения процентов брать из `senior.seniorSharePercent` и `drop.dropSharePercent` (через `useQuery` на ProjectDetails endpoint, если возвращает расширенно — иначе через отдельный fetch users).
- [ ] **РБАК**: видимо только ADMIN / ACCOUNTANT / SENIOR / DROP (этого проекта). JUNIOR / HR — без финансовой секции (текущая логика).

### AC4. DROP profile — Финансы tab

- [ ] На `/crm/profile` для роли DROP:
  - Кнопка «Добавить приход» — открывает форму регистрации drop income (`POST /api/transactions/drop-income`).
  - Форма: Select проекта (только drop-проекты где caller — drop), amount, currency, receipt upload.
  - После submit → toast «Приход зарегистрирован, ожидает валидации».
- [ ] Список транзакций DROP user (текущая страница /crm/finance после Phase 1 fix визуально пустая) — добавить отображение его DROP_INCOME / PAYOUT_DROP записей.

### AC5. Project finance — показ DROP balance / payouts

- [ ] На странице финансов (`/crm/finance`) для ADMIN — добавить колонку/badge показывающий drop-проекты отдельно (фильтр или badge).
- [ ] Balance partner панель — добавить блок «Баланс дропов» если есть валидные drop incomes.

### AC6. Регрессия — senior-проекты UI

- [ ] Все существующие финансовые экраны для senior-проектов работают 1:1.
- [ ] Создание senior income — без изменений.
- [ ] Партнёрский баланс 50/50 — без изменений.
- [ ] Никакие drop-специфические элементы не показываются для senior-only видов.

### AC7. Локально

```bash
pnpm typecheck
pnpm lint
pnpm --filter @crm/web build
pnpm --filter @crm/e2e test
```

Все зелёные.

### AC8. Playwright проверка (через MCP)

Скриншоты в `/tmp/drop-phase2-fe-*.png`:

- [ ] ADMIN → создание проекта → выбрать дроп из Select → submit → проект имеет `dropId` (через postgres MCP подтвердить).
- [ ] ADMIN → открыть detail drop-проекта → badge «Drop-проект» виден, distribution breakdown показывает 26%/5%/50/50.
- [ ] DROP → /crm/profile → Финансы tab → есть кнопка «Добавить приход».
- [ ] Регрессия: senior-проект detail page — без drop UI.

### AC9. Push

- [ ] git push origin feat/drop-role-phase2
- [ ] gh pr comment 65 (или какой PR номер) с summary + скриншоты.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
