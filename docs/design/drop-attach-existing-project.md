# Design Spec: Привязка / снятие дропа на вкладке «Состав» страницы проекта

> **Mode:** E — Reconciliation / conformance (текстовая спека, без Claude Design-раунда)
> **Design-gate:** degraded (headless, text-only conformance) — Chrome MCP / Claude Design недоступен в изолированном агентном окружении.
> **Tier:** 2 (правка существующего экрана — вкладка «Состав» страницы проекта)
> **Slug:** `drop-attach-existing-project`
> **Автор:** ui-ux-designer · 2026-07-12
> **Зависит от:** `docs/design/foundation.md` · `docs/design/drop-role-ux.md`
> **Реализует задачу:** `.claude/tasks/task-drop-attach-design.md`

---

## 1. Brief (контекст)

На проде нельзя привязать дропа к **существующему** проекту. Привязка дропа при создании
работает (форма `projects/index.tsx` строки ~688–719), но после создания — нет.

Бэкенд уже поддерживает `PATCH /projects/:id { dropId: string | null }`. UI-gap:
вкладка «Состав» (`ProjectEffectiveTeamCard`) показывает дропа read-only, без действий.
Кнопка «Добавить участника» на вкладке «Обзор» использует `POST /projects/:id/members`
и не подходит для дропа (400 «Only JUNIORs, HRs, and ACCOUNTANTs can be added as project
members»).

**Решение:** расширить вкладку «Состав» двумя возможностями:

1. **Привязать дропа** когда `project.dropId === null` — кнопка + пикер-диалог.
2. **Снять дропа** когда `project.dropId !== null` — иконка-кнопка на строке дропа + confirm-диалог.

Эти действия находятся на вкладке «Состав», управляются отдельной мутацией
(`PATCH /projects/:id`), и не пересекаются с механикой добавления обычных участников.

---

## 2. Что НЕ меняется (conformance-проверка)

- `ProjectEffectiveTeamCard` — структура плоского списка, бейджи ролей, навигация по профилям.
- Фильтр `availableToAdd` на вкладке «Обзор» — кандидаты для обычных участников.
- `MemberRow` — компонент строки обычного участника.
- Диалог «Добавить участника» на вкладке «Обзор» — не трогать.
- RBAC для existing action'ов (`canManage`, `canRemoveMembers`).
- Стиль синего бейджа «Дроп» / «Drop-проект» в хедере проекта.

---

## 3. Token map

Все токены из `apps/web/app/styles/globals.css` (`@theme inline {}`). **Новых токенов не вводится.**

| Назначение                                | Tailwind class                                                                                  | Причина                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Фон карточки                              | `bg-card`                                                                                       | `ProjectEffectiveTeamCard` — уже `bg-card`       |
| Граница карточки                          | `border-border/40`                                                                              | соответствует existing `border-border/40`        |
| Основной текст                            | `text-foreground`                                                                               | имя дропа в строке                               |
| Вторичный текст / иконки                  | `text-muted-foreground`                                                                         | иконка кнопки «снять» в neutral-состоянии        |
| Hover деструктивной иконки                | `hover:text-destructive`                                                                        | паттерн `MemberRow` строка ~1599                 |
| Кнопка-иконка ghost                       | `variant="ghost" size="icon"`                                                                   | паттерн `MemberRow` кнопка удаления              |
| Размер кнопки-иконки (строка)             | `h-5 w-5`                                                                                       | соответствует `MemberRow` строка ~1599           |
| Иконка внутри кнопки-иконки               | `h-3 w-3`                                                                                       | соответствует `MemberRow` строка ~1600           |
| Кнопка «Привязать дропа» (header card)    | `h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground` + `variant="ghost" size="sm"` | паттерн «Добавить» карточки Команда строка ~1020 |
| Строка кандидата в пикере                 | `flex items-center gap-2.5 rounded-md px-3 py-2`                                                | паттерн Add Member Dialog строка ~1263           |
| Avatar кандидата в пикере                 | `h-7 w-7 shrink-0`                                                                              | паттерн Add Member Dialog строка ~1264           |
| Кнопка «Назначить» в пикере               | `size="sm" h-7 text-xs px-2.5 shrink-0 variant="default"`                                       | паттерн кнопки «Добавить» в пикере строка ~1280  |
| Состояние «Назначен» в пикере             | `variant="outline" text-emerald-500 border-emerald-500/40`                                      | паттерн isAdded строка ~1284–1285                |
| Confirm-диалог                            | `CrmDialogContent maxWidth="sm:max-w-sm"`                                                       | паттерн Remove Member Dialog строка ~1208        |
| Бейдж дропа в строке эффективного состава | `variant="outline" border-blue-500/30 bg-blue-500/10 text-blue-400 shrink-0 text-[9px]`         | existing строки 1764–1768                        |
| Радиус кнопок внутри card                 | `rounded-md`                                                                                    | concentric radius (Foundation §3)                |

