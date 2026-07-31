# Design Spec — Company-share payout CTA + two-step payout modal

> **Design tier:** 1 (новая поверхность: полоса-призыв + новая модалка)
> **design-gate:** degraded (Tier 1, без Claude Design/Chrome-MCP сессии — ui-ux-designer агент
> не имеет доступа к браузерной генерации в этом окружении; см. `design-gate.md` §Fallback).
> Компенсировано: designer-authored HTML-мокапы, отрендеренные и сфотографированные Playwright
> **на реальных значениях токенов** из `apps/web/app/styles/globals.css` (`.dark`, default theme) —
> не абстрактные наброски, а пиксельно точные referenced-состояния. `design.png`-эквивалент = набор
> PNG в `docs/design/assets/company-share-cta/` (см. §Fidelity-референсы).
> **Status:** coder-ready
> **Референс задачи:** `.claude/tasks/task-company-share-cta.md`
> **Заменяемый диалог:** `apps/web/app/routes/_authenticated/finance/components/dialogs/PayoutDialog.tsx`

---

## 1. Контекст и направление

**Purpose.** Синьор декларирует приходы по проектам; бухгалтер их проверяет (`VALIDATED`). У синьора
накапливаются проверенные, но ещё не включённые ни в одну заявку приходы — по каждому из них он
должен оплатить долю CheekyCheeseIT. Сегодня вход в этот флоу спрятан в обычной кнопке внутри
плотного списка транзакций; владелец хочет заметный, но не крикливый CTA + модалку, которая не
теряет состояние заявки при неожиданном закрытии.

**Audience.** SENIOR (несколько раз в неделю), сканирует список, действует быстро. Money-path —
повышенная цена ошибки (двойная отправка, потеря состояния заявки, путаница «создано» vs «оплачено»).

**Tone.** Наследует `docs/design/foundation.md` §1 целиком: dense · quiet · scannable · operations
console. Полоса-призыв — АКЦЕНТНЫЙ, но не маркетинговый элемент: один жёлтый прожектор на экране,
не заливка.

**Memorable detail.** Явное разделение двух состояний одной заявки — «создана» (orange badge,
существующий `STATUS_LABELS.PENDING_PAYMENT`) vs «оплачено» (emerald badge, существующий
`STATUS_LABELS.PAID`) — плюс постоянная зелёная строка-подтверждение прямо под шапкой модалки на
шаге 2: «Заявка создана · Деньги ещё не отправлены». Это единственная НОВАЯ микро-деталь дизайна;
всё остальное — переиспользование существующего словаря статусов.

**Constraints.** Tailwind v4 + shadcn/ui + Radix, Russian UI, WCAG 2.2 AA, responsive 320–1440,
только существующие токены (`globals.css`), никакого нового визуального языка.

---

## 2. Token map

Ничего нового не вводится. Используются исключительно существующие семантические токены:

| Назначение                               | Token / класс                                                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Канвас страницы                          | `bg-background`                                                                                                                                                                                    |
| Карточка / диалог                        | `bg-card` + `border-border`                                                                                                                                                                        |
| Полоса-призыв — фон/бордер               | `bg-primary/8` (hover `bg-primary/12`) + `border-primary/25` (паттерн `hiring-strip.tsx` из `apps/landing`, адаптированный под dense-тон CRM — см. §4.1)                                           |
| Полоса-призыв — иконка-плашка            | `bg-primary/15 text-primary`                                                                                                                                                                       |
| Текст — основной / вторичный             | `text-foreground` / `text-muted-foreground`                                                                                                                                                        |
| Бренд / CTA                              | `bg-primary text-primary-foreground` (существующий `Button` `default` variant)                                                                                                                     |
| Суммы / числа                            | `tabular-nums` (обязательно везде — foundation.md §4)                                                                                                                                              |
| Статус «Ожидает выплаты»                 | существующий `STATUS_COLORS.PENDING_PAYMENT` + `STATUS_LABELS.PENDING_PAYMENT` (`finance/constants.ts`) — `bg-orange-500/15 text-orange-400 border-orange-500/30`                                  |
| Статус «Оплачено»                        | существующий `STATUS_COLORS.PAID` + `STATUS_LABELS.PAID` — `bg-emerald-500/15 text-emerald-400 border-emerald-500/30`                                                                              |
| Подтверждение «заявка создана» (строка)  | существующий emerald-confirmed паттерн `PayoutDetailDialog.tsx:532-547` (`border-emerald-500/30 bg-emerald-500/10`) — переиспользован для НОВОГО смысла (создание заявки, не подтверждение оплаты) |
| Ошибка                                   | `text-destructive` / `border-destructive` (существующий `status-box.error` паттерн `PayoutDetailDialog.tsx:549-567`)                                                                               |
| Индеterминate/выбранный чекбокс проекта  | `accent-primary` на нативном `<input type="checkbox">` (существующий паттерн `PayoutDialog.tsx:174`)                                                                                               |
| Радиус                                   | `rounded-lg` (диалог/карточки проектов) / `rounded-md` (иконка-плашка, инпуты)                                                                                                                     |
| Stepper — активный / готов / будущий шаг | `bg-primary text-primary-foreground` / `border-emerald-500/30 bg-emerald-500/15 text-emerald-400` / `border-border text-muted-foreground`                                                          |

---

## 3. Список компонентов

