# Design Spec: Хаб «Мой проект» + страница «Легенда» + навигация JUNIOR

> Mode A — Design Direction (pre-feature)
> Spec slug: `junior-hub`
> Фаза: junior UX рефактор, фаза 2
> Coder task: `.claude/tasks/task-junior-ux-2-hub.md`
> Автор: ui-ux-designer · 2026-06-11

---

## 1. Direction (frontend-design-direction)

### 1.1 Purpose

Интерфейс решает три задачи для JUNIOR:

1. **Хаб «Мой проект»** — одним взглядом увидеть статус активного проекта, персону «синьора» по легенде, статус своего контракта, последнюю зарплату, контакт HR. Заменяет пустой дашборд.
2. **Страница «Легенда»** — читать и дополнять живой документ персоны (персона / cover story / журнал событий) перед клиентскими коллами.
3. **Навигация** — точно 5 разделов без лишнего шума (Мой проект · Легенда · Финансы · Документы · Профиль).

### 1.2 Audience

**Кто:** JUNIOR-разработчик, активный member проекта.
**Паттерн использования:** 1–3 сеанса в день, каждый по 1–3 минуты. Сценарии:

- Утро: проверить статус контракта, последнюю зарплату перед звонком с клиентом.
- Перед колл-ом: открыть «Легенду», освежить персону + cover story.
- После события: добавить запись в журнал легенды («клиент спросил про образование, сказали МГУ»).
- Периодически: перейти в Финансы / Документы по быстрым ссылкам.

Джун **не управляет** — он потребитель информации + ведёт журнал. Интерфейс должен минимизировать когнитивную нагрузку: нет лишних действий, нет ADMIN-шума, нет данных которые ему не принадлежат.

### 1.3 Tone

`dense / quiet / scannable`

- Dense: максимум нужной информации без скролла на десктопе (≥ 1024px).
- Quiet: без декоративных элементов. Карточки с `border-border/40` и `bg-card`, не `bg-gradient-*`.
- Scannable: иерархия через размер шрифта, не через цвет. Статусы — Badge с существующими variants (`role`, `outline`, `secondary`). Суммы — `tabular-nums`.

**Запрещено для этого экрана:** purple/gradient hero, glass morphism, oversized cards, decorative icons без семантики.

### 1.4 Memorable detail

**Персона-карточка «Синьор проекта»** — единственный элемент с характером: аватар-инициалы на `bg-yellow-subtle` с `text-primary` (бренд-жёлтый), жирное ФИО из легенды, `text-muted-foreground` для роли. Это сигнал: «кем ты являешься для клиента». Никакого реального фото, никаких контактов синьора — только persona.

Эффект: переход из Хаба в Легенду ощущается как «открываю своё досье», а не «открываю настройки».

### 1.5 Constraints

- Tailwind v4 CSS-first (`@theme inline` tokens из `globals.css`), без hardcoded hex
- shadcn/ui компоненты как base (Card, Badge, Button, Avatar, Skeleton, Separator, Tooltip, ScrollArea)
- Framer Motion для enter-анимаций (stagger pattern, уже используется в `crm/index.tsx`)
- WCAG 2.2 Level AA — минимум target size 24×24px, focus ring, contrast 4.5:1 text / 3:1 UI
- Responsive: 320 / 768 / 1024 / 1440
- Russian UI: все user-facing тексты на русском
- TanStack Router file-based routes (`apps/web/app/routes/crm/`)
- TanStack Query для data fetching (переиспользовать хуки: `useLegend`, `useAddLegendEntry`, `useUpsertLegend`)
- НЕ показывать реального синьора/дропа: ФИО + роль — только из `legend.fullName` / `legend.presentedRole`
- НЕ показывать `rate` / `currency` / распределения проекта

---

## 2. Component list

### 2.1 Существующие shadcn/ui (переиспользовать без изменений)

