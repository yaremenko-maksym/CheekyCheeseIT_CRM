# Design Spec: Junior Hub Round 2 — Bento Grid, Passwords, Profile Layout

> Mode A → B — Design Direction (round 2, post-UT feedback)
> Spec slug: `junior-hub-round2`
> Источник: UT feedback 2026-06-12 (7 пунктов), task `.claude/tasks/task-junior-ut-round2.md`
> Прецедент: `docs/design/junior-hub.md` (round 1) · `docs/design/project-credentials.md` · `docs/design/drop-role-ux.md`
> Автор: ui-ux-designer · 2026-06-12

---

## Текущее состояние (baseline)

Скриншоты в `docs/design/assets/junior-r2/`:

- `01-hub-current-1440.jpeg` — хаб на 1440×900: 5 строк вертикального скролла, бедная секция «ПАРОЛИ ПРОЕКТА» снизу, QuickLinksBar в самом низу (удаляется).
- `02-legend-current.jpeg` — страница «Легенда»: просмотр — хорошо.
- `03-datepicker-form-current.jpeg` — форма «Персона» в режиме редактирования: дата-пикер _с уже выбранной датой_ влезает. Проблема только при _пустом_ placeholder `«Выберите дату рождения»`.
- `04-profile-current.jpeg` — профиль джуна: 6 вкладок (Обзор / Проект / Команда / Реквизиты / Документы / Финансы).

**Диагноз по п. 1 (скролл):** на 1440×900 контент занимает ~1050px по высоте из-за вертикального стека: заголовок + [ряд 2col] + [ряд 2col] + [full-width HR] + [full-width Credentials] + [full-width QuickLinksBar]. 150px сверхлимит + QuickLinksBar дублирует nav.

---

## 1. Редизайн сетки хаба — Bento Grid (пункт 1)

### 1.1 Проблема

Текущий layout: `space-y-4` с 4 вложенными grid-контейнерами. На 1440px не помещается в 900px viewport. QuickLinksBar (удаляется в п.2) занимает целую строку и дублирует боковое меню.

### 1.2 Решение: 3-колонный bento-grid

Ключевая идея: _единый_ CSS grid `grid-cols-3` на десктопе, где карточки занимают разные col-span. Группировка логическая: левая колонка — идентичность проекта+персона, средняя — договорные данные, правая — финансы+контакт. Пароли встраиваются в нижнюю полосу.

#### Desktop ≥ 1024px (3 колонки)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  <h1>Мой проект</h1>  · subtitle: companyName                                  │
│  [ProjectSwitcher — только при >1 проекте]                                     │
├─────────────────────┬─────────────────────┬───────────────────────────────────┤
│  ProjectInfoCard    │  PersonaCard        │  ContractStatusCard + SalaryCard   │
│  col-span-1         │  col-span-1         │  col-span-1                        │
│  (лого · компания · │  (аватар-инициалы · │  flex-col gap-3:                  │
│   домен · старт ·   │   ФИО · роль ·     │  ─ ContractStatusCard (h-auto)     │
│   статус)           │   «Открыть легенду»)│  ─ SalarySnapshotCard (flex-1)     │
│                     │                     │  (нет Separator между ними)        │
├─────────────────────┴─────────────────────┴───────────────────────────────────┤
│  HrContactCard + ProjectCredentialsSection — col-span-3                       │
│  flex gap-4 (горизонтально):                                                  │
│  ├── HrContactCard  flex-shrink-0 w-[280px]                                   │
│  └── ProjectCredentialsSection  flex-1                                        │
└───────────────────────────────────────────────────────────────────────────────┘
```

CSS:

```tsx
// Внешний контейнер HubCards
<motion.div
  className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
  variants={container}
  initial="hidden"
  animate="show"
