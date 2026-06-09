# task-fix-pr33-user-testing-round3

## Агент: coder

## Приоритет: high

## Зависит от: commit ee0d034 (PR 33 CI green)

## Ветка: feature/users-page-refactor (та же — push в PR 33)

## Fixes: User Testing round 3 — 4 правки

## Контекст

После round 2 (ee0d034) юзер re-тестирует /crm/users. Round 3 фидбэк (4 пункта):

- **ut-15** Платёжные реквизиты switcher — сейчас «голый» radio с двумя borderом'ы карточками, сделать **красиво**
- **ut-16** Сборка команды для SENIOR (HR multiselect + accountant) — сделать **красиво**
- **ut-17** Добавить **необязательное** поле «Telegram-канал команды»
- **ut-18** Убрать сортировку из заголовков таблицы → перенести в фильтр-бар (рядом с поиском и role-filter)

User confirmed: telegram channel хранить в **teams.telegramChannel** (правильная нормализация).

## Spec / files reference

- `apps/web/app/components/users/UserDialog.tsx` — все UI правки секций
- `apps/web/app/components/users/share-slider.tsx` — пример shadcn полированной микро-секции
- `apps/web/app/routes/crm/users/index.tsx` — filter bar + sort logic (см. строки 102–165: `searchQuery`, `roleFilter`, `sortKey`, `sortDir`, `toggleSort`)
- `apps/web/app/components/users/UserRow.tsx` — column headers (если они там; иначе в `index.tsx` table head)
- `apps/api/src/database/schema.ts` — `teams` table
- `packages/shared/src/schemas/teams.ts` — teamSchema
- `apps/api/src/teams/teams.service.ts` — update method
- `apps/api/src/users/users.service.ts` — `adminUpdateUser` для propagation в teams
- Backend RBAC соблюсти: только ADMIN может менять teamTelegramChannel SENIOR'а (existing checks ut-10/11 уже это покрывают)

## Конкретные изменения

### ut-15: Pretty payment method switcher

**Сейчас:** две bordered карточки с радио + label (см. скриншот юзера — выглядит «голо»).

**Сделать:** **Segmented toggle control** (как iOS/macOS Segmented Control):

- Один rounded контейнер `rounded-lg border border-border bg-muted/40 p-1`
- Две кнопки внутри: `flex-1`, при active — `bg-background shadow-sm`, при inactive — transparent
- Каждая кнопка содержит **иконку слева + текст**:
  - USDT ERC-20: иконка `<Wallet>` или `<Coins>` (lucide-react)
  - Bank UAH (ФОП): иконка `<Building>` или `<Landmark>` (lucide-react)
- Текущая выбранная кнопка имеет: фон background, shadow-sm, font-medium
- Hover на inactive: `bg-muted/60`
- Transition: `transition-all duration-150`
- `role="radiogroup"` на контейнере, `role="radio"` + `aria-checked` на кнопках
- Сохрани все валидации/regexes как есть — меняем только presentation

Опционально (если останется время): после выбора варианта внутрь section появляется иконка + краткий описательный текст под switcher'ом:

- USDT: «Будет использоваться адрес кошелька в сети Ethereum»
- Bank: «Будет использоваться украинский банковский счёт ФОП»

### ut-16: Pretty team members в SENIOR Команда секции

**Сейчас:** HR multiselect checkbox list + Accountant auto-set (выглядит как plain checkbox list).

**Сделать:** **Chips/badges** UX:

**HR-блок:**