| Компонент                                                        | Где используется                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `Card`, `CardHeader`, `CardContent`, `CardTitle`                 | Все блоки хаба и страницы легенды                                     |
| `Avatar`, `AvatarFallback`                                       | Аватар-инициалы персоны; нет `AvatarImage` — только initials          |
| `Badge`                                                          | Статус контракта, статус выплаты, статус проекта                      |
| `Button`                                                         | CTA «Подписать», «Открыть легенду», «Добавить запись», быстрые ссылки |
| `Skeleton`                                                       | Loading-состояние всех блоков хаба                                    |
| `Separator`                                                      | Разделитель в блоке HR, между секциями легенды                        |
| `Tooltip`, `TooltipProvider`, `TooltipTrigger`, `TooltipContent` | Collapsed-sidebar tooltips, hint на суммах                            |
| `ScrollArea`                                                     | Журнал легенды при > 5 записях                                        |
| `Textarea`                                                       | Поле добавления записи в журнал                                       |
| `Input`, `Label`                                                 | Форма редактирования легенды (персона / cover)                        |

### 2.2 Существующие компоненты проекта (переиспользовать)

| Компонент                                           | Где                                            | Как использовать                       |
| --------------------------------------------------- | ---------------------------------------------- | -------------------------------------- |
| `ProjectLogo`                                       | `components/projects/ProjectLogo.tsx`          | Логотип в карточке проекта хаба        |
| `ProjectLegendSection`                              | `components/projects/ProjectLegendSection.tsx` | На странице «Легенда» — весь edit-flow |
| `useLegend`, `useUpsertLegend`, `useAddLegendEntry` | `hooks/use-legend.ts`                          | Data layer легенды                     |
| `BrandMark`                                         | `components/brand-mark.tsx`                    | Уже в sidebar                          |
| `useActiveTeam`                                     | `hooks/use-active-team.ts`                     | Получить HR-контакт из команды         |

### 2.3 Новые компоненты (Coder создаёт)

| Компонент / хук      | Файл (предлагаемый)                                    | Ответственность                                             |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| `JuniorProjectHub`   | `routes/crm/project.tsx` (переписать / заменить)       | Корневой компонент хаба                                     |
| `ProjectInfoCard`    | `routes/crm/project/components/ProjectInfoCard.tsx`    | Карточка проекта (лого · компания · домен · старт · статус) |
| `PersonaCard`        | `routes/crm/project/components/PersonaCard.tsx`        | Персона «синьора»: инициалы · ФИО · роль · CTA              |
| `ContractStatusCard` | `routes/crm/project/components/ContractStatusCard.tsx` | Статус контракта + CTA «Подписать»                          |
| `SalarySnapshotCard` | `routes/crm/project/components/SalarySnapshotCard.tsx` | Последняя выплата (сумма · месяц · статус) + ссылка         |
| `HrContactCard`      | `routes/crm/project/components/HrContactCard.tsx`      | HR: имя + контакт                                           |
| `QuickLinksBar`      | `routes/crm/project/components/QuickLinksBar.tsx`      | Быстрые ссылки: Легенда · Документы · Финансы               |
| `ProjectSwitcher`    | `routes/crm/project/components/ProjectSwitcher.tsx`    | Переключатель при > 1 активном проекте                      |
| `LegendPage`         | `routes/crm/legend.tsx`                                | Страница «Легенда» (обёртка)                                |
| `LegendPersonaBlock` | `routes/crm/legend/components/LegendPersonaBlock.tsx`  | Персона-блок с аватаром                                     |
| `LegendCoverBlock`   | `routes/crm/legend/components/LegendCoverBlock.tsx`    | Cover story блок                                            |
| `LegendJournalBlock` | `routes/crm/legend/components/LegendJournalBlock.tsx`  | Журнал (append-only)                                        |
| `useJuniorProject`   | `hooks/use-junior-project.ts`                          | Query `/api/projects/my` → активный проект(ы) JUNIOR        |

> **Примечание по route:** `routes/crm/project.tsx` (без `$projectId`) — новый route `/crm/project` только для JUNIOR. Существующий `routes/crm/projects/$projectId.tsx` не трогается.

---

## 3. Token map

Все токены из `apps/web/app/styles/globals.css`. Новых токенов не нужно.

