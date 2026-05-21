# task-fix-profile-round3

## Агент: coder
## Приоритет: high
## Ветка: claude/youthful-hermann-8df1d5 (PR #28)

## КРИТИЧЕСКИ ВАЖНО

- **Fix-задача в существующую ветку:**
  ```bash
  git fetch origin
  git checkout claude/youthful-hermann-8df1d5
  git pull origin claude/youthful-hermann-8df1d5
  ```
- Push в эту же ветку → PR #28 обновится автоматически.
- Каждая независимая правка — отдельный commit (как минимум 6).

## Все 9 правок User Testing раунда 3

---

### #1 — Способы оплаты как табы с анимированным layout фоном

В `apps/web/app/components/user-profile/self-edit/RequisitesEditForm.tsx` сейчас segmented control (`role="radio"` две кнопки). Юзер хочет такой же стиль как у профильных табов — **AnimatedTabs с жёлтым pill**.

**Что сделать:**
- Заменить весь segmented div на `<AnimatedTabs tabs={[{value:'USDT_ERC20', label:'USDT ERC-20'}, {value:'BANK_UAH_FOP', label:'UAH ФОП'}]} value={method} onChange={...} />`
- Иконки и описания убрать (или переместить в каждую Card-карточку как было)
- Для SENIOR/ADMIN: один из tab'ов нужно "залочить". Поскольку AnimatedTabs не поддерживает disabled — либо
  - (A) не показывать UAH FOP tab совсем для SENIOR/ADMIN
  - (B) расширить AnimatedTabs API `tabs[].disabled?: boolean` и в UI рендерить кнопку disabled с lock иконкой
- Я предпочту **подход (B)** — расширить AnimatedTabs. Тогда tooltip "SENIOR и ADMIN получают только в USDT ERC-20" остаётся через Radix Tooltip wrapper.

**Commit:** `feat(profile): requisites method switch uses AnimatedTabs with yellow pill`

---

### #2 — Доля как Slider + Input компонент

В `ChangeSalaryDialog.tsx` сейчас для SENIOR показывается обычный `<Input>` для % доли (см. скриншот: "Доля от транзакций (%)" → number input "26"). Юзер говорит что **уже есть компонент с ползунком + инпутом (0-100)** — нужно найти и использовать.

**Что сделать:**
1. Найди существующий "ползунок + инпут 0-100" — поиск через ast-grep:
   ```
   ast-grep find_code "Slider" в apps/web/app
   ```
   Кандидаты по проекту: `apps/web/app/components/ui/slider.tsx` (shadcn slider), или `PercentInput`/`ShareInput` — что-то в `apps/web/app/components/ui/`.
2. Если найдён готовый компонент типа `<SliderInput value={n} onChange={...} min={0} max={100} />` — используй его в `ChangeSalaryDialog.tsx` для `seniorSharePercent`.
3. Если такого компонента нет — создай `apps/web/app/components/ui/slider-number-input.tsx`:
   ```tsx
   <div className="space-y-3">
     <div className="flex items-center gap-3">
       <Slider value={[value]} onValueChange={([v]) => onChange(v)} min={0} max={100} step={1} className="flex-1" />
       <Input type="number" value={value} onChange={(e) => onChange(Math.min(100, Math.max(0, +e.target.value || 0)))} min={0} max={100} className="w-20 text-center" />
       <span className="text-sm text-muted-foreground">%</span>
     </div>
   </div>
   ```
4. В `ChangeSalaryDialog.tsx` заменить плоский Input на этот компонент.

**Commit:** `feat(admin): change-salary share input uses Slider + number combo`

---

### #3 — Унифицировать Role picker (цветной)

См. скриншоты: на странице создания/редактирования юзера используется **красивый цветной select** где роли — это цветные Badge (Админ жёлтый, Синьор синий, Джун зелёный, HR фиолетовый, Бухгалтер коричневый). В `ChangeRoleDialog.tsx` сейчас обычный shadcn `<Select>` с белым текстом (см. третий скриншот).