>
  {/* Левая колонка */}
  <motion.div variants={card} className="lg:col-span-1">
    <ProjectInfoCard ... />
  </motion.div>

  {/* Средняя колонка */}
  <motion.div variants={card} className="lg:col-span-1">
    <PersonaCard ... />
  </motion.div>

  {/* Правая колонка: Contract + Salary в flex-col */}
  <motion.div variants={card} className="lg:col-span-1 flex flex-col gap-3">
    <ContractStatusCard ... />
    <SalarySnapshotCard className="flex-1" ... />
  </motion.div>

  {/* Нижняя полоса: HR + Credentials рядом */}
  <motion.div variants={card} className="col-span-full flex flex-col md:flex-row gap-4">
    <HrContactCard className="md:w-[280px] shrink-0" ... />
    <div className="flex-1 min-w-0">
      <ProjectCredentialsSection projectId={projectId} canEdit={false} canAdd={true} />
    </div>
  </motion.div>
</motion.div>
```

#### Tablet 768–1023px (2 колонки)

```
┌─────────────────────────────┬──────────────────────────────┐
│  ProjectInfoCard            │  PersonaCard                 │
├─────────────────────────────┴──────────────────────────────┤
│  ContractStatusCard   │  SalarySnapshotCard               │
│  col-span-1           │  col-span-1                       │
├─────────────────────────────────────────────────────────────┤
│  HrContactCard  (col-span-full, w-full)                    │
├─────────────────────────────────────────────────────────────┤
│  ProjectCredentialsSection  (col-span-full)                │
└─────────────────────────────────────────────────────────────┘
```

На tablet HR и Credentials разворачиваются в `flex-col` (каждый full-width). CSS:

```tsx
// нижняя полоса:
className = 'col-span-full flex flex-col md:flex-row gap-4'
// при md: flex-row (HR 280px + Credentials flex-1)
// при < md: flex-col (оба full-width стопкой)
```

#### Mobile < 768px (1 колонка, порядок = приоритет)

1. ProjectInfoCard
2. PersonaCard
3. ContractStatusCard
4. SalarySnapshotCard
5. HrContactCard
6. ProjectCredentialsSection

Без горизонтальных разделителей. Карточки `w-full`.

### 1.3 Высота на 1440×900 — расчёт

| Элемент                          | Высота (прим.) |
| -------------------------------- | -------------- |
| Заголовок + subtitle             | ~56px          |
| gap + ProjectSwitcher (если нет) | 0px            |
| gap-4                            | 16px           |
| Верхний ряд (3 карточки)         | ~160px         |
| gap-4                            | 16px           |
| Нижняя полоса (HR + Credentials) | ~140px         |
| Итого контент                    | ~388px         |
| + внешние отступы page padding   | ~48px          |
| **Итого**                        | **~436px**     |

Значительно меньше 900px viewport — цель «на один экран» достигается. (Текущий стек: ~1050px.)

### 1.4 Что удаляется

`QuickLinksBar` — компонент и рендер полностью удаляются (п.2 из task-файла, Coder).
Шорткаты `Легенда / Документы / Финансы` не переезжают в хаб — они доступны из боковой навигации (5 пунктов). Дублирование не нужно.

---

## 2. Credentials: пересмотр размещения и поведения (пункт 4 + пункт 6)

### 2.1 Проблема текущего состояния

`ProjectCredentialsSection` — `col-span-full` отдельной полосой, визуально изолирована. Заголовок «ПАРОЛИ ПРОЕКТА» + «Нет сохранённых паролей» — бедное состояние. JUNIOR не может добавлять (только view+reveal). В RBAC-таблице из task файла: JUNIOR теперь получает add.

### 2.2 Новое размещение в bento

В нижней полосе рядом с `HrContactCard` (см. §1.2). Преимущество:

- HR-карточка компактная (~120px высоты), Credentials получает всё оставшееся пространство по ширине.
- Визуальная логика: «кто отвечает» (HR) + «что нужно для работы» (пароли) — в одной горизонтальной зоне.

### 2.3 Новый проп `canAdd`

**Изменение RBAC (round 2):** JUNIOR-член проекта может **создавать** записи (add). Edit/delete — по-прежнему только ADMIN/HR.

```tsx
interface ProjectCredentialsSectionProps {
  projectId: string
  canEdit: boolean // edit + delete (ADMIN/HR → true; JUNIOR → false)
  canAdd?: boolean // create new (JUNIOR на своём проекте → true; все остальные наследуют от canEdit)
}
```

Дефолт `canAdd = canEdit` — обратная совместимость. Для JUNIOR: `canEdit={false} canAdd={true}`.

Рендер кнопки «+ Добавить»:

```tsx
// Было: canEdit
// Стало: canEdit || canAdd
const showAddButton = canEdit || (canAdd ?? false)
```

### 2.4 Состояние empty для JUNIOR (с canAdd=true)

```
┌─ Card border-border/40 ─────────────────────────────────────────────────────────┐
│  [KeyRound h-4 w-4] ПАРОЛИ ПРОЕКТА                         [+ Добавить]         │
│  ─────────────────────────────────────────────────────────────────────────────── │
│  Нет сохранённых паролей                          text-sm text-muted-foreground  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Кнопка «+ Добавить» показывается JUNIOR (впервые). Tooltip: `«Добавить аккаунт проекта»`.
`data-testid="credentials-add-btn"` — тот же, AutoTest не ломается.