| Назначение                         | Token                                     | Tailwind class                |
| ---------------------------------- | ----------------------------------------- | ----------------------------- |
| Фон страницы                       | `--color-background`                      | `bg-background`               |
| Карточки                           | `--color-card`                            | `bg-card`                     |
| Elevated surfaces (sidebar active) | `--color-surface`                         | `bg-surface`                  |
| Граница карточек                   | `--color-border`                          | `border-border/40`            |
| Основной текст                     | `--color-foreground`                      | `text-foreground`             |
| Вторичный текст (captions, hints)  | `--color-muted-foreground`                | `text-muted-foreground`       |
| Аватар-инициалы: фон               | `--color-yellow-subtle`                   | `bg-yellow-subtle`            |
| Аватар-инициалы: текст             | `--color-primary`                         | `text-primary`                |
| CTA кнопки (primary)               | `--color-primary`                         | `bg-primary` (Button default) |
| Hover/ghost states                 | `--color-accent`                          | `hover:bg-accent`             |
| Destructive (ошибки, отклонения)   | `--color-destructive`                     | `text-destructive`            |
| Радиус (карточки)                  | `--radius-lg` = `var(--radius)`           | `rounded-lg` (`0.625rem`)     |
| Радиус (кнопки внутри карточки)    | `--radius-md` = `var(--radius) - 2px`     | `rounded-md`                  |
| Суммы (табличные цифры)            | CSS: `font-variant-numeric: tabular-nums` | `tabular-nums` (Tailwind v4)  |

**Concentric radius (make-interfaces-feel-better):** Карточка `rounded-lg` (0.625rem) → Button внутри `rounded-md` (0.5rem). Padding карточки `p-4` (1rem) — разница достаточная, оптика корректна.

**Статус-цвета для Badge** — используем существующие variants из `components/ui/badge.tsx`:

- Контракт подписан → `variant="outline"` + иконка CheckCircle `text-green-500`
- Контракт не подписан → `variant="default"` (primary-жёлтый) — CTA
- Выплата PAID → `variant="outline"` зелёный tint
- Выплата PENDING → `variant="secondary"`
- Статус проекта ACTIVE → `variant="outline"` с зелёным dot
- Статус проекта CLOSED → `variant="secondary"` muted

> Если `badge.tsx` не содержит статусные variants — добавить `status-active` / `status-closed` / `paid` / `pending` как CSS-var-based variants (не hardcoded hex) в `badge.tsx`. Проверить `badge.tsx` перед реализацией.

---

## 4. Layout spec

### 4.1 Хаб «Мой проект» (`/crm/project`)

#### Desktop ≥ 1024px (2-колоночный CSS grid)

```
┌─────────────────────────────────────────────────────────┐
│ [ProjectSwitcher — только если >1 проект]               │
├──────────────────────┬──────────────────────────────────┤
│ ProjectInfoCard      │ PersonaCard                      │
│ (лого · компания ·  │ (аватар-инициалы · ФИО · роль ·  │
│  домен · старт ·    │  «Открыть легенду»)               │
│  статус)            │                                   │
├──────────────────────┼──────────────────────────────────┤
│ ContractStatusCard   │ SalarySnapshotCard               │
│ (статус · CTA)      │ (сумма · месяц · статус · ссылка) │
├──────────────────────┴──────────────────────────────────┤
│ HrContactCard (имя · контакт)                           │
├─────────────────────────────────────────────────────────┤
│ QuickLinksBar (Легенда · Документы · Финансы)           │
└─────────────────────────────────────────────────────────┘
```

CSS: `grid-cols-1 md:grid-cols-2 gap-4`. Строки 1-2 = `grid-cols-2`. Строки 3-4 = `col-span-full`.

#### Mobile < 768px (1 колонка)

Порядок блоков: ProjectInfoCard → PersonaCard → ContractStatusCard → SalarySnapshotCard → HrContactCard → QuickLinksBar. Stacked, полная ширина.

#### Стек мобильный < 320px

Карточки `w-full`, без горизонтального overflow. Аватар инициалы `h-10 w-10` (40×40px, min hit area = 44×44px через padding). Кнопки минимум `h-9` (36px) + touch padding.

### 4.2 Страница «Легенда» (`/crm/legend`)

#### Desktop ≥ 1024px