---

## 4. Компоненты (существующие shadcn/ui)

Все компоненты — из уже используемых в файле. **Новых компонентов не создаётся.**

| Компонент                                               | Использование                                                    | Источник в коде                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `Button` `variant="ghost" size="icon"`                  | Иконка-кнопка «снять дропа» в строке `ProjectEffectiveTeamCard`  | `MemberRow` ~1596–1604                                          |
| `Button` `variant="ghost" size="sm"`                    | Кнопка «Привязать дропа» в заголовке `ProjectEffectiveTeamCard`  | Кнопка «Добавить» в Team card ~1017–1029                        |
| `Tooltip` + `TooltipTrigger` + `TooltipContent`         | Подсказка когда `project.archivedAt` или нет кандидатов          | Team card ~1014–1035                                            |
| `Dialog`                                                | Диалог пикера дропов + confirm снятия (два отдельных `<Dialog>`) | `addMemberOpen` Dialog ~1241, `removeMemberTarget` Dialog ~1207 |
| `CrmDialogContent`                                      | Обёртка диалогов (фикс header/body/footer, scrollable body)      | строка ~1168, ~1208, ~1247                                      |
| `CrmDialogHeader` / `CrmDialogBody` / `CrmDialogFooter` | Структура диалогов                                               | существующие диалоги                                            |
| `DialogTitle` / `DialogDescription`                     | Заголовок и a11y-описание диалога                                | существующие диалоги                                            |
| `Avatar` + `AvatarFallback` + `AvatarImage`             | Аватар дропа в пикере                                            | Add Member Dialog ~1264–1268                                    |
| `Badge`                                                 | Бейдж роли «Дроп» в пикере (синий info-стиль) + в строке состава | строки 1763–1769 (состав), 1274–1279 (пикер)                    |
| `UserPlus` (lucide)                                     | Иконка в кнопке «Привязать дропа»                                | Team card ~1027                                                 |
| `UserMinus` (lucide)                                    | Иконка в кнопке снятия дропа в строке                            | `MemberRow` ~1600                                               |
| `useMutation` (TanStack Query)                          | Мутация `PATCH /projects/:id { dropId }` для привязки/снятия     | `editMutation` ~579–586 (та же mutation)                        |

---

## 5. Архитектурное решение

### 5.1 Мутация

Кодер ДОЛЖЕН использовать **существующую `editMutation`** (строки ~579–586) или создать
отдельную `dropMutation` — оба варианта корректны. Рекомендуется отдельная мутация для
clarity и независимого `isPending`-состояния кнопки снятия:

```ts
const dropMutation = useMutation({
  mutationFn: (dropId: string | null) =>
    api.patch<ProjectDto>(`/projects/${projectId}`, { dropId }).then((r) => r.data),
  onSuccess: () => {
    void qc.invalidateQueries({ queryKey: ['projects', projectId] })
    void qc.invalidateQueries({ queryKey: ['projects'] })
    setDropPickerOpen(false)
    setDetachDropConfirmOpen(false)
  },
})
```

### 5.2 Данные кандидатов (DROP-пользователи)

Повторно использовать уже загруженный `allUsers` (строка ~613–617, `queryKey: ['users']`,
enabled `canManage`). DROP-кандидаты = `(allUsers ?? []).filter(u => u.role === 'DROP')`.

**Важно:** `allUsers` уже фетчится когда `canManage` (ADMIN/HR). Привязка дропа — только
для `canManage`, поэтому данные будут доступны.

### 5.3 Состояние «дроп уже назначен» — UX-решение

**Решение: СКРЫТЬ DROP-кандидатов из пикера когда `project.dropId !== null`.**

Аргументация:

- Пикер «Привязать дропа» открывается только когда `project.dropId === null` (кнопка
  скрыта/disabled иначе). Сценарий «дроп есть, но пикер открыт» невозможен при корректном
  UI-гейте.
- Кнопка «Привязать дропа» в заголовке карточки НЕ показывается если `project.dropId !== null`
  (conditional render).