### 2.5 Состояние list для JUNIOR (canAdd=true, canEdit=false)

```
┌─ Card border-border/40 ─────────────────────────────────────────────────────────┐
│  [KeyRound] ПАРОЛИ ПРОЕКТА                                  [+ Добавить]         │
│  ─────────────────────────────────────────────────────────────────────────────── │
│  [G] GitHub                                                              [👁]     │
│       login: john.doe@company.com · github.com                                   │
│       ••••••••                                                                    │
│  ─────────────────────────────────────────────────────────────────────────────── │
│  [J] Jira                                                                [👁]     │
│       login: john.doe · jira.company.com                                         │
│       ••••••••                                                                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Только `[👁]` (без `[✏] [🗑]`) — как в round 1. Кнопка «+ Добавить» присутствует.

### 2.6 Новые data-testid (дополнение к реестру из project-credentials.md §12)

| testid                          | Что                                                     |
| ------------------------------- | ------------------------------------------------------- |
| `credentials-add-btn`           | Кнопка «+ Добавить» — уже есть в реестре, НЕ менять     |
| `credentials-section`           | Уже есть                                                |
| `junior-hub-hr-credentials-row` | `flex`-обёртка нижней полосы (HR + Credentials) в bento |

---

## 3. Профиль джуна — итоговая раскладка (пункт 3)

### 3.1 Текущее состояние

Вкладки: `Обзор / Проект / Команда / Реквизиты / Документы / Финансы` — 6 штук. Из них Проект/Команда/Финансы — data-leak (см. task §3 + `users-access.service.ts`).

### 3.2 Целевой allowlist вкладок для JUNIOR

Coder меняет `users-access.service.ts` — allowlist (НЕ denylist):

```ts
// JUNIOR смотрит свой профиль (isSelf && viewer.role === 'JUNIOR'):
tabs.push('overview', 'requisites', 'documents')
// НЕ включать: 'projects', 'team', 'finance', 'interviews', 'contract'