```
┌─────────────────────────────────────────────────────────┐
│ Заголовок «Легенда» + subtitle (проект · синьор)        │
├──────────────────────┬──────────────────────────────────┤
│ LegendPersonaBlock   │ LegendCoverBlock                 │
│ (ФИО · ДР · адрес · │ (роль · стек · бэкграунд)       │
│  хобби + edit)      │ + edit)                          │
├──────────────────────┴──────────────────────────────────┤
│ LegendJournalBlock (журнал — append-only лента)         │
└─────────────────────────────────────────────────────────┘
```

#### Mobile < 768px: 1 колонка, stacked.

### 4.3 Навигация JUNIOR

`NAV_ITEMS` в `nav-sidebar.tsx` — для роли `JUNIOR` ровно 5 пунктов:

| #   | Пункт      | Icon                | Route            |
| --- | ---------- | ------------------- | ---------------- |
| 1   | Мой проект | `Home` (lucide)     | `/crm/project`   |
| 2   | Легенда    | `BookOpen` (lucide) | `/crm/legend`    |
| 3   | Финансы    | `DollarSign`        | `/crm/finance`   |
| 4   | Документы  | `FileText`          | `/crm/documents` |
| 5   | Профиль    | `UserCircle`        | `/crm/profile`   |

Убрать у JUNIOR: `Дашборд` (`/crm/dashboard`) · `Команда` · `Проекты` · `Собеседования`.
Остальные роли — без изменений.

Redirect: при логине JUNIOR → `/crm/project` (аналогично DROP → `/crm/profile`).
Применить в `routes/crm/index.tsx` (CrmDashboard component, рядом с DROP-редиректом).

---

## 5. Motion spec

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

Применять к `motion.div` обёрткам карточек при первой загрузке хаба.

**Правила motion (make-interfaces-feel-better):**

- Enter: opacity + `translateY(12px)`, stagger 60ms между карточками.
- Exit: не нужен на хабе (страница не меняет состав карточек).
- Skeleton → данные: без анимации перехода (React просто меняет), чтобы не было дерганья.
- Icon-swap (Pencil → Save, CheckCircle → Spinner): cross-fade через `transition-property: opacity, transform; duration: 150ms`.
- Запрещено: `transition: all`, `will-change: all`, scroll-triggered анимации.
- Переключатель проектов (ProjectSwitcher): `transition-property: opacity; duration: 200ms` при смене активного проекта.

---

## 6. A11y critical paths (WCAG 2.2)

**Skill: `accessibility` применён для следующих критических путей:**

### 6.1 Focus order (SC 1.3.2 / 2.4.3)

Логический порядок фокуса на хабе:

1. ProjectSwitcher (если есть)
2. ProjectInfoCard (нет интерактивных — tabindex не нужен)
3. PersonaCard → кнопка «Открыть легенду»
4. ContractStatusCard → кнопка «Подписать контракт» (если есть)
5. SalarySnapshotCard → ссылка «Все мои выплаты»
6. HrContactCard (нет интерактивных)
7. QuickLinksBar → 3 ссылки

Порядок в DOM должен совпадать с визуальным — не использовать `order` CSS без `tabindex`.

На странице «Легенда»:

1. Заголовок (h1)
2. PersonaBlock кнопка «Редактировать» → форма (if editing: поля в order → кнопка Сохранить → кнопка Отмена)
3. CoverBlock кнопка «Редактировать»
4. JournalBlock → лента записей (li) → кнопка «Добавить запись» → textarea (if open) → Сохранить / Отмена

### 6.2 Target size (SC 2.5.8 minimum 24×24px; aim 44×44px)

| Элемент                           | Визуальный размер | Hit area                                    | Класс                            |
| --------------------------------- | ----------------- | ------------------------------------------- | -------------------------------- |
| Кнопка «Открыть легенду»          | `h-8` (32px)      | `h-9 px-3` ≥ 44px touch                     | `size="sm"` Button → ok          |
| Кнопка «Подписать контракт» (CTA) | `h-8` (32px)      | `h-9 px-4`                                  | `size="sm"` Button               |
| Аватар-инициалы (link к легенде)  | 40×40px           | `min-w-[44px] min-h-[44px]` якорный элемент |                                  |
| Быстрые ссылки QuickLinksBar      | `h-9` (36px)      | `h-10 px-3`                                 | `size="sm"` + `py-1`             |
| Кнопка «Добавить запись» (журнал) | `h-7` (28px)      | `h-8 min-w-[24px]`                          | Проверить ≥ 24px                 |
| Переключатель проектов            | `h-8`             | `h-9 px-3`                                  | SegmentedToggle или Button group |

