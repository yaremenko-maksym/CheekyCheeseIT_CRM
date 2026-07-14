# Design Spec — Per-project Drop Share Override + Payment-type Income Routing

> **Design tier:** 2 (правка существующих экранов)
> **design-gate:** degraded (Tier 2 conformance, Claude Design не задействован — текстовая спека)
> **Status:** coder-ready
> **Ветка фичи:** `feature/drop-share-override-and-receiver`
> **Референс брифа:** `.claude/briefs/pm-brief-drop-share-override-and-receiver.md`
> **Референс ADR:** `docs/architecture/2026-07-13-payment-type-income-routing.md`
> **Задача дизайнера:** `task-drop-share-design`

---

## ⚠️ ADDENDUM (2026-07-13) — читать первым

Эта спека писалась **до** финализации контракта (первая версия — коммит `1c66d2a0`). Владелец
зафиксировал финальный контракт в ADR `2026-07-13-payment-type-income-routing.md` — он меняет
**Surface B** и добавляет **Surface C**. Ниже — актуальная версия документа целиком.

Что изменилось vs первая версия:

1. **Surface A** («Доля дропа (%)» слайдер) — **без изменений**, корректна с первого захода.
2. **Surface B** («Получатель прихода») — **ПЕРЕЕХАЛА**. Раньше планировался обязательный
   селектор получателя внутри диалога `DROP_INCOME` (дроп декларирует свой приход и выбирает,
   кому он фактически пришёл — себе или админу). **Это устарело.** Теперь: `DROP_INCOME` (как и
   `SENIOR_INCOME`) на ФОП/гіг-проектах остаётся **без всякого селектора получателя** — лайфсайкл
   не меняется. Получатель появляется в **новом, отдельном ADMIN-only флоу** декларации
   USDT-прихода (`USDT_INCOME` — синтетический UI-тип в `CreateTransactionDialog`, ledger-тип
   остаётся `ADMIN_INCOME`).
3. **Surface C** (НОВАЯ) — Select «Тип оплаты» проекта (`FOP` / `GIG_CONTRACT` / `USDT`),
   заменяет существующее free-text поле `paymentType` в форме проекта.
4. Добавлен **гейт-скрытие** для SENIOR/DROP на USDT-проектах (пустые состояния/подсказки внутри
   `CreateTransactionDialog`).

Coder реализует по разделам ниже (единственный источник правды теперь). Старый черновик Surface B
(«селектор получателя в DROP_INCOME») **не реализовывать** — он удалён из этой версии документа;
история — в git blame коммита `1c66d2a0`, если понадобится context.

---

## Контекст и UX-принцип

Все три поверхности — **conformance к уже существующим паттернам**, не новый визуальный язык:

- **Surface A** (`dropSharePercentOverride` слайдер) повторяет `seniorSharePercentOverride` ShareSlider.
  Различие только в label/role/hint. Никаких новых компонентов.
- **Surface B** (получатель admin-USDT-прихода) повторяет структуру существующей ветки `DIVIDEND`
  в `CreateTransactionDialog.tsx` (:801-883) — самодостаточный блок «баланс/получатель (grouped
  Select)/сумма», ADMIN-only, плюс переиспользует уже существующий `isUsdtLocked`-механизм
  форс-валюты (:211-215, использован для `ADMIN_INCOME`+`COMPANY_ACCOUNT`).
- **Surface C** (тип оплаты проекта) заменяет уже существующее free-text поле `paymentType`
  (сейчас — обычный `Input` внутри общего цикла полей в `ProjectEditFields` и в форме создания
  проекта) на `Select` с 3 значениями — тот же RBAC-паттерн disabled/hidden, что у
  `seniorSharePercentOverride`.

Coder строит строго по референс-паттернам из `$projectId.tsx`, `projects/index.tsx` и
`CreateTransactionDialog.tsx`. `design-gate: degraded` — генерация нового макета не требуется.

---

## Token map

Используются исключительно существующие семантические токены из `apps/web/app/styles/globals.css`.
Новые токены не вводятся — это касается и addendum-поверхностей (Surface B v2 и C переиспользуют
идентичный набор, никаких новых CSS-переменных).

| Назначение                               | Tailwind / CSS token                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Фон страницы / канвас                    | `bg-background`                                                                                                                        |
| Поднятая поверхность (карточка)          | `bg-card` / `border-border`                                                                                                            |
| Вторичный / подписи                      | `text-muted-foreground`                                                                                                                |
| Основной текст                           | `text-foreground`                                                                                                                      |
| Ошибка / деструктив                      | `text-destructive` / `border-destructive`                                                                                              |
| Бренд / CTA                              | `bg-primary` / `text-primary`                                                                                                          |
| Инпут / бордер                           | `border-input` / `bg-background` / `bg-muted`                                                                                          |
| Радиус                                   | `rounded-md` (вложенные контролы) / `rounded-lg` (карточки)                                                                            |
| Disabled-состояние                       | `opacity-60` (как в ShareSlider) / `opacity-50` (SelectItem disabled — компонент)                                                      |
| Визуальный акцент слайдера (company-bar) | `bg-primary/20 text-primary`                                                                                                           |
| Визуальный акцент слайдера (role-bar)    | `bg-emerald-500/20 text-emerald-400` (эталон ShareSlider)                                                                              |
| Info-hint (company-balance box)          | `border-blue-500/20 bg-blue-500/5 text-blue-400` (существующий паттерн, `CreateTransactionDialog.tsx:702`, `:804`)                     |
| Hint-текст                               | `text-xs text-muted-foreground`                                                                                                        |
| Ошибка валидации                         | `text-[11px] text-destructive` (паттерн CreateTransactionDialog)                                                                       |
| Тип-карточка (выбранная/невыбранная)     | `border-primary bg-primary/8 text-foreground` / `border-border bg-muted/20 text-muted-foreground` (паттерн `type`-селектора, :508-513) |
| Select group label                       | `text-sm font-semibold` (встроено в `SelectLabel`, `ui/select.tsx:102`)                                                                |

---

## Surface A — слайдер «Доля дропа (%)» в форме редактирования проекта

**Без изменений** — раздел ниже идентичен первой версии спеки, конформна финальному контракту.

### Референс-паттерн

`apps/web/app/routes/_authenticated/projects/$projectId.tsx` — `ProjectEditFields` (строки 339–397),
поле `seniorSharePercentOverride` с `ShareSlider`.

