# Design Spec: Роль DROP — «Мой роутинг», финансовый кабинет, 4-навигация

> Mode A — Design Direction (pre-feature)
> Spec slug: `drop-role-ux`
> Источник-план: `docs/architecture/2026-06-10-drop-role-design.md`
> Прецедент структуры: `docs/design/junior-hub.md`
> Автор: ui-ux-designer · 2026-06-12

---

## 1. Direction (frontend-design-direction)

### 1.1 Purpose

Интерфейс решает три задачи для DROP:

1. **Хаб «Мой роутинг»** — единый центр управления платёжным потоком: текущий баланс/доля, список приходов требующих действия («Платить компании»), активные drop-проекты, быстрые действия. Заменяет текущий редирект на `/crm/profile`.
2. **Финансовый кабинет** — полная лента приходов (`pending → validated → paid`), баланс/доля breakdown, долг компании, статусы исходящих платежей, действия (зарегистрировать приход, инициировать крипто-платёж).
3. **Команда и Профиль** — своя одна drop-team (синьор/HR/бухгалтер, реальные контакты) + профиль с акцентом на реквизиты (кошельки).

### 1.2 Audience

**Кто:** DROP-участник схемы роутинга платежей.
**Паттерн использования:** 2–5 сеансов в неделю, каждый по 3–10 минут. Сценарии:

- Клиент перевёл деньги → Дроп открывает хаб, видит «Требует действия» → нажимает «Зарегистрировать приход».
- Бухгалтер подтвердил приход → Дроп получает сигнал → видит в «Требует действия» CTA «Платить компании» → инициирует платёж.
- Контроль баланса: раз в неделю — открыть хаб, проверить накопленное/долг.
- Координация: нужен контакт синьора или HR → «Команда».

Дроп **не управляет командой** и не видит чужих финансов — только своё. Интерфейс должен делать платёжный цикл (`приход → валидация → платёж компании`) максимально читаемым за один взгляд.

### 1.3 Tone

`dense / quiet / operational`

- **Dense:** Карточка баланса + блок «Требует действия» + список проектов — всё без скролла на 1024px+.
- **Quiet:** Карточки `border-border/40 bg-card`. Ни одного decorative gradient. Акценты — только через `--primary` (жёлтый) на CTA и statusных indikatorах.
- **Operational:** Финансовые суммы — `tabular-nums`. Статусы — Badge с семантикой (pending/validated/paid), не только цветом.

**Запрещено:** purple/gradient hero, glass morphism, oversized hero copy, cards inside cards, decorative blobs.

### 1.4 Memorable detail

**Карточка баланса** — единственный элемент с характером. Крупная сумма накопленной доли в `text-3xl font-bold tabular-nums text-foreground`, под ней 3 компактных метрики в ряд (`ставка % · в работе N · долг компании`). Визуальный сигнал: «это мои деньги, я их контролирую».

Блок «Требует действия» использует `--primary` (бренд-жёлтый) только для badge-счётчика и кнопки CTA — всё остальное нейтрально. Это создаёт иерархию: жёлтое = действие требуется сейчас.

### 1.5 Constraints

- Tailwind v4 CSS-first (`@theme inline` токены из `globals.css`), без hardcoded hex
- shadcn/ui компоненты как base (Card, Badge, Button, Avatar, Skeleton, Separator, Tooltip, ScrollArea, Table)
- Framer Motion для enter-анимаций (stagger pattern, как в `crm/index.tsx`)
- WCAG 2.2 Level AA — target size 24×24px, focus ring, contrast 4.5:1 text / 3:1 UI
- Responsive: 320 / 768 / 1024 / 1440
- Russian UI — все user-facing тексты на русском
- TanStack Router file-based routes (`apps/web/app/routes/crm/`)
- TanStack Query для data fetching (новые хуки: `useDropSummary`, `useDropIncomes`, `useDropProjects`)
- НЕ показывать данные других дропов, чужих команд, джунов, легенд

---

## 2. Навигация DROP (4 пункта)

### 2.1 Целевой состав NAV_ITEMS для роли `DROP`

| #   | Пункт       | Icon (lucide) | Route          |
| --- | ----------- | ------------- | -------------- |
| 1   | Мой роутинг | `Route`       | `/crm/routing` |
| 2   | Финансы     | `DollarSign`  | `/crm/finance` |
| 3   | Команда     | `UsersRound`  | `/crm/team`    |
| 4   | Профиль     | `UserCircle`  | `/crm/profile` |

**Изменения в `nav-sidebar.tsx` относительно текущего состояния:**

1. Добавить пункт `Мой роутинг` (icon `Route` из lucide) — первым, только для `DROP`.
2. Пункт `Команда` — уже есть в `roles: ['DROP']`, оставить.
3. Пункт `Финансы` — уже есть в `roles: ['DROP']`, оставить.
4. Пункт `Профиль` — уже есть в `roles: ['DROP']`, оставить.

**Redirect:** при логине DROP (или переходе на `/crm`) → `/crm/routing` (хаб).
Изменить в `routes/crm/index.tsx`: `user?.role === 'DROP'` → `navigate({ to: '/crm/routing' })`.