### 6.3 Contrast (SC 1.4.3: 4.5:1 normal; SC 1.4.11: 3:1 UI)

Проверены токены из `globals.css`:

| Элемент                         | Foreground token                                         | Background token                | Ratio (approx)                                                                                    | Статус |
| ------------------------------- | -------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| Основной текст на карточках     | `--foreground` L=0.97                                    | `--card` L=0.12                 | > 10:1                                                                                            | PASS   |
| Muted text (captions)           | `--muted-foreground` L=0.58                              | `--card` L=0.12                 | ~5.5:1                                                                                            | PASS   |
| Аватар текст-инициалы           | `--primary` L=0.84 c=0.183                               | `--yellow-subtle` L=0.22 c=0.04 | **ВНИМАНИЕ** — проверить в реализации; при L-разнице < 0.5 contrast может упасть ниже 3:1 на dark |
| Badge «Подписать» (primary фон) | `--primary-foreground` L=0.08                            | `--primary` L=0.84              | > 7:1                                                                                             | PASS   |
| Зелёный status dot              | `oklch(0.65 0.2 142)` (CSS green-600) на `--card` L=0.12 | ~4.8:1                          | PASS                                                                                              |

> **Аватар-инициалы CRITICAL CHECK:** На dark mode `--yellow-subtle` = `oklch(0.22 0.04 85.3)`, текст `--primary` = `oklch(0.84 0.183 85.3)`. Lightness delta = 0.62 — достаточно. Однако Coder ОБЯЗАН верифицировать contrast checker инструментом после реализации. Альтернатива если падает: использовать `--surface` (L=0.16) фон + `--primary` текст.

### 6.4 Icon-only buttons — aria-label

| Элемент                                           | Требование                                          |
| ------------------------------------------------- | --------------------------------------------------- |
| Кнопка «Редактировать» персону (Pencil icon only) | `aria-label="Редактировать персону"`                |
| Кнопка «Редактировать» cover (Pencil icon only)   | `aria-label="Редактировать cover story"`            |
| Кнопка «Добавить запись» (Plus icon only)         | `aria-label="Добавить запись в журнал"`             |
| Кнопка collapse/expand ProjectSwitcher            | `aria-label="Переключить проект"` + `aria-expanded` |

Если кнопка содержит текст (`<Pencil /> Редактировать`) — `aria-label` не нужен.

### 6.5 Focus indicators (SC 2.4.11)

Используем `outline-ring` из `globals.css` (`outline-color: var(--ring)`). Проверить что все `Button variant="ghost"` и `Link` компоненты не имеют `outline: none` без альтернативы. shadcn/ui Button по умолчанию имеет `focus-visible:ring-2 focus-visible:ring-ring` — не переопределять.

### 6.6 Семантика

- Страница хаба: `<main>` → `<h1>Мой проект</h1>` (или `sr-only` если дизайн не показывает заголовок явно).
- Страница легенды: `<main>` → `<h1>Легенда</h1>` + `<section aria-labelledby>` для каждого блока (персона, cover, журнал).
- Журнал: `<ol>` (ordered) или `<ul>` — лента chronological записей.
- ProjectSwitcher при 2 проектах: `role="group"` + `aria-label="Выбор проекта"`, кнопки с `aria-pressed`.
- Статус-индикаторы: не только цвет — Badge + текст или иконка + текст всегда.

### 6.7 Reflow (SC 1.4.10)

Layout через CSS grid с `grid-cols-1 md:grid-cols-2` → при zoom 400% на 1440px экране = мобильный layout. Не должно быть горизонтального скролла. Проверить: карточки `w-full`, ProjectLogo `max-w-[3rem] shrink-0`.

---

## 7. Data contracts (что Coder берёт из API)

### 7.1 Хаб — данные