- Это чище UX чем disabled-строки с подсказкой — не перегружает список.

Отдельно: фильтр `availableToAdd` на вкладке «Обзор» (строки ~694–702) уже исключает
ADMIN/SENIOR, но НЕ исключает DROP. Кодер ДОЛЖЕН добавить в `availableToAdd`:

```ts
if (u.role === 'DROP') return false // DROP не добавляется через /members
```

Это предотвращает 400 от API при попытке добавить дропа через обычный пикер участников.

---

## 6. Детальный UI-spec по состояниям

### 6.1 Состояние A: у проекта нет дропа (`project.dropId === null`)

**В `ProjectEffectiveTeamCard` (CardHeader, строки ~1717–1723):**

```
┌─ CardHeader pb-3 ─────────────────────────────────────────────┐
│  Эффективный состав  (HR/бухгалтер — из текущей команды синьора)
│                                              [+ Привязать дропа]│  ← новая кнопка
└───────────────────────────────────────────────────────────────┘
```

Кнопка «Привязать дропа»:

- Условие рендера: `canManage && !project.archivedAt && project.dropId === null`
- `variant="ghost" size="sm"`, классы: `h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground`
- Иконка: `<UserPlus className="h-3 w-3" />` + текст «Привязать дропа»
- При клике: `setDropPickerOpen(true)`
- Если нет DROP-пользователей в системе: завернуть в `Tooltip` + `TooltipContent` «Нет активных дропов»
  и задизейблить (`disabled={dropCandidates.length === 0}`)
- `data-testid="attach-drop-btn"`

**В теле карточки (строка после `senior && juniors.length === 0`):**

Нет дропа → не показывать «заглушку» (не добавлять пустую строку «Дроп не назначен»).
Список и так понятен — синьор, HR, бухгалтеры, джуны. Пустое состояние по дропу излишне.

### 6.2 Состояние B: у проекта есть дроп (`project.dropId !== null`)

Строка дропа в `flatMembers` уже рендерится через обычный маппинг (строки ~1670–1680,
~1763–1769). **Изменение:** добавить кнопку снятия на строку дропа — по аналогии с
`MemberRow` (строки ~1595–1604).

Строка дропа в `ProjectEffectiveTeamCard` должна стать:

```tsx
{m.role === 'DROP' ? (
  <Link/div ...>   {/* аватар + имя + бейдж — как сейчас */}
    {rowContent}
  </Link/div>
  {canManage && !project.archivedAt && (
    <Button
      variant="ghost"
      size="icon"
      className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
      aria-label="Снять дропа с проекта"
      data-testid="detach-drop-btn"
      onClick={() => setDetachDropConfirmOpen(true)}
    >
      <UserMinus className="h-3 w-3" />
    </Button>
  )}
) : (
  /* обычный бейдж для не-DROP ролей */
)}
```

**Техническая деталь:** текущий `rowContent` — `<>...</>` без внешнего контейнера.
Кнопка снятия должна быть СНАРУЖИ `rowContent`, на уровне `Link`/`div`-обёртки строки.
Кодер должен реструктурировать рендер строки дропа так, чтобы кнопка снятия была
sibling к `rowContent` внутри flex-контейнера:

```tsx
return isNavigable ? (
  <Link
    key={m.key}
    ...
    className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/30 transition-colors"
  >
    {rowContent}
    {m.role === 'DROP' && canManage && !project.archivedAt && (
      <Button ... onClick={...} >
        <UserMinus className="h-3 w-3" />
      </Button>
    )}
  </Link>
) : (...)
```

**Кнопка «Привязать дропа» в CardHeader:**
НЕ показывается когда `project.dropId !== null` — conditional render.

### 6.3 Состояние C: проект в архиве (`project.archivedAt !== null`)

Обе кнопки (привязать / снять) НЕ рендерятся. Условие: `!project.archivedAt` в обоих местах.
Дроп-строка остаётся read-only, видна как обычно.

---

## 7. Диалог «Привязать дропа» (DropPickerDialog)