Текущее поведение (редирект на `/crm/profile`) — временный костыль из phase 1 (см. `index.tsx:78`).

### 2.2 Новый route

```
apps/web/app/routes/crm/routing.tsx       → /crm/routing
apps/web/app/routes/crm/routing/          → директория компонентов хаба
  components/
    DropBalanceCard.tsx
    DropActionRequiredBlock.tsx
    DropProjectsList.tsx
    DropQuickActions.tsx
```

---

## 3. Хаб «Мой роутинг» (`/crm/routing`)

### 3.1 Layout ≥ 1024px (desktop)

```
┌──────────────────────────────────────────────────────────────┐
│  <h1>Мой роутинг</h1>  text-muted-foreground: «Платёжный хаб»│
├───────────────────┬──────────────────────────────────────────┤
│  DropBalanceCard  │  DropActionRequiredBlock                  │
│  (баланс·доля·    │  (validated приходы → CTA «Платить»)     │
│   ставка·долг)    │                                          │
├───────────────────┴──────────────────────────────────────────┤
│  DropProjectsList  (drop-проекты: компания · синьор · N пр.)  │
├──────────────────────────────────────────────────────────────┤
│  DropQuickActions  (2 кнопки)                                 │
└──────────────────────────────────────────────────────────────┘
```

CSS: `grid-cols-1 md:grid-cols-2 gap-4`.

- Строка 1: `DropBalanceCard` (col 1) + `DropActionRequiredBlock` (col 2).
- Строка 2: `DropProjectsList` — `col-span-full`.
- Строка 3: `DropQuickActions` — `col-span-full`.

### 3.2 Layout < 768px (mobile, 1 колонка)

Порядок: DropActionRequiredBlock → DropBalanceCard → DropProjectsList → DropQuickActions.

На мобильном `DropActionRequiredBlock` идёт **первым** — дроп открывает хаб чтобы выполнить действие, баланс вторичен.

### 3.3 DropBalanceCard — детальная структура

**Данные:** `GET /api/finance/drop/me/summary` → `{ balance, dropSharePercent, pendingIncomesCount, debtToCompany }`.

Компонент — `Card` со структурой:

```
┌─ Card bg-card border-border/40 ─────────────────────────────┐
│  [Wallet icon h-4 w-4 text-muted-foreground] МОЙ БАЛАНС     │
│  ─────────────────────────────────────────────────────────  │
│  <big> $X,XXX.XX </big>  ← text-3xl font-bold tabular-nums  │
│  Накопленная доля                                           │
│  ─────────────────────────────────────────────────────────  │
│  [Percent] X%     [Clock] N в работе     [ArrowDown] $X.XX  │
│   Ставка           Приходов               Долг компании     │
└─────────────────────────────────────────────────────────────┘
```

**Детали метрик (нижняя строка):**

- Каждая метрика: `flex flex-col items-center gap-0.5`, текст значения `text-sm font-semibold tabular-nums`, подпись `text-xs text-muted-foreground`.
- Разделитель между метриками: `<Separator orientation="vertical" className="h-8" />`.
- `деbtToCompany` > 0 → цвет значения `text-destructive`. = 0 → `text-muted-foreground`.
- Icon: `Wallet` для заголовка, `Percent`, `Clock`, `ArrowDownCircle` (lucide) для метрик.

**Loading:** `<Skeleton className="h-32 w-full rounded-lg" />`.

**Error:** `text-xs text-destructive` + retry кнопка.

### 3.4 DropActionRequiredBlock — детальная структура

**Данные:** из того же `GET /api/finance/drop/me/summary` (поле `pendingIncomesCount`) + `GET /api/finance/drop/me/incomes?status=validated` → список validated приходов.

Два состояния:

**A. Есть validated приходы (требуют оплаты компании):**

```
┌─ Card border-border/40 ─────────────────────────────────────┐
│  [AlertCircle icon text-primary] ТРЕБУЕТ ДЕЙСТВИЯ           │
│  Badge variant="default" (primary жёлтый): "N приходов"     │
│  ─────────────────────────────────────────────────────────  │
│  [список validated приходов — max 3 строки]                  │
│  ┌ $1,500  TechCorp · 12 июн  → Button "Платить" sm ghost   │
│  ├ $800    StartupA · 10 июн  → Button "Платить" sm ghost   │
│  └ +N ещё...                   (link к /crm/finance)        │
│  ─────────────────────────────────────────────────────────  │
│  Button variant="default" w-full: "Платить компании"        │
└─────────────────────────────────────────────────────────────┘
```

Кнопка «Платить компании» (w-full primary) → `/crm/payments/initiate` (общий flow, бэкенд выбирает validated приходы автоматически). Кнопка «Платить» на строке → `/crm/payments/initiate/:incomeId`.

**B. Нет pending действий:**

```
┌─ Card border-border/40 ─────────────────────────────────────┐
│  [CheckCircle icon text-green-500] ВСЁ ОПЛАЧЕНО             │
│  ─────────────────────────────────────────────────────────  │
│  Нет приходов, требующих оплаты.      text-muted-foreground  │
└─────────────────────────────────────────────────────────────┘
```