```
GET /api/projects/my
→ ProjectDto[] (только active для JUNIOR, per RBAC)
  - id, name, logoUrl, companyName, domain, startDate, status
  - НЕТ: rate, currency, seniorSharePercent, dropSharePercent

Из projectId → GET /api/projects/:id/legend
→ LegendDto { fullName, presentedRole, entries[] }
  Только fullName + presentedRole нужны для PersonaCard хаба

Из projectId → GET /api/contracts/my (или /api/employee-contracts?projectId=...)
→ { status: 'SIGNED' | 'PENDING_SIGNATURE' | null }

GET /api/finance/payout-requests?limit=1&sort=date_desc
→ last payout { amount, currency, month, status }
  Только SALARY-тип, только своё (JUNIOR RBAC)

Из team → HR user { displayName, telegramHandle, phone }
  (через /api/projects/:id — там есть seniorId, через team можно вытащить HR)
  Либо отдельный endpoint /api/projects/:id/team-hr → { name, contact }
```

> **Замечание Coder'у:** если `/api/projects/my` не существует — создать endpoint или переиспользовать `/api/projects?memberId=me`. Endpoint должен возвращать ТОЛЬКО проекты где current user = active project_member. Финансовая маскировка обязательна (без rate/currency).

### 7.2 Страница «Легенда» — данные

```
GET /api/projects/:projectId/legend
→ Legend { fullName, dateOfBirth, address, hobbies, presentedRole, presentedStack, backstory, entries[] }

PUT /api/projects/:projectId/legend (UpsertLegendDto)
→ Legend

POST /api/projects/:projectId/legend/entries (AddLegendEntryDto)
→ Legend (с обновлённым entries[])
```

Все хуки уже реализованы: `useLegend`, `useUpsertLegend`, `useAddLegendEntry` в `hooks/use-legend.ts`.

---

## 8. Edge cases

### 8.1 Хаб

| Кейс                               | Поведение                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Нет активных проектов              | Пустое состояние: `<EmptyState>` с текстом «Вас ещё не добавили в проект. Свяжитесь с вашим HR.» + контакт если доступен |
| Один активный проект (99% случаев) | ProjectSwitcher не рендерится                                                                                            |
| Два активных проекта               | ProjectSwitcher — `SegmentedToggle` вверху (существующий `segmented-toggle.tsx`)                                         |
| Более двух проектов                | Spec поддерживает до 2; если 3+ — показать первый active + предупреждение в console.warn (UI не ломается)                |
| Легенда не заполнена               | PersonaCard: аватар «?» инициалы, ФИО «—», роль «—», кнопка «Открыть легенду» (CTA)                                      |
| HR не найден в команде             | HrContactCard: «HR не назначен. Обратитесь к администратору.»                                                            |
| Контракт не существует             | ContractStatusCard: «Контракт не оформлен» (Badge secondary)                                                             |
| Нет выплат                         | SalarySnapshotCard: «Выплат пока нет» (text-muted-foreground)                                                            |
| Loading                            | Все карточки → `<Skeleton>` соответствующей высоты. Не показывать пустые карточки-рамки без данных.                      |
| API error                          | Toast.error (sonner) + retry кнопка в блоке где ошибка; другие карточки продолжают работать (независимые queries)        |

### 8.2 Страница «Легенда»

| Кейс                                         | Поведение                                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Легенда пустая (первое открытие)             | Пустое состояние с кнопкой «Создать легенду» (ADMIN/HR могут создать; JUNIOR видит CTA если он тоже редактор)                       |
| Журнал пустой                                | «Записей пока нет» + кнопка «Добавить первую запись»                                                                                |
| Пользователь — субъект легенды (senior/drop) | Страница `/crm/legend` для них недоступна (бэк отдаёт 403); на фронте: redirect на `/crm/profile` или пустое состояние с сообщением |
| ACCOUNTANT / другой SENIOR                   | 403 от `/api/projects/:id/legend`; хук `useLegend` обрабатывает 403 → null; страница показывает «У вас нет доступа»                 |
| Журнал > 10 записей                          | ScrollArea с фиксированной высотой `max-h-80` (20rem)                                                                               |
| Текст записи > 500 символов                  | Textarea `maxLength={2000}`, счётчик «X / 2000» под textarea                                                                        |
| Ошибка сохранения легенды                    | Toast.error + форма остаётся открытой (не закрывать при ошибке)                                                                     |
| Конкурентное редактирование                  | `staleTime: 30_000` в useLegend; при успешном upsert → invalidate query → re-fetch последние данные                                 |

