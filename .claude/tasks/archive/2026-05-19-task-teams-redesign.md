# task-teams-redesign

## Агент: coder

## Приоритет: high

## Ветка: feature/teams-redesign

## Контекст

Редизайн двох сторінок команд у CRM-системі CheekyCheeseIT. Детальний дизайн-спек:
`docs/superpowers/specs/2026-05-18-teams-redesign.md`

Детальний план реалізації з повним кодом для кожного кроку:
`docs/superpowers/plans/2026-05-18-teams-redesign.md`

**Що вже зроблено (Task 1, в main і в цій гілці):**

- Міграція `apps/api/drizzle/migrations/0006_team_telegram_notes.sql` застосована до БД
- `apps/api/src/database/schema.ts` — таблиця `teams` має поля `telegram` і `notes`
- `packages/shared/src/schemas/teams.ts` — `teamSchema` і `updateTeamSchema` мають `telegram?` і `notes?`

**Що треба зробити (Tasks 2, 3, 4):**

### Task 2 — Backend (teams.service.ts + teams.controller.ts)

**Файли для зміни:**

- `apps/api/src/teams/teams.service.ts`
- `apps/api/src/teams/teams.controller.ts`

**Зміни:**

1. У `mapTeam()` — додати `telegram: team.telegram ?? null` і `notes: team.notes ?? null` до об'єкта, що повертається (зараз повертає тільки id, name, createdAt, updatedAt, members)

2. У методі `update(id, name, currentUser)` — змінити сигнатуру на `update(id, name, telegram, notes, currentUser)` і додати до `.set({ name, updatedAt })` також `telegram` і `notes` (якщо вони не `undefined`)

3. У методі `addMember()` після перевірки `if (user.role === 'ADMIN')` — додати дві нові перевірки:
   - Якщо `user.role === 'SENIOR'` і команда вже має SENIOR → `throw new BadRequestException('Team already has a senior')`
   - Якщо `user.role === 'JUNIOR'` → перевірити через `fetchAllProjects()` чи є у джуна активний проект (`p.members.some(m => m.userId === userId && m.leftAt === null)`) → якщо є, `throw new BadRequestException('Junior already has an active project')`

4. У контролері метод `update` — змінити `const { name } = updateTeamSchema.parse(body)` на `const { name, telegram, notes } = updateTeamSchema.parse(body)` і передати `telegram, notes` у `teamsService.update()`

Усі деталі із точним кодом дивись у плані: **Task 2** у `docs/superpowers/plans/2026-05-18-teams-redesign.md`.

### Task 3 — Frontend: список команд (apps/web/app/routes/crm/team/index.tsx)

Повний редизайн: grid-сітка → вертикальний список рядків по 56px (h-14).

Основні зміни:

- Прибрати підзаголовок сторінки
- Додати useState для `search`, `filterRole`, `sortBy` + `useMemo` для `filteredTeams`
- Замінити `<motion.div className="grid ...">` на `<motion.div className="flex flex-col gap-1.5">`
- Додати тулбар: Input (пошук) + Select (фільтр ролі: all/SENIOR/HR/JUNIOR/ACCOUNTANT) + Select (сортування: name/members/projects)
- Кожен рядок: аватарки (-space-x-2) | назва/HR-підзаголовок | badge учасників | badge проектів (зелений якщо >0) | кнопка ✏ тільки для canManage
- Видалити кнопки UserPlus і Trash2 з рядків
- Весь рядок клікабельний → navigate до `/crm/team/$teamId`
- Кнопка ✏ → `e.stopPropagation()` + відкрити editTeam dialog

Усі деталі із точним кодом дивись у плані: **Task 3** у `docs/superpowers/plans/2026-05-18-teams-redesign.md`.

Важливо: `canManage` — у цьому файлі означає ADMIN АБО (HR і є HR цієї команди). Логіка вже є в існуючому коді, треба зберегти.

### Task 4 — Frontend: сторінка команди (apps/web/app/routes/crm/team/$teamId.tsx)

Single-column layout, нові діалоги, RBAC.

Основні зміни:

- Прибрати `lg:grid-cols-3` grid — все в `<div className="space-y-6">`
- Прибрати sidebar блок (Статистика + Активність)
- Кнопка "Редагувати" → діалог з полями name + telegram + notes; PATCH /api/teams/:id
- Кнопка "Додати" (UserPlus) → підключити до діалогу вибору учасників
- Додати секцію "Активні проекти" з badge-лічильником — список проектів де `senior == team's senior` і `status === 'ACTIVE'`; кожен рядок — Link до `/crm/projects/$projectId`
- JUNIOR-вид: filterувати `visibleMembersByRole` (без інших джунів), `visibleProjects` (тільки свій проект)
- Діалог addMember: без поля пошуку, список за алфавітом, disabled-рядки з поясненням, checkbox-вибір, кнопка "Додати (N)"

Фільтрація для addMember dialog:

```typescript
const candidateUsers = (allUsers ?? [])
  .filter((u) => u.role !== 'ADMIN')
  .map((u) => {
    if (memberUserIds.has(u.id)) return { ...u, disabledReason: 'в команді' }
    if (u.role === 'SENIOR' && teamHasSenior) return { ...u, disabledReason: 'вже є синьор' }
    if (u.role === 'JUNIOR' && juniorIdsWithProjects.has(u.id))
      return { ...u, disabledReason: 'має проект' }
    return u
  })
  .sort((a, b) => {
    const aD = !!a.disabledReason,
      bD = !!b.disabledReason
    if (aD !== bD) return aD ? 1 : -1
    return a.displayName.localeCompare(b.displayName)
  })
```

Усі деталі із точним кодом дивись у плані: **Task 4** у `docs/superpowers/plans/2026-05-18-teams-redesign.md`.

## Acceptance criteria

- [ ] `GET /api/teams` і `GET /api/teams/:id` повертають `telegram` і `notes`
- [ ] `PATCH /api/teams/:id` зберігає `telegram` і `notes` у БД
- [ ] Спроба додати другого SENIOR → 400 Bad Request
- [ ] Спроба додати JUNIOR з активним проектом → 400 Bad Request
- [ ] Список команд: рядковий layout, висота 56px, не змінюється при 3+ HR у підзаголовку
- [ ] Тулбар: пошук фільтрує по назві, фільтр ролей звужує список, сортування працює
- [ ] Тільки ✏ кнопка для canManage, без UserPlus і Trash2 на карточках
- [ ] Сторінка команди: single-column, без sidebar статистики
- [ ] Секція "Активні проекти" з лічильником, кожен рядок клікабельний
- [ ] Кнопка "Редагувати" відкриває діалог name/telegram/notes, PATCH зберігає
- [ ] Кнопка "Додати" відкриває діалог з відсортованим/filtered списком
- [ ] JUNIOR не бачить інших джунів і бачить тільки свій проект
- [ ] TypeCheck API і Web: 0 errors
- [ ] Всі unit-тести проходять

## Запрещено трогать

- `apps/api/drizzle/migrations/` — міграція вже застосована, не чіпати
- `apps/api/src/database/schema.ts` — вже містить telegram і notes, не чіпати
- `packages/shared/src/schemas/teams.ts` — вже оновлено, не чіпати
- `apps/e2e/` — тестами займається AutoTest агент
- `.github/workflows/` — DevOps агент