```
┌─ CrmDialogContent maxWidth="max-w-sm" ───────────────────────┐
│  CrmDialogHeader                                              │
│    DialogTitle: «Привязать дропа»                             │
│    DialogDescription sr-only: «Выбор дропа для проекта»      │
├───────────────────────────────────────────────────────────────┤
│  CrmDialogBody                                                │
│  ┌ max-h-72 overflow-y-auto space-y-1.5 ───────────────────┐ │
│  │  [если нет кандидатов]                                   │ │
│  │  <p className="text-sm text-muted-foreground py-2">      │ │
│  │    Нет доступных дропов                                  │ │
│  │  </p>                                                    │ │
│  │                                                          │ │
│  │  [для каждого DROP-кандидата]                            │ │
│  │  div flex items-center gap-2.5 rounded-md px-3 py-2     │ │
│  │    Avatar h-7 w-7                                        │ │
│  │      AvatarFallback text-[10px]                          │ │
│  │      AvatarImage src={u.avatarUrl}                       │ │
│  │    div min-w-0 flex-1                                    │ │
│  │      p text-sm font-medium truncate — displayName        │ │
│  │      p text-xs text-muted-foreground truncate — email    │ │
│  │    Badge variant="outline"                               │ │
│  │      className="border-blue-500/30 bg-blue-500/10        │ │
│  │               text-blue-400 shrink-0 text-[9px]"         │ │
│  │      «Дроп»                                              │ │
│  │    Button size="sm"                                      │ │
│  │      variant={isAssigned ? 'outline' : 'default'}        │ │
│  │      className={cn('shrink-0 h-7 text-xs px-2.5',        │ │
│  │        isAssigned && 'text-emerald-500 border-emerald-500/40')} │ │
│  │      disabled={isAssigned || dropMutation.isPending}     │ │
│  │      onClick={() => dropMutation.mutate(u.id)}           │ │
│  │      aria-label={`Назначить ${u.displayName} дропом`}   │ │
│  │      data-testid={`assign-drop-btn-${u.id}`}             │ │
│  │      {isAssigned ? 'Назначено' : dropMutation.isPending ? '...' : 'Назначить'} │ │
│  └──────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

**Поведение после назначения:**

- Мутация успешна → диалог закрывается (`setDropPickerOpen(false)`) через `onSuccess`.
- `invalidateQueries` для `['projects', projectId]` → карточка перерисовывается с новым дропом.
- Toast не обязателен (существующий код не всегда использует toast для PATCH).
- При `isPending` = единственный запрос в полёте → кнопка disabled.

**Нет кандидатов (пустое состояние):**
`dropCandidates.length === 0` → показать «Нет доступных дропов» в теле диалога.
Кнопка «Привязать дропа» в CardHeader при этом задизейблена с Tooltip.

---

## 8. Диалог «Снять дропа» (DetachDropConfirmDialog)

Точно по образцу Remove Member Dialog (строки ~1207–1238):

```
┌─ CrmDialogContent maxWidth="sm:max-w-sm" ────────────────────┐
│  CrmDialogHeader                                              │
│    DialogTitle: «Снять дропа?»                                │
│    DialogDescription sr-only: «Подтверждение снятия дропа»   │
├───────────────────────────────────────────────────────────────┤
│  CrmDialogBody pb-2                                           │
│  <p className="text-sm text-muted-foreground">                │
│    <span className="font-medium text-foreground">             │
│      {drop?.displayName}                                      │
│    </span>{' '}                                               │
│    будет снят с проекта. Приходы больше не будут              │
│    проходить через него.                                      │
│  </p>                                                         │
├───────────────────────────────────────────────────────────────┤
│  CrmDialogFooter                                              │
│    Button variant="outline" onClick={() => setDetachDropConfirmOpen(false)} │
│      «Отмена»                                                 │
│    Button variant="destructive"                               │
│      onClick={() => dropMutation.mutate(null)}                │
│      disabled={dropMutation.isPending}                        │
│      data-testid="detach-drop-confirm-btn"                    │
│      «Снять»                                                  │
└───────────────────────────────────────────────────────────────┘
```

**Поведение:**

- `dropMutation.mutate(null)` → `PATCH /projects/:id { dropId: null }` → строка дропа исчезает из карточки.
- Диалог закрывается через `onSuccess`.

---

## 9. Responsive-поведение (4 класса устройств)

Вкладка «Состав» — `ProjectEffectiveTeamCard` — уже является `Card` без grid. Новые элементы
встраиваются в существующую структуру. **Mobile-first.**

### 9.1 Мобильный (320 / 375px)

- **CardHeader** с кнопкой «Привязать дропа»: `flex items-center justify-between` уже есть
  на уровне CardHeader (как в Team card). Кнопка помещается справа даже на 320px (`shrink-0`).
- **Строка дропа с кнопкой снятия**: `flex items-center gap-2.5`. Имя дропа `truncate flex-1` —
  усекается при нехватке места. Кнопка-иконка `h-5 w-5 shrink-0` — фиксированный размер,
  не вытесняется. На 320px может потребоваться `min-w-0` на span имени (уже есть в `rowContent`
  через `truncate flex-1`).
- **Диалог пикера дропов на 320px**: `CrmDialogContent` с `max-w-sm` — на 320px займёт
  практически всю ширину (300px контент + padding). `max-h-72 overflow-y-auto` — список
  скроллируется. Кнопка «Назначить» `h-7` = 28px высота; добавить `min-w-[72px]` чтобы не
  «схлопнуться» при длинном имени (текст обрезает `truncate`).
- **Тач-таргеты:**
  - Кнопка «Привязать дропа»: `h-7` = 28px — меньше ≥44px мобильного минимума. **Увеличить
    hit-area** через `p-2` или использовать `h-9` на мобайле: `className="h-7 sm:h-7"` плюс
    обёртка `<span className="flex items-center">` с `p-2 -m-2` (расширение тач-области без
    изменения видимого размера). Альтернатива проще: `size="sm"` уже `h-9` в shadcn/ui — проверить
    реальный размер в `button.tsx` вариантах. Если `h-7` по умолчанию — добавить класс
    `min-h-[44px] sm:min-h-0 px-2 sm:px-1.5` для мобайла.
  - Кнопка снятия `h-5 w-5` — явно меньше 44px на мобайле. Паттерн из `MemberRow` — такой же.
    Wrap в `<span className="flex items-center justify-center p-2 -m-2">` для расширения
    тач-области до ≈36px без изменения визуала. Можно использовать класс `touch-target-expand`
    если он определён в globals.css, иначе inline-padding trick.
  - Кнопки «Назначить» в пикере `h-7` = 28px — аналогично тач-расширение или `min-h-[44px]` при
    `sm:min-h-0`.

### 9.2 Планшет (768px)

- Layout без изменений (Card в одну колонку в контент-области).
- CardHeader с кнопкой — достаточно места.
- Диалог `max-w-sm` = 384px — комфортен.

### 9.3 Ноутбук (1024 / 1280px)

- Вкладка «Состав» на 1024px: `ProjectEffectiveTeamCard` в полную ширину контент-области
  (или в grid `lg:grid-cols-2` если такая раскладка существует — проверить по коду).
- По коду: при `activeTab === 'members'` рендерится только `<ProjectEffectiveTeamCard>` без
  дополнительного grid (строка ~917–922). Значит карточка растягивается на всю ширину.
- Кнопки комфортны, overflow не грозит.

### 9.4 Большой (1440 / 1920px)

- Аналогично 1024px — без изменений. `ProjectEffectiveTeamCard` ограничена контент-областью.

### 9.5 Диалог на всех ширинах

`CrmDialogContent` использует `max-h-[90dvh]` и scroll body — надёжно на всех устройствах.
На 320px ширина диалога ≈ `min(calc(100vw - 32px), 384px)` = ~288px. Список кандидатов
корректно скроллируется через `overflow-y-auto`.

---

## 10. Edge cases

| Кейс                                                        | Поведение                                                                                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Нет DROP-пользователей в системе                            | Кнопка «Привязать дропа» disabled + Tooltip «Нет доступных дропов». Диалог НЕ открывается.                                       |
| Один DROP-пользователь в системе                            | Пикер показывает одну строку. После назначения — состояние B.                                                                    |
| Дроп уже назначен                                           | Кнопка «Привязать дропа» НЕ показывается. Строка дропа с кнопкой «снять».                                                        |
| Проект в архиве (`archivedAt !== null`)                     | Обе кнопки скрыты. Дроп-строка read-only. Паттерн совпадает с `canManage && !project.archivedAt` в Team card.                    |
| `allUsers` не загружен (loading)                            | Кнопка «Привязать дропа» disabled пока `canManage && !allUsers`. Либо `dropCandidates.length === 0` → Tooltip.                   |
| Мутация PATCH в полёте                                      | Кнопка «Снять» disabled (`dropMutation.isPending`). Кнопка «Назначить» в пикере disabled.                                        |
| API ошибка PATCH                                            | Диалог остаётся открытым. Показать toast-ошибку через `onError`. Кнопка переходит из `'...'` в исходное состояние.               |
| `project.dropId !== null`, но `effectiveTeam.drop === null` | API-несоответствие: показать fallback «Дроп назначен, данные недоступны» в позиции дропа. Кнопка «снять» активна (dropId задан). |
| Viewer = DROP (сам дроп просматривает проект)               | `canManage` = false → обе кнопки не рендерятся. Строка дропа read-only (как сейчас).                                             |
| Viewer = SENIOR / ACCOUNTANT / JUNIOR                       | `canManage` = false → кнопки не рендерятся.                                                                                      |

---

## 11. A11y (WCAG 2.2 AA)

### 11.1 Target size (SC 2.5.8 — минимум 24×24px; на мобайле целимся ≥44px)

| Элемент                                   | Визуальный размер | Тач-область                                                                              | Статус                           |
| ----------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- | -------------------------------- |
| Кнопка «Привязать дропа» (ghost sm)       | `h-7` = 28px      | Добавить `min-h-[44px] sm:min-h-0` ИЛИ padding-trick `p-2 -m-2`                          | Требует корректировки на мобайле |
| Кнопка «снять дропа» (ghost icon h-5 w-5) | 20×20px визуально | Добавить обёртку `flex items-center justify-center p-2.5 -m-2.5` → ≈ 44×44px тач-область | Требует корректировки на мобайле |
| Кнопка «Назначить» в пикере (sm h-7)      | 28px              | Добавить `min-h-[44px] sm:min-h-0`                                                       | Требует корректировки на мобайле |
| «Снять» в confirm-диалоге (destructive)   | `h-9` = 36px      | ≥ 24px — WCAG-OK; на мобайле 36px достаточно                                             | OK (close to 44, acceptable)     |
| «Отмена» в confirm-диалоге (outline)      | `h-9` = 36px      | OK                                                                                       | OK                               |

### 11.2 Контраст (SC 1.4.3)

| Элемент                                                      | Foreground                            | Background       | Статус      |
| ------------------------------------------------------------ | ------------------------------------- | ---------------- | ----------- |
| Имя дропа `text-foreground` на `bg-card`                     | `--foreground` L~0.97                 | `--card` L~0.12  | >10:1 PASS  |
| Бейдж «Дроп» `text-blue-400` на `bg-blue-500/10` + `bg-card` | синий ~L0.65                          | dark card ~L0.12 | ~4.5:1 PASS |
| Кнопка `text-muted-foreground` ghost                         | `--muted-foreground` L~0.58           | `bg-card`        | ~4.8:1 PASS |
| Кнопка `hover:text-destructive`                              | `--destructive` L~0.58                | `bg-card`        | ~4.8:1 PASS |
| «Снять» variant="destructive"                                | `--destructive-foreground` near-white | `--destructive`  | >4.5:1 PASS |

### 11.3 Focus (SC 2.4.11)

- Все кнопки — shadcn/ui `Button` с `focus-visible:ring-2 focus-visible:ring-ring` — PASS out of box.
- Диалог: `CrmDialog` (shadcn/ui `Dialog`) уже реализует focus-trap через Radix UI — PASS.
- Escape закрывает диалог (Radix `Dialog`) — PASS.
- После закрытия диалога фокус возвращается на триггер-кнопку (Radix default) — PASS.

### 11.4 Focus order (SC 1.3.2, 2.4.3)

На вкладке «Состав» вся логика — в `ProjectEffectiveTeamCard`:

1. Кнопка «Привязать дропа» в CardHeader (если visible).
2. Строки участников (Link / div навигация по профилям).
3. Кнопка «снять дропа» в строке дропа (если visible).

DOM-порядок совпадает с визуальным — порядок корректен.

### 11.5 Icon-only (SC 1.1.1)

| Элемент                                    | aria-label                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Кнопка снятия дропа (UserMinus icon)       | `aria-label="Снять дропа с проекта"`                                                                                                            |
| Кнопка привязки дропа (если только иконка) | Содержит видимый текст «Привязать дропа» — aria-label не нужен                                                                                  |
| Кнопка «Назначить» в пикере                | Содержит видимый текст — aria-label не нужен. Дополнительно: `aria-label={Назначить ${u.displayName} дропом}` — рекомендуется для однозначности |

### 11.6 Семантика

- Диалоги: `DialogTitle` (обязателен, виден) + `DialogDescription` (sr-only) — pattern из codebase.
- Кнопка снятия — `<Button>`, не `<div onClick>` — семантический интерактивный элемент.
- Пикер-список кандидатов: `div`-строки без семантики `<ul>/<li>` — это паттерн существующего
  Add Member Dialog (~1263). Coder может оставить `div` для consistency, или обернуть в `<ul>/<li>`.
  Рекомендация: `<ul className="space-y-1.5">` + `<li>` для семантики списка.

---

## 12. Точные ссылки на строки кода для переиспользования

| Паттерн                                                            | Файл                 | Строки    |
| ------------------------------------------------------------------ | -------------------- | --------- |
| RBAC-переменные `canManage`, `canRemoveMembers`                    | `$projectId.tsx`     | 476–480   |
| `allUsers` query (DROP-кандидаты — уже загружены)                  | `$projectId.tsx`     | 613–617   |
| `addMemberMutation` (образец мутации) → заменить на `dropMutation` | `$projectId.tsx`     | 619–639   |
| `editMutation` (образец `PATCH /projects/:id`)                     | `$projectId.tsx`     | 579–586   |
| Кнопка «Добавить» в Team card (образец кнопки в CardHeader)        | `$projectId.tsx`     | 1013–1036 |
| Диалог «Добавить участника» (образец пикера)                       | `$projectId.tsx`     | 1240–1301 |
| Диалог «Убрать участника?» (образец confirm)                       | `$projectId.tsx`     | 1206–1238 |
| `MemberRow` кнопка удаления (образец icon-кнопки)                  | `$projectId.tsx`     | 1595–1604 |
| `ProjectEffectiveTeamCard` — маппинг дропа                         | `$projectId.tsx`     | 1618–1817 |
| DROP строка в `flatMembers` (push)                                 | `$projectId.tsx`     | 1668–1680 |
| DROP бейдж синий info                                              | `$projectId.tsx`     | 1763–1769 |
| Рендер `isNavigable` Link/div строки                               | `$projectId.tsx`     | 1794–1813 |
| Drop Select в форме СОЗДАНИЯ (образец бейджа + подсказки)          | `projects/index.tsx` | 688–719   |
| Фильтр `availableToAdd` (добавить исключение `role === 'DROP'`)    | `$projectId.tsx`     | 694–702   |
| `[addMemberOpen]` state (образец state для нового диалога)         | `$projectId.tsx`     | 490       |
| `[removeMemberTarget]` state (образец state confirm-диалога)       | `$projectId.tsx`     | 493       |

---

## 13. Новые state-переменные (добавить в `ProjectDetailPage`)

```ts
const [dropPickerOpen, setDropPickerOpen] = useState(false)
const [detachDropConfirmOpen, setDetachDropConfirmOpen] = useState(false)
```

Добавить рядом с `addMemberOpen` (строка ~490).

---

## 14. Новые вычисляемые переменные

```ts
// После строки ~694 (рядом с availableToAdd)
const dropCandidates = (allUsers ?? []).filter((u) => u.role === 'DROP')
```

И обязательная правка `availableToAdd` (строка ~694–702):

```ts
const availableToAdd = (allUsers ?? []).filter((u) => {
  if (u.role === 'ADMIN' || u.role === 'SENIOR') return false
  if (u.role === 'DROP') return false // ← ДОБАВИТЬ: дроп не через /members
  if (activeMembers.some((m) => m.userId === u.id)) return false
  if (u.role === 'JUNIOR') {
    if (hasActiveJunior) return false
    if (u.hasActiveProject) return false
  }
  return true
})
```

---

## 15. data-testid реестр (для AutoTest)

| testid                     | Что                                                        |
| -------------------------- | ---------------------------------------------------------- |
| `attach-drop-btn`          | Кнопка «Привязать дропа» в CardHeader эффективного состава |
| `attach-drop-dialog`       | Корневой элемент диалога пикера дропов                     |
| `assign-drop-btn-{userId}` | Кнопка «Назначить» для конкретного дропа в пикере          |
| `detach-drop-btn`          | Кнопка «снять дропа» (UserMinus) на строке дропа           |
| `detach-drop-dialog`       | Корневой элемент confirm-диалога снятия                    |
| `detach-drop-confirm-btn`  | Кнопка «Снять» в confirm-диалоге                           |

---

## 16. Русские тексты (user-facing)

| Элемент                                                      | Текст                                                                               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Кнопка привязки (CardHeader)                                 | «Привязать дропа»                                                                   |
| Tooltip когда нет кандидатов                                 | «Нет доступных дропов»                                                              |
| Tooltip когда проект в архиве (не рендерится, кнопка скрыта) | —                                                                                   |
| DialogTitle пикера                                           | «Привязать дропа»                                                                   |
| Пустой список в пикере                                       | «Нет доступных дропов»                                                              |
| Кнопка «Назначить» в пикере                                  | «Назначить» / «Назначено» / «…» (pending)                                           |
| Кнопка снятия aria-label                                     | «Снять дропа с проекта»                                                             |
| DialogTitle confirm снятия                                   | «Снять дропа?»                                                                      |
| Текст в confirm                                              | «{displayName} будет снят с проекта. Приходы больше не будут проходить через него.» |
| Кнопка «Отмена» в confirm                                    | «Отмена»                                                                            |
| Кнопка «Снять» в confirm                                     | «Снять»                                                                             |

---

## 17. Handoff-чеклист для Coder

### Pre-implementation

- [ ] Прочитать этот spec и `docs/design/foundation.md` (tone: dense/quiet/operational).
- [ ] Найти `$projectId.tsx` — единственный файл изменений.
- [ ] Проверить, что `editMutation` (строка ~579) принимает `dropId` через `UpdateProjectDto` из `@crm/shared` — если нет, добавить поле в schema Zod.
- [ ] Проверить endpoint `PATCH /projects/:id` принимает `{ dropId: string | null }` без дополнительных обязательных полей — бэкенд должен поддерживать partial update.
- [ ] `allUsers` query `enabled: canManage` — кандидаты уже доступны при открытии пикера.

### Implementation steps

1. Добавить в `ProjectDetailPage`:
   - 2 state-переменные (`dropPickerOpen`, `detachDropConfirmOpen`).
   - `dropMutation` (`PATCH /projects/:id { dropId }`) — рядом с `addMemberMutation`.
   - `dropCandidates` вычисляемая переменная.
   - Исправить `availableToAdd` — исключить `role === 'DROP'`.
2. Изменить `ProjectEffectiveTeamCard`:
   - Принять доп. props: `canManage: boolean`, `isArchived: boolean`, `onDetachDrop: () => void`.
   - Добавить кнопку «Привязать дропа» в CardHeader (conditional).
   - Добавить кнопку снятия на строку дропа (conditional, только `m.role === 'DROP'`).
3. Добавить два диалога (после существующих диалогов, строка ~1301+):
   - `DropPickerDialog` (open=`dropPickerOpen`).
   - `DetachDropConfirmDialog` (open=`detachDropConfirmOpen`).
4. Передать новые props в `<ProjectEffectiveTeamCard>` при рендере на вкладке «Состав» (строки ~917–922).

### Post-implementation WCAG verify

- [ ] Кнопка снятия имеет `aria-label="Снять дропа с проекта"`.
- [ ] Кнопка привязки задизейблена с Tooltip когда нет кандидатов.
- [ ] Обе кнопки скрыты на архивированном проекте.
- [ ] На 320px проверить: имя дропа не вытесняет кнопку снятия (truncate + shrink-0).
- [ ] Пикер на 320px: `max-h-72 overflow-y-auto` — список скроллируется.
- [ ] Playwright screenshot: вкладка «Состав» с дропом + без дропа на 375px и 1280px.

### Anti-slop check

- [ ] Нет новых цветов кроме существующих токенов (голубой бейдж — уже используется).
- [ ] Нет новых радиусов — только `rounded-lg` / `rounded-md`.
- [ ] Нет `transition: all`.
- [ ] Бейдж «Дроп» — используем existing `border-blue-500/30 bg-blue-500/10 text-blue-400`.
- [ ] Нет карточки в карточке — пикер-строки в `div`, не вложенные `Card`.

---

## 18. Антипаттерны (не допускать)

- Не добавлять «Привязать дропа» в диалог «Добавить участника» (вкладка «Обзор») — это отдельный endpoint и отдельный UX-путь.
- Не рендерить «Дроп не назначен» как пустую строку в карточке — отсутствие дропа читается по отсутствию строки.
- Не использовать `confirm()` вместо `Dialog` для подтверждения снятия — нарушает WCAG и a11y.
- Не хранить список кандидатов в отдельном state — переиспользовать `allUsers` (уже загружен).
- Не делать кнопку «Снять» primary-жёлтой — это деструктивное действие (`variant="destructive"`).
- Не добавлять градиент или highlight на строку дропа с активной кнопкой — tone: quiet/operational.

---

## 19. Строй НАШИМИ компонентами

Кодер строит по этому spec, используя **существующие shadcn/ui компоненты и Tailwind-токены**.
Не копировать HTML из внешних источников. Не вводить новые зависимости.
Единственный изменяемый файл фронтенда: `apps/web/app/routes/_authenticated/projects/$projectId.tsx`.