// Кто-то смотрит профиль JUNIOR (target.role === 'JUNIOR'):
// ADMIN → все вкладки (существующая логика строка ~40 — оставить)
// HR → overview + documents + requisites (существующая логика)
// SENIOR → 0 вкладок (существующая логика строки ~122-136 — оставить)
```

### 3.3 Как не выглядеть пусто с 3 вкладками

После удаления 3 вкладок останется 3: «Обзор», «Реквизиты», «Документы». Риск — tab bar выглядит разреженным. Решение: **уплотнить вкладки через `gap`** и убедиться что `AnimatedTabs` не растягивает их на всю ширину.

Текущий `AnimatedTabs` — проверить что `tabs` container имеет `w-fit` или `inline-flex`, не `w-full`. Если сейчас `w-full justify-between` — поменять на `w-fit gap-1` (Coder). 3 таба с `w-fit` смотрятся плотно и естественно.

**Вкладка «Обзор»** — вносит самый большой вклад в насыщенность. Проверить что там есть:

- KPI-карточки (Зарплата / Способ выплат) — _уже показываются_ (см. скриншот `04-profile-current.jpeg`).
- Технологии — badge-список.
- Личные данные — форма.

Это достаточно. Пустота — _ощущаемая_, не реальная. Основная причина — широкий spacing между 6 табами → при 3 табах будет лучше.

### 3.4 Секция «Пароли проекта» в профиле джуна (пункт 6 — новый surface для ADMIN/HR)

**Где:** в вкладке «Обзор» профиля JUNIOR (`OverviewTab`). Место — **после** KPI-карточек (Зарплата/Способ выплат) и **перед** блоком Технологии.

**Кто видит:** только ADMIN и HR (по правилам видимости из `buildProfileView`). Сам JUNIOR — не видит (не нужно: у него есть хаб).

**Реализация:** условный рендер внутри `OverviewTab`:

```tsx
// В OverviewTab (apps/web/app/components/user-profile/tabs/OverviewTab.tsx):
{
  user.role === 'JUNIOR' && permissions.fields.projectCredentials === true && (
    <ProfileCredentialsSection
      userId={user.id}
      canEdit={permissions.fields.editCredentials === true}
    />
  )
}
```

**Новый компонент `ProfileCredentialsSection`** (создаёт Coder):

```
apps/web/app/components/user-profile/ProfileCredentialsSection.tsx
```

Endpoint: `GET /api/credentials?userId={juniorId}` с guard: `ADMIN || (HR && hrSharesActiveTeamWith(juniorId))`.
Поведение: аналог `ProjectCredentialsSection` — список + reveal + edit (для ADMIN/HR). Reveal требует отдельного `GET /api/credentials/:id/reveal?userId={juniorId}`.

**Визуальная структура** — идентично `ProjectCredentialsSection` (Card + CardHeader «ПАРОЛИ ПРОЕКТА» + список). Переиспользовать тот же компонент с пропом `userId` вместо `projectId`, или создать `ProfileCredentialsSection` как тонкую обёртку с другим хуком.

### 3.5 permissions.fields расширение

Coder добавляет два новых поля в `buildProfileView` result:

```ts
fields: {
  // ...существующие...
  projectCredentials: boolean // ADMIN || HR-своя-команда → true; остальные → false
  editCredentials: boolean // ADMIN → true; HR-своя-команда → true; остальные → false
}
```

### 3.6 Итоговая RBAC-таблица для профиля JUNIOR

| Зритель                    | Вкладки                           | Секция «Пароли»           |
| -------------------------- | --------------------------------- | ------------------------- |
| Сам JUNIOR                 | Обзор / Реквизиты / Документы     | Не показывается           |
| ADMIN                      | Все (существующая логика)         | Показывается, edit+reveal |
| HR (своя команда)          | overview + requisites + documents | Показывается, edit+reveal |
| HR (чужая команда)         | 0 вкладок (403)                   | —                         |
| SENIOR / ACCOUNTANT / DROP | 0 вкладок                         | —                         |

### 3.7 data-testid для новой секции

| testid                                | Что                                       |
| ------------------------------------- | ----------------------------------------- |
| `profile-credentials-section`         | Корневая Card в ProfileCredentialsSection |
| `profile-credentials-add-btn`         | Кнопка «+ Добавить» (ADMIN/HR)            |
| `profile-credentials-reveal-btn-{id}` | Кнопка reveal в профиле                   |
| `profile-credentials-edit-btn-{id}`   | Кнопка edit (ADMIN/HR)                    |
| `profile-credentials-delete-btn-{id}` | Кнопка delete (ADMIN/HR)                  |

---

## 4. Date-picker: фикс placeholder «Выберите дату рождения» (пункт 5)

### 4.1 Диагностика

Файл: `apps/web/app/routes/crm/legend.tsx:283`

```tsx
<DatePickerField
  value={field.state.value ?? ''}
  onChange={(v) => field.handleChange(v)}
  placeholder="Выберите дату рождения"