`apps/web/app/components/ui/share-slider.tsx` — компонент `ShareSlider` (строки 41–126). Компонент
**уже поддерживает** `role="DROP"` (`ROLE_LABELS.DROP`, share-slider.tsx:38) — использовать как есть,
без модификаций компонента.

### Компонент

Используется существующий `ShareSlider` из `@/components/ui/share-slider`.
**Новых компонентов не требуется.**

Параметры вызова `ShareSlider` для доли дропа:

```tsx
<ShareSlider
  value={sliderValue} // dropSharePercentOverride ?? effectiveDropSharePercent
  min={0}
  max={100}
  disabled={!canEditOverride} // canEditOverride = role ADMIN | ACCOUNTANT
  onChange={(v) => field.handleChange(v)}
  onBlur={field.handleBlur}
  error={!!err}
  inputTestId="project-edit-drop-share-override"
  role="DROP"
/>
```

### Расположение в `ProjectEditFields`

Новую секцию размещать **сразу после** секции `seniorSharePercentOverride` (строка 392 в `$projectId.tsx`).

```tsx
{/* Per-project DROP share — только для drop-проектов, только ADMIN/ACCOUNTANT.
    Паттерн — полный аналог seniorSharePercentOverride выше. */}
{viewerRole !== 'HR' && viewerRole !== 'JUNIOR' && project.dropId != null && (
  <form.Field name="dropSharePercentOverride" validators={...}>
    {(field) => {
      const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
      const raw = field.state.value as number | null
      const hasOverride = raw !== null && raw !== undefined
      const sliderValue = hasOverride ? (raw as number) : effectiveDropSharePercent
      return (
        <div className="space-y-2" data-testid="project-edit-drop-share-section">
          <Label className={cn(err && 'text-destructive')}>Доля дропа (%)</Label>
          <ShareSlider
            value={sliderValue}
            min={0}
            max={100}
            disabled={!canEditOverride}
            onChange={(v) => field.handleChange(v)}
            onBlur={field.handleBlur}
            error={!!err}
            inputTestId="project-edit-drop-share-override"
            role="DROP"
          />
          <p className="text-xs text-muted-foreground">
            По умолчанию: {effectiveDropSharePercent}%. Установите те же значение, чтобы сбросить
            переопределение.
          </p>
          {!canEditOverride && (
            <p className="text-xs text-muted-foreground italic">
              Менять может только ADMIN или ACCOUNTANT.
            </p>
          )}
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
      )
    }}
  </form.Field>
)}
```

### Условие видимости (RBAC)

| Роль       | Условие показа                            | Состояние                     |
| ---------- | ----------------------------------------- | ----------------------------- |
| ADMIN      | `dropId != null`                          | enabled                       |
| ACCOUNTANT | `dropId != null`                          | enabled                       |
| SENIOR     | `dropId != null`                          | disabled (`!canEditOverride`) |
| DROP       | `dropId != null`                          | disabled (`!canEditOverride`) |
| HR         | скрыто (фильтр `viewerRole !== 'HR'`)     | —                             |
| JUNIOR     | скрыто (фильтр `viewerRole !== 'JUNIOR'`) | —                             |

Не-drop-проекты (`project.dropId == null`): секция полностью скрыта для всех ролей.

### Значение для формы

- `dropSharePercentOverride` = `null | number` (аналог `seniorSharePercentOverride`).
- `effectiveDropSharePercent` — текущая эффективная доля, резолвится по бэкенд-иерархии из ADR D4:
  `project.dropSharePercentOverride ?? user.dropSharePercent ?? 5` (БЕЗ team-уровня — у дропа нет
  team-membership override, в отличие от senior).
- **Implicit-null-reset:** если пользователь устанавливает значение === `effectiveDropSharePercent`,
  frontend отправляет `null` (или backend резолвит это как сброс). Паттерн строго как у senior.

### info-row «Доля дропа» в Обзоре

Рядом с `InfoRow` «Доля синьора» (строка 1028 в `$projectId.tsx`) добавить строку для drop-проектов:

```tsx
{
  canSeeProjectFinance && project.dropId != null && (
    <InfoRow icon={<Percent className="h-3.5 w-3.5" />} label="Доля дропа">
      <ProjectDropShareInfo project={project} />
    </InfoRow>
  )
}
```

`ProjectDropShareInfo` — компонент по образцу `ProjectShareInfo` (существующий для senior, строка
429). Показывает: текущую эффективную долю + источник (`PROJECT` / `USER_DEFAULT`), бейдж «Override»
при наличии override. Паттерн: `text-sm font-medium tabular-nums` для числа.

### Панель `ProjectDropDistribution`

Компонент (`$projectId.tsx:1520`) уже читает `project.dropSharePercent ?? 5`. После backend-задачи
DTO будет возвращать эффективную долю (с учётом override). **UI-правок не требуется** — данные
придут обновлёнными в DTO. Дизайнер отмечает: панель показывает эффективную долю (снапшот на момент
рендеринга), не хранимый override отдельно.

---

## Surface B — Получатель admin-USDT-прихода (НОВЫЙ флоу, заменяет старый Surface B)

> **DROP_INCOME / SENIOR_INCOME на ФОП/гіг — БЕЗ ИЗМЕНЕНИЙ.** Дроп/синьор декларируют свой приход
> строго как сегодня — проект, сумма+валюта, чек, дата. Никакого селектора получателя туда НЕ
> добавляется. Гейт-скрытие для этих ролей на USDT-проектах — см. подраздел ниже.

### Референс-паттерны (3 существующих места, комбинируются)

1. **Синтетический UI-тип диалога** — `DIVIDEND` (`CreateTransactionDialog.tsx:42-45,84,90,801-883`).
   `DIVIDEND` — не значение `TransactionType`, а UI-only ветка `DialogTxType`, потому что реальный
   ledger-тип создаётся отдельным company-account-эндпоинтом. **Тот же паттерн** для нового
   `USDT_INCOME`: UI-only синтетический тип, реальный ledger-тип на бэкенде — `ADMIN_INCOME`
   (переиспользуется, см. ADR D3) через отдельный метод/эндпоинт `declareUsdtProjectIncome`.
   Это значит `USDT_INCOME` **не входит** в `constants.ts` `TYPE_LABELS`/`TYPE_COLORS` (те остаются
   `Record<TransactionType, …>` — нулевой blast radius, как и у `DIVIDEND`).
