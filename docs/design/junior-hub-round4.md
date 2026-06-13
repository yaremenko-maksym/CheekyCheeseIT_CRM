# Design Spec: Junior Hub Round 4 — Equal-Height Columns + Redesigned Salary Card

> Mode B → D — Visual Audit + Design Direction (round 4, post-UT feedback #188)
> Spec slug: `junior-hub-round4`
> Источник: UT feedback owner (2026-06-13) — «правая колонка «Моя зарплата» короче левого стека → пустота справа снизу; выглядит бедно»
> Прецеденты: `docs/design/junior-hub-round3.md` (round 3, реализован в #188)
> Автор: ui-ux-designer · 2026-06-13
> Скриншот «до»: `docs/design/assets/junior-r4/01-before-1440.jpeg`

---

## 0. Диагностика (почему round 3 дал неравную высоту)

### Реальный снимок 1440×900 (живой стек после #188)

```
Левый стек (col-span-1):
  ├── ProjectInfoCard    ~380px  (лого, домен, старт, статус, HR-контакт)
  ├── gap-4              16px
  └── PersonaCard        ~155px  (аватар, имя, роль, кнопка)
  ──────────────────────────────
  Итого левой колонки:   ~551px

Правая колонка (col-span-2):
  └── SalarySnapshotCard ~415px  (заголовок, 500 USD, 3 строки выплат, ссылка)

Разница:                 ~136px пустоты справа снизу
```

### Root cause

Round 3 применил `items-start` на grid-контейнере — это корректное исправление round 2
(убрало `h-full` растяжку внутри карточек). Но у `items-start` есть последствие:
каждый grid-item имеет `align-self: start`, то есть занимает ровно столько высоты,
сколько его контент. Левый стек тянется до PersonaCard (~551px), правая SalaryCard —
до «Все мои выплаты» (~415px). Разница 136px — визуальная пустота.

Три варианта решения:

1. **A — чисто контентный**: добавить настолько богатый контент в SalaryCard, что она
   дотянется по высоте естественно. Проблема: данных нестабильно (может быть 0–3 строки).
2. **B — CSS stretch + left self-start**: убрать `items-start` → `items-stretch`, левый
   `motion.div` получает `self-start` (его карточки остаются h-fit), правый `motion.div`
   получает `flex flex-col`, SalaryCard — `h-full flex flex-col`. Правая колонка займёт
   100% высоты grid-строки. Левый стек — натуральная высота. Чисто, без хаков.
3. **C — hybrid**: оставить `items-start`, правый `motion.div` + `h-full self-stretch` +
   SalaryCard `h-full`. При `items-start` grid row = max(left, right), `h-full` на обёртке
   не сработает предсказуемо без явного grid row height.

**Выбор стратегии: Вариант B.** Самый чистый и предсказуемый CSS. Подтверждён MDN:
при `align-items: stretch` (default) каждый grid-item растягивается до высоты grid-строки.
`self-start` на левом div блокирует растяжку только для него. Правый div `flex flex-col` +
SalaryCard `flex-1` — карточка заполняет всю доступную высоту.

---

## 1. Equal-Height: Grid-стратегия

### Было (round 3)

```tsx
<motion.div
  className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start"
  ...
>
  <motion.div variants={card} className="lg:col-span-1 flex flex-col gap-4">
    {/* left stack — h-fit cards */}
  </motion.div>

  <motion.div variants={card} className="lg:col-span-2">
    <SalarySnapshotCard ... />
  </motion.div>
```

**Проблема:** `items-start` → оба child-div получают `align-self: start` → их высота
равна контенту. SalaryCard короче левого стека → пустота.

### Стало (round 4)

```tsx
<motion.div
  className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
  {/* items-start УБИРАЕТСЯ — используем default align-items: stretch */}
  ...
>
  {/* Левый стек: self-start — НЕ растягивается, карточки остаются h-fit */}
  <motion.div variants={card} className="lg:col-span-1 flex flex-col gap-4 self-start">
    <ProjectInfoCard ... />
    <PersonaCard ... />
  </motion.div>

  {/* Правая колонка: flex flex-col — SalaryCard заполняет grid row height */}
  <motion.div variants={card} className="lg:col-span-2 flex flex-col">
    <SalarySnapshotCard ... className="flex-1" />
  </motion.div>
```

**Механика:**

- Без `items-start` grid по умолчанию `align-items: stretch`.
- Левый `motion.div` с `self-start` — align-self overridden → высота по контенту (~551px).
- Grid-строка = 551px (от левого стека как более высокого).
- Правый `motion.div` без `self-start` → получает `align-self: stretch` → высота = 551px.
- `flex flex-col` на правом div + `flex-1` на SalaryCard → SalaryCard занимает 100% 551px.
- Внутри SalaryCard: `flex flex-col` + нижняя секция `mt-auto` → контент вверху, итог внизу.

**Responsive:**

- На mobile (`grid-cols-1`): обе колонки — col-span-1, нет смысла в stretch → поведение
  корректное (стек вертикально, каждая карточка h-fit).
- На tablet (`md:grid-cols-2`): левый стек col-1, правый col-1 → stretch работает
  аналогично desktop (левый `self-start`, правый занимает высоту ряда).

---

## 2. SalarySnapshotCard — полный редизайн

### Проблема round 3 (видно на скриншоте «до»)

1. Большое «500 USD» + «/ мес» — единственный визуальный акцент, остальное плоско.
2. «Последние выплаты» — мелкая серая подпись, потом 3 строки без визуальной структуры.
3. Ссылка «Все мои выплаты» — единственный интерактивный элемент кроме заголовка.
4. На col-span-2 (928px эффективной ширины на 1440px) — контент занимает только
   ~200px по высоте из ~415px карточки. С round 4 карточка станет ~551px — без переработки
   пустота увеличится.

### Принципы redesign

- **Заполнить высоту осмысленно, не декоративно.** Контент-разделы с семантической ролью.
- **Визуально богаче без AI-slop.** Нет градиентов, нет декоративных блобов. Богатство =
  правильные размеры, правильные dividers, правильная информационная иерархия.
- **Убрать кнопку «Все мои выплаты».** Требование UT. Убирается полностью.
- **Структура карточки — 3 зоны:**
  1. **Header zone** — заголовок «Моя зарплата» + иконка (без изменений).
  2. **Rate zone** — крупная ставка + контекст валюты/периода + тонкий разделитель.
  3. **Payments zone** — секция выплат с header'ом + строки + статус-бейджи аккуратнее.
  4. **Summary zone** — «прилипает» к низу через `mt-auto`: сводная строка или пустое
     состояние.

### Структура контента (новая)

```
┌─ Card h-full flex flex-col ────────────────────────────────────────────────────┐
│  CardHeader: «Моя зарплата»                             [DollarSign icon]      │
│  ─────────────────────────────────────────────────────────────────────────── │
│  CardContent flex flex-col flex-1:                                             │
│                                                                                │
│  ┌─ Rate zone ──────────────────────────────────────────────────────────────┐ │
│  │  [500]  USD  ·  / месяц                                                  │ │
│  │  text-4xl bold tabular-nums    text-base muted    text-sm muted          │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│  Separator opacity-30                                                          │
│                                                                                │
│  ┌─ Payments zone ──────────────────────────────────────────────────────────┐ │
│  │  ПОСЛЕДНИЕ ВЫПЛАТЫ         text-xs uppercase tracking-wider muted        │ │
│  │  ──────────────────────────────────────────────────────────────────────  │ │
│  │  Май 2026           500 USD        [Ожидание]                            │ │
│  │  Апрель 2026        500 USD        [Выплачено]                           │ │
│  │  Март 2026          500 USD        [Выплачено]                           │ │
│  │  (строки: py-2.5, border-b border-border/20, last:border-0)              │ │
│  │                                                                           │ │
│  │  (при 0 выплат: серая italic строка «Выплат ещё не было»)                │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│  flex-1 (spacer — занимает остаток высоты между выплатами и итогом)           │
│                                                                                │
│  ┌─ Summary zone (mt-auto) ─────────────────────────────────────────────────┐ │
│  │  Separator opacity-20                                                     │ │
│  │  pt-3                                                                     │ │
│  │  «Ставка за месяц»        «500 USD»                                      │ │
│  │  text-xs muted             text-sm font-semibold tabular-nums            │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Детали компонента

```tsx
function SalarySnapshotCard({ salaryMeta, salaryTxs, isLoading, className }: SalarySnapshotCardProps) {
  const baseClass = 'border-border/40 bg-card flex flex-col'  // flex-col для h-full
  const cardClass = className ? `${baseClass} ${className}` : baseClass

  if (isLoading) { ... }

  const hasRate = salaryMeta?.monthlySalary != null
  const currency = salaryMeta?.salaryCurrency ?? 'USD'
  const amount = hasRate ? Number(salaryMeta!.monthlySalary).toLocaleString('ru-RU') : null

  return (
    <Card className={cardClass} data-testid="salary-snapshot-card">
      <CardHeader className="flex flex-row items-center justify-between pb-3 shrink-0">
        <CardTitle className="text-sm font-semibold">Моя зарплата</CardTitle>
        <DollarSign className="h-4 w-4 text-muted-foreground" aria-hidden />
      </CardHeader>

      <CardContent className="flex flex-col flex-1 pt-0 gap-0">

        {/* Rate zone */}
        {hasRate ? (
          <div className="flex items-baseline gap-2 pb-4" data-testid="salary-rate-zone">
            <span className="text-4xl font-bold tabular-nums leading-none" data-testid="salary-rate-amount">
              {amount}
            </span>
            <span className="text-base text-muted-foreground uppercase tracking-wide">
              {currency}
            </span>
            <span className="text-sm text-muted-foreground ml-auto">/ месяц</span>
          </div>
        ) : (
          <div className="pb-4">
            <p className="text-sm text-muted-foreground/60 italic" data-testid="salary-no-rate">
              Ставка не назначена
            </p>
          </div>
        )}

        <Separator className="opacity-30 mb-4 shrink-0" />

        {/* Payments zone */}
        <div className="space-y-0" data-testid="salary-tx-list">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
            Последние выплаты
          </p>
          {salaryTxs.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 italic py-2">
              Выплат ещё не было
            </p>
          ) : (
            salaryTxs.map((tx) => {
              const isPaid = tx.status === 'PAID' || tx.status === 'VALIDATED'
              const txVariant = isPaid ? ('paid' as const) : ('pending' as const)
              const label = tx.salaryMonth
                ?? new Date(tx.createdAt).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
              return (
                <div
                  key={tx.id}
                  className="flex items-center justify-between py-2.5 border-b border-border/20 last:border-0"
                  data-testid="salary-tx-row"
                >
                  <span className="text-sm text-muted-foreground capitalize">{label}</span>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums text-sm font-medium">
                      {Number(tx.amount).toLocaleString('ru-RU')} {tx.currency}
                    </span>
                    <Badge variant={txVariant} className="text-xs min-w-[72px] justify-center">
                      {isPaid ? 'Выплачено' : 'Ожидание'}
                    </Badge>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Spacer — pushes summary to bottom */}
        <div className="flex-1" />

        {/* Summary zone — anchored to bottom */}
        {hasRate && (
          <div className="mt-auto pt-3 shrink-0" data-testid="salary-summary">
            <Separator className="opacity-20 mb-3" />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Ставка за месяц</span>
              <span className="text-sm font-semibold tabular-nums">
                {amount} {currency}
              </span>
            </div>
          </div>
        )}

      </CardContent>
    </Card>
  )
}
```

**Что убрано:**

- Ссылка «Все мои выплаты» с `data-testid="salary-all-link"` — **удалена полностью**.
- `ExternalLink` import — убирается если не используется в других местах файла.

**Что изменено:**

- `text-3xl` → `text-4xl` для суммы (шире карточка = крупнее акцент оправдан).
- `space-y-4` в CardContent → `flex flex-col flex-1 gap-0` (структурный контейнер для h-full).
- Заголовок секции выплат: `text-xs` → добавлен `uppercase tracking-wider` (SaaS-стиль).
- Badge выплат: добавлено `min-w-[72px] justify-center` — выравнивание по ширине.
- Summary zone: новая секция внизу карточки — итоговая строка со ставкой.
- `<Link to="/crm/finance">` — **удалена**.
- CardHeader: добавлен `shrink-0` чтобы не сжимался при flex-1 у CardContent.

---

## 3. HubCards — итоговый шаблон

### Только изменённые строки (diff-формат для Coder)

```diff
- className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start"
+ className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
```

```diff
- <motion.div variants={card} className="lg:col-span-1 flex flex-col gap-4">
+ <motion.div variants={card} className="lg:col-span-1 flex flex-col gap-4 self-start">
```

```diff
- <motion.div variants={card} className="lg:col-span-2">
-   <SalarySnapshotCard ... />
- </motion.div>
+ <motion.div variants={card} className="lg:col-span-2 flex flex-col">
+   <SalarySnapshotCard ... className="flex-1" />
+ </motion.div>
```

### Полный HubCards (для reference)

```tsx
function HubCards({ project, projectId }: { project: ProjectDto; projectId: string }) {
  const { data: legend, isLoading: legendLoading } = useLegend(projectId, true)
  const { data: salaryMeta, isLoading: salaryMetaLoading } = useSalaryMeta()
  const { data: salaryTxs, isLoading: salaryTxsLoading } = useSalaryTransactions()
  const { data: hrContact, isLoading: hrLoading } = useHrContact(projectId)

  const salaryLoading = salaryMetaLoading || salaryTxsLoading

  return (
    <motion.div
      className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
      variants={container}
      initial="hidden"
      animate="show"
      data-testid="junior-hub-bento"
    >
      {/* Left stack: self-start → h-fit cards, не растягиваются */}
      <motion.div variants={card} className="lg:col-span-1 flex flex-col gap-4 self-start">
        <ProjectInfoCard project={project} hrContact={hrContact ?? null} hrLoading={hrLoading} />
        <PersonaCard legend={legend ?? null} isLoading={legendLoading} />
      </motion.div>

      {/* Right wide: flex flex-col → SalaryCard flex-1 = grid row height */}
      <motion.div variants={card} className="lg:col-span-2 flex flex-col">
        <SalarySnapshotCard
          salaryMeta={salaryMeta ?? null}
          salaryTxs={salaryTxs ?? []}
          isLoading={salaryLoading}
          className="flex-1"
        />
      </motion.div>

      {/* Bottom full-width: Пароли проекта */}
      <motion.div variants={card} className="col-span-full">
        <ProjectCredentialsSection projectId={projectId} canEdit={false} canAdd twoColumn />
      </motion.div>
    </motion.div>
  )
}
```

---

## 4. Импорты: что удалить

В `apps/web/app/routes/crm/project.tsx` после изменений удалить:

```tsx
// УДАЛИТЬ если ExternalLink не используется в других компонентах файла:
import { BookOpen, DollarSign, ExternalLink, Phone, Send, UserCircle } from 'lucide-react'
//                             ^^^^^^^^^^ — убрать из destructure

// УДАЛИТЬ ссылку «Все мои выплаты»:
// <Link to="/crm/finance" ... data-testid="salary-all-link">...</Link>
// Если Link импортирован только для этого — убрать import { Link } тоже.
// Проверить: Link используется в SalarySnapshotCard. Если убираем единственное место — убрать.
```

Проверить файл: `import { createFileRoute, Link, useNavigate }` — `Link` используется ТОЛЬКО
в `SalarySnapshotCard` для «Все мои выплаты». После удаления ссылки → убрать `Link` из импорта.

---

## 5. data-testid изменения (от round 3)

### Удаляются

| testid            | Причина                                    |
| ----------------- | ------------------------------------------ |
| `salary-all-link` | Ссылка «Все мои выплаты» удалена полностью |

### Добавляются

| testid             | Что                                                |
| ------------------ | -------------------------------------------------- |
| `salary-rate-zone` | Обёртка rate-секции (ставка + валюта + период)     |
| `salary-summary`   | Summary zone внизу карточки (ставка за месяц итог) |

### Сохраняются (без изменений)

| testid                 | Что                                  |
| ---------------------- | ------------------------------------ |
| `salary-snapshot-card` | SalarySnapshotCard                   |
| `salary-rate-amount`   | Цифра ставки (span внутри rate-zone) |
| `salary-no-rate`       | Italic «Ставка не назначена»         |
| `salary-tx-list`       | Обёртка списка выплат                |
| `salary-tx-row`        | Строка выплаты                       |
| `junior-hub-bento`     | Корневой motion.div                  |
| `project-info-card`    | ProjectInfoCard                      |
| `persona-card`         | PersonaCard                          |

---

## 6. Skeleton loading — обновить

Skeleton должен отражать равные высоты. Правый skeleton — тоже `flex flex-col`:

```tsx
{
  /* Right wide skeleton */
}
;<div className="lg:col-span-2 flex flex-col">
  <Skeleton className="flex-1 min-h-[200px] rounded-lg" />
</div>
```

`min-h-[200px]` — минимальная высота skeleton при пустом контенте.

---

## 7. Token map

Все токены из `apps/web/app/styles/globals.css`. Новых токенов не добавляется.

| Назначение          | Token                      | Tailwind class                   |
| ------------------- | -------------------------- | -------------------------------- |
| Карточки bento      | `--color-card`             | `bg-card`                        |
| Граница карточек    | `--color-border`           | `border-border/40`               |
| Разделители         | `--color-border` × opacity | `border-border/20`, `opacity-30` |
| Основной текст      | `--color-foreground`       | `text-foreground`                |
| Вторичный текст     | `--color-muted-foreground` | `text-muted-foreground`          |
| Суммы (tabular)     | CSS `font-variant-numeric` | `tabular-nums`                   |
| Радиус карточек     | `--radius-lg`              | `rounded-lg`                     |
| Размер суммы ставки | (нет токена, utility)      | `text-4xl`                       |

---

## 8. A11y (WCAG 2.2 AA)

### 8.1 Убранные элементы

- Ссылка «Все мои выплаты» (`<Link>`) удалена — убирает один интерактивный элемент из
  tab order. Это упрощает focus path, не нарушает его.

### 8.2 Новые элементы

- Summary zone — не интерактивная, семантически `<div>`. Нет ARIA-изменений.
- Badge: `min-w-[72px] justify-center` — визуальное выравнивание. Badge-контент остаётся
  читаемым (`text-xs`). Контраст «Выплачено» / «Ожидание» — не меняется, токены те же.

### 8.3 Target size (SC 2.5.8)

Интерактивных элементов в SalaryCard после изменений нет (ссылка удалена, Badge не интерактивен).

### 8.4 Focus order после изменений

1. ProjectSwitcher (если > 1 проекта)
2. ProjectInfoCard → TG/phone ссылки (HrInline)
3. PersonaCard → кнопка «Открыть легенду»
4. SalarySnapshotCard — нет интерактивных элементов (ссылка удалена)
5. ProjectCredentialsSection → «+ Добавить» → строки → [👁] кнопки

### 8.5 Reflow (SC 1.4.10)

`grid-cols-3` → при zoom 400% → `grid-cols-1`, обе колонки стекаются вертикально.
`self-start` на левом div — не влияет на mobile layout (col-span-1 нет stretch).

---

## 9. Anti-pattern checklist (Mode C)

- Нет градиентов.
- Нет `rounded-2xl` везде — только `rounded-lg` Card.
- Нет `shadow-xl`.
- Нет decorative blobs или иконок для украшения.
- Summary zone — функциональная (повторяет ставку как anchor внизу), не декоративная.
- `text-4xl` для суммы — единственный размерный акцент, на 2/3-ширины карточке оправдан.
- `uppercase tracking-wider` на «ПОСЛЕДНИЕ ВЫПЛАТЫ» — SaaS-паттерн (не AI-slop,
  используется в shadcn/ui TableHead по умолчанию).
- Нет `transition: all`.

---

## 10. Edge cases

| Кейс                      | Поведение                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Нет ставки, нет выплат    | Rate zone: «Ставка не назначена» italic. Payments zone: «Выплат ещё не было» italic. Summary zone: скрыта (только при `hasRate`). Карточка h-full от grid row — пустая, но без дыры (grid row = левый стек). |
| Нет ставки, есть выплаты  | Rate zone: «Ставка не назначена». Payments zone: строки выплат. Summary zone: скрыта.                                                                                                                        |
| Есть ставка, нет выплат   | Rate zone: «500 USD / месяц». Payments zone: «Выплат ещё не было». Summary zone: «Ставка за месяц 500 USD». Карточка заполнена через flex-1 spacer.                                                          |
| 1 строка выплаты          | Одна строка в payments zone. Spacer компенсирует. Summary внизу.                                                                                                                                             |
| 3 строки выплат (номинал) | 3 строки. Spacer сокращается. Summary внизу.                                                                                                                                                                 |
| Данные загружаются        | Skeleton: `flex-1 min-h-[200px]` — skeleton занимает grid row height.                                                                                                                                        |
| Мобайл < 768px            | `grid-cols-1` → `self-start` на левом div неактивен (одна колонка). SalaryCard — h-fit (flex-1 на col-span-1 неэффективен без stretch-соседа). Нормальное поведение.                                         |

---

## 11. Handoff-чеклист для Coder

### apps/web/app/routes/crm/project.tsx

- [ ] `HubCards`: убрать `items-start` из grid className → `"grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"`
- [ ] Левый `motion.div`: добавить `self-start` → `"lg:col-span-1 flex flex-col gap-4 self-start"`
- [ ] Правый `motion.div`: добавить `flex flex-col` → `"lg:col-span-2 flex flex-col"`
- [ ] Передать `className="flex-1"` в `SalarySnapshotCard`
- [ ] `SalarySnapshotCard`: добавить `flex flex-col` к `baseClass` → `'border-border/40 bg-card flex flex-col'`
- [ ] `SalarySnapshotCard` CardHeader: добавить `shrink-0`
- [ ] `SalarySnapshotCard` CardContent: `className="space-y-4"` → `className="flex flex-col flex-1 pt-0 gap-0"`
- [ ] Rate zone: `text-3xl` → `text-4xl`; добавить `pb-4` к wrapper; `ml-auto` на «/ мес»
- [ ] `<Separator>` после rate zone: добавить `mb-4 shrink-0`
- [ ] Payments zone header: добавить `uppercase tracking-wider`
- [ ] Badge в строках выплат: добавить `min-w-[72px] justify-center`
- [ ] Добавить `<div className="flex-1" />` spacer после payments zone
- [ ] Добавить summary zone (`mt-auto pt-3 shrink-0`) с `<Separator>` + строкой ставки
- [ ] **УДАЛИТЬ** `<Link to="/crm/finance" ... data-testid="salary-all-link">...</Link>`
- [ ] Убрать `Link` из импорта `createFileRoute, Link, useNavigate` → оставить `createFileRoute, useNavigate`
- [ ] Убрать `ExternalLink` из lucide-react импорта
- [ ] Обновить skeleton правой колонки: `<div className="lg:col-span-2 flex flex-col"><Skeleton className="flex-1 min-h-[200px] rounded-lg" /></div>`

### E2E (AutoTest зона)

- [ ] Удалить тест на `salary-all-link` (элемент удалён)
- [ ] Добавить проверку что `salary-snapshot-card` не содержит ссылки на `/crm/finance`
- [ ] Добавить smoke: `salary-summary` visible когда `salaryMeta.monthlySalary` не null

---

## 12. Открытые вопросы для PM

1. **Summary zone при нет ставки**: карточка будет пустой снизу (spacer заполняет). Это
   приемлемо? Альтернатива — показывать summary zone с «—» при нет ставки.

2. **Количество строк выплат**: сейчас API возвращает 3 последних. При 0 строк — только
   «Выплат ещё не было». При большом контенте (3 строки) — spacer сократится, summary
   прижмётся снизу. Если владелец хочет видеть больше строк — увеличить лимит в
   `useSalaryTransactions()` до 5, spec от этого не меняется.

3. **«Все мои выплаты» убрана навсегда?** Убрана полностью (требование UT). Если нужен
   способ попасть в историю выплат — это через навигацию «Финансы» (уже есть в сайдбаре).
   Уточнить у владельца что ссылки больше нет совсем, не перенести в другое место.