| Компонент                                       | Тип                                     | Источник / примечание                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`, `Badge`, `Card`/`CardContent`         | Существующий                            | shadcn/ui, без изменений                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Dialog`, `CrmDialogContent/Header/Body/Footer` | Существующий                            | `apps/web/app/components/ui/crm-dialog.tsx` — **используется с новым `className` на `CrmDialogContent`** (см. §6.1), проп `maxWidth` не меняется                                                                                                                                                                                                                                                                                                                |
| `STATUS_LABELS` / `STATUS_COLORS`               | Существующий (переиспользован)          | `finance/constants.ts` — источник бейджей «Ожидает выплаты» / «Оплачено» на шаге 2                                                                                                                                                                                                                                                                                                                                                                              |
| `fmtAmount`                                     | Существующий                            | `finance/constants.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| checkbox (native `<input type="checkbox">`)     | Существующий паттерн                    | `PayoutDialog.tsx:170-175` — переиспользуется 1:1, включая проектный tri-state (новое: `.indeterminate` через `ref`, стандартный DOM API, не новый компонент)                                                                                                                                                                                                                                                                                                   |
| **`CompanySharePayoutStrip`**                   | **НОВЫЙ**                               | Полоса-призыв. Presentational, `null` при пустом входе. Предлагаемый путь: `apps/web/app/routes/_authenticated/finance/components/CompanySharePayoutStrip.tsx`                                                                                                                                                                                                                                                                                                  |
| **`CompanySharePayoutModal`**                   | **НОВЫЙ** (заменяет `PayoutDialog.tsx`) | Двухшаговая модалка. Путь: `apps/web/app/routes/_authenticated/finance/components/dialogs/CompanySharePayoutModal.tsx`                                                                                                                                                                                                                                                                                                                                          |
| **`PayoutPaymentForm`**                         | **ИЗВЛЕЧЁННЫЙ существующий**            | Тело формы оплаты — извлекается из `PayoutDetailDialog.tsx` (строки 300-677: instruction-card / tx-hash input / dev-simulate / on-chain status / manual-confirm) в отдельный presentational-компонент БЕЗ изменения логики. Используется ОБОИМИ: (a) `PayoutDetailDialog.tsx` (обёртка `<Dialog>`, существующий путь «Оплатить» на уже созданной заявке — **без изменений поведения**) и (b) `CompanySharePayoutModal` (шаг 2, embedded, без своего `<Dialog>`) |
| Stepper (①Выбор → ②Оплата)                      | **НОВЫЙ, минимальный**                  | Некликабельный progress-индикатор из 2 сегментов внутри `CompanySharePayoutModal`. НЕ переиспользует `SegmentedToggle` (тот — mutually-exclusive **выбор**, кликабельный; здесь — **последовательный прогресс**, не кликабельный «назад» с шага 2 к шагу 1). Собран из тех же токенов (primary/emerald/border/muted), без новых CSS-переменных                                                                                                                  |
| Confirmation-strip «Заявка создана»             | **НОВЫЙ layout, existing tokens**       | `div role="status"` — переиспользует emerald `status-box` паттерн `PayoutDetailDialog.tsx:532-547`, новый текст под новую семантику                                                                                                                                                                                                                                                                                                                             |

**Итог:** 2 новых компонента (`CompanySharePayoutStrip`, `CompanySharePayoutModal`) + 1 извлечение
существующей логики без переписывания (`PayoutPaymentForm`) + 1 маленький новый некликабельный
паттерн (stepper), построенный из существующих токенов. `PayoutDialog.tsx` удаляется целиком.
`PayoutDetailDialog.tsx` **не удаляется** — становится тонкой обёрткой над `PayoutPaymentForm`
(поведение для существующих точек входа «Оплатить» на уже созданной заявке не меняется, см. §7).

---

## 4. Поверхность A — Полоса-призыв (`CompanySharePayoutStrip`)

### 4.1 Обоснование паттерна

Владелец сослался на «полосу найма» на лендинге (`apps/landing/app/components/marketing/hiring-strip.tsx`)
как ориентир тона. Структура один-в-один переносима: **весь блок — один кликабельный элемент**,
тонкий tinted-фон + бордер, никакого декоративного веса. Три отличия, обязательные из-за смены
контекста (marketing announcement → operations CTA):

1. **Без dismiss-крестика.** Финансовое обязательство нельзя «закрыть навсегда» — в отличие от
   маркетингового объявления это не шум, а актуальный факт. Полоса и так исчезает сама, когда платить
   нечего (см. §4.4).
2. **Не full-bleed / не центрировано.** CRM — не лендинг: полоса — обычный блок в контент-колонке
   (`rounded-lg border`, как остальные карточки), left-aligned, dense-тон.
3. **Содержит данные** (счётчик проектов + сумма), а не только призывный текст — CRM-паттерн
   `info-hint`-блоков (`CreateTransactionDialog.tsx:702`, `DropBalanceCard`) уже показывает числа
   внутри тонированных боксов.

### 4.2 Где рендерится и почему

| Место                                   | Позиция                                                                            | Обоснование                                                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SeniorDashboard.tsx`                   | **Самый верх** `space-y-6`-контейнера — ПЕРЕД KPI-гридом (перед строкой 134)       | «Заметный призыв» (формулировка владельца) — первое, что видит синьор с непогашенным долгом. Ниже KPI/EarningsStatsBlock/InProgressPanel полоса рисковала бы затеряться |
| `finance/index.tsx`                     | Первый элемент внутри `space-y-6`, ПЕРЕД `Card`, оборачивающей `TransactionsTable` | Буквально «вверху списка» (формулировка задачи) — список транзакций начинается сразу под ней                                                                            |
| `DropDashboard.tsx` / `DropFinancePage` | **НЕ добавляется**                                                                 | Вне скоупа задачи (только SENIOR); см. §9. `InProgressPanel` (общий с DropDashboard) НЕ трогается этой поверхностью — полоса не встраивается внутрь него                |

### 4.3 Данные (client-derived, без нового эндпоинта)

Источник — уже загруженный в обоих местах `['transactions']` query (`financeApi.getTransactions()`,
self-scoped бэкендом на текущего пользователя). Никакого нового API не требуется (task уже это
допускает как основной путь):

```
outstanding = transactions.filter(t =>
  t.type === 'SENIOR_INCOME' &&
  t.status === 'VALIDATED' &&
  t.payoutRequestId == null
)
```

**Критично — сумма к оплате, НЕ валовый приход.** Полоса показывает ДОЛЮ КОМПАНИИ (`payable`), не
сумму приходов. Формула — 1:1 копия расчёта, уже существующего в `PayoutDialog.tsx:81-92`
(`previewRows`), это НЕ новая бизнес-логика, а перенос:

```
sharePercent = tx.seniorSharePercent ?? user.seniorSharePercent ?? 26   // существующий дефолт
payable      = amount * (1 - sharePercent / 100)
```