2. **Grouped receiver Select** — ADR требует 2 группы опций («Админы» + «Счёт компании»). Компонент
   `Select` из `@/components/ui/select` уже экспортирует `SelectGroup` + `SelectLabel` +
   `SelectSeparator` (`ui/select.tsx:9,96-106,130-140`) — **на сегодня нигде в приложении не
   используются**, но это часть канонического shadcn/ui набора этого же файла. Первое использование
   в этой фиче — не новый компонент, а первое включение уже существующего примитива.
3. **Форс-валюта USDT без нового UI** — существующий `isUsdtLocked` (:211-215) уже скрывает валютный
   селектор `AmountCurrencyInput` (`disableCurrency` prop, :887-901) для `ADMIN_INCOME` при
   `fundingSource === 'COMPANY_ACCOUNT'`. Расширить это булево значение — `USDT_INCOME` **всегда**
   locked (не по toggle, а безусловно, т.к. валюта для этого типа всегда USDT).

### Тип-карточка «Тип операции»

Добавить `'USDT_INCOME'` в `availableTypes` **только для ADMIN** (ADR Q4 — ACCOUNTANT НЕ декларирует
USDT-приход):

```tsx
const availableTypes: DialogTxType[] = isAdmin
  ? ['ADMIN_INCOME', 'USDT_INCOME', 'EXPENSE', 'SALARY', 'ADMIN_TRANSFER', 'DIVIDEND']
  : isAccountant
    ? ['ADMIN_INCOME', 'EXPENSE', 'SALARY', 'ADMIN_TRANSFER']
    : isSenior
      ? ['SENIOR_INCOME']
      : isDrop
        ? ['DROP_INCOME']
        : []
```

Иконка/описание — по образцу `TYPE_ICONS`/`TYPE_DESCRIPTIONS` + `typeLabel()`/`DIVIDEND_LABEL`
(:42-49,71-91):

```tsx
const USDT_INCOME_LABEL = 'USDT-приход'
const USDT_INCOME_DESCRIPTION = 'Приход по USDT-проекту — получатель + авто-обязательства'

// typeLabel() расширить:
function typeLabel(t: DialogTxType): string {
  if (t === 'DIVIDEND') return DIVIDEND_LABEL
  if (t === 'USDT_INCOME') return USDT_INCOME_LABEL
  return TYPE_LABELS[t]
}

// TYPE_ICONS / TYPE_DESCRIPTIONS — добавить ключ 'USDT_INCOME' (Record<string, …>,
// не Record<TransactionType, …> — безопасно, как у DIVIDEND):
TYPE_ICONS.USDT_INCOME = <TrendingUp className="h-4 w-4" /> // income-семантика, как остальные income-типы
TYPE_DESCRIPTIONS.USDT_INCOME = USDT_INCOME_DESCRIPTION
```

`data-testid` карточки типа генерируется существующим паттерном
`` `create-transaction-type-${t.toLowerCase()}` `` (:514) → `create-transaction-type-usdt_income`
автоматически, без ручной правки.

### Проект-селектор — расширить существующий блок

Существующий блок «Project selector» (:532-570) уже условно рендерится для
`SENIOR_INCOME | ADMIN_INCOME | DROP_INCOME`. Расширить условие + пул на `USDT_INCOME`:

```tsx
{(type === 'SENIOR_INCOME' ||
  type === 'ADMIN_INCOME' ||
  type === 'DROP_INCOME' ||
  type === 'USDT_INCOME') && (
  <div className="space-y-1.5">
    <Label className="text-xs text-muted-foreground">Проект</Label>
    <Select value={projectId} onValueChange={...}>
      <SelectTrigger data-testid="create-transaction-project-trigger" ...>
        <SelectValue placeholder="Выберите проект" />
      </SelectTrigger>
      <SelectContent>
        {(type === 'ADMIN_INCOME'
          ? adminProjects
          : type === 'DROP_INCOME'
            ? dropProjects
            : type === 'USDT_INCOME'
              ? usdtProjects
              : myProjects
        ).map((p) => (
          <SelectItem key={p.id} value={p.id} className="text-sm">
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
    {/* существующий error-параграф без изменений */}
  </div>
)}
```

`usdtProjects` — новый derived-массив: **любой** активный USDT-проект (не только «свой», ADR D3:
«Проект — ЛЮБОЙ USDT-проект»):

```tsx
const usdtProjects = isAdmin ? projects.filter((p) => p.paymentType === 'USDT') : []
```

**Data-требование:** локальный тип `ProjectOption` (:65) расширить полем `paymentType?: string | null`
— бэкенд уже отдаёт `paymentType` в `GET /projects` (проверено, `projectSchema.paymentType`,
`packages/shared/src/schemas/projects.ts:147`), фронту нужно только дописать поле в локальный тип.

### Получатель — новый grouped Select (сердце Surface B)

Разместить **сразу после** проект-селектора, в собственном блоке `type === 'USDT_INCOME'`
(структурно — рядом с существующей веткой `DIVIDEND` :801, тот же уровень вложенности):

```tsx
{
  type === 'USDT_INCOME' && (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">Получатель прихода</Label>
      <Select
        value={receiverId}
        onValueChange={(v) => {
          setReceiverId(v)
          clearFieldError('receiver')
        }}
      >
        <SelectTrigger
          className={cn('h-9 text-sm', fieldErrors.receiver && 'border-destructive')}
          data-testid="usdt-income-receiver-trigger"
        >
          <SelectValue placeholder="Выберите получателя" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Админы</SelectLabel>
            {adminUsers.map((u) => (
              <SelectItem key={u.id} value={u.id} className="text-sm">
                {u.displayName}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>Счёт компании</SelectLabel>
            <SelectItem value="COMPANY_ACCOUNT" className="text-sm">
              Счёт компании
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Весь приход (gross) уйдёт выбранному получателю. Компания автоматически создаст
        обязательства выплатить синьору и дропу их доли.
      </p>
      {fieldErrors.receiver && (
        <p className="text-[11px] text-destructive" data-testid="usdt-income-error-receiver">
          {fieldErrors.receiver}
        </p>
      )}
    </div>
  )
}
```