/>
```

Контекст: форма `grid-cols-2 sm:grid-cols-2`, DatePickerField стоит рядом с Input «ФИО» в одной ячейке. Кнопка-триггер в `date-picker.tsx` имеет `w-full justify-start`. Placeholder «Выберите дату рождения» (25 символов) + `CalendarIcon mr-2` = сумма текста шире ячейки grid на малых экранах (<640px) и при sidebar открытом на ~900px viewport.

`date-picker.tsx` не имеет `truncate` на тексте внутри кнопки — текст расширяет кнопку или обрезается без ellipsis.

### 4.2 Fix A — укоротить placeholder (рекомендуемый, нулевая стоимость)

Заменить длинный placeholder на компактный:

```tsx
// Было:
placeholder = 'Выберите дату рождения'

// Стало:
placeholder = 'Дата рождения'
```

«Дата рождения» = 14 символов (vs 25). Помещается в любую ячейку от 180px. Семантика не теряется — Label над полем уже говорит «Дата рождения».

### 4.3 Fix B — добавить `truncate` в DatePickerField (защитный, применить всегда)

Файл: `apps/web/app/components/ui/date-picker.tsx`

**Текущий код строки 34–35:**

```tsx
;<CalendarIcon className="mr-2 h-4 w-4" />
{
  selected ? format(selected, 'dd MMM yyyy', { locale: ru }) : placeholder
}
```

**После fix:**

```tsx
<CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
<span className="truncate">{selected ? format(selected, 'dd MMM yyyy', { locale: ru }) : placeholder}</span>
```

Изменения:

- `shrink-0` на иконке — иконка не сжимается при нехватке места.
- `<span className="truncate">` — текст обрезается с ellipsis вместо расширения кнопки.
- Кнопка уже имеет `w-full` — `min-w-0` на ней не нужен (родительский flex-контейнер уже `w-full`).

Оба фикса применять вместе: A — в `legend.tsx`, B — в `date-picker.tsx`.

### 4.4 Скриншот before/after

Скриншот «before» — `docs/design/assets/junior-r2/03-datepicker-form-current.jpeg` (форма с уже выбранной датой — не воспроизводит проблему). Проблема возникает при **пустом** value — placeholder «Выберите дату рождения» выходит за кнопку. After-скриншот Coder делает после реализации (Mode D или в PR).

---

## 5. Token map

Все токены из `apps/web/app/styles/globals.css`. **Новых токенов не добавляется.**

| Назначение                    | Token                                      | Tailwind class            |
| ----------------------------- | ------------------------------------------ | ------------------------- |
| Карточки bento                | `--color-card`                             | `bg-card`                 |
| Граница карточек              | `--color-border`                           | `border-border/40`        |
| Основной текст                | `--color-foreground`                       | `text-foreground`         |
| Вторичный текст               | `--color-muted-foreground`                 | `text-muted-foreground`   |
| Аватар-инициалы фон           | `--color-yellow-subtle`                    | `bg-yellow-subtle`        |
| Аватар-инициалы текст         | `--color-avatar-text`                      | `text-avatar-text`        |
| CTA кнопки, Badge primary     | `--color-primary`                          | `bg-primary text-primary` |
| Credentials reveal-zone       | `--color-muted`                            | `bg-muted/40`             |
| Ошибки                        | `--color-destructive`                      | `text-destructive`        |
| Радиус карточек               | `--radius-lg` = `var(--radius)` = 0.625rem | `rounded-lg`              |
| Радиус кнопок внутри карточек | `--radius-md` = `calc(var(--radius)-2px)`  | `rounded-md`              |
| Суммы                         | CSS `font-variant-numeric: tabular-nums`   | `tabular-nums`            |

**Concentric radius**: нижняя полоса (HR + Credentials) — `rounded-lg` у обеих Card. Reveal-контейнер внутри Credentials — `rounded-[calc(var(--radius)-4px)]` (как в project-credentials.md §4).

---

## 6. Motion spec

Тот же stagger pattern что в round 1 (`docs/design/junior-hub.md §5`):

```tsx
const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const card = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] } },
}
```

При переходе на bento — те же `motion.div variants={card}` оборачивают каждый grid-item. Нижняя полоса (HR + Credentials flex-row) — один `motion.div variants={card}` на весь flex-контейнер, не два отдельных.

---

## 7. A11y critical paths (WCAG 2.2 AA)

### 7.1 Focus order новой bento-сетки

DOM-порядок совпадает с визуальным слева-направо, сверху-вниз (CSS grid не меняет DOM-order):

1. ProjectSwitcher (если >1 проект)
2. ProjectInfoCard (нет интерактивных)
3. PersonaCard → кнопка «Открыть легенду»
4. ContractStatusCard → кнопка «Подписать» (если visible)
5. SalarySnapshotCard → ссылка «Все мои выплаты»
6. HrContactCard → ссылки TG/phone
7. ProjectCredentialsSection → кнопка «+ Добавить» → строки записей → [👁] кнопки

На мобиле ContractStatusCard и SalarySnapshotCard расстаются в разные строки (1-кол) — DOM-порядок: Contract (строка 3) → Salary (строка 4). Визуальный и DOM порядок совпадают — порядок по Tab логичен.

### 7.2 Target size (SC 2.5.8)

| Элемент                           | Размер           | Статус                          |
| --------------------------------- | ---------------- | ------------------------------- |
| Кнопка «Открыть легенду»          | `h-8` 32px       | ≥ 24px PASS                     |
| Кнопка «+ Добавить» (credentials) | `h-8` 32px       | ≥ 24px PASS                     |
| Кнопка reveal `[👁]`              | `h-7 w-7` 28px   | ≥ 24px PASS                     |
| Ссылки TG/phone в HrContactCard   | `text-xs` inline | Проверить `min-h-[24px] py-0.5` |

### 7.3 Контраст (SC 1.4.3 / 1.4.11)

Токены проверены в round 1 (junior-hub.md §6.3) — без изменений. Новый элемент: кнопка «+ Добавить» у JUNIOR — `Button variant="outline"`: `--foreground` на `--card` → >10:1 PASS.

### 7.4 Icon-only кнопки (SC 1.1.1)

Кнопка «+ Добавить» в Credentials содержит текст → `aria-label` не нужен. Reveal/copy/edit/delete — из project-credentials.md §8.4, без изменений.

### 7.5 Семантика нижней полосы

```tsx
<section aria-label="HR и пароли проекта" className="col-span-full ...">
  <HrContactCard ... />
  <ProjectCredentialsSection ... />