Группировка — по `projectId`: `projectsCount = new Set(outstanding.map(t => t.projectId)).size`.
Сумма — по валюте (см. edge-case «смешанные валюты» ниже). `outstanding.length === 0` →
`CompanySharePayoutStrip` возвращает `null` (компонент сам решает, не родитель — паттерн 1:1 с
`HiringStrip`'s `count <= 0` guard).

### 4.4 Визуальный дизайн

Референс-скриншоты: `docs/design/assets/company-share-cta/banner-320.png`,
`docs/design/assets/company-share-cta/banner-1440.png` (Playwright-рендер на реальных oklch-значениях
из `globals.css`).

Единый кликабельный `<button type="button">` (не `<a>` — открывает модалку, не навигирует):

```tsx
<button
  type="button"
  onClick={onOpen}
  data-testid="company-share-cta-strip"
  className="flex w-full min-h-11 items-center gap-3 rounded-lg border border-primary/25 bg-primary/8 px-4 py-3 text-left transition-colors hover:bg-primary/12"
>
  <span className="hidden sm:flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
    <Coins className="h-[18px] w-[18px]" aria-hidden="true" />
  </span>
  <span className="min-w-0 flex-1">
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-semibold">Доля CheekyCheeseIT к оплате</span>
      <Badge
        variant="outline"
        className="rounded-full border-orange-500/30 bg-orange-500/15 text-orange-400"
      >
        {projectsCount} {pluralizeProjects(projectsCount)}
      </Badge>
    </span>
    <span className="mt-0.5 block text-xs text-muted-foreground">
      По проверенным приходам, ещё не включённым в заявку на выплату
    </span>
  </span>
  {/* амаунт + «Оплатить» — на <480px это ВТОРАЯ строка (см. §8 responsive) */}
  <span className="flex shrink-0 items-center gap-3 max-[479px]:w-full">
    <span className="text-[17px] font-bold tabular-nums text-primary">{amountLabel}</span>
    <span className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground max-[479px]:flex-1">
      Оплатить
    </span>
  </span>
</button>
```

**Иконка — `Coins`, не `Wallet`.** Осознанный выбор: `Wallet` уже зарезервирован в кодовой базе за
действиями «твои личные деньги» (шапка `finance/index.tsx:824`, `InProgressPanel` кнопки, тело
`PayoutDetailDialog`). `Coins` — уже существующий якорь именно «счёт КОМПАНИИ»
(`PayoutDetailDialog.tsx:56`, `MANUAL_METHODS.COMPANY_ACCOUNT`). Переиспользование этого якоря для
«доля компании» семантически точнее и не вводит новую иконку в словарь.

Внутренний «Оплатить» — это НЕ вложенный `<button>` (невалидный HTML внутри `<button>`), а `<span>`
со стилем кнопки — паттерн 1:1 с `MANUAL_METHODS`-плашками в `PayoutDetailDialog.tsx:600-618`
(кликабельный `role="radio"` `<button>`, визуальная «кнопка» внутри — тот же приём инверсии
вложенности). Весь клик обрабатывает внешний `<button>`.

### 4.5 Состояния

| Состояние                   | Поведение                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Пусто (`outstanding = []`)  | Компонент не рендерится вовсе — `null`, ни одного DOM-узла, ни заголовка секции                                                                                                                                           |
| Заполнено, 1 валюта         | `amountLabel = fmtAmount(sum, currency)` — см. `banner-1440.png` контекст A/B                                                                                                                                             |
| Заполнено, смешанные валюты | `amountLabel = "820 USDT + 300 EUR"` (join по валютам, до 3 значений; 4+ → `"3+ валюты — точная сумма в модалке"`); подпись меняется на «Несколько валют — точная сумма в модалке» — см. `banner-1440.png` edge-case блок |
| Загрузка транзакций         | Полоса не рендерится, пока `['transactions']` не загружен (`isLoading`) — избегает мигания «пусто→заполнено»                                                                                                              |

---

## 5. Модалка — общий каркас (`CompanySharePayoutModal`)

Единый `<Dialog>` с ОДНИМ смонтированным `<CrmDialogContent>`, внутренний `step: 'select' | 'submitting' | 'pay'`
управляет содержимым. Компонент НЕ размонтирует/не пересоздаёт `<Dialog>` между шагами — это и есть
механизм «модалка не закрывается» (владелец: «после сабмита модалка не закрывается»).

### 5.1 Мобильный shell — full-screen override

`CrmDialogContent` по умолчанию (`crm-dialog.tsx:41-51`) уже `w-full` + `sm:rounded-xl` (на мобайле —
без радиуса, edge-to-edge по ширине), но высота всегда `max-h-[90dvh]` центрированная — на маленьком
экране с длинным списком проектов это оставляет мёртвые поля сверху/снизу. Задача явно требует
full-screen/bottom-sheet на мобайле — минимальная точечная правка (НЕ новый компонент, `className`
проп уже поддержан):

```tsx
<CrmDialogContent
  maxWidth="sm:max-w-lg"
  className="max-h-[100dvh] sm:max-h-[90dvh]"
  data-testid="company-share-payout-modal"
>
```

На `<640px` это даёt подлинный full-screen (100dvh, edge-to-edge, без радиуса — уже дефолт компонента);
`sm:` и выше — существующее центрированное поведение без изменений. Референс:
`modal-step1-320.png` (мобайл, full-screen) vs `modal-step1-1440.png` (десктоп, центрированная карточка).

### 5.2 Заголовок — один `<DialogTitle>`, текст меняется, не элемент

Radix требует ровно один `DialogTitle` на диалог. Между шагами текст ЗАГОЛОВКА обновляется (не
пересоздаётся другой элемент) — избегает кратковременной дыры в a11y-дереве:

- Шаг «Выбор»: `Оплата доли CheekyCheeseIT`
- Шаг «Оплата»: `Заявка на выплату` + рядом статусный `Badge` (см. §7.2)

### 5.3 Stepper (персистентный, оба шага)

```tsx
<div className="mb-4 flex items-center gap-2" role="status" aria-label={stepAriaLabel}>
  <StepDot state={step === 'select' ? 'active' : 'done'} label="1" />
  <span className="text-xs font-medium">Выбор</span>
  <span className={cn('h-px w-8', step !== 'select' ? 'bg-emerald-500/30' : 'bg-border')} />
  <StepDot state={step === 'select' ? 'upcoming' : step === 'pay' ? 'active' : 'done'} label="2" />
  <span className="text-xs font-medium">Оплата</span>
</div>
```

`StepDot` — inline helper (20×20px circle), 3 визуальных состояния: `upcoming` (`border-border
text-muted-foreground`), `active` (`bg-primary text-primary-foreground`, текущий шаг),
`done` (`bg-emerald-500/15 text-emerald-400 border-emerald-500/30`, галочка вместо номера). **НЕ
кликабельно** — в отличие от `SegmentedToggle` это не переключатель: с шага 2 нельзя нажать на «1»
и вернуться (заявка уже создана на сервере, «назад» не имеет смысла — см. §7.4).

### 5.4 A11y — перенос фокуса и объявление смены шага (обязательное требование задачи)

Смена `step` внутри одного смонтированного диалога — Radix `focus-trap` работает на уровне диалога
целиком, но НЕ знает про внутреннюю смену «под-экрана». Два механизма, оба обязательны:

1. **Перенос фокуса.** Контейнер шага 2 — `<div ref={step2ContainerRef} tabIndex={-1}>`, `useEffect`
   на `step === 'pay'` вызывает `step2ContainerRef.current?.focus()`. Фокус уходит с кнопки «Создать
   выплату» (которая логически «исчезла» под новым контентом) на начало нового контента, а не
   остаётся на невидимом/неактуальном элементе.
2. **Живая область объявления.** Один постоянный (не пересоздаваемый) элемент:
   ```tsx
   <div aria-live="polite" className="sr-only" data-testid="company-share-step-announcer">
     {step === 'pay' ? 'Шаг 2 из 2. Заявка на выплату создана. Деньги ещё не отправлены.' : ''}
   </div>
   ```
   Текст появляется ТОЛЬКО в момент перехода (пусто на шаге 1) — screen reader объявляет его один раз
   при смене, не на каждом ре-рендере.

### 5.5 Закрытие в любой момент

`onOpenChange={(open) => !open && handleClose()}` — единая точка для Escape / клика по оверлею /
крестика `CrmDialogContent`. `handleClose` сбрасывает ЛОКАЛЬНЫЙ UI-стейт (`step` → `'select'`,
`selected` → `new Set()`, `payoutId` → `null`) — **никогда не откатывает** уже созданную на сервере
заявку (см. §7.5).

---

## 6. Поверхность B — Шаг 1: выбор (`step === 'select'`)

Референсы: `modal-step1-320.png` / `-768.png` / `-1024.png` / `-1440.png` (заполненный список,
частичный выбор), `modal-step1-empty-320.png` / `-1440.png` (пустой выбор → кнопка отправки
заблокирована).

### 6.1 Группировка данных

```
projects: Map<projectId, { name: string; incomes: TransactionDto[] }>
```

Строится из `validatedTxs` (тот же проп, что был у `PayoutDialog` — `SENIOR_INCOME`, `VALIDATED`,
`payoutRequestId == null`), `groupBy(t => t.projectId)`. Порядок проектов — по дате самого свежего
прихода внутри (newest-first), как везде в приложении.

### 6.2 Чекбокс проекта — tri-state

```tsx
const projectRef = useRef<HTMLInputElement>(null)
const projectIncomeIds = incomes.map((t) => t.id)
const selectedCount = projectIncomeIds.filter((id) => selected.has(id)).length
const allSelected = selectedCount === projectIncomeIds.length
const noneSelected = selectedCount === 0

useEffect(() => {
  if (projectRef.current) projectRef.current.indeterminate = !allSelected && !noneSelected
}, [allSelected, noneSelected])

function toggleProject() {
  setSelected((prev) => {
    const next = new Set(prev)
    if (allSelected) projectIncomeIds.forEach((id) => next.delete(id))
    else projectIncomeIds.forEach((id) => next.add(id))
    return next
  })
}
```

Нативный `<input type="checkbox">` + `.indeterminate` через ref — тот же примитив, что уже в
`PayoutDialog.tsx:170-175`, БЕЗ нового компонента `Checkbox` (в инвентаре shadcn/ui его нет —
вводить ради одной фичи означало бы новый визуальный язык; нативный чекбокс с `accent-primary`
УЖЕ единственный existing паттерн выбора в этом флоу).

### 6.3 Разметка ряда — тач-таргет ≥44px

```tsx
<div className="overflow-hidden rounded-lg border border-border">
  <label className="flex min-h-11 cursor-pointer items-center gap-3 p-3 hover:bg-muted/30">
    <input ref={projectRef} type="checkbox" checked={allSelected} onChange={toggleProject}
           className="h-4 w-4 shrink-0 accent-primary"
           aria-label={`Выбрать все приходы проекта ${project.name}`} />
    <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
      <span className="truncate text-sm font-medium">{project.name}</span>
      <span className="shrink-0 tabular-nums text-sm font-medium">{fmtAmount(projectTotal, cur)}</span>
    </span>
  </label>
  {incomes.map((tx) => (
    <label key={tx.id} className="flex min-h-11 cursor-pointer items-center gap-3 border-t border-border py-2.5 pl-10 pr-3 hover:bg-muted/20">
      <input type="checkbox" checked={selected.has(tx.id)} onChange={() => toggleTx(tx.id)}
             className="h-4 w-4 shrink-0 accent-primary"
             aria-label={`Приход от ${fmtDate(tx.txDate ?? tx.createdAt)}`} />
      <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">Приход от {fmtDate(...)}</span>
        <span className="shrink-0 tabular-nums text-xs">{fmtAmount(tx.amount, tx.currency)}</span>
      </span>
    </label>
  ))}
</div>
```

Тач-таргет — вся строка `<label>` (`min-h-11` = 44px + `p-3`/`py-2.5` дают фактическую высоту
≥44px), не голый чекбокс (16px) — паттерн 1:1 с обоснованием `drop-share-override-and-receiver.md`
§Surface B responsive («full-width контейнера компенсирует высоту»).

### 6.4 Живой итог

Переиспользуется ЦЕЛИКОМ существующий блок `PayoutDialog.tsx:190-313` (single-currency /
mixed-currency ветки, `previewRows`, `hasMixedCurrencies`) — **без изменений расчёта**, только
источник `selected` теперь может включать элементы из разных проектов (не меняет формулу). Пустой
выбор → блок итога скрыт целиком (`{selected.size > 0 && (...)}`), НЕ показан с нулевыми суммами —
поведение 1:1 со старым диалогом.

### 6.5 Пустой выбор → блокировка отправки

`disabled={selected.size === 0 || createMutation.isPending}` — тот же паттерн, что
`PayoutDialog.tsx:325`. Референс: `modal-step1-empty-320.png`/`-1440.png`.

### 6.6 Дефолт выбора при открытии (изменение относительно старого диалога — обосновано ниже)

| Точка входа                                                                           | Дефолт                                                   |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Полоса-призыв (`CompanySharePayoutStrip`)                                             | **ВСЁ выбрано** (все проекты, все приходы)               |
| Заголовок финансов «Выплатить (N)» (было: `finance/index.tsx:815-827`)                | **ВСЁ выбрано** (изменено — см. обоснование ниже)        |
| Точечная кнопка «Создать выплату» на одном ряду (`InProgressPanel`, `TransactionRow`) | Только этот один приход (как раньше, `preselectedTxIds`) |

**Отступление от текущего поведения.** Старый `PayoutDialog` при открытии с заголовка всегда
стартовал с ПУСТОГО выбора (`preselectedTxIds` undefined → `new Set()`). Полоса-призыв, по своей
природе, УЖЕ утверждает «у вас есть N проектов на сумму X к оплате» — открыть модалку и увидеть
пустой список противоречило бы собственному обещанию баннера и добавляло бы лишний клик «выбрать
всё» в самом частом сценарии (оплатить все накопленные приходы разом). Пере-группировка по проектам
(эта фича) делает результат выбора визуально прозрачным, так что дефолт «всё» не рискует случайной
переплатой вслепую — пользователь ВИДИТ весь список перед отправкой и может снять лишнее. Ради
консистентности одного и того же экрана то же поведение перенесено и на заголовочную кнопку
(единственная точка входа без предвыбора). Точечная кнопка на одном ряду — намеренно НЕ трогается:
там пользователь явно указал ОДИН приход, менять умолчание там было бы сюрпризом в противоположную
сторону.

### 6.7 Защита от двойной отправки

`createMutation.isPending` блокирует кнопку (existing паттерн). Дополнительно — на время отправки
disable-ить весь список чекбоксов (`<fieldset disabled={createMutation.isPending}>` вокруг списка
проектов) — предотвращает смену выбора в момент, когда запрос уже летит с прежним набором id.

---

## 7. Поверхность C — Шаг 2: оплата (`step === 'pay'`), модалка НЕ закрывается

Референсы: `modal-step2-fresh-320.png`/`-1440.png` (сразу после перехода), `-validating-1440.png`,
`-error-1440.png`, `-confirmed-1440.png`.

### 7.1 Механизм перехода (без закрытия — ключевое требование)

```tsx
const createMutation = useMutation({
  mutationFn: () => financeApi.createPayoutRequest({ transactionIds: [...selected] }),
  onSuccess: (payout) => {
    // Сидируем кэш ответом мутации — PayoutPaymentForm использует ТОТ ЖЕ
    // query key, что и PayoutDetailDialog, поэтому шаг 2 рендерится без
    // мигания скелетоном (данные уже есть), но остаётся независимо
    // refetch-able (например, после клика «Подтвердить оплату»).
    qc.setQueryData(['payout-request', payout.id], payout)
    void qc.invalidateQueries({ queryKey: ['transactions'] })
    void qc.invalidateQueries({ queryKey: ['payout-requests'] })
    void qc.invalidateQueries({ queryKey: ['finance-summary'] })
    setPayoutId(payout.id)
    setStep('pay') // ← НЕ onClose()
  },
})
```

`CrmDialogContent`, `<Dialog open>` — не трогаются. Единственное, что меняется — внутренний JSX,
управляемый `step`. Это и есть механизм «не закрывается»: компонент дальше рендерит
`<PayoutPaymentForm payoutId={payoutId} variant="embedded" />` вместо контента шага 1.

### 7.2 Разделение «создано» vs «оплачено» (главное требование владельца)

Три независимых, взаимно усиливающих сигнала — специально избыточно, потому что цена ошибки
(человек решает, что уже заплатил) высокая:

1. **Статусный Badge рядом с заголовком** — переиспользует существующий словарь статусов, который
   пользователь уже видит в таблице транзакций каждый день:
   - Сразу после создания: `<Badge className={STATUS_COLORS.PENDING_PAYMENT}>{STATUS_LABELS.PENDING_PAYMENT}</Badge>`
     → «Ожидает выплаты» (orange).
   - После успешного подтверждения оплаты (`onChainStatus === 'confirmed'` внутри `PayoutPaymentForm`,
     существующая логика `PayoutDetailDialog.tsx:186`): бейдж переключается на
     `STATUS_COLORS.PAID` / `STATUS_LABELS.PAID` → «Оплачено» (emerald).
2. **Постоянная confirmation-строка** сразу под шапкой, ПОКА статус `PENDING_PAYMENT`:
   ```tsx
   <div
     role="status"
     className="flex gap-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5"
   >
     <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
     <div>
       <p className="text-xs font-medium text-emerald-400">Заявка создана</p>
       <p className="text-[11px] text-muted-foreground">
         Деньги ещё не отправлены — переведите сумму и укажите хеш транзакции ниже.
       </p>
     </div>
   </div>
   ```
   Формулировка нарочно ставит рядом два факта в одном предложении — «создана» И «не отправлены» —
   чтобы ни один из них не читался в отрыве. Эта строка **исчезает**, когда статус переходит в
   `PAID` (заменяется существующим confirmed-блоком `PayoutDetailDialog.tsx:532-547` — «Транзакция
   подтверждена»), так что в любой момент на экране ровно ОДНО заявление о состоянии, не два
   противоречащих.
3. **Stepper** (§5.3) — шаг «1 Выбор» помечен ✓ (готово), шаг «2 Оплата» — активен, ПОКА статус не
   `PAID`; когда `PAID` — оба сегмента ✓. Второстепенный, периферийный сигнал (для тех, кто
   ориентируется по прогрессу, а не по тексту).

### 7.3 `PayoutPaymentForm` — извлечение, не переписывание

Всё содержимое `PayoutDetailDialog.tsx:300-677` (instruction-card / список входящих в заявку
транзакций / tx-hash input / dev-simulate радиогруппа / on-chain status блок / manual-confirm секция
ADMIN/ACCOUNTANT) переносится «как есть» в `PayoutPaymentForm({ payoutId, onPaid? })`. Логика
мутаций (`payMutation`, `manualMutation`), `useQuery(['payout-request', payoutId])` — без изменений.
Единственное отличие использования:

- **`PayoutDetailDialog.tsx`** (существующий, не удаляется) — оборачивает `PayoutPaymentForm` в
  СОБСТВЕННЫЙ `<Dialog><CrmDialogContent>`, как сегодня. Точки входа «Оплатить» на уже созданной
  строке (`TransactionRow`, `InProgressPanel`, `DropDashboard`) продолжают открывать ИМЕННО его —
  **поведение не меняется**, это explicit сохранение из задачи («существующее поведение, сохранить»).
- **`CompanySharePayoutModal`** — рендерит `PayoutPaymentForm` БЕЗ своего `<Dialog>`
  (`variant="embedded"` просто означает «без внешнего `<Dialog>`/`<CrmDialogContent>` обёртки и без
  собственной кнопки „Закрыть“ — footer-кнопки берёт из общего футера модалки», см. §7.6).

### 7.4 Нет пути назад на шаг 1

Ни один UI-элемент шага 2 не позволяет вернуться к выбору. Обоснование: заявка на сервере уже
существует (`payout_request` со статусом `PENDING_PAYMENT` + выбранные транзакции переведены в тот
же статус) — «отмена выбора» с точки зрения пользователя должна означать явное действие
(отменить/удалить заявку), которого в скоупе задачи нет. Кнопка footer на шаге 2 — `Закрыть`
(не «Отмена» — семантически отличается: закрывает окно, не отменяет заявку).

### 7.5 Закрытие на шаге 2 не теряет данные

Явно наследуется от `PayoutDetailDialog` (уже так работает): `onClose` НЕ вызывает удаление/отмену
заявки. Созданный `payout_request` виден как обычная строка `PAYOUT` / `PENDING_PAYMENT` в таблице
транзакций и в `InProgressPanel` (существующий рендер, `TransactionRow`/`InProgressPanel` уже умеют
показывать такие строки с кнопкой «Оплатить» → открывает `PayoutDetailDialog`). Повторный вход для
завершения оплаты идёт через ЭТОТ существующий путь, не через повторное открытие
`CompanySharePayoutModal` — она предназначена только для однонаправленного потока «выбор → создание»
(см. §7.4 обоснование).

### 7.6 Footer шага 2

```tsx
<CrmDialogFooter>
  <Button variant="outline" onClick={handleClose}>
    {isPaid || onChainStatus === 'confirmed' ? 'Закрыть' : 'Закрыть'}
  </Button>
  {!isPaid && onChainStatus !== 'confirmed' && (
    <Button
      data-testid="company-share-submit-payment"
      onClick={submitPayment}
      disabled={submitDisabled}
    >
      {payMutation.isPending ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Проверка…
        </>
      ) : (
        'Подтвердить оплату'
      )}
    </Button>
  )}
</CrmDialogFooter>
```

1:1 копия существующей логики `PayoutDetailDialog.tsx:681-717` (gate по `simulateMode`/hash-длине/
`isPending`) — `PayoutPaymentForm` экспортирует нужные вычисляемые флаги (`submitDisabled`,
`isPaid`, `onChainStatus`) наружу через children-render-prop ИЛИ модалка просто читает их из общего
хука состояния оплаты (реализационная деталь — оставляю на усмотрение кодера, лишь бы кнопки не
дублировали логику, а переиспользовали существующую).

### 7.7 Ошибка на шаге 2

Без изменений от существующего `PayoutDetailDialog` поведения: `role="alert"` красный блок под
инпутом хеша (`PayoutDetailDialog.tsx:549-567`), заявка остаётся `PENDING_PAYMENT`, повторная
отправка доступна сразу. Текст ошибки дополнительно явно напоминает, что заявка не откатывается —
см. `modal-step2-error-1440.png` («Заявка остаётся в статусе «Ожидает выплаты» — данные не
потеряны.»), это МЕЛКАЯ формулировка-усиление поверх существующего текста, не новая логика.

---

## 8. Responsive — сводная таблица (4 класса)

| Класс                | Полоса-призыв (`CompanySharePayoutStrip`)                                                                                                                                                           | Модалка, шаг 1                                                                                                                                                                                           | Модалка, шаг 2                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **320–375 (мобайл)** | Колоночная раскладка (`<480px`): иконка скрыта (`hidden`, экономит горизонт), заголовок+бейдж, описание, затем сумма+full-width «Оплатить» отдельной строкой. Мин-высота 44px. См. `banner-320.png` | `CrmDialogContent` full-screen (`className="max-h-[100dvh]"`, §5.1) — edge-to-edge, без радиуса. Список скроллится в `CrmDialogBody`, footer sticky. Тач-таргеты ≥44px (§6.3). См. `modal-step1-320.png` | Тот же full-screen shell. Instruction-card/inputs — full-width, без изменений от `PayoutDetailDialog` (уже адаптивен). См. `modal-step2-fresh-320.png` |
| **768 (планшет)**    | Полная горизонтальная раскладка (иконка видна), как на десктопе, в пределах контент-колонки                                                                                                         | `CrmDialogContent` центрированная карточка `sm:max-w-lg`, `sm:max-h-[90dvh]` — тот же список, больше воздуха                                                                                             | Центрированная карточка, без изменений                                                                                                                 |
| **1024 (ноутбук)**   | Без изменений от 768                                                                                                                                                                                | Без изменений от 768                                                                                                                                                                                     | Без изменений от 768                                                                                                                                   |
| **1440+ (большой)**  | Полоса не растягивается сверх контент-колонки (`max-w`, наследует контейнер страницы — foundation.md §2)                                                                                            | Диалог не растягивается сверх `sm:max-w-lg` (существующий кап `CrmDialogContent`). См. `modal-step1-1440.png`                                                                                            | Без изменений. См. `modal-step2-fresh-1440.png`, `-validating-1440.png`, `-error-1440.png`, `-confirmed-1440.png`                                      |

**Verification (Playwright, обязательно перед PR):** на каждой из тест-ширин 320/375/768/1024/1280/1440/1920
— `document.documentElement.scrollWidth <= document.documentElement.clientWidth` на странице
дашборда И финансов с открытой полосой; внутри модалки — тот же чек на `CrmDialogContent`; на 320 —
все `<label>`-ряды и кнопки footer измерены ≥44px по высоте.

---

## 9. RBAC / границы скоупа

| Роль                 | Полоса-призыв                                                                                                                                                                                                     | Модалка (эта фича)                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SENIOR**           | Видна на `SeniorDashboard` + `finance/index.tsx`                                                                                                                                                                  | `CompanySharePayoutModal` — все точки входа (полоса, заголовок, точечная кнопка)                                                                                                                                    |
| **ADMIN**            | `SeniorDashboard` рендерится и для ADMIN (self-scoped, см. `SeniorDashboard.tsx` doc-comment) — полоса появляется, если у ADMIN есть собственные `SENIOR_INCOME` (обычно нет в проде, есть в dev-тестовых данных) | Тот же путь, что SENIOR — новых RBAC-веток не требуется, self-scope уже на бэкенде                                                                                                                                  |
| **DROP**             | **НЕ добавляется** (вне скоупа задачи, явно оговорено)                                                                                                                                                            | `InProgressPanel`/`DropDashboard` продолжают работать через СУЩЕСТВУЮЩИЙ `PayoutDetailDialog` для «Оплатить»; кнопки «Создать выплату» на этих экранах, которые СЕГОДНЯ открывали `PayoutDialog` — см. пометку ниже |
| HR/JUNIOR/ACCOUNTANT | Не видят (не декларируют `SENIOR_INCOME`)                                                                                                                                                                         | Не применимо                                                                                                                                                                                                        |

**Важная развилка для кодера — `InProgressPanel` (общий SeniorDashboard/DropDashboard).**
`InProgressPanel.tsx` сегодня рендерит `PayoutDialog` (toolbar-кнопка «Создать выплату» + построчная)
для ОБЕИХ ролей — SENIOR и DROP. `PayoutDialog.tsx` удаляется целиком (AC6 задачи), значит
`InProgressPanel` обязан получить замену. Задача явно запрещает расширять DROP-скоуп молча, но не
предписывает ломать существующую DROP-кнопку. Рекомендация: `InProgressPanel` переключается на
`CompanySharePayoutModal` для ОБЕИХ ролей (сохраняет статус-кво функциональности один-в-один — та же
кнопка, тот же результат, никакой НОВОЙ поверхности для DROP не появляется, т.к. `CompanySharePayoutStrip`
туда не добавляется). Это НЕ расширение скоупа — просто продолжение существующей точки входа через
единственный оставшийся модальный компонент. Если ревьюер решит иначе (например, оставить DROP на
отдельном форке старой модалки) — явно отметить это как открытый вопрос в PR body, не решать молча в
противоположную сторону.

---

## 10. Edge cases

| Кейс                                                                 | Поведение                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Длинное название проекта                                             | `truncate` на `<span>` названия (project-row и в live-итоге), полная строка доступна через `title` атрибут ИЛИ `Tooltip` (по аналогии с `TransactionDetailDialog` — на усмотрение кодера). Чекбокс/сумма не сжимаются (`shrink-0`). См. `modal-step1-*.png`, третья группа |
| Много проектов / много приходов внутри проекта                       | Список НЕ виртуализируется (объём на практике мал — приходы одного синьора за период до заявки) — обычный вертикальный скролл внутри `CrmDialogBody` (`flex-1 overflow-y-auto`, уже в компоненте). Footer и заголовок остаются sticky                                      |
| Смешанные валюты в выбранной корзине                                 | Переиспользуется существующая ветка `hasMixedCurrencies` (`PayoutDialog.tsx:251-281`) — per-currency breakdown вместо вводящей в заблуждение единой суммы. Полоса — см. §4.5                                                                                               |
| Переполнение суммы на маленьком экране (много цифр в `tabular-nums`) | `text-primary` amount в шаге-1-итоге не имеет фиксированной ширины — переносится на новую строку внутри `flex justify-between` контейнера (уже работает в существующем `PayoutDialog`-паттерне, unit-протестировано визуально на 320px)                                    |
| Нет `contractAddress` (не настроен кошелёк компании)                 | Существующее поведение `PayoutDetailDialog.tsx:352-359` (destructive-блок «Адрес не настроен») — наследуется автоматически через `PayoutPaymentForm`, без доп. работы                                                                                                      |
| Двойной клик «Создать выплату»                                       | Кнопка + `<fieldset disabled>` на время `isPending` (§6.7) — второй клик невозможен, пока не разрешится первый запрос                                                                                                                                                      |
| Ошибка сети при создании заявки (шаг 1 → шаг 2 переход не произошёл) | `createMutation.isError` — inline `text-destructive` под кнопкой (существующий паттерн `PayoutDialog.tsx:315`), модалка остаётся на шаге 1, выбор НЕ сбрасывается, повторная отправка доступна                                                                             |
| Закрытие на шаге 2, затем открытие полосы заново                     | Полоса пересчитывается из свежих `['transactions']` (инвалидированы в `onSuccess`, §7.1) — уже оплаченная/поданная заявка исчезает из `outstanding`, новая полоса (если есть остаток) — с нуля                                                                             |
| 0 проектов, но пользователь как-то попал в модалку (гонка данных)    | `CompanySharePayoutModal` не открывается без вызывающей стороны — но на всякий случай: `validatedTxs.length === 0` → тело шага 1 показывает `«Нет проверенных приходов»` (текст 1:1 с `PayoutDialog.tsx:159-162`), кнопка заблокирована                                    |

---

## 11. Motion

Наследует `foundation.md` §7 — только compositor-friendly свойства, никакого нового языка:

- Открытие/закрытие диалога — существующая Radix-анимация `CrmDialogContent` (`fade+zoom+slide`,
  150-200ms), без изменений.
- Переход `step: 'select' → 'pay'` — **без motion-эффекта смены контента** (просто замена JSX).
  Причина: любая fade/slide-анимация между двумя РАЗНЫМИ по смыслу шагами рискует прочитаться как
  «что-то плавно превратилось», что противоречит цели «чётко новое состояние», а не непрерывность.
  Резкая, но не дёрганая смена контента + перенос фокуса (§5.4) — более честный сигнал «это другой
  экран», чем плавный кросс-фейд.
- `status-box` (confirmation strip, error, on-chain) — существующие `animate-in fade-in-0
slide-in-from-bottom-1 duration-200` (`PayoutDetailDialog.tsx:515`), без изменений.
- `prefers-reduced-motion` — уважается автоматически через существующие Radix/tailwind-animate
  примитивы, дополнительной работы не требует (в этой фиче нет новых keyframe-анимаций).

---

## 12. data-testid — сводная таблица

| Элемент                                      | `data-testid`                                       |
| -------------------------------------------- | --------------------------------------------------- |
| Полоса-призыв (контейнер)                    | `company-share-cta-strip`                           |
| Модалка (контейнер `CrmDialogContent`)       | `company-share-payout-modal`                        |
| Живая область объявления смены шага          | `company-share-step-announcer`                      |
| Чекбокс проекта                              | `` `company-share-project-checkbox-${projectId}` `` |
| Чекбокс прихода                              | `` `company-share-income-checkbox-${txId}` ``       |
| Блок живого итога (шаг 1)                    | `company-share-selection-total`                     |
| Кнопка «Создать выплату» (шаг 1)             | `company-share-create-payout`                       |
| Кнопка «Подтвердить оплату» (шаг 2)          | `company-share-submit-payment`                      |
| Confirmation-строка «Заявка создана» (шаг 2) | `company-share-created-notice`                      |

---

## 13. Fidelity-референсы (для Mode B после реализации)

Все PNG — Playwright-рендер designer-authored HTML на РЕАЛЬНЫХ значениях токенов из `globals.css`
(см. заголовок документа, degraded Tier 1). Использовать как fidelity-эталон наравне с обычным
`design.png` (правило `design-fidelity-review.md` — деградация означает «эталон не из Claude Design»,
но требование покрытия классов устройств не снижается — все 4 класса покрыты):

```
docs/design/assets/company-share-cta/
├── tokens.css                          — токены (ссылка на источник в комментарии файла)
├── banner.html / banner-320.png / banner-1440.png
├── modal-step1.html / modal-step1-{320,768,1024,1440}.png
├── modal-step1-empty.html / modal-step1-empty-{320,1440}.png
└── modal-step2.html (#fresh|#validating|#error|#confirmed)
    / modal-step2-fresh-{320,1440}.png
    / modal-step2-{validating,error,confirmed}-1440.png
```

---

## 14. Инструкция для кодера (КРИТИЧНО)

1. **Строй нашими компонентами.** `Dialog`/`CrmDialogContent`/`Badge`/`Button` из shadcn/ui, нативный
   `<input type="checkbox">` (паттерн `PayoutDialog.tsx`) — `design.html`-мокапы в `assets/` — ЧИСТО
   визуальный референс для скриншотов, **НЕ код для вставки** (это hand-rolled CSS, имитирующий
   Tailwind классы вручную — реальный код должен использовать настоящие Tailwind-утилиты и настоящие
   компоненты, а не то, что в мокапе).
2. **`PayoutDialog.tsx` удаляется**, `PayoutDetailDialog.tsx` **остаётся** (тонкая обёртка над новым
   `PayoutPaymentForm`) — не путать эти два файла между собой (§7.3).
3. **Формула суммы к оплате** — `amount * (1 - sharePercent/100)`, НЕ валовый приход (§4.3). Это
   самый высокий по цене ошибки момент спеки — легко случайно показать gross вместо payable.
4. **Дефолт выбора «всё»** при открытии без preselection (§6.6) — осознанное отступление от старого
   `PayoutDialog`, не забыть перенести на заголовочную кнопку `finance/index.tsx` тоже.
5. **Переход шаг1→шаг2 — БЕЗ `onClose()`.** Самая частая потенциальная ошибка реализации — случайно
   вызвать существующий `handleClose()`-паттерн по инерции из старого кода. `setStep('pay')`, не
   закрытие.
6. **Фокус + `aria-live`** на смене шага — оба механизма обязательны (§5.4), не только один из них.
7. **DROP-точки входа** (`InProgressPanel`) — сохранить работающими через `CompanySharePayoutModal`
   (§9), но НЕ добавлять `CompanySharePayoutStrip` на `DropDashboard`/`DropFinancePage`.
8. **`Coins` для полосы, `Wallet` — нигде не меняется** в остальных местах (§4.4) — не путать
   иконки между собой, семантика разная.
9. **Responsive** — `className="max-h-[100dvh] sm:max-h-[90dvh]"` на `CrmDialogContent` для ЭТОЙ
   модалки (§5.1); не переносить этот override на другие диалоги приложения — только сюда, т.к.
   именно у этой модалки потенциально длинный список.
10. **data-testid** — строго по таблице §12, AutoTest на них полагается.