Обоснование дизайн-решения: переиспользуется существующий `receiverId`-стейт (уже общий для
SALARY/DIVIDEND/ADMIN_TRANSFER, :138) с sentinel-строкой `'COMPANY_ACCOUNT'` для «Счёт компании» —
это ровно то же значение, что уже отправляется в payload при выборе company-funding для
`ADMIN_INCOME`/`EXPENSE` (:326,363), поэтому бэкенд-контракт `createUsdtIncomeSchema.receiverId:
uuid | 'COMPANY_ACCOUNT'` (ADR D3) резолвится без доп. маппинга на фронте — значение из Select идёт
в payload как есть.

### Дефолт получателя

**НЕ предвыбирать** (ADR — осознанный выбор). Существующий сброс `setReceiverId('')` при смене типа
(:498) уже это обеспечивает — доп. логики не требуется (в отличие от старой версии спеки, где для
DROP-роли предполагался автопредвыбор — это была часть устаревшего контракта, здесь неприменимо:
`USDT_INCOME` доступен только ADMIN).

### Сумма — форс-валюта USDT

Расширить существующий `isUsdtLocked` (:211-215; НЕ создавать новую переменную):

```tsx
const isUsdtLocked =
  type === 'USDT_INCOME' ||
  ((type === 'EXPENSE' || type === 'ADMIN_INCOME') && fundingSource === 'COMPANY_ACCOUNT')
```

`AmountCurrencyInput` (:887-901) уже условно рендерится для `type !== 'DIVIDEND'` — `USDT_INCOME`
проходит через тот же общий блок без правок JSX, только через `isUsdtLocked`. Currency-селектор
внутри компонента скрывается автоматически (`disableCurrency={isUsdtLocked}`).

### Чек / подтверждение

**Обновлено под финальное решение ADR Q1** (`docs/architecture/2026-07-13-payment-type-income-routing.md`,
раздел «Открытые вопросы владельцу») — владелец выбрал **(а) прямой кредит, без on-chain
tx-link верификации** для admin-USDT-прихода (не вариант «прямой + опциональная ссылка»,
который предполагала более ранняя версия этого раздела). Из этого следует: `USDT_INCOME` —
**без чека/подтверждения вообще**, не «опционально, как у `ADMIN_INCOME`». `showReceipt`
(:456-460) НЕ расширяется на `USDT_INCOME`; `createUsdtIncomeSchema` (ADR D3) не содержит
полей `receiptDocumentId`/`receiptExternalUrl`, submit-payload их не отправляет:

```tsx
const showReceipt =
  type === 'ADMIN_INCOME' ||
  type === 'SENIOR_INCOME' ||
  type === 'DROP_INCOME' ||
  type === 'EXPENSE'
// USDT_INCOME сюда НЕ входит (ADR Q1) — доверенный ADMIN, прямой кредит,
// без receipt-доказательства для этого флоу.
```

### Валидация

Расширить `validate()` (:278-306):

```tsx
if (
  type === 'ADMIN_INCOME' ||
  type === 'SENIOR_INCOME' ||
  type === 'DROP_INCOME' ||
  type === 'USDT_INCOME'
) {
  if (!projectId) errors.project = 'Выберите проект'
}
if (type === 'USDT_INCOME') {
  if (!receiverId) errors.receiver = 'Выберите получателя'
}
```

### Submit

Новый ветвь в `mutation.mutationFn` (рядом с `ADMIN_INCOME`/`DROP_INCOME`, :315-352), вызывает
**новый** `financeApi`-метод (frontend-задача добавляет функцию + импортирует DTO-тип из
`@crm/shared` после backend-контракта):

```tsx
if (type === 'USDT_INCOME') {
  return financeApi.declareUsdtProjectIncome({
    projectId,
    amount: amt,
    currency: 'USDT',
    receiverId, // uuid ИЛИ 'COMPANY_ACCOUNT' — как есть из Select
    receiptDocumentId,
    receiptExternalUrl,
    notes: notes || null,
    txDate: txDate || null,
  })
}
```

Точный путь эндпоинта (`POST /api/finance/usdt-income` по ADR D3 vs существующая конвенция
`/transactions/*`) — контракт backend-задачи; фронт вызывает через `financeApi.declareUsdtProjectIncome`
независимо от итогового пути.

### Гейт-скрытие для SENIOR/DROP на USDT-проектах (ADR D2)

ФОП/гіг lifecycle SENIOR_INCOME/DROP_INCOME не меняется, но проект-пул для этих типов **исключает**
USDT-проекты (декларирует только ADMIN):

```tsx
const myProjects = isSenior
  ? projects.filter((p) => p.seniorId === user?.id && p.paymentType !== 'USDT')
  : projects
const dropProjects = isDrop
  ? projects.filter((p) => p.dropId === user?.id && p.paymentType !== 'USDT')
  : []
```

**Пустое состояние**, когда у SENIOR/DROP есть проекты, но ВСЕ они USDT-типа (список пуст после
фильтра, хотя исходный непуст) — показать подсказку под селектором проекта вместо тихого пустого
Select:

```tsx
{
  type === 'SENIOR_INCOME' &&
    projects.some((p) => p.seniorId === user?.id) &&
    myProjects.length === 0 && (
      <p
        className="text-xs text-muted-foreground italic"
        data-testid="senior-income-usdt-gate-hint"
      >
        На всех ваших проектах приход декларирует администратор (USDT). Обратитесь к администратору.
      </p>
    )
}
{
  type === 'DROP_INCOME' &&
    projects.some((p) => p.dropId === user?.id) &&
    dropProjects.length === 0 && (
      <p className="text-xs text-muted-foreground italic" data-testid="drop-income-usdt-gate-hint">
        На всех ваших проектах приход декларирует администратор (USDT). Обратитесь к администратору.
      </p>
    )
}
```

Если у SENIOR/DROP есть смесь ФОП/гіг + USDT проектов — USDT-проекты просто не появляются в
Select (тихая фильтрация, без hint), декларация на оставшихся проектах работает как обычно.

---

## Surface C — «Тип оплаты» Select в форме проекта (НОВАЯ)

### Референс-паттерн

Поле `paymentType` уже существует **как free-text `Input`** в двух местах, оба — часть одного и
того же generic-цикла из 6 полей:

- Создание проекта: `apps/web/app/routes/_authenticated/projects/index.tsx:758-786`.
- Редактирование проекта: `apps/web/app/routes/_authenticated/projects/$projectId.tsx:268-303`.

