# task-drop-phase1-frontend

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase1 (та же что у backend — продолжение)

## Зависит от: task-drop-phase1-backend (push'нут в эту ветку, миграция применена)

## Источник истины: [`docs/specs/drop-role-and-finance-spec.md`](../drop-role-and-finance-spec.md)

## Контекст

**Фаза 1, frontend.** Backend (схема, миграции, новые сервисы UsersService.createDrop / archiveDrop, TeamsService.createDropTeam / archiveDropTeam / rotateSenior / addSeniorToDropTeam, ProjectsService visibility, teamless gates, расширенный createUser с `teamMode`) уже в ветке `feat/drop-role-phase1`. Твоя задача — UI на русском, **сохраняя текущий senior-флоу 1:1**.

Один PR на Фазу 1 — после твоего push'а PM позовёт AutoTest для E2E.

## Подготовка

1. Прочитай спек: [`docs/specs/drop-role-and-finance-spec.md`](../drop-role-and-finance-spec.md).
2. `git checkout feat/drop-role-phase1 && git pull` — backend уже там.
3. Через context7 MCP: освежи API TanStack Router (`validateSearch`, `navigate({ search })`), Zod v4 (`z.discriminatedUnion` для `teamMode`), shadcn `RadioGroup`/`Select`/`AlertDialog`.
4. Через playwright MCP открой текущий `/crm/team`, `/crm/team/:id`, форму создания синьора и сделай baseline-скриншоты (положи в `/tmp/baseline-*.png`) — будут эталоном «как было».

## Acceptance Criteria

### AC1. Sidebar — роль DROP

- [ ] Где живёт sidebar nav config (см. backend AC8) — добавить DROP-пункты: Профіль, Команда, Фінанси. БЕЗ Собеседований, Проектов, Документов, Дашборда.
- [ ] Существующие role-видимости для ADMIN/SENIOR/JUNIOR/HR/ACCOUNTANT — **без изменений**.
- [ ] Когда DROP открывает `/crm/dashboard` — redirect на `/crm/profile` (или 404-плэйсхолдер если уж так проще).

### AC2. Форма «Создать дропа» — зеркало синьора

- [ ] Найди где сейчас открывается «Создать синьора» (обычно с `/crm/team` или `/crm/users`).
- [ ] В том же месте добавить **рядом** кнопку «Создать дропа» (видна только ADMIN). НЕ меняй кнопку «Создать синьора».
- [ ] Новый компонент `apps/web/app/components/users/create-drop-dialog.tsx` (зеркало `create-senior-dialog.tsx` — если такого имени нет, ищи существующую форму создания юзера-синьора и копируй её структуру):
  - Поля: имя/email/telegram/phone (как у синьора).
  - Реквизиты: USDT ERC-20 + Bank UAH ФОП + preferredMethod (используй существующие поля профиля).
  - **Новое поле:** «Доля дропа, %» — number input, default 5, range 0-100, hint «Доля дропа от каждой выплаты». Поле обязательно.
  - Секция «Команда дропа» — те же поля, что в форме команды синьора:
    - HR(ы) — мульти-селект (мин 1, обязательно).
    - Бухгалтер — селект (обязательно).
    - Телеграм-канал — текст (если в команде синьора такое поле есть; иначе пропустить).
  - На submit: POST `/api/users/drop` (или какой endpoint backend сделал — уточни через `gh pr view` description backend-таска).
- [ ] После успеха → toast «Дроп создан», invalidate queries, закрыть диалог, навигация на `/crm/team/<новой команды>`.

### AC3. Форма «Создать синьора» — 2 опции

- [ ] В существующей форме создания синьора **добавить ОДНО новое поле** перед submit: `RadioGroup` «Команда»:
  - Опция 1 (default, selected): **«Создать свою команду»** — далее идут существующие поля HR/бухгалтер/telegram (current behavior).
  - Опция 2: **«Добавить в существующую команду дропа»** — выпадающий список drop-команд без активного синьора (GET endpoint бэка, например `/api/teams?type=DROP&hasActiveSenior=false`). Поля HR/бухгалтер/telegram **скрываются**.
- [ ] Submit:
  - Опция 1 → текущий запрос без изменений (`teamMode: 'CREATE_NEW'` или вообще без поля — backend дефолтит).
  - Опция 2 → добавить в body `teamMode: 'JOIN_DROP_TEAM'`, `dropTeamId: <selected>`.
- [ ] **Регрессия:** существующее поведение «Создать синьора» с дефолтной опцией работает 1:1 как раньше.

### AC4. Со страницы «Команды» убрать кнопку «Создать команду»

- [ ] `/crm/team/index.tsx` — найти кнопку «Создать команду» (или аналог) и **удалить её**. Сами команды (карточки) показываются как раньше, фильтры/поиск — без изменений.
- [ ] В списке команд показывать значок типа: маленький badge «DROP» возле имени, если `team.type === 'DROP'` (например, рядом с именем дропа). Для senior-команд badge не нужен (типовой).