---

## 9. data-testid map (для AutoTest)

Стабильные селекторы для E2E тестов — только `data-testid`, не классы:

| data-testid               | Элемент                                          |
| ------------------------- | ------------------------------------------------ |
| `junior-hub`              | Корневой div хаба `JuniorProjectHub`             |
| `project-info-card`       | `ProjectInfoCard`                                |
| `persona-card`            | `PersonaCard`                                    |
| `persona-fullname`        | Имя «синьора» из легенды (ФИО)                   |
| `persona-role`            | Роль «синьора» (presentedRole)                   |
| `persona-open-legend-btn` | Кнопка «Открыть легенду»                         |
| `contract-status-card`    | `ContractStatusCard`                             |
| `contract-status-badge`   | Badge со статусом контракта                      |
| `contract-sign-btn`       | CTA «Подписать контракт» (если visible)          |
| `salary-snapshot-card`    | `SalarySnapshotCard`                             |
| `salary-last-amount`      | Сумма последней выплаты (tabular-nums)           |
| `salary-all-link`         | Ссылка «Все мои выплаты»                         |
| `hr-contact-card`         | `HrContactCard`                                  |
| `quick-links-bar`         | `QuickLinksBar`                                  |
| `quick-link-legend`       | Ссылка «Легенда» в QuickLinksBar                 |
| `project-switcher`        | ProjectSwitcher (только при > 1 проект)          |
| `legend-page`             | Корневой div страницы «Легенда»                  |
| `legend-persona-block`    | `LegendPersonaBlock`                             |
| `legend-cover-block`      | `LegendCoverBlock`                               |
| `legend-journal-block`    | `LegendJournalBlock`                             |
| `legend-entry-add-btn`    | Кнопка «Добавить запись»                         |
| `legend-entry-textarea`   | Textarea для новой записи                        |
| `legend-entry-submit-btn` | Кнопка «Сохранить запись»                        |
| `legend-entry-item`       | `<li>` в журнале (каждая запись)                 |
| `junior-nav`              | Sidebar nav для JUNIOR (обёртка для count check) |

---

## 10. Что НЕ входит в scope этого spec'а

- UX синьора / дропа / HR / ADMIN — не трогаем.
- Финансовый раздел JUNIOR (чистка фильтров, subtitle документов) — следующая фаза (junior-ux-3-cleanup).
- Реальное фото на PersonaCard — решено: только аватар-инициалы (§2.3 продуктового дизайн-дока).
- Активные фичи work-hub (задачи, чат) — YAGNI.
- Страница «Профиль» изменения — лёгкая косметика (убрать просмотр чужих) в рамках существующего компонента.

---

## 11. Handoff-checklists для Coder

### Pre-implementation

- [ ] Прочитать продуктовую спеку `docs/architecture/2026-06-10-junior-ux-refactor-design.md` §4
- [ ] Проверить существующие `badge.tsx` variants — нужны ли новые для статусов
- [ ] Подтвердить endpoint `/api/projects/my` или эквивалент (task-junior-ux-1-backend)
- [ ] Проверить что `legend.fullName` / `legend.presentedRole` доступны в LegendDto из `@crm/shared`

### Post-implementation WCAG verify

- [ ] Аватар-инициалы PersonaCard: contrast checker (foreground `--primary` на `--yellow-subtle`) в dark и light mode
- [ ] Все кнопки-иконки имеют `aria-label` (§6.4)
- [ ] Tabular-nums на `salary-last-amount` (CSS `font-variant-numeric: tabular-nums`)
- [ ] Все `Button variant="ghost"` без `outline: none` — focus ring видимый
- [ ] Responsive smoke: 320px / 768px / 1024px / 1440px — нет горизонтального overflow
- [ ] Playwright screenshot: хаб + легенда на 1440px и 375px (в PR)

### Anti-slop check (Mode C)

- [ ] Нет purple/gradient backgrounds на карточках
- [ ] Нет `rounded-2xl` везде подряд — только `rounded-lg` / `rounded-md` из token system
- [ ] Нет `shadow-xl` на всех карточках без причины
- [ ] Нет decorative blobs / illustrations за данными
- [ ] Нет `transition: all`