Обе локации — **буквально идентичный код** (`['techStack','teamSize','benefits','paymentType',
'salaryReview','corpTech']` + `labels`-record + `form.Field` + `Input`). RBAC-паттерн для field-scoped
disable — `seniorSharePercentOverride` (`canEditOverride`, `$projectId.tsx:516`).

### Значения enum

`FOP → 'ФОП'`, `GIG_CONTRACT → 'гіг-контракт'`, `USDT → 'USDT'` (см. ADR D1,
`projectPaymentTypeSchema = z.enum(['FOP','GIG_CONTRACT','USDT'])`).

### Изменение в generic-цикле (edit-форма и create-форма — идентично)

Внутри `.map((fieldName) => ...)` выделить `paymentType` спец-веткой (остальные 5 полей остаются
`Input` без изменений):

```tsx
{
  ;(['techStack', 'teamSize', 'benefits', 'paymentType', 'salaryReview', 'corpTech'] as const).map(
    (fieldName) => {
      const labels: Record<string, string> = {
        techStack: 'Стек технологий',
        teamSize: 'Состав команды',
        benefits: 'Бенефиты',
        paymentType: 'Тип оплаты',
        salaryReview: 'Пересмотр ЗП',
        corpTech: 'Корп. технологии',
      }
      if (fieldName === 'paymentType') {
        return (
          <form.Field key="paymentType" name="paymentType">
            {(field: AnyField) => (
              <div className="space-y-1.5">
                <Label>Тип оплаты</Label>
                <Select
                  value={field.state.value as string}
                  onValueChange={(v) => field.handleChange(v)}
                  disabled={!canEditPaymentType}
                >
                  <SelectTrigger className="h-9 text-sm" data-testid="project-payment-type-trigger">
                    <SelectValue placeholder="Выберите тип оплаты" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FOP" className="text-sm">
                      ФОП
                    </SelectItem>
                    <SelectItem value="GIG_CONTRACT" className="text-sm">
                      гіг-контракт
                    </SelectItem>
                    <SelectItem value="USDT" className="text-sm">
                      USDT
                    </SelectItem>
                  </SelectContent>
                </Select>
                {!canEditPaymentType && (
                  <p className="text-xs text-muted-foreground italic">
                    Менять может только ADMIN или ACCOUNTANT.
                  </p>
                )}
              </div>
            )}
          </form.Field>
        )
      }
      return (
        <form.Field key={fieldName} name={fieldName}>
          {(field: AnyField) => (
            <div className="space-y-1.5">
              <Label>{labels[fieldName]}</Label>
              <Input
                value={field.state.value as string}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  field.handleChange(e.target.value)
                }
                placeholder=""
              />
            </div>
          )}
        </form.Field>
      )
    },
  )
}
```

`canEditPaymentType` = то же выражение, что `canEditOverride` (ADMIN | ACCOUNTANT) — **в edit-форме
переиспользовать существующую переменную `canEditOverride`** (`$projectId.tsx:516`) напрямую, без
дублирования. **В create-форме** (`index.tsx`) объявить аналог `const canEditPaymentType =
user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT'` — заметить, что `canCreate` там = ADMIN||HR
(:136), т.е. **HR может создать проект, но не может выбрать тип оплаты** при создании: Select
показывает дефолт `ФОП` (соответствует backend-дефолту `DEFAULT 'FOP'`, ADR D1) в disabled-состоянии
с тем же hint'ом «Менять может только ADMIN или ACCOUNTANT.» ACCOUNTANT физически не видит create-форму
(`canCreate` их не пускает) — RBAC-переменная остаётся симметричной ради conformance с edit-формой,
не создаёт лишнего состояния.

### Read-only view — InfoRow «Тип оплаты»

Существующий `InfoRow` (`$projectId.tsx:989-995`) сейчас рендерит `project.paymentType` как
свободный текст **без RBAC-гейта** (виден всем ролям, включая HR/JUNIOR). Обновить:

```tsx
{
  viewerRole !== 'JUNIOR' && (
    <InfoRow icon={<CreditCard className="h-3.5 w-3.5" />} label="Тип оплаты">
      {project.paymentType ? (
        <span className="font-medium">{PAYMENT_TYPE_LABELS[project.paymentType]}</span>
      ) : (
        <span className="text-muted-foreground/40 italic">—</span>
      )}
    </InfoRow>
  )
}
```

`PAYMENT_TYPE_LABELS` — константа-маппинг enum→русский лейбл (`{ FOP: 'ФОП', GIG_CONTRACT:
'гіг-контракт', USDT: 'USDT' }`), общая для Select-опций и read-view (не дублировать строки).

**Важно (Q5 — скрытие от JUNIOR):** это единственная RBAC-правка read-view в этой фиче — раньше
строка была видна всем. Теперь `viewerRole !== 'JUNIOR'` явно исключает JUNIOR, HR **продолжает
видеть значение** (Q5-таблица в задаче: HR = read (value), только JUNIOR = скрыто целиком). Если
backend решит маскировать поле как `null` в JUNIOR-DTO (а не просто не различать роль) — фронт всё
равно должен не рендерить строку для JUNIOR явным условием (defense-in-depth, не полагаться только
на `project.paymentType == null`, т.к. HR тоже мог бы теоретически получить null по другой причине).

### data-testid

| Элемент                                                 | `data-testid`                  |
| ------------------------------------------------------- | ------------------------------ |
| SelectTrigger «Тип оплаты» (edit + create — одинаковый) | `project-payment-type-trigger` |

---

## Responsive (4 класса устройств)

**Подход: mobile-first.** Все три поверхности наследуют поведение своих референс-паттернов —
ShareSlider (Surface A), диалог `CreateTransactionDialog`/`CrmDialog` (Surface B), форма проекта в
диалоге (Surface C).

### Surface A — ShareSlider в edit-диалоге проекта

| Класс            | Поведение                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Мобайл 320–639   | `space-y-2` = стандартный vertical stack. Визуальный bar 100% ширина контейнера — адаптируется автоматически. Числовой инпут `w-16` не меняется. Hit-area слайдера: `h-2` track → thumb нативный браузерный (≥44px в большинстве мобильных браузеров). Range-инпут `accent-primary`. Весь блок не обрезается — нет фиксированных горизонтальных размеров. |
| Планшет 640–1023 | Идентично мобайлу, ширина контейнера больше — bar читается лучше.                                                                                                                                                                                                                                                                                         |
| Ноутбук 1024+    | Полная ширина внутри `space-y-3` формы. Числовые значения чёткие.                                                                                                                                                                                                                                                                                         |
| Большой 1440+    | Контент-колонка формы с `max-w` — нет растяжки.                                                                                                                                                                                                                                                                                                           |