**Loading:** `<Skeleton className="h-28 w-full rounded-lg" />`.

### 3.5 DropProjectsList — детальная структура

**Данные:** `GET /api/projects/drop/me` → `DropProjectDto[] { id, companyName, seniorDisplayName, incomesCount, status }`.

```
┌─ Card border-border/40 ─────────────────────────────────────┐
│  [Briefcase icon] МОИ DROP-ПРОЕКТЫ                          │
│  ─────────────────────────────────────────────────────────  │
│  ┌ [Avatar "ТC"] TechCorp  · Oleksiy Kovalenko  · 12 прих. ┐│
│  ├ [Avatar "SA"] StartupA  · Dmytro Marchenko   · 5 прих.  ││
│  └───────────────────────────────────────────────────────── ┘│
└─────────────────────────────────────────────────────────────┘
```

**Строка проекта:**

- `Avatar` (инициалы компании, `bg-secondary text-secondary-foreground`, `h-8 w-8`).
- `companyName` — `text-sm font-medium truncate flex-1`.
- `·` разделитель + `seniorDisplayName` — `text-xs text-muted-foreground`.
- `·` разделитель + `N прих.` — `text-xs text-muted-foreground tabular-nums`.
- `Badge variant="outline"` для статуса: ACTIVE → dot зелёный + «Активный»; CLOSED → «Закрытый» secondary.

**Пустое состояние:** «Нет активных drop-проектов. Обратитесь к администратору.»

**Loading:** 2× `<Skeleton className="h-10 w-full rounded-md" />`.

### 3.6 DropQuickActions

```
┌─ flex gap-3 ────────────────────────────────────────────────┐
│  [Plus icon] Зарегистрировать приход   Button variant="outline"│
│  [ArrowUpRight icon] Платить компании   Button variant="default"│
└─────────────────────────────────────────────────────────────┘
```

- «Зарегистрировать приход» — открывает существующий `CreateTransactionDialog` (компонент должен поддерживать `DROP_INCOME` тип; Coder проверяет).
- «Платить компании» — навигация на `/crm/payments/initiate` (или модальный flow, если существует).
- На мобильном: `flex-col w-full` (кнопки в колонку, полная ширина).

---

## 4. Финансовый кабинет (`/crm/finance` — drop-версия)

### 4.1 Стратегия

Существующий `/crm/finance` уже в nav для DROP. Задача — убедиться что он рендерит **drop-специфичный вид** когда `user.role === 'DROP'`. Coder должен проверить текущий `routes/crm/finance/` (или аналог) — там скорее всего SENIOR/ADMIN-ориентированный UI.

Вариант реализации: в `finance.tsx` добавить `if (user.role === 'DROP') return <DropFinancePage />`.

### 4.2 Layout drop-финансов ≥ 1024px

```
┌──────────────────────────────────────────────────────────────┐
│  <h1>Финансы</h1>                                            │
├──────────────────────────────────────────────────────────────┤
│  DropBalanceSummaryCard  (переиспользовать из хаба, col-full) │
├──────────────────────────────────────────────────────────────┤
│  Лента приходов (DropIncomesTable)              [Фильтры ↓]   │
│  фильтры: тип DROP_INCOME · статус · период                   │
├──────────────────────────────────────────────────────────────┤
│  DropPaymentsHistory  (исходящие платежи компании)           │
└──────────────────────────────────────────────────────────────┘
```

### 4.3 DropBalanceSummaryCard (расширенная версия для /crm/finance)

Та же карточка баланса из хаба (`DropBalanceCard`) + дополнительный breakdown:

```
Накоплено: $X,XXX.XX  |  Ставка: X%  |  В работе: N прих.  |  Долг: $X.XX
─────────────────────────────────────────────────────────────
Последний приход: $X,XXX.XX  TechCorp  12 июн  [Валидирован]
```

Переиспользовать компонент — просто проп `variant="compact"` (хаб) vs `variant="full"` (финансы).

### 4.4 DropIncomesTable

**Данные:** `GET /api/finance/drop/me/incomes?status=&type=&from=&to=&page=&limit=20`.

**Колонки таблицы:**

| Колонка  | Описание                                                |
| -------- | ------------------------------------------------------- |
| Дата     | `text-xs text-muted-foreground tabular-nums`            |
| Компания | Название клиента из прихода                             |
| Сумма    | `font-semibold tabular-nums` + currency                 |
| Тип      | Badge: `DROP_INCOME` → «Приход»                         |
| Статус   | Badge: pending/validated/paid (см. §4.5)                |
| Действие | Кнопка «Платить» — только если `status === 'validated'` |

shadcn/ui `Table` компонент: `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`.

**Фильтры:** `Select` для статуса + `Select` для периода (текущий месяц / прошлый / 3 мес / всё). Расположение: над таблицей, `flex gap-2 flex-wrap`.

**Пустое состояние:** «Приходов пока нет».

**Пагинация:** если записей > 20 — кнопки «Предыдущая» / «Следующая» под таблицей.