**Что сделать:**
1. Найди реализацию цветного picker через ast-grep — он используется в `apps/web/app/routes/crm/users/` или `apps/web/app/routes/crm/team/`. Скорее всего custom Select с Badge внутри SelectItem.
2. Извлеки в reusable `apps/web/app/components/ui/role-select.tsx` если ещё не extracted (или импортируй существующий).
3. Используй в `ChangeRoleDialog.tsx` вместо обычного Select.
4. Опция "Администратор" должна быть **скрыта** из этого Picker (по бизнес-правилу ADMIN'а нельзя через UI сделать).

**Commit:** `refactor(admin): ChangeRoleDialog uses shared colored RoleSelect`

---

### #4 — Опция "Изменить зарплату" → "Изменить долю %" для SENIOR/ADMIN

В `AdminActionsMenu.tsx` сейчас одна опция "Изменить зарплату" с DollarSign иконкой. Для SENIOR/ADMIN бизнес-логика — это процент доли, не зарплата. Юзер хочет name + иконку контекстными.

**Что сделать:**
- В `AdminActionsMenu.tsx`:
  - Если target role = SENIOR or ADMIN → label "Изменить долю %", icon `Percent`
  - Иначе (JUNIOR/HR/ACCOUNTANT) → label "Изменить зарплату", icon `DollarSign`
- Передавать `user.role` в AdminActionsMenu (если еще не передаётся) — props `user`.
- В `ChangeSalaryDialog`: title тоже динамический — "Изменить долю" или "Изменить зарплату".

**Commit:** `feat(admin): contextual label "Изменить долю %" vs "Изменить зарплату" by role`

---

### #5 — Убрать "Управление командой" и "Переназначить проект"

В `AdminActionsMenu.tsx` две disabled опции с "СКОРО" badge (см. четвёртый скриншот). Юзер просит **полностью убрать** их пока нет реализации.

**Что сделать:**
- Удалить два menu item'а из `AdminActionsMenu.tsx` (manage-team, reassign-project).
- В `permissions.actions` matrix (`apps/api/src/users/users-access.service.ts`) — удалить эти action keys из ADMIN ветки:
  ```
  actions.push('edit-profile', 'change-role', 'change-salary', 'change-requisites', 'set-note', 'archive')
  // удалить 'manage-team', 'reassign-project'
  ```
- Также удалить endpoints `manageTeam` и `reassignProject` из `users.controller.ts` (они и так стали 501 NotImplementedException — можно полностью удалить).
- В `actionKeySchema` (`packages/shared/src/schemas/view-permissions.ts`) удалить keys 'manage-team', 'reassign-project'.
- Удалить components `ManageTeamDialog.tsx` и `ReassignProjectDialog.tsx` если их импорт нигде больше нет.
- Обновить unit-тесты которые проверяют `expect(p.actions).toEqual(expect.arrayContaining([... 'manage-team', 'reassign-project']))` — убрать эти ключи.

**Commit:** `chore(admin): remove unimplemented manage-team and reassign-project actions`

---

### #6 — Перенести дизайн транзакций со страницы Финансы

В профиле есть таб **Финансы** (`FinanceTab.tsx`) — простая таблица. На странице `/crm/finance` есть полноценный список с фильтрами и модалкой деталей по клику.

**Что сделать:**
1. Найди компонент списка транзакций на странице `/crm/finance` (через ast-grep `TransactionsList` / `TransactionRow` / `TransactionDetailDialog` в apps/web/app/routes/crm/finance/).
2. Если он already reusable — импортируй в `FinanceTab.tsx` и передай `seniorId={userId}` фильтр.
3. Если он tightly coupled к routes — извлеки в reusable `apps/web/app/components/finance/TransactionsList.tsx` и `TransactionDetailDialog.tsx`, потом используй в обоих местах.
4. По клику на строку — открывается модалка с деталями (полная карточка транзакции).
5. Фильтры (период, проект, статус) — оставить если они есть на /finance, или базовые.
6. Для роли вьюера передавать через permissions: ADMIN/ACCOUNTANT видит все детали, SENIOR/JUNIOR — свои только.

**Commit:** `feat(profile): finance tab reuses /finance transactions list with detail modal`

---

### #7 — Убрать таб "Собеседования" из профиля

Сейчас для ADMIN viewing SENIOR показывается tab "Собеседования" (в `users-access.service.ts` matrix).

**Что сделать:**
- В `users-access.service.ts` убрать `tabs.push('interviews')` из ADMIN ветки (line `if (targetIsSenior) tabs.push('interviews')`).
- В `UserProfileShell.tsx` убрать import + рендер `InterviewsTab` (можно файл оставить, но не использовать).
- В matrix tests обновить expectations — после убирания interviews ADMIN viewing SENIOR будет иметь 7 tabs (вместо 8).
- В `packages/shared/src/schemas/view-permissions.ts` ключ `'interviews'` в `tabKeySchema` оставить (на случай если где-то ещё используется), либо тоже убрать если нигде.

**Commit:** `chore(profile): remove interviews tab from profile — link in header replaces it`

---

### #8 — Кнопка "Собеседования" в шапку для ADMIN viewing SENIOR

Сейчас `showInterviewsLink` срабатывает только для **self-SENIOR**. Юзер хочет такую же кнопку для **ADMIN viewing SENIOR** (с прямой ссылкой на канбан-доску того синьора).

**Что сделать:**
- В `UserProfileShell.tsx`:
  ```tsx
  const showInterviewsLink =
    (mode === 'self' && user.role === 'SENIOR') ||
    (mode === 'view' && user.role === 'SENIOR')
  ```
  Условие можно упростить до `user.role === 'SENIOR'` если кнопка нужна **всегда** когда target = SENIOR.
- Это связано с #7 — убираем tab, добавляем link.
- В `UserProfileHeader.tsx` — `showInterviewsLink` уже работает, ничего менять не надо.

**Commit:** оба #7 и #8 могут быть в одном commit: `feat(profile): replace interviews tab with header link for SENIOR profiles`

---

### #9 — Отображение admin note

**Юзер вопрос:** "Где отображаются заметки админа? Кроме истории изменения профиля"

Сейчас `setAdminNote` записывает в БД (поле `users.adminNote`), но в UI оно нигде не показывается за пределами audit log.

**Что сделать:**
- На странице профиля (`OverviewTab.tsx` или новая отдельная карточка), показать админскую заметку **только для viewer = ADMIN**.
- Карточка `<Card>` с заголовком "Заметка администратора" + текст. Если пусто — placeholder "Заметки нет" и кнопка "Добавить" (которая открывает SetNoteDialog).
- Размещение: в `OverviewTab.tsx` после "Технологии" карточки, до "Личные данные" — только для ADMIN viewer.
- Permission: `permissions.actions.includes('set-note')` или `viewer.role === 'ADMIN'` (передавать через props/data).
- `data.overview` сейчас имеет `adminNote: viewer.role === 'ADMIN' ? target.adminNote : null` (в `users.service.ts.buildProfileView`) — то есть текст уже приходит. Просто отрендерить.

```tsx
{viewer.role === 'ADMIN' && data.overview?.adminNote !== undefined && (
  <Card>
    <CardHeader>
      <CardTitle className="flex items-center justify-between text-base">
        <span className="flex items-center gap-2">
          <StickyNote className="h-4 w-4" />
          Заметка администратора
        </span>
        <Button variant="ghost" size="sm" onClick={openSetNoteDialog}>
          <Pencil className="h-4 w-4" />
        </Button>
      </CardTitle>
    </CardHeader>
    <CardContent>
      {data.overview.adminNote ? (
        <p className="text-sm whitespace-pre-wrap">{data.overview.adminNote}</p>
      ) : (
        <p className="text-sm text-muted-foreground italic">Заметок нет</p>
      )}
    </CardContent>
  </Card>
)}
```

**Commit:** `feat(profile): show admin note card on profile for ADMIN viewers`

---

## ОБЩЕЕ ACCEPTANCE

- `pnpm exec turbo typecheck lint --force` clean
- `cd apps/api && pnpm test` — 0 failed (обновлены unit tests где надо)
- API:3001 + Web:3000 — 200
- Push в `claude/youthful-hermann-8df1d5`
- 6-9 коммитов (по одному на каждую правку, можно сгруппировать #7+#8)

## После

Короткий summary (≤300 слов): список SHA коммитов с маппингом на правки #1-#9, какие unit-тесты обновлены, какие компоненты переиспользованы (Slider/RoleSelect/TransactionsList).

Используй MCP:
- ast-grep для поиска reusable компонентов (Slider, цветной RoleSelect, Transactions list)
- context7 для Radix Slider / shadcn docs
- eslint MCP pre-check
- playwright MCP для visual verification после большого батча