**Нет обрезания на мобайле:** `ShareSlider` использует `flex items-center gap-3` для ряда
с range + числовым инпутом — адаптируется. Визуальный bar — `overflow-hidden rounded-md` —
адаптируется к ширине родителя.

### Surface B — тип-карточка + проект-Select + grouped receiver-Select в `CreateTransactionDialog`

| Класс          | Поведение                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Мобайл 320–639 | `CrmDialog` full-screen (`max-h-[90dvh]`, body скроллится). Тип-карточки (`grid grid-cols-1`) — стек в 1 колонку, каждая ≥ 44px высоты (`px-3 py-2` + текст+description ⇒ фактическая высота карточки ~52-56px, comfortably ≥44px тач-таргет). Проект-Select и Получатель-Select — `SelectTrigger h-9` (36px) при закрытом состоянии — на мобайле хорошо, т.к. `SelectTrigger` full-width контейнера (широкий тач-таргет по X компенсирует высоту по Y); открытый `SelectContent` — Radix Portal, покрывает viewport, `SelectItem` `py-1.5` (~32px) читаемо и скроллируемо. `SelectGroup`/`SelectLabel` («Админы»/«Счёт компании») не ломают раскладку — `px-2 py-1.5 text-sm font-semibold`, обычный block-level элемент. |
| Планшет 640+   | Диалог 90dvh, Select нормальный, тип-карточки — та же 1-колоночная сетка (не расширяется на 2 колонки — конформно с существующим паттерном :490).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Ноутбук 1024+  | Стандартный диалог (`sm:max-w-lg`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Большой 1440+  | Без изменений — диалог не растягивается сверх `sm:max-w-lg`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**Длинные имена ADMIN в SelectItem:** Radix `SelectItem` по умолчанию не обрезает текст (нет
`overflow: hidden` на `ItemText`) — длинные `displayName` переносятся, не обрезаются ни на одном
классе устройств.

### Surface C — Select «Тип оплаты» в форме проекта (create + edit)

| Класс          | Поведение                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Мобайл 320–639 | Форма проекта уже рендерится внутри `Dialog`/`Sheet` full-screen на мобайле (существующее поведение create/edit диалогов). Select full-width контейнера (`space-y-1.5` секция) — тач-таргет `h-9` по высоте, полная ширина по X. Disabled-состояние (`opacity-50` встроено в `SelectTrigger`, компонент) — читаемо, не выглядит как активный контрол. |
| Планшет 640+   | Форма может идти в 1-2 колонки (существующая раскладка) — Select не меняется.                                                                                                                                                                                                                                                                         |
| Ноутбук 1024+  | Стандартно.                                                                                                                                                                                                                                                                                                                                           |
| Большой 1440+  | `max-w` формы — Select не растягивается сверх контейнера поля.                                                                                                                                                                                                                                                                                        |

---

## Edge-cases

### Surface A

| Кейс                                                    | Поведение                                                                                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Не-drop-проект (`dropId == null`)                       | Секция «Доля дропа» полностью скрыта для всех ролей                                                                                                                    |
| Дроп-проект, но `dropSharePercent` не пришло в DTO      | Показывать `effectiveDropSharePercent` = `5` (дефолт `DEFAULT_DROP_SHARE_PERCENT`); hint: «По умолчанию: 5%»                                                           |
| Override = null (сброшен)                               | Слайдер показывает `effectiveDropSharePercent` (из user-default), не 0                                                                                                 |
| Пользователь не ADMIN/ACCOUNTANT                        | Слайдер `disabled` (opacity-60), hint «Менять может только ADMIN или ACCOUNTANT.»                                                                                      |
| HR / JUNIOR                                             | Секция `dropSharePercentOverride` скрыта (`viewerRole !== 'HR' && viewerRole !== 'JUNIOR'`)                                                                            |
| Значение > 100 или < 0                                  | Validator: «Введите целое число от 0 до 100» (паттерн senior)                                                                                                          |
| **USDT-проект без синьора-небанковской привязки — n/a** | Surface A не зависит от `paymentType` вообще — слайдер видим на drop-проекте независимо от типа оплаты (ФОП/гіг/USDT); доля дропа резолвится одинаково во всех случаях |

### Surface B (admin-USDT flow)

| Кейс                                                                                                               | Поведение                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Пустой список ADMIN (edge-case — теоретически невозможно, минимум 1 ADMIN всегда есть, включая самого декларатора) | `adminUsers` включает и самого декларирующего ADMIN — список никогда не пуст на практике; UI не полагается на это жёстко, просто не рендерит пустую `SelectGroup` без падения                                                     |
| Имя ADMIN длиннее ~30 символов                                                                                     | `SelectItem` допускает wrap — текст переносится, ничего не обрезается                                                                                                                                                             |
| Проект без синьора-ADMIN (обычный drop/senior-USDT-проект)                                                         | Обязательства создаются по стандартной логике ADR D4 (senior-доля — если синьор не ADMIN; drop-доля — если `dropId` привязан); UI не меняется в зависимости от того, кто синьор                                                   |
| USDT-проект БЕЗ синьора вообще (гипотетически) — n/a на UI-уровне                                                  | Backend-инвариант (`projects.seniorId NOT NULL` в схеме) — фронт не обрабатывает этот кейс отдельно                                                                                                                               |
| Нет ни одного USDT-проекта в системе                                                                               | `usdtProjects` — пустой массив; проект-Select открывается пустым (без вспомогательного текста внутри `SelectContent` — минимальный edge-case, ADMIN и так знает, что USDT-проектов нет); Submit заблокирован валидацией `project` |
| SENIOR/DROP — ВСЕ их проекты USDT-типа                                                                             | Гейт-хинт под селектором проекта (см. раздел «Гейт-скрытие» выше) — `senior-income-usdt-gate-hint` / `drop-income-usdt-gate-hint`                                                                                                 |
| SENIOR/DROP — смесь ФОП/гіг + USDT проектов                                                                        | USDT-проекты тихо отфильтрованы из Select, без хинта — деклатор просто не видит их в списке                                                                                                                                       |
| Диалог закрыт/сброшен                                                                                              | `receiverId` сбрасывается в `''` (уже существующий `resetForm`/type-switch механизм, :498) — предвыбора нет по дизайну                                                                                                            |
| Ошибка загрузки списка пользователей (`allUsers` query error)                                                      | `adminUsers` — пустой derived-массив (fallback `[]`, уже в коде :195 `data: allUsers = []`); Select открывается пустым, стандартный паттерн query error — не блокирует диалог                                                     |

### Surface C (тип оплаты)

| Кейс                                                         | Поведение                                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| HR открывает create-форму                                    | Select виден, **disabled**, дефолт «ФОП»; hint «Менять может только ADMIN или ACCOUNTANT.»                                                        |
| SENIOR/DROP видят Select в read-view (InfoRow)               | Значение видно (read), не редактируется — они вообще не имеют доступа к edit-диалогу (`canOpenEdit` их не включает)                               |
| JUNIOR                                                       | Секция целиком скрыта, и в edit-форме (JUNIOR не открывает edit вообще), и в read-view InfoRow (`viewerRole !== 'JUNIOR'` явный гейт)             |
| `project.paymentType` не пришёл в DTO (legacy/до миграции)   | InfoRow показывает `—` (существующий fallback-паттерн `text-muted-foreground/40 italic`); Select в форме — fallback на `'FOP'` как value          |
| Смена типа с USDT на ФОП/гіг при наличии pending-obligations | UI-уровня edge-case не требует спец-обработки — backend-инвариант (существующие obligations не отменяются сменой paymentType, это backend-задача) |

---

## A11y (WCAG 2.2 AA)

### Surface A — ShareSlider

| Требование                      | Реализация                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `aria-label` на range-инпуте    | ShareSlider передаёт `aria-label={labels.aria}` = «Доля дропа в процентах» (из `ROLE_LABELS['DROP']`)                   |
| `aria-label` на числовом инпуте | Аналогично — уже в компоненте                                                                                           |
| Label / for                     | `<Label>` над блоком — визуальный; range и number инпуты не `id`-связаны (паттерн компонента) — aria-label компенсирует |
| Contrast                        | `text-muted-foreground` на `bg-card` — 4.5:1 в dark-mode (выверено в tokens)                                            |
| Focus                           | Range инпут: нативный `focus` браузера + `accent-primary`; number инпут: `focus-visible:ring-1 focus-visible:ring-ring` |
| Target size                     | Range thumb нативный — варьируется по браузеру (обычно 20–28px нативно); acceptable (SC 2.5.8 минимум 24px)             |
| Disabled state                  | `aria-disabled` не нужен — `disabled` атрибут на инпутах достаточен; `opacity-60` — визуальный индикатор                |

### Surface B — тип-карточка + оба Select (проект / получатель)

| Требование                             | Реализация                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Тип-карточка (`button`)                | Нативный `<button type="button">` — фокусируем по Tab, активируем Enter/Space без доп. ARIA                                                     |
| Radix Select a11y (project + receiver) | `Select` (Radix) автоматически: `role="combobox"`, `aria-expanded`, `aria-haspopup`, `role="option"` на items                                   |
| `SelectGroup`/`SelectLabel`            | Radix `Group`/`Label` — screen reader объявляет группу перед перечислением опций внутри (`aria-labelledby` авто-связь, встроено в примитив)     |
| Focus trap                             | Radix `SelectContent` trap focus внутри себя — штатное поведение Radix UI                                                                       |
| Escape close                           | Radix закрывает Select по Escape — штатно                                                                                                       |
| Contrast                               | `text-muted-foreground` hints — ≥4.5:1; `text-destructive` ошибки — ≥4.5:1; `text-blue-400` company-hint box — выверено в существующем паттерне |
| Target size SelectTrigger              | `h-9` = 36px height; ширина full-width контейнера — более чем 44px в ширину → ок. На мобайле: tap target крупный (full-width)                   |
| SelectItem target size                 | Radix `py-1.5` ≈ 32px высота элемента — допустимо (SC 2.5.8 минимум 24px); на мобайле Radix SelectContent — оверлей позволяет комфортный tap    |
| Обязательное поле (получатель)         | `aria-required` не добавляется явно — ошибка валидации через `fieldErrors.receiver` + screen reader читает error-параграф                       |
| Error сообщение                        | `<p data-testid="usdt-income-error-receiver">` — визуальный + screen reader (inline после trigger)                                              |

### Surface C — Select «Тип оплаты»

| Требование                         | Реализация                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `<Label>` над селектором           | `<Label>Тип оплаты</Label>` — визуальный, стандартная связь по позиционированию (паттерн остальных полей формы)                           |
| Radix Select a11y                  | Как у Surface B — встроено в примитив                                                                                                     |
| Disabled state                     | `disabled` prop на `Select` (Radix) → `aria-disabled` авто, `data-disabled` для стилизации (`opacity-50` встроено)                        |
| Contrast                           | Disabled-текст всё ещё ≥3:1 (не полностью invisible) — компонент не переопределяет цвет текста, только opacity                            |
| Target size                        | `h-9` (36px) + full-width — тот же паттерн, что везде в форме проекта                                                                     |
| Screen reader на скрытии от JUNIOR | Секция не рендерится вообще для JUNIOR (`viewerRole !== 'JUNIOR'`) — корректно, не «visually hidden», а полностью убрана из DOM/AT-дерева |

---

## Список компонентов

| Компонент                                                               | Тип                                                 | Источник                                                                                         |
| ----------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ShareSlider`                                                           | Существующий                                        | `apps/web/app/components/ui/share-slider.tsx`                                                    |
| `Select`, `SelectTrigger`, `SelectContent`, `SelectItem`, `SelectValue` | Существующий                                        | `apps/web/app/components/ui/select.tsx` (shadcn/Radix)                                           |
| `SelectGroup`, `SelectLabel`, `SelectSeparator`                         | Существующий, **первое использование в приложении** | `apps/web/app/components/ui/select.tsx` (уже экспортированы, не используются нигде до этой фичи) |
| `Label`                                                                 | Существующий                                        | `apps/web/app/components/ui/label.tsx`                                                           |
| `AmountCurrencyInput`                                                   | Существующий (расширяется `isUsdtLocked`)           | `apps/web/app/components/ui/amount-currency-input.tsx`                                           |
| `ProjectDropShareInfo`                                                  | **НОВЫЙ** компонент (если нужен)                    | По образцу `ProjectShareInfo` — read-only строка доли дропа с бейджем                            |
| `PAYMENT_TYPE_LABELS`                                                   | **НОВАЯ** константа (не компонент)                  | Маппинг enum→лейбл, общий для Select-опций Surface C и read-view InfoRow                         |

### `ProjectDropShareInfo` — эскиз API

```tsx
// По образцу существующего ProjectShareInfo
function ProjectDropShareInfo({ project }: { project: ProjectDetailDto }) {
  const override = project.dropSharePercentOverride
  const effective = project.dropSharePercent ?? 5 // effective из DTO
  return (
    <span className="text-sm font-medium tabular-nums">
      {effective}%
      {override !== null && override !== undefined && (
        <Badge variant="outline" className="ml-1.5 text-[10px]">
          Override
        </Badge>
      )}
    </span>
  )
}
```

Если архитектурно проще встроить inline — допустимо, отдельный компонент не обязателен.

---

## data-testid — сводная таблица (все поверхности)

| Элемент                                                | `data-testid`                                       | Поверхность |
| ------------------------------------------------------ | --------------------------------------------------- | ----------- |
| Слайдер доли дропа (числовой инпут)                    | `project-edit-drop-share-override`                  | A           |
| Секция слайдера (обёртка)                              | `project-edit-drop-share-section`                   | A           |
| Тип-карточка «USDT-приход» (авто из паттерна)          | `create-transaction-type-usdt_income`               | B           |
| Проект-Select (переиспользуется всеми 4 income-типами) | `create-transaction-project-trigger` (существующий) | B           |
| Получатель-Select trigger                              | `usdt-income-receiver-trigger`                      | B (новый)   |
| Получатель — ошибка валидации                          | `usdt-income-error-receiver`                        | B (новый)   |
| Гейт-хинт SENIOR (все проекты USDT)                    | `senior-income-usdt-gate-hint`                      | B (новый)   |
| Гейт-хинт DROP (все проекты USDT)                      | `drop-income-usdt-gate-hint`                        | B (новый)   |
| Select «Тип оплаты» (create + edit форма проекта)      | `project-payment-type-trigger`                      | C (новый)   |

---

## Motion

Никакого дополнительного motion. Переходы слайдера (bar width) — `transition-all duration-150` уже
в ShareSlider (строки 72 и 80). Select-анимации, тип-карточки (`transition-all`) — из
shadcn/Radix/существующего паттерна диалога (стандартные `fade-in`). Новых анимаций не добавлять —
это касается всех трёх поверхностей, включая новый grouped Select и Select «Тип оплаты».

---

## Инструкция для кодера (КРИТИЧНО)

1. **Строй нашими компонентами** по этой спеке — `ShareSlider`, `Select`/`SelectGroup`/`SelectLabel`/
   `SelectSeparator` из shadcn/ui. **НЕ** копируй generic HTML, **НЕ** вводи новые CSS-переменные /
   hardcoded hex.
2. **Surface A** — полный аналог `seniorSharePercentOverride` (строки 339–397 в `$projectId.tsx`).
   Различия: имя поля, label, `role="DROP"`, условие `project.dropId != null`. **Без изменений с
   первой версии спеки.**
3. **Surface B — НЕ добавляй селектор получателя в `DROP_INCOME`/`SENIOR_INCOME`.** Это устаревшее
   требование из первой версии спеки. Получатель — только в новой ветке `type === 'USDT_INCOME'`
   (синтетический UI-тип, ADMIN-only, ledger-тип на бэкенде остаётся `ADMIN_INCOME`). Модель — ветка
   `DIVIDEND` (:801-883) как структурный референс + grouped `SelectGroup`/`SelectLabel`.
4. **Гейт-скрытие для SENIOR/DROP** — фильтруй `myProjects`/`dropProjects` по `paymentType !==
'USDT'`; хинт только когда список опустел ПОСЛЕ фильтра (не когда изначально пуст).
5. **Surface C** — заменяет существующее free-text `Input` для `paymentType` (НЕ добавляет новое
   поле) в ДВУХ местах: `projects/index.tsx` (create) и `$projectId.tsx` (edit) — идентичные
   generic-циклы, найди оба. RBAC: disabled non-ADMIN/ACCOUNTANT (переиспользуй `canEditOverride` в
   edit-форме); скрой read-view InfoRow от JUNIOR (`viewerRole !== 'JUNIOR'`).
6. **НЕ вставляй `receiverId` в `createDropIncomeSchema`/`createDropIncome`-payload** (ADR C14 — это
   был баг черновика M1, откатывается на backend-стороне; фронт просто не добавляет это поле в
   DROP_INCOME submit).
7. **`ProjectDropShareInfo`** — опциональный компонент по образцу `ProjectShareInfo`. Если
   `ProjectShareInfo` уже абстрагирован достаточно, используй его с `role="DROP"` параметром.
8. **data-testid** строго по сводной таблице выше — AutoTest использует их (особенно
   `usdt-income-error-receiver` и `project-payment-type-trigger` — точные имена из задачи).
9. **Responsive** — нет фикс-ширин, нет overflow, ни на одной из 3 поверхностей. Проверь на 320px
   (ShareSlider bar, тип-карточки в 1 колонку, оба Select full-width).
10. **Implicit-null-reset для Surface A** — логика на frontend/backend согласно брифу (backend-задача
    задаёт контракт).
11. **Зависимость от backend-контракта:** `ProjectOption.paymentType`, `financeApi.declareUsdtProjectIncome`,
    DTO-тип для USDT-income — приходят из backend-задачи (`task-drop-share-backend`, модель opus).
    Frontend-задача НЕ стартует раньше готовности этого контракта (см. `pm-brief` — sequential
    single-pipeline, frontend ждёт backend).

---

## Fidelity-референсы (для Mode B после реализации)

`design-gate: degraded` — Claude Design не задействован, `design.png` не создаётся для этой фичи
(Tier 2 conformance к существующим паттернам). Mode B fidelity-аудит после реализации сверяется
против **этой спеки + существующих референс-компонентов** (`ShareSlider`, `DIVIDEND`-ветка,
`seniorSharePercentOverride`), не против макета — по правилу `design-fidelity-review.md` §Деградация
(«fidelity-diff против spec docs/design/<slug>.md + foundation.md»). Responsive-проверка всех 4
классов на localhost остаётся обязательной.