### 4.5 Статусные Badge для приходов

| Статус      | Badge variant | Иконка                | Текст         |
| ----------- | ------------- | --------------------- | ------------- |
| `pending`   | `secondary`   | `Clock h-3 w-3`       | «Ожидает»     |
| `validated` | `default`     | `CheckCircle h-3 w-3` | «Валидирован» |
| `paid`      | `outline`     | `CircleCheck h-3 w-3` | «Оплачен»     |
| `rejected`  | `destructive` | `XCircle h-3 w-3`     | «Отклонён»    |

Badge с иконкой слева: `<Badge variant="..."><Clock className="mr-1 h-3 w-3" />Ожидает</Badge>`.

Проверить в `badge.tsx` — если `destructive` variant не поддерживает текстовое содержимое — добавить. Не hardcoded hex.

### 4.6 DropPaymentsHistory

Упрощённая лента исходящих платежей (дроп → компания):

```
┌─ Card border-border/40 ─────────────────────────────────────┐
│  [ArrowUpRight] ПЛАТЕЖИ КОМПАНИИ                            │
│  ─────────────────────────────────────────────────────────  │
│  12 июн  $2,300  txHash: 0xabc...123   [Подтверждён]        │
│  05 июн  $1,100  txHash: 0xdef...456   [Ожидает]            │
└─────────────────────────────────────────────────────────────┘
```

`txHash` — `font-mono text-xs truncate max-w-[120px]`, Tooltip с полным хэшем.

---

## 5. Команда (`/crm/team` — drop-версия)

### 5.1 Стратегия

Существующий `/crm/team` сейчас показывает ВСЕ команды (баг: `TeamsService.findAll` не фильтрует для DROP). После бэкенд-фикса DROP получит только свою одну команду.

Фронтенд изменения минимальны: нет смысла строить отдельный компонент, пока бэкенд не исправлен. Spec описывает **целевой визуальный результат** после фикса.

### 5.2 Целевой вид drop-команды

```
┌──────────────────────────────────────────────────────────────┐
│  <h1>Моя команда</h1>                                        │
│  text-muted-foreground: «Ваша drop-команда для координации»  │
├──────────────────────────────────────────────────────────────┤
│  TeamCard: [название команды]                                 │
│  ─────────────────────────────────────────────────────────  │
│  [Avatar] Oleksiy Kovalenko    Синьор    📧 · 📱 · TG        │
│  [Avatar] Anna Lysenko         HR        📧 · 📱 · TG        │
│  [Avatar] Mykola Savchenko     Бухгалтер 📧 · 📱 · TG        │
└──────────────────────────────────────────────────────────────┘
```

- Контакты: иконки-ссылки `mailto:`, `tel:`, `https://t.me/` — реальные (дроп координируется напрямую).
- Read-only — нет кнопок редактирования/добавления.
- Подпись страницы: `«Ваша drop-команда для координации»` — explicit: дроп понимает зачем этот экран.

**Пустое состояние** (до бэкенд-фикса или если команда не назначена):
«Команда не назначена. Обратитесь к администратору.»

---

## 6. Профиль (`/crm/profile` — drop-акценты)

### 6.1 Изменения в существующем Профиле

Профиль уже работает. Spec описывает **акцент на Реквизиты** — таб «Реквизиты» должен быть активным по умолчанию при переходе с хаба.

**Redirect из хаба к реквизитам:** DropQuickActions или DropBalanceCard могут содержать ссылку:

```tsx
<Link to="/crm/profile" search={{ tab: 'requisites' }}>
  Мои реквизиты
</Link>
```

Таб «Реквизиты» (`/crm/profile?tab=requisites`) — кошельки (USDT ERC-20), банковские реквизиты. Критично для роутинга — Coder проверяет что реквизиты USDT видны и редактируемы под ролью DROP.

### 6.2 Видимость табов для DROP

| Таб       | DROP видит? | Примечание                                  |
| --------- | ----------- | ------------------------------------------- |
| Обзор     | Да          | Личные данные, доля                         |
| Проекты   | Нет         | Список проектов в профиле — лишнее для DROP |
| Команда   | Нет         | Есть отдельная страница /crm/team           |
| Реквизиты | Да          | Приоритетный таб                            |
| Документы | Да          | Контракт/онбординг                          |
| Финансы   | Нет         | Есть отдельная страница /crm/finance        |

Если у DROP в Профиле сейчас показаны все 6 табов — Coder скрывает лишние через RBAC-проп или `user.role` check.

---

## 7. Token map

Все токены из `apps/web/app/styles/globals.css` (`@theme inline {}`). **Новых токенов не добавляется.**