</section>
```

Каждая Card внутри сохраняет свои CardHeader/CardTitle — заголовки остаются в accessibility tree.

### 7.6 Реflow (SC 1.4.10)

`grid-cols-3` на lg → при zoom 400% на 1440px = effective width 360px → отрабатывает `grid-cols-1` (мобильный стек). Нет горизонтального overflow.

---

## 8. Edge cases

### 8.1 Bento grid

| Кейс                             | Поведение                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Зарплата не назначена            | SalarySnapshotCard: «Ставка не назначена» (italic muted). Карточка остаётся в flex-col, высота минимальная. ContractStatusCard не «растягивается» сверх natural height.           |
| Контракт подписан (нет CTA)      | ContractStatusCard короткая (~80px). SalarySnapshotCard с `flex-1` заполняет правую колонку.                                                                                      |
| Нет паролей + JUNIOR canAdd=true | Credentials: empty state + кнопка «+ Добавить». HR-карточка не «вырастает» чтобы заполнить место — `HrContactCard` `h-fit` (нет `flex-1`).                                        |
| > 8 паролей                      | Credentials: `ScrollArea max-h-[480px]` (из project-credentials.md §9.2). Нижняя полоса может вырасти. На десктопе это ок — пользователь скроллит внутри ScrollArea, не страницу. |
| Легенда не заполнена             | PersonaCard: инициалы «?», ФИО «—», роль «—», кнопка CTA «Открыть легенду». Без изменений vs round 1.                                                                             |
| HR не найден                     | HrContactCard: compact empty state. Ширина `w-[280px]` сохраняется, не схлопывается — иначе Credentials занял бы всю строку и выглядел несбалансированно.                         |

### 8.2 Профиль JUNIOR с 3 вкладками

| Кейс                                  | Поведение                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Нет документов (Documents tab пустой) | DocumentsTab: пустое состояние «Нет документов». Вкладка остаётся в tab bar.                                                                             |
| Нет реквизитов                        | RequisitesTab: пустое состояние + CTA заполнить. Вкладка остаётся.                                                                                       |
| ADMIN смотрит профиль JUNIOR          | Все вкладки (существующая логика `users-access.service.ts:40`). Вкладка «Контракт» тоже показывается (строка 42 — `!isSelf && target.role !== 'ADMIN'`). |
| Нет паролей в профиле (ADMIN смотрит) | `ProfileCredentialsSection`: empty state + кнопка «+ Добавить».                                                                                          |

---

## 9. Полный реестр data-testid (дополнения к round 1)

**Новые в round 2:**

| testid                                | Что                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `junior-hub-bento`                    | Корневой `motion.div` bento-grid (заменяет `junior-hub` если переименовать) |
| `junior-hub-hr-credentials-row`       | Flex-обёртка нижней полосы (HR + Credentials)                               |
| `profile-credentials-section`         | Корневая Card `ProfileCredentialsSection` в профиле                         |
| `profile-credentials-add-btn`         | Кнопка «+ Добавить» в профиле                                               |
| `profile-credentials-reveal-btn-{id}` | Кнопка reveal в профиле                                                     |
| `profile-credentials-edit-btn-{id}`   | Кнопка edit в профиле                                                       |
| `profile-credentials-delete-btn-{id}` | Кнопка delete в профиле                                                     |

**Изменения в существующих testid:**

| testid                | Изменение                                                                    |
| --------------------- | ---------------------------------------------------------------------------- |
| `quick-links-bar`     | УДАЛЯЕТСЯ (компонент и `data-testid` выпиливаются, E2E фиксируется AutoTest) |
| `quick-link-legend`   | УДАЛЯЕТСЯ (в составе QuickLinksBar)                                          |
| `credentials-add-btn` | СОХРАНЯЕТСЯ — теперь видна и у JUNIOR (`canAdd=true`)                        |

---

## 10. Русские тексты (новые/изменённые)

| Элемент                                           | Текст                                               |
| ------------------------------------------------- | --------------------------------------------------- |
| DatePickerField placeholder (legend)              | `«Дата рождения»` ← было `«Выберите дату рождения»` |
| Tooltip кнопки «+ Добавить» (credentials, JUNIOR) | `«Добавить аккаунт проекта»`                        |
| Секция паролей в профиле (заголовок)              | `«ПАРОЛИ ПРОЕКТА»` (тот же паттерн)                 |
| Пустое состояние секции в профиле                 | `«Нет сохранённых паролей»`                         |

---

## 11. Anti-patterns (Mode C checklist)

- Нет purple/gradient на карточках bento.
- Нет `rounded-2xl` везде — только `rounded-lg` (0.625rem) на Card + `rounded-md` внутри.
- Нет `shadow-xl` на карточках — только `border-border/40`.
- Нет decorative blobs/illustrations.
- Нет `transition: all` — только explicit properties (150ms bg-color/opacity/color).
- Нет Cards inside Cards (credentials reveal-блок — `div`, не `Card`; HR и Credentials — параллельные Cards в flex-row, не nested).
- Нет AI-slop generic gradient hero на хабе — хаб остаётся `dense / quiet / scannable`.
- Размещение паролей рядом с HR — функциональная логика, не декоративная.

---

## 12. Handoff-чеклист для Coder

### Пункт 1 — bento grid

- [ ] Заменить `<motion.div className="space-y-4">` на `<motion.div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">` в `HubCards` (`project.tsx`)
- [ ] Правую колонку (Contract + Salary) обернуть в `<motion.div className="flex flex-col gap-3">`
- [ ] Нижнюю полосу (HR + Credentials) обернуть в `<section aria-label="HR и пароли проекта" className="col-span-full flex flex-col md:flex-row gap-4">`
- [ ] `HrContactCard` получает `className="md:w-[280px] shrink-0"` — добавить к компоненту prop `className`
- [ ] `ProjectCredentialsSection` обернуть в `<div className="flex-1 min-w-0">`
- [ ] Удалить `<motion.div variants={card}><QuickLinksBar /></motion.div>` и сам `QuickLinksBar` компонент
- [ ] Убрать неиспользуемые импорты (`BookOpen`, `FileText`, `DollarSign` если больше не нужны)