- Заголовок: «HR» с количеством `(2 выбрано)`
- Список выбранных HR — chips (одинаковые badge'ы):
  - Аватар (24px) + имя + крестик `<X>` для удаления
  - `flex items-center gap-2 rounded-full bg-secondary px-3 py-1 text-sm`
  - При hover на чипе подсветить крестик
- Если ни один не выбран: muted placeholder «Никто не выбран»
- Внизу «+ Добавить HR» кнопка как ghost button:
  - Открывает Popover с searchable command list (shadcn Command)
  - Список оставшихся HR (которые ещё не выбраны)
  - Поиск по имени/email
  - Клик — добавляет в chips, popover закрывается
- Если HR в системе только 1 — авто-выбран, чип неудаляемый (no `<X>`), tooltip «Единственный HR»

**Accountant-блок:**

- Заголовок: «Бухгалтер»
- Если accountant авто-выбран (один в системе) — chip без X, с tooltip «Единственный бухгалтер в системе»
- Если есть выбор — dropdown как обычный Select, но стилизованный как кнопка-чип в неактивном состоянии

**Сохрани:**

- Все валидации (минимум 1 HR, ровно 1 accountant)
- Все form data flow — только presentation меняется
- Submit поведение

### ut-17: Telegram channel поле команды

#### Backend

1. **Migration** `apps/api/drizzle/migrations/0012_team_telegram_channel.sql`:
   ```sql
   ALTER TABLE teams ADD COLUMN telegram_channel TEXT;
   ```
2. **Schema** `apps/api/src/database/schema.ts`:
   ```ts
   telegramChannel: text('telegram_channel'),
   ```
3. **Shared schema** `packages/shared/src/schemas/teams.ts`:
   - Add `telegramChannel: z.string().regex(/^@?[a-zA-Z0-9_]{5,32}$/).nullable().optional()` к teamSchema, createTeamSchema, updateTeamSchema
4. **TeamsService** `apps/api/src/teams/teams.service.ts`:
   - `update()` — передавать telegramChannel в db.update
5. **Users → Teams propagation**:
   - В `packages/shared/src/schemas/users.ts` добавь `teamTelegramChannel: z.string()...optional()` к adminUpdateUserSchema
   - В `apps/api/src/users/users.service.ts` `adminUpdateUser`:
     - Если `target.role === 'SENIOR'` и `dto.teamTelegramChannel !== undefined` — найди team SENIOR'а (existing logic `getOrCreateTeamForSenior`), внутри той же transaction вызови `tx.update(teams).set({ telegramChannel: dto.teamTelegramChannel }).where(eq(teams.id, teamId))`
     - Сделай в той же tx что и user update — atomicity
     - Audit log: `team_audit_log.record({ action: 'team_updated', changes: { telegramChannel: { from, to } } }, tx)` — внутри tx
   - Если попытка установить teamTelegramChannel для не-SENIOR → 400 BadRequest «Telegram channel can only be set for SENIOR users»

#### Frontend

`UserDialog.tsx` Команда секция (только для SENIOR/JUNIOR с командой — но JUNIOR не имеет своей команды; покажи поле **только для SENIOR Edit/Create**):

- Field name: `teamTelegramChannel`
- Label: «Telegram-канал команды»
- Optional indicator (нет красной звёздочки)
- Input prefix icon `<Send>` (lucide-react) или текстовый префикс `t.me/`
- Placeholder: `@team_channel`
- Helper text: «Опционально. Канал для общения команды.»
- Validation на blur (используй ut-8 dirty-gate):
  - Если пусто/null — OK
  - Если есть значение — regex `^@?[a-zA-Z0-9_]{5,32}$`
  - Error: «Некорректный канал (5–32 латинских символов или \_, опц. @)»

`/crm/team` (если кто-то отображает SENIOR'а на /crm/team team detail) — отображай telegram channel как ссылку `https://t.me/<channel_minus_at>` с иконкой `<ExternalLink>`. **Опционально** — если есть время, не блокирующее AC.

### ut-18: Move sort from column headers to filter bar

**В `apps/web/app/routes/crm/users/index.tsx`:**

1. **Убрать** click handlers + sort triangles с column headers «Пользователь», «Роль», «Добавлен». Заголовки остаются текстом только.
2. **Добавить** в filter bar (где сейчас search + roleFilter) **рядом справа** новый блок:
   - **Сортировка** — shadcn `<Select>` с вариантами:
     - «По имени» (displayName)
     - «По роли» (role)
     - «По дате добавления» (createdAt)
     - (исключи 'email' если он сейчас sortable — он редко используется)
   - **Направление** — toggle button (ghost variant, square) с иконками `<ArrowUp>` / `<ArrowDown>`:
     - Toggle переключает `sortDir` между asc/desc
     - aria-label: «Направление сортировки: <По возрастанию|По убыванию>»
3. **Default** sort: `displayName` asc (как сейчас).
4. **Layout** на filter bar:
   ```
   [🔍 Search input] [Роль ▾] | [Сортировка ▾] [↑/↓]
   ```
   Используй `gap-2`. Sort блок отдели вертикальной чёрточкой `<div className="h-6 w-px bg-border" />` или `border-l pl-3`.
5. **Mobile**: на узких экранах — sort dropdown может перейти на новую строку (uses existing responsive pattern в filter bar).

## Verification

- `pnpm --filter @crm/shared typecheck` clean
- `pnpm --filter @crm/api typecheck && pnpm --filter @crm/api test` — все green
- `pnpm --filter @crm/web typecheck && pnpm --filter @crm/web test` — все green
- `pnpm --filter @crm/api db:migrate` — migration applies cleanly
- Visual check через Playwright (опц): screenshot localhost:3000/crm/users показывает новые элементы

## Acceptance criteria

- [ ] ut-15: payment switcher переделан в segmented toggle (rounded container, icons, active highlight)
- [ ] ut-16: HR/Accountant — chips with avatars + searchable add popover
- [ ] ut-17 BE: `teams.telegramChannel` column + schema + service + admin propagation in tx + RBAC reject non-SENIOR
- [ ] ut-17 FE: telegramChannel field in UserDialog Команда секция для SENIOR
- [ ] ut-18: sort handles убраны из column headers, sort dropdown + direction toggle в filter bar
- [ ] Все existing tests зелёные (unit, web)
- [ ] CI зелёный после push (Typecheck + E2E)
- [ ] Reviewer не открывает новых критичных findings

## Запреты

- Не меняй API contracts existing endpoints (URLs, response shapes)
- Не откатывай round 2 / round 1 правки
- Не открывай новый PR — push в существующую ветку `feature/users-page-refactor`
- Не трогай RBAC — defenive checks от ut-10/11/12 должны остаться

## Commit

```
feat(users): UI polish round 3 + teams.telegramChannel

ut-15: payment method as segmented toggle (rounded container with
       active highlight, icons for USDT/Bank, smooth transition)
ut-16: HR/Accountant rendering as chips with avatars + searchable
       Popover for adding HR; single-HR/single-Accountant locked
       with tooltip
ut-17: new optional teams.telegramChannel column (migration 0012);
       teamSchema/createTeamSchema/updateTeamSchema extended;
       UsersService.adminUpdateUser propagates teamTelegramChannel
       to teams within the same tx + audit log; non-SENIOR rejected
       with 400; UserDialog Команда section shows the field for
       SENIOR with @ prefix + regex validation
ut-18: sort relocated from column headers to filter bar (Select
       for sort key + direction toggle); column headers are plain
       text now

ac_verified: 1,2,3,4,5,6
addresses: User Testing PR 33 round 3
```

## После завершения

Push в `feature/users-page-refactor`. CI пройдёт автоматом. Отчёт PM-у:

- Изменённые файлы
- Migration команда (`pnpm --filter @crm/api db:migrate`) применилась
- Все 4 AC закрыты
- CI зелёный