| Назначение                           | Token                               | Tailwind class                |
| ------------------------------------ | ----------------------------------- | ----------------------------- |
| Фон страницы                         | `--color-background`                | `bg-background`               |
| Карточки                             | `--color-card`                      | `bg-card`                     |
| Граница карточек                     | `--color-border`                    | `border-border/40`            |
| Основной текст                       | `--color-foreground`                | `text-foreground`             |
| Вторичный текст                      | `--color-muted-foreground`          | `text-muted-foreground`       |
| CTA, Badge «validated», Alert-иконка | `--color-primary`                   | `text-primary` / `bg-primary` |
| Hover/ghost states                   | `--color-accent`                    | `hover:bg-accent`             |
| Destructive (долг, rejected, ошибки) | `--color-destructive`               | `text-destructive`            |
| Avatar-фон (инициалы компании)       | `--color-secondary`                 | `bg-secondary`                |
| Avatar-текст                         | `--color-secondary-foreground`      | `text-secondary-foreground`   |
| Reveal-контейнер (secure zone)       | `--color-muted`                     | `bg-muted/40`                 |
| Радиус карточки                      | `--radius-lg` = `var(--radius)`     | `rounded-lg`                  |
| Радиус кнопок внутри карточки        | `--radius-md` = `var(--radius)-2px` | `rounded-md`                  |
| Суммы, хэши, метрики                 | CSS `font-variant-numeric`          | `tabular-nums`                |

**Concentric radius:** Карточка `rounded-lg` → кнопки внутри `rounded-md`. Padding карточки `p-4` / `p-5` — разница достаточна.

**Статус-цвета:** только через существующие Badge variants. Если `badge.tsx` не имеет `destructive` variant — добавить через CSS var (не hex). Проверить перед реализацией.

---

## 8. Motion spec

Используем тот же Framer Motion stagger pattern что в `routes/crm/index.tsx`:

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

Применять к `motion.div` обёрткам карточек хаба при первой загрузке.

**Правила motion:**

- Enter: opacity + `translateY(12px)`, stagger 60ms.
- Exit: не нужен на хабе.
- Skeleton → данные: без анимации (React условный рендер без перехода).
- Кнопки: `transition-property: background-color, color, opacity; duration: 150ms`.
- Запрещено: `transition: all`, `will-change: all`, scroll-triggered анимации.
- `DropActionRequiredBlock` — при появлении/исчезновении строк приходов: `<AnimatePresence>` + `motion.li` с `initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}`.

---

## 9. A11y critical paths (WCAG 2.2 AA)

### 9.1 Focus order (`/crm/routing`)

1. `<h1>Мой роутинг</h1>` (нет фокуса, anchor)
2. `DropBalanceCard` (нет интерактивных — tabindex не нужен)
3. `DropActionRequiredBlock` → строки приходов → кнопки «Платить» (по порядку) → кнопка «Платить компании»
4. `DropProjectsList` (строки — нет интерактивных, если без drill-down)
5. `DropQuickActions` → «Зарегистрировать приход» → «Платить компании»

DOM-порядок совпадает с визуальным. На мобиле порядок меняется (DropActionRequiredBlock первый визуально) — изменить DOM через `order` (CSS order), но обеспечить, что tabindex следует DOM: применить `order` только на grid-items, не через absolute positioning.

### 9.2 Target size (SC 2.5.8, min 24×24px)

| Элемент                         | Размер              | Hit area              |
| ------------------------------- | ------------------- | --------------------- |
| Кнопка «Платить» (строка)       | `h-7` (28px)        | `h-8 min-w-[60px]`    |
| Кнопка «Зарегистрировать»       | `h-9` (36px)        | OK                    |
| Кнопка «Платить компании» (CTA) | `h-9` (36px)        | OK                    |
| Icon-кнопки в таблице приходов  | `h-7 w-7` (28×28px) | OK (> 24px)           |
| Контактные иконки (Команда)     | `h-8 w-8` (32×32px) | `p-1.5` touch padding |

### 9.3 Contrast (SC 1.4.3: 4.5:1 normal; SC 1.4.11: 3:1 UI)

| Элемент                     | Foreground token                         | Background token     | Ratio  | Статус |
| --------------------------- | ---------------------------------------- | -------------------- | ------ | ------ |
| Основной текст на карточке  | `--foreground` L=0.97                    | `--card` L=0.12      | >10:1  | PASS   |
| Muted text                  | `--muted-foreground` L=0.58              | `--card` L=0.12      | ~5.5:1 | PASS   |
| `text-destructive` (долг)   | `--destructive` L=0.58                   | `--card` L=0.12      | ~4.8:1 | PASS   |
| Badge `validated` (primary) | `--primary-foreground` L=0.08            | `--primary` L=0.84   | >7:1   | PASS   |
| Avatar инициалы компании    | `--secondary-foreground` L=0.2           | `--secondary` L=0.94 | >8:1   | PASS   |
| Зелёный dot статуса         | `oklch(0.65 0.2 142)` на `--card` L=0.12 | ~4.8:1               | PASS   |

### 9.4 Icon-only кнопки (SC 1.1.1)

| Элемент                            | aria-label требование                                                  |
| ---------------------------------- | ---------------------------------------------------------------------- |
| «Платить» (строка прихода)         | `aria-label="Оплатить приход от {company}"`                            |
| Кнопка «retry» при ошибке загрузки | `aria-label="Повторить загрузку"`                                      |
| Reveal txHash (если есть toggle)   | `aria-label="Показать полный хэш"`                                     |
| Контактные иконки (email, tel, TG) | `aria-label="Email {name}"` / `"Телефон {name}"` / `"Telegram {name}"` |