### Пункт 2 — QuickLinksBar удаление (task §2)

- [ ] Удалить `function QuickLinksBar()` и её рендер в `HubCards`
- [ ] Проверить E2E на `quick-links-bar` / `quick-link-legend` testid — убрать или обновить (AutoTest зона)

### Пункт 3 — credentials canAdd

- [ ] `ProjectCredentialsSectionProps`: добавить `canAdd?: boolean`
- [ ] Кнопка «+ Добавить» показывается при `canEdit || (canAdd ?? false)`
- [ ] В `project.tsx`: `<ProjectCredentialsSection projectId={projectId} canEdit={false} canAdd={true} />`

### Пункт 4 — date-picker fix

- [ ] `apps/web/app/routes/crm/legend.tsx:283`: placeholder `"Выберите дату рождения"` → `"Дата рождения"`
- [ ] `apps/web/app/components/ui/date-picker.tsx`: `CalendarIcon` + `shrink-0`; текст в `<span className="truncate">`
- [ ] Playwright скриншот before/after с пустым value (legend.tsx форма персоны без даты)

### Пункт 5 — профиль JUNIOR (frontend, без backend)

- [ ] `users-access.service.ts`: allowlist для JUNIOR self-view: `tabs.push('overview', 'requisites', 'documents')` — убрать `'projects', 'team', 'finance'`
- [ ] Проверить `AnimatedTabs` — 3 таба не расстягиваются на всю ширину (w-fit/inline-flex контейнер)
- [ ] Backend: `buildProfileView` — убедиться что данные projects/team/finance не текут в DTO при JUNIOR self-view (security-reviewer проверяет)