### AC5. Страница `/crm/team/:id` — поддержка drop-команды

- [ ] Если `team.type === 'DROP'`:
  - Шапка показывает: «Команда дропа» + имя дропа (link на профиль).
  - Состав: дроп (отдельная секция) + HR(ы) + бухгалтер + активный синьор (если есть).
  - JUNIORы НЕ показываются (этой ветки нет в backend `mapDropTeam`).
  - Кнопка **«Сменить синьора»** (ADMIN или HR этой команды): открывает диалог со селектом синьоров без активной команды → POST `/api/teams/:id/rotate-senior { newSeniorId }`. После успеха toast «Синьор обновлён».
  - Если активного синьора нет — placeholder «Синьора нет» + та же кнопка «Назначить синьора».
- [ ] Если `team.type === 'SENIOR'` — рендеринг **без изменений**.

### AC6. Профиль дропа

- [ ] `/crm/profile` для DROP — те же блоки, что у синьора, но:
  - Поле «Доля, %» (read-only для самого дропа; редактирует ADMIN). Сейчас в API нет endpoint'а на update share — пока read-only для всех, кроме ADMIN, через тот же `PATCH /api/users/:id` если поле там разрешено. Если не успеваешь — пропусти edit, оставь read-only.
  - Реквизиты: USDT ERC-20 + Bank UAH (как у синьора, доступны оба).
  - Раздел «Команда» — линк на его drop-team.
  - **Нет** разделов «Проекты» (личного списка), «Собеседования», «Документы».

### AC7. Edge: синьор без команды

- [ ] Если синьор без активной команды (бэкэнд возвращает пустые проекты/403 на собеседованиях):
  - Sidebar скрывает «Проекти» и «Співбесіди» (frontend gate: `useAuth()` + `useActiveTeam()` хук — если нет team, скрыть).
  - В шапке профиля — значок/чип **«Без команды»**.
  - Блок-баннер в профиле: «У вас нет активной команды. Создайте свою или присоединитесь к команде дропа» + кнопка → открывает диалог с **той же RadioGroup**, что в AC3 (опция 1: создать свою команду; опция 2: добавить в drop-team). Submit → POST `/api/users/me/rejoin-team`.
  - На роутах `/crm/projects`, `/crm/interviews` — empty state «Нет активной команды» + та же кнопка.

### AC8. RBAC — Финансы для DROP

- [ ] `/crm/finance` — пункт доступен дропу: видит **только свои** транзакции (`seniorId = ?` ⇒ бэкэнд для DROP должен возвращать его собственные транзакции; уточни в backend описании).
- [ ] Кнопка «Добавить приход» — доступна (как у синьора). Форма та же, валюта/проект/чек.
- [ ] Распределение/доли — **не отображается в этой фазе** (Фаза 2). Дроп видит свои транзакции как «приходы».

### AC9. Тексты на русском

- [ ] Все новые тексты — русский. Никакого украинского, английского.
- [ ] Существующие тексты не трогать (если случайно затронул — откатить).

### AC10. Локальная проверка перед push

```bash
pnpm typecheck
pnpm lint
pnpm --filter @crm/web build  # SSR-проверка
pnpm test
pnpm --filter @crm/e2e test
```

- [ ] Прогон playwright по золотому флоу: открыть `/crm/team`, создать дропа (диалог), увидеть карточку drop-team, открыть карточку, увидеть состав. Открыть форму создания синьора, увидеть RadioGroup, попереключать опции. Скриншоты → `/tmp/drop-phase1-fe-*.png`.
- [ ] Сравнить с baseline (AC0 шаг 4) — никаких регрессий по senior-флоу.

### AC11. Open PR

- [ ] Только после успешных AC10 → open PR (если ещё не открыт от backend этапа) или закомментить в существующем PR-описании «frontend ready, screenshots: /tmp/drop-phase1-fe-\*.png».
- [ ] PR description: ссылка на спек, список AC из обоих task'ов, скриншоты ключевых экранов (через `gh pr comment` с image upload — или хотя бы текстовый чеклист «что проверено»).

## Что НЕ нужно

- Drop-проект distribution UI (Фаза 2).
- Ручное подтверждение выплаты UI (Фаза 3).
- Создание drop-проекта из UI — поле `dropId` в форме создания проекта НЕ добавляется (Фаза 2).
- Любые правки бэкенда — это уже сделано в backend task'е.

## Memory & progress

- Поддерживай `docs/specs/tasks/task-drop-phase1-frontend.progress.md` с milestone-маркерами.
- После работы обнови `docs/agents/memory/coder/lessons.md` если что-то найдено non-obvious.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