Если кнопка содержит видимый текст — `aria-label` не нужен.

### 9.5 Focus indicators (SC 2.4.11)

Используем `outline-ring` из `globals.css` (`--ring`). Все `Button variant="ghost"` и `Link` — не переопределять `outline: none`. shadcn/ui Button по умолчанию `focus-visible:ring-2 focus-visible:ring-ring`.

### 9.6 Семантика

- Хаб: `<main>` → `<h1>Мой роутинг</h1>` (или `sr-only` если дизайн убирает заголовок).
- Список приходов: `<ul>` / shadcn `Table` (семантическая таблица с `<thead>`, `<tbody>`).
- Список drop-проектов: `<ul>` с `<li>` (не просто div-стак).
- DropActionRequiredBlock: `<section aria-label="Требует действия">`.
- DropBalanceCard: `<section aria-label="Мой баланс">`.
- Статус-метрики в BalanceCard: не только цвет — Badge + текст всегда (долг = текст + цвет).

### 9.7 Reflow (SC 1.4.10)

CSS grid `grid-cols-1 md:grid-cols-2` → при zoom 400% корректный mobile layout. Без горизонтального overflow. `tabular-nums` суммы — не ломают layout при крупных числах (`max-w-full overflow-hidden text-ellipsis` на контейнере).

---

## 10. Data contracts (API)

### 10.1 Хаб — данные

```
GET /api/finance/drop/me/summary
→ DropSummaryDto {
    balance: number           // накопленная доля, USD
    dropSharePercent: number  // процентная ставка дропа (5 по умолчанию)
    pendingIncomesCount: number  // приходов в статусе validated (требуют оплаты)
    debtToCompany: number    // долг компании перед дропом (доля синьора к выплате)
  }

GET /api/finance/drop/me/incomes?status=validated&limit=3
→ DropIncomeDto[] {
    id: string
    companyName: string
    amount: number
    currency: string
    createdAt: string        // ISO date
    status: 'pending' | 'validated' | 'paid' | 'rejected'
  }

GET /api/projects/drop/me
→ DropProjectDto[] {
    id: string
    companyName: string
    seniorDisplayName: string  // displayName синьора (НЕ реальное имя если маска)
    incomesCount: number
    status: 'active' | 'closed'
  }
```

**Замечание Coder'у:**