### Пункт 6 — ProfileCredentialsSection (security-critical — требует security-reviewer)

- [ ] Новый компонент `ProfileCredentialsSection.tsx`
- [ ] Новый хук `use-profile-credentials.ts` (endpoint `GET /api/credentials?userId={id}`)
- [ ] Backend: endpoint + guard `ADMIN || hrSharesActiveTeamWith`
- [ ] `users-access.service.ts`: добавить `fields.projectCredentials` и `fields.editCredentials`
- [ ] `OverviewTab.tsx`: условный рендер `ProfileCredentialsSection` для JUNIOR-цели
- [ ] security-reviewer MANDATORY: RBAC integration spec (403 для чужих HR, SENIOR/ACCOUNTANT/DROP)

### Post-implementation

- [ ] `eslint lint-files` на изменённых `.tsx` файлах
- [ ] `pnpm typecheck` (turbo cache bypass: `--force`)
- [ ] Playwright screenshot: хаб на 1440px (один экран?), хаб на 375px (мобиль)
- [ ] Lighthouse: layout не добавляет CLS (grid вместо space-y не должен)
- [ ] Контраст: «+ Добавить» для JUNIOR — Button variant="ghost"/"outline" на `bg-card`

---

## 13. Открытые вопросы для PM

1. **`HrContactCard` ширина 280px** — на узких 768px-824px viewports нижняя полоса может выглядеть неравномерно (HR-карточка фиксированная, Credentials узкая). Альтернатива: `min-w-[200px] max-w-[300px]`. Уточнить с визуальной проверкой Coder'а.

2. **`ProfileCredentialsSection` в профиле** — отдельный компонент или shared-переиспользование `ProjectCredentialsSection` с новым пропом `mode="profile" userId=`? Переиспользование дешевле, но требует условной логики хука (projectId vs userId). Оставляю на Coder'а — выбрать вариант дешевле без дублирования core reveal-логики.

3. **JUNIOR add credentials — миграция?** — если бэк уже имеет RBAC check на create credential (только ADMIN/HR), то добавление JUNIOR потребует расширения `credentials.service.ts`. Проверить `apps/api/src/credentials/credentials.service.ts` — нужна ли миграция guard'а. Это security-reviewer зона.

4. **Скриншот date-picker до/после** — из-за отсутствия пустого значения в тестовых данных (у Sofii заполнена дата) воспроизвести проблему через Playwright сложно без очистки поля. Coder делает скриншот при реализации (открыть форму → вручную очистить → screenshot).