- Если `GET /api/finance/drop/me/summary` не существует — создать endpoint. Аналог: `getSummary` для SENIOR. Доступен только самому дропу (RBAC: `DROP` + `userId === req.user.id`).
- Если `GET /api/projects/drop/me` не существует — фильтр в `ProjectsService.findAll` для DROP: проекты где `drop_id = self`.
- `seniorDisplayName` — реальное имя синьора (дроп его видит, координируются напрямую согласно §4 plan-doc'а).

### 10.2 Финансы — данные

```
GET /api/finance/drop/me/incomes?status=&type=&from=&to=&page=1&limit=20
→ PaginatedResult<DropIncomeDto>

GET /api/finance/drop/me/payments
→ DropPaymentDto[] {
    id: string
    amount: number
    currency: string
    txHash?: string          // крипто-хэш если крипто-платёж
    status: 'pending' | 'confirmed' | 'failed'
    createdAt: string
  }
```

### 10.3 Хук-структура (новые хуки)

```ts
// apps/web/app/hooks/use-drop-summary.ts
export function useDropSummary() // query /api/finance/drop/me/summary

// apps/web/app/hooks/use-drop-incomes.ts
export function useDropIncomes(filters) // query /api/finance/drop/me/incomes
export function useDropProjects() // query /api/projects/drop/me
export function useDropPayments() // query /api/finance/drop/me/payments
```

Образцы: `use-legend.ts` и существующие finance hooks. Все ответы через `.parse()` из `@crm/shared` Zod-схем.

---

## 11. Edge cases

### 11.1 Хаб «Мой роутинг»

| Кейс                     | Поведение                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| Нет drop-проектов        | DropProjectsList: «Нет активных drop-проектов. Обратитесь к администратору.»                   |
| Нет validated приходов   | DropActionRequiredBlock: состояние B (CheckCircle + «Всё оплачено»)                            |
| `debtToCompany === 0`    | Метрика долга: `text-muted-foreground`, значение «$0.00», без destructive                      |
| `debtToCompany > 0`      | Метрика долга: `text-destructive`, Tooltip «Долг компании перед вами — доля синьора к выплате» |
| `balance === 0`          | Сумма «$0.00», без специальной стилизации (neutral)                                            |
| Validated приходов > 3   | В DropActionRequiredBlock показать 3 + ссылка «+N ещё» → `/crm/finance?status=validated`       |
| Ошибка API `/me/summary` | Toast + inline retry. Другие блоки продолжают работать (независимые queries)                   |
| Loading                  | Все блоки → Skeleton соответствующей высоты                                                    |

### 11.2 Финансы

| Кейс                             | Поведение                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| Нет приходов                     | DropIncomesTable: «Приходов пока нет»                                               |
| Нет платежей компании            | DropPaymentsHistory: «Нет истории платежей»                                         |
| `txHash` отсутствует             | Колонка txHash: «—» (dash)                                                          |
| Фильтр применён, нет результатов | «Нет приходов по выбранным фильтрам. Сбросить фильтры.» с кнопкой сброса            |
| Пагинация страница > 1           | Кнопки «Предыдущая» / «Следующая». Нет пагинации с > 3 страниц — не нужно для дропа |

### 11.3 Команда

| Кейс                                   | Поведение                                            |
| -------------------------------------- | ---------------------------------------------------- |
| Команда не назначена (до бэкенд-фикса) | «Команда не назначена. Обратитесь к администратору.» |
| Нет HR в команде                       | Строка HR скрыта (не показывать пустую строку)       |
| Нет бухгалтера                         | Аналогично                                           |
| Контакт пустой (нет telegram handle)   | Иконка TG скрывается (не рендерить пустую ссылку)    |

---

## 12. data-testid реестр (для AutoTest)

Стабильные селекторы — только `data-testid`, не классы:

| testid                       | Что                                            |
| ---------------------------- | ---------------------------------------------- |
| `drop-routing-hub`           | Корневой div хаба `/crm/routing`               |
| `drop-balance-card`          | `DropBalanceCard`                              |
| `drop-balance-amount`        | Сумма накопленной доли (tabular-nums)          |
| `drop-balance-share-percent` | Метрика ставки %                               |
| `drop-balance-pending-count` | Метрика «в работе» (кол-во приходов)           |
| `drop-balance-debt`          | Метрика долга компании                         |
| `drop-action-block`          | `DropActionRequiredBlock`                      |
| `drop-action-income-item`    | `<li>` строка validated прихода                |
| `drop-action-pay-btn-{id}`   | Кнопка «Платить» на строке прихода             |
| `drop-action-pay-all-btn`    | CTA «Платить компании» (общая)                 |
| `drop-action-more-link`      | Ссылка «+N ещё» к /crm/finance                 |
| `drop-projects-list`         | `DropProjectsList` блок                        |
| `drop-project-item-{id}`     | `<li>` строка drop-проекта                     |
| `drop-quick-register-btn`    | «Зарегистрировать приход»                      |
| `drop-quick-pay-btn`         | «Платить компании» (DropQuickActions)          |
| `drop-finance-page`          | Корневой div `/crm/finance` drop-view          |
| `drop-incomes-table`         | `DropIncomesTable`                             |
| `drop-income-row-{id}`       | `<tr>` строка прихода                          |
| `drop-income-status-{id}`    | Badge статуса прихода                          |
| `drop-income-pay-btn-{id}`   | Кнопка «Платить» в таблице                     |
| `drop-filter-status`         | Select фильтра статуса                         |
| `drop-filter-period`         | Select фильтра периода                         |
| `drop-payments-history`      | `DropPaymentsHistory` блок                     |
| `drop-payment-row-{id}`      | Строка исходящего платежа                      |
| `drop-nav`                   | Sidebar nav для DROP (обёртка для count check) |

---

## 13. Русские тексты (user-facing)

### Хаб «Мой роутинг»

| Элемент                          | Текст                                                        |
| -------------------------------- | ------------------------------------------------------------ |
| Заголовок страницы               | `«Мой роутинг»`                                              |
| Subtitle страницы                | `«Платёжный хаб»`                                            |
| BalanceCard заголовок            | `«МОЙ БАЛАНС»` (uppercase tracking-wider)                    |
| BalanceCard subtitle             | `«Накопленная доля»`                                         |
| Метрика ставки                   | `«Ставка»`                                                   |
| Метрика в работе                 | `«В работе»`                                                 |
| Метрика долг                     | `«Долг компании»`                                            |
| Tooltip долга                    | `«Доля синьора, которую компания должна выплатить вам»`      |
| ActionBlock заголовок (активный) | `«ТРЕБУЕТ ДЕЙСТВИЯ»`                                         |
| ActionBlock badge                | `«{N} приходов»` / `«{N} приход»` (склонение, если нужно)    |
| ActionBlock кнопка строки        | `«Платить»`                                                  |
| ActionBlock CTA                  | `«Платить компании»`                                         |
| ActionBlock ссылка доп.          | `«+{N} ещё»`                                                 |
| ActionBlock заголовок (пустой)   | `«ВСЁ ОПЛАЧЕНО»`                                             |
| ActionBlock пустой текст         | `«Нет приходов, требующих оплаты»`                           |
| ProjectsList заголовок           | `«МОИ DROP-ПРОЕКТЫ»`                                         |
| ProjectsList пустой              | `«Нет активных drop-проектов. Обратитесь к администратору.»` |
| QuickActions кнопка 1            | `«Зарегистрировать приход»`                                  |
| QuickActions кнопка 2            | `«Платить компании»`                                         |

### Финансы (drop-view)

| Элемент                   | Текст                                                      |
| ------------------------- | ---------------------------------------------------------- |
| Заголовок страницы        | `«Финансы»`                                                |
| IncomesTable заголовок    | `«МОИ ПРИХОДЫ»`                                            |
| Колонки таблицы           | `«Дата»  «Компания»  «Сумма»  «Тип»  «Статус»  «Действие»` |
| Фильтр статус placeholder | `«Все статусы»`                                            |
| Фильтр период placeholder | `«Все периоды»`                                            |
| Пустая таблица            | `«Приходов пока нет»`                                      |
| Фильтр без результатов    | `«Нет приходов по выбранным фильтрам.»`                    |
| Кнопка сброса             | `«Сбросить фильтры»`                                       |
| PaymentsHistory заголовок | `«ПЛАТЕЖИ КОМПАНИИ»`                                       |
| Пустая история            | `«Нет истории платежей»`                                   |
| Статусы приходов          | `«Ожидает»  «Валидирован»  «Оплачен»  «Отклонён»`          |
| Статусы платежей          | `«Ожидает»  «Подтверждён»  «Ошибка»`                       |

### Команда (drop-view)

| Элемент                    | Текст                                                  |
| -------------------------- | ------------------------------------------------------ |
| Заголовок страницы         | `«Моя команда»`                                        |
| Subtitle                   | `«Ваша drop-команда для координации»`                  |
| Пустое состояние           | `«Команда не назначена. Обратитесь к администратору.»` |
| Роль синьора               | `«Синьор»`                                             |
| Роль HR                    | `«HR»`                                                 |
| Роль бухгалтера            | `«Бухгалтер»`                                          |
| aria-label email-ссылки    | `«Email {name}»`                                       |
| aria-label tel-ссылки      | `«Телефон {name}»`                                     |
| aria-label telegram-ссылки | `«Telegram {name}»`                                    |

---

## 14. Handoff-чеклист для Coder

### Pre-implementation

- [ ] Прочитать план-документ `docs/architecture/2026-06-10-drop-role-design.md` (источник решений)
- [ ] Проверить существующие badge.tsx variants — нужен ли `destructive` variant с текстом
- [ ] Найти `CreateTransactionDialog` — поддерживает ли `DROP_INCOME` тип, или нужно расширить
- [ ] Проверить `/crm/payments/initiate/:incomeId` — существует ли route, доступен ли DROP
- [ ] Подтвердить endpoint `/api/finance/drop/me/summary` или создать (задача Coder §6 плана)
- [ ] Подтвердить endpoint `/api/projects/drop/me` или создать фильтр в `ProjectsService`
- [ ] Проверить `TeamsService.findAll` — фильтр для DROP (задача Coder §6 плана)
- [ ] `nav-sidebar.tsx` — добавить `Route` icon из lucide + `Мой роутинг` entry для `DROP`
- [ ] `routes/crm/index.tsx` — изменить redirect для DROP: `/crm/profile` → `/crm/routing`

### Post-implementation WCAG verify

- [ ] Все icon-only кнопки имеют `aria-label` (§9.4)
- [ ] tabular-nums на суммах (CSS `font-variant-numeric: tabular-nums`)
- [ ] `debtToCompany > 0` → `text-destructive` (§3.3)
- [ ] Responsive smoke: 320px / 768px / 1024px / 1440px — нет горизонтального overflow
- [ ] Playwright screenshot: хаб + финансы на 1440px и 375px (в PR)
- [ ] Все `Button variant="ghost"` — focus ring видимый

### Anti-slop check (Mode C)

- [ ] Нет purple/gradient backgrounds на карточках
- [ ] Нет `rounded-2xl` везде — только `rounded-lg` / `rounded-md`
- [ ] Нет `shadow-xl` на всех карточках без причины
- [ ] Нет decorative blobs / illustrations
- [ ] Нет `transition: all`
- [ ] Суммы — `tabular-nums`, не `text-2xl text-center bold` без контекста

---

## 15. Антипаттерны (проверить при code review)

- Не использовать `transition: all` на кнопках — только explicit properties.
- Не вкладывать Cards внутрь Card — DropActionRequiredBlock это не Card внутри Card (строки приходов — `<li>`, не вложенные Card).
- Не делать «баланс» крупным hero-элементом с gradient фоном — это operational SaaS, не wallet-app.
- Не хранить финансовые данные в localStorage / IndexedDB — только TanStack Query memory cache (см. persist query allow-list: finance/PII НИКОГДА).
- Не показывать skeleton-рамки без данных внутри — только Skeleton или данные, без пустых Card-оболочек.
- Не делать «Платить компании» деструктивным (красным) — это нормальное действие, не удаление. Primary-желтый.
- Не прятать метрику долга при `debtToCompany === 0` — показывать «$0.00» (дроп должен видеть что долга нет).
- Не добавлять `data-amount` или другие атрибуты с финансовыми данными в DOM-элементы — только отображение.
- `tabular-nums` обязателен на всех числовых полях (суммы, проценты, счётчики).
- Реальные контакты синьора/HR/бухгалтера в «Команде» — не маскировать (дроп координируется напрямую). Это отличие от JUNIOR-хаба где персона из легенды.
