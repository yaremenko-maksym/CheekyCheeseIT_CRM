# Design Spec — Обязательный чек для всех транзакций + attach/replace + explorer-only USDT

> **Design tier:** 2 (правка 9 существующих плотных диалогов + новый compact attach-UI со строки/деталей)
> **design-gate:** degraded (Claude Design не задействован — headless-сессия без браузера; текстовая
> спека Mode E). Fidelity-аудит после реализации сверяется против ЭТОЙ спеки + существующих
> референс-компонентов (`ReceiptInput`, `ReceiptPanel`, `FundingSourceFields`, `AdminEditTransactionDialog`),
> не против `design.png`.
> **Status:** coder-ready
> **Ветка фичи:** `feature/transaction-receipts`
> **Референс брифа:** `.claude/briefs/pm-brief-transaction-receipts.md` (§4 инвентаризация, §5 allowlist, §6 attach-контракт)
> **Референс task-файла:** `.claude/tasks/task-receipts-design.md`

---

## Резюме UX-решений (executive summary)

1. **Компактная подача — НЕ коллапс, НЕ новый визуальный блок.** `ReceiptInput` уже занимает
   компактную позицию (tab-toggle 32px + drop-zone/URL-инпут) в существующем месте — сразу после
   Amount+Currency+Date, перед Notes. Единственное изменение: **расширить** список типов, для которых
   этот (уже существующий) блок рендерится и становится **обязательным** — никакого нового layout,
   никакого accordion/collapse (аккордеон для ОБЯЗАТЕЛЬНОГО поля — anti-pattern: прячет то, что должно
   быть заметно). Для `PaySalaryDialog`/`SettleSeniorPayoutDialog` — тот же компонент **заменяет**
   существующее необязательное текстовое поле «TX Hash» (см. §2.2 — обоснование консолидации).
2. **Explorer-only — новый проп `ReceiptInput.explorerOnly`.** Когда `true`: tab-toggle («Файл»/«Ссылка»)
   **скрывается целиком** (не disabled — одна оставшаяся вкладка в 2-табовом тумблере выглядит сломанной),
   рендерится только URL-инпут с explorer-специфичным hint. Авто-нормализация: если родитель переключает
   `explorerOnly` в `true`, пока `state.mode === 'file'` — компонент сам сбрасывает в пустой `url`-режим
   (не оставляет невалидный файл-чек на USDT-транзакции).
3. **Attach/replace — новый компонент `AttachReceiptSheet`.** Один переиспользуемый `Sheet` (side=right,
   `w-full sm:max-w-md`), два entry-point: (а) компактная icon-кнопка в `TransactionRow` (видима от
   768px — `md:`), (б) явная кнопка рядом с `ReceiptPanel` в `TransactionDetailDialog` (видима на ВСЕХ
   классах, **основной вход на мобайле**, `h-11`=44px). RBAC/статус-гейт — единая шаренная функция
   `canAttachReceipt()`, не дублируется между row/detail/sheet. Замена существующего чека → `AlertDialog`
   confirm (существующий примитив, паттерн `ValidateDialog.tsx`).
4. **Пустое состояние старых транзакций** — уже решено существующим `ReceiptPanel` (dashed placeholder,
   «Нет прикреплённого чека», компонент #356-совместим). Новое: в `TransactionRow` — приглушённая
   `Receipt`-иконка как индикатор наличия/отсутствия чека (только когда у смотрящего есть право
   действовать — иначе не рендерим лишний визуальный шум в и так плотной таблице).
5. **Побочные фиксы конформности** (низкий риск, тот же участок кода, который и так трогается):
   `showReceiptPanel` в `TransactionDetailDialog` расширяется на `SALARY`/`ADMIN_TRANSFER`/`DIVIDEND_TO_ADMIN`
   и попутно закрывает пред-существующий пробел `DROP_INCOME` (уже могла иметь чек, но никогда не
   получала split-view превью — латентный баг, не в скоупе фичи по духу, но тот же `if`, тот же PR).

---

## 1. Контекст (бизнес)

«Чек» (`receiptDocumentId` XOR `receiptExternalUrl`, DB CHECK-констрейнт, компонент `ReceiptInput`)
становится обязательным во всех пользовательских create/pay-флоу. USDT-валютные транзакции требуют
именно ссылку на blockchain-explorer (allowlist доменов), не файл. Появляется generic attach/replace
эндпоинт для транзакций, у которых чека ещё нет либо он требует замены. История не мигрируется — старые
транзакции остаются без чека, UI не ломается на пустом значении. Полный бизнес-контекст, RBAC-матрица,
допущения (A1–A6) — `.claude/briefs/pm-brief-transaction-receipts.md`.

---

## 2. Компонент-инвентарь

### 2.1 Существующие (переиспользуются как есть или расширяются)

| Компонент                                                                      | Файл                                                            | Роль в этой фиче                                                                                                                           |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ReceiptInput`                                                                 | `.../finance/components/ReceiptInput.tsx`                       | **Расширяется** — новый проп `explorerOnly` (+ опц. `error`), см. §4.1                                                                     |
| `emptyReceiptState`, `receiptStateFromDocument`, `receiptStateFromExternalUrl` | `ReceiptInput.tsx`                                              | Без изменений — переиспользуются в `AttachReceiptSheet`                                                                                    |
| `ReceiptPanel`, `useReceiptUrl`                                                | `.../finance/components/dialogs/receipt-panel.tsx`              | Без изменений — уже решает empty-state (§7)                                                                                                |
| `CreateTransactionDialog`                                                      | `.../finance/components/dialogs/CreateTransactionDialog.tsx`    | Расширяется `showReceipt` + `validate()` + submit-payload (§3.1)                                                                           |
| `PaySalaryDialog`                                                              | `.../finance/components/dialogs/PaySalaryDialog.tsx`            | «TX Hash» текст-инпут → `ReceiptInput` (§3.2)                                                                                              |
| `SettleSeniorPayoutDialog`                                                     | `.../finance/components/dialogs/SettleSeniorPayoutDialog.tsx`   | Добавляется `ReceiptInput` (§3.3)                                                                                                          |
| `FundingSourceFields`                                                          | `.../finance/components/dialogs/FundingSourceFields.tsx`        | Источник `currency` state для explorer-only дискриминанта — без изменений                                                                  |
| `TransactionRow`                                                               | `.../finance/components/TransactionRow.tsx`                     | Новая icon-кнопка/индикатор «Чек» в actions-кластере (§5.2)                                                                                |
| `TransactionDetailDialog`, `receipt-panel.tsx`                                 | `.../finance/components/dialogs/TransactionDetailDialog.tsx`    | `showReceiptPanel` расширяется + кнопка attach/replace (§5.5)                                                                              |
| `AdminEditTransactionDialog`                                                   | `.../finance/components/dialogs/AdminEditTransactionDialog.tsx` | Референс-паттерн (1:1 replace-with-delete) — НЕ заменяется новым эндпоинтом; остаётся отдельным ADMIN-only «редактировать всё» флоу (§5.6) |
| `Sheet`/`SheetContent`/`SheetHeader`/`SheetTitle`/`SheetFooter`                | `apps/web/app/components/ui/sheet.tsx`                          | Контейнер `AttachReceiptSheet`                                                                                                             |
| `AlertDialog`/`AlertDialogAction`/`AlertDialogCancel`/…                        | `apps/web/app/components/ui/alert-dialog.tsx`                   | Confirm при замене чека (паттерн `ValidateDialog.tsx:268-282`)                                                                             |
| `Button`, `Badge`, `Label`, `Input`                                            | `apps/web/app/components/ui/*`                                  | Стандартные примитивы                                                                                                                      |

### 2.2 Новые

| Компонент                           | Тип                  | Назначение                                                                                                            |
| ----------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `AttachReceiptSheet`                | Новый компонент      | Единая точка attach/replace для ЛЮБОЙ транзакции; вызывает `PATCH /transactions/:id/receipt`                          |
| `canAttachReceipt()`                | Новая shared-функция | RBAC+статус-гейт — единая логика для row-иконки, detail-кнопки и самого Sheet (§5.1)                                  |
| `financeApi.attachReceipt(id, dto)` | Новый API-метод      | `api.patch<TransactionDto>(\`/transactions/${id}/receipt\`, data)`— паттерн 1:1 с`paySalary`/`adminUpdateTransaction` |

**Координация с backend-задачей (§5 брифа) — контракт УЖЕ landed** (`wip(shared): mandatory receipt
refine + explorer allowlist + attach schema`, `packages/shared/src/schemas/finance.ts`), имена ниже —
финальные, использовать буквально (НЕ изобретать альтернативные):

- `attachReceiptSchema` / `AttachReceiptDto` — тело `PATCH /transactions/:id/receipt` (XOR, mandatory).
- `BLOCKCHAIN_EXPLORER_HOSTS: ReadonlySet<string>` — 8 доменов allowlist (те же, что §4.2).
- `isExplorerUrl(url: string): boolean` — https + allowlist-host + non-empty path.
- `receiptMandatoryError(receipt, effectiveCurrency): string | null` — **готовая** shared pure-функция,
  возвращает русское сообщение об ошибке (или `null`) по ЕДИНЫМ правилам (XOR, mandatory,
  USDT→explorer-only). Frontend `validate()` вызывает её НАПРЯМУЮ — см. §3.1 (не переизобретать
  проверку из отдельных `isAllowedExplorerUrl`/`hasReceipt`-проверок, как в первом черновике этой
  спеки — `receiptMandatoryError` уже покрывает всё одним вызовом, DRY с backend).
- `mandatoryReceiptRefine(getCurrency)` — backend-only superRefine-фабрика (уже применена ко всем 7
  create/pay-схемам per §4.3 таблице — discriminant-выражения там подтверждены 1:1 с реальным кодом).

### 2.3 Согласование с существующим `txHash` (важное дизайн-решение)

`TransactionDto.txHash` (raw-строка, `TxHashLink` в `TransactionDetailDialog.tsx:125-137`) — легаси-поле
времён ДО этой фичи, жёстко хардкодит `https://etherscan.io/tx/${hash}` (только Ethereum, не
multi-chain). Оно рендерится ТОЛЬКО для `SALARY`/`PAYOUT`/`PAYOUT_ADMIN` — типов, у которых сегодня НЕТ
`receiptDocumentId`/`receiptExternalUrl`.

**Решение:** для `SALARY` (единственный из трёх, который эта фича трогает) — **убрать** UI-инпут «TX Hash
(необязательно)» из `PaySalaryDialog` и заменить его на mandatory `ReceiptInput` (explorer-only при
USDT). `ReceiptPanel` уже корректно резолвит ЛЮБОЙ explorer-домен (не хардкодит etherscan.io) — он
становится каноничной поверхностью проверки. Старый `TxHashLink`-ряд в `SalaryContent` **не удаляется**,
а ограничивается legacy-fallback (только когда есть `tx.txHash`, но НЕТ нового чека — старые PAID-строки
до фичи):

```tsx
{
  tx.txHash && !tx.receiptDocumentId && !tx.receiptExternalUrl && (
    <Row icon={<Hash className="h-4 w-4" />} label="TX Hash">
      <TxHashLink hash={tx.txHash} />
    </Row>
  )
}
```

`PAYOUT`/`PAYOUT_ADMIN` — вне скоупа (A5 брифа: `payout-requests` уже требует on-chain `txHash`,
отдельный чек не добавляется) — их `TxHashLink`-ряды НЕ трогать.

Backend-координация (не моя зона, но нужно явно передать backend-задаче): `paySalarySchema.txHash`
можно оставить в контракте как необязательное legacy-поле (frontend просто больше не собирает его через
UI) — решение backend Coder, не блокирует frontend-реализацию.

---

## 3. Секция A — компактное размещение `ReceiptInput` в 9 create/pay-диалогах

### 3.1 `CreateTransactionDialog` — расширение существующего блока (7 из 9 флоу)

Единственная структурная правка — расширить `showReceipt` (:544-548) с 4 до 7 типов. JSX-блок
ReceiptInput (:1086-1106) **уже** сидит вне guard'а `type !== 'DIVIDEND'` (тот guard применяется только к
Amount+Currency и Date блокам выше) — то есть добавление `'DIVIDEND'` в список автоматически подхватывает
правильную позицию (после «Сумма (USDT)», перед Notes) БЕЗ переноса JSX:

```tsx
const showReceipt =
  type === 'ADMIN_INCOME' ||
  type === 'SENIOR_INCOME' ||
  type === 'DROP_INCOME' ||
  type === 'EXPENSE' ||
  // НОВОЕ — mandatory-чек добавляется этим тикетом (было: без чека вовсе)
  type === 'USDT_INCOME' ||
  type === 'ADMIN_TRANSFER' ||
  type === 'DIVIDEND'
```

**Эффективная валюта** — единая точка для explorer-only дискриминанта (§4), охватывает ВСЕ 7 типов
одним выражением (включая существующие SENIOR_INCOME/DROP_INCOME — валюта у них свободный выбор
независимо от `paymentType` проекта, см. брифовый R4 «универсальный дискриминант»):

```tsx
const effectiveCurrency: Currency = type === 'DIVIDEND' ? 'USDT' : isUsdtLocked ? 'USDT' : currency
const isExplorerOnly = effectiveCurrency === 'USDT'
```

**`validate()` (:335-372)** — обязательность расширяется с `SENIOR_INCOME || DROP_INCOME` на ВСЕ
`showReceipt`-типы. Вызывает **готовую** shared-функцию `receiptMandatoryError` (§2.2) — НЕ
переизобретает XOR/mandatory/explorer-проверку вручную:

```tsx
if (showReceipt) {
  const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
  const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
  const receiptError = receiptMandatoryError(
    { receiptDocumentId, receiptExternalUrl },
    effectiveCurrency,
  )
  if (receiptError) errors.receipt = receiptError
}
```

`receiptMandatoryError` — импорт из `@crm/shared` (`packages/shared/src/schemas/finance.ts`), ТА ЖЕ
функция, что backend гоняет в `mandatoryReceiptRefine`/сервисе — сообщение об ошибке 1:1 совпадает
клиент/сервер (никакого дублирования copy/regex во фронте).

**Рендер** (:1087-1106) — только проп-расширение, JSX-структура без изменений:

```tsx
{showReceipt && (
  <div className="space-y-1.5">
    <ReceiptInput
      state={receipt}
      onChange={(s) => { setReceipt(s); clearFieldError('receipt') }}
      label="Чек / подтверждение *"   {/* НОВОЕ: звёздочка ВСЕГДА теперь — поле mandatory для всех 7 типов, не только SENIOR_INCOME */}
      explorerOnly={isExplorerOnly}
      error={fieldErrors.receipt}
    />
    {fieldErrors.receipt && (
      <p className="text-[11px] text-destructive" data-testid="create-transaction-error-receipt">
        {fieldErrors.receipt}
      </p>
    )}
  </div>
)}
```

**Submit-payload** — `receiptDocumentId`/`receiptExternalUrl` уже собираются один раз в начале
`mutationFn` (:379-381) и переиспользуются во всех ветках. Добавить их в 3 ветки, где их сегодня нет:
`USDT_INCOME` (:426-437 — убрать комментарий «No receipt fields», добавить оба поля), `ADMIN_TRANSFER`
(:465-474), `DIVIDEND` (:475-486 — сегодня игнорирует receipt полностью, добавить).

### 3.2 `PaySalaryDialog` — замена «TX Hash» на `ReceiptInput`

Текущая структура (:97-162): summary-card → `FundingSourceFields` → **«TX Hash (необязательно)»
Input** → Notes → error. Новая структура — заменить блок TX Hash (:134-143) на:

```tsx
<div className="space-y-1.5">
  <ReceiptInput
    state={receipt}
    onChange={(s) => {
      setReceipt(s)
      setFieldError(null)
    }}
    label="Чек / подтверждение *"
    explorerOnly={currency === 'USDT'}
    error={fieldError}
  />
  {fieldError && (
    <p className="text-[11px] text-destructive" data-testid="pay-salary-error-receipt">
      {fieldError}
    </p>
  )}
</div>
```

`currency` — уже существующий state (:31), синхронизирован с `FundingSourceFields` (COMPANY_ACCOUNT
форсит USDT; ADMIN_PERSONAL — свободный выбор, дефолт остаётся USDT до ручной смены). Никакого нового
state для валюты не требуется — дискриминант `currency === 'USDT'` покрывает оба случая (форс И ручной
выбор).

`handleSubmit` — добавить client-side gate (mirrors CreateTransactionDialog): блокировать
`mutation.mutate()`, если `!hasReceipt`, показать `fieldError`. Mutation payload — добавить
`receiptDocumentId`/`receiptExternalUrl` в тело `financeApi.paySalary(...)` (:51-57); `txHash` поле
из payload убрать (или оставить `null` — backend решает).

### 3.3 `SettleSeniorPayoutDialog` — добавление `ReceiptInput`

Самый компактный из трёх — сегодня НЕТ ни Notes, ни какого-либо receipt/hash поля (:141-180: summary-card
→ `FundingSourceFields` → error). Добавить идентичный блок, что и в §3.2, между `FundingSourceFields` и
`error`:

```tsx
<FundingSourceFields ... />

<div className="space-y-1.5">
  <ReceiptInput
    state={receipt}
    onChange={(s) => { setReceipt(s); setFieldError(null) }}
    label="Чек / подтверждение *"
    explorerOnly={currency === 'USDT'}
    error={fieldError}
  />
  {fieldError && (
    <p className="text-[11px] text-destructive" data-testid="settle-senior-error-receipt">
      {fieldError}
    </p>
  )}
</div>

{error && <p ...>}
```

Аналогично — новый local `[receipt, setReceipt]` state (init `emptyReceiptState()`, сброс в
`resetState()`), gate в `handleSubmit`/`mutation.mutate()`, payload расширяется
`receiptDocumentId`/`receiptExternalUrl` в вызове `financeApi.settleSeniorPayoutFromTransaction(...)`.

### 3.4 Почему это уже «компактно» — без коллапса

`CrmDialogBody` уже `flex-1 overflow-y-auto` (scroll body), `CrmDialogContent` — `max-h-[90dvh]`
(`crm-dialog.tsx:42,74`) — диалоги технически НЕ переполняются от добавления одного `space-y-1.5`-блока
(tab-toggle 32px + drop-zone ~76px ИЛИ url-инпут 36px). Единственный риск «плотности» — субъективная
длина скролла, не overflow/breakage. Коллапс/accordion для ОБЯЗАТЕЛЬНОГО поля усложняет completion
(пользователь должен сначала найти и раскрыть секцию, прежде чем сможет пройти mandatory-валидацию) —
antipattern для required-полей (см. `accessibility` skill: не прятать required-контролы за
доп.взаимодействием). Решение: НЕ вводить коллапс — компактность уже достигнута тем, что
`ReceiptInput` — плотный компонент по конструкции (без лишних отступов/декора), и он ставится в
ЕДИНСТВЕННОЕ разумное место (после суммы/валюты, где currency уже известна для explorer-гейта).

---

## 4. Секция B — Explorer-only режим для USDT

### 4.1 `ReceiptInput` — расширение публичного API

```tsx
interface ReceiptInputProps {
  state: ReceiptState
  onChange: (next: ReceiptState) => void
  label?: string
  ownerId?: string
  /**
   * НОВОЕ. Когда true — компонент показывает ТОЛЬКО url-режим (без
   * tab-toggle, без «Файл»). Явный explorer-hint под инпутом. Если
   * `state.mode === 'file'` в момент включения — авто-сброс в пустой
   * url-режим (см. эффект ниже).
   */
  explorerOnly?: boolean
  /**
   * НОВОЕ. Внешняя ошибка валидации (напр. non-allowlist домен) — красный
   * ring на url-инпуте. Текст ошибки родитель рендерит сам (существующий
   * паттерн `fieldErrors.receipt`) — компонент не дублирует сообщение.
   */
  error?: string
}
```

**Авто-нормализация** (эффект, аналог существующего узко-скоупленного эффекта :119-123 — тот же
паттерн триггера по конкретному значению, не по всему `state`):

```tsx
useEffect(() => {
  if (explorerOnly && state.mode === 'file') {
    if (state.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(state.previewUrl)
    onChange({
      mode: 'url',
      documentId: null,
      externalUrl: '',
      fileName: '',
      previewUrl: null,
      mimeType: '',
    })
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- триггер по explorerOnly, не по всему state (паттерн :119-123)
}, [explorerOnly])
```

**Рендер** — когда `explorerOnly`, tab-toggle-блок (:199-226) не рендерится вообще, `state.mode`
трактуется как всегда `'url'`:

```tsx
{!explorerOnly && (/* существующий tab-toggle :199-226, без изменений */)}

{(explorerOnly || state.mode === 'url') && (
  <div>
    <Input
      value={state.externalUrl}
      onChange={(e) => onChange({ ...state, mode: 'url', externalUrl: e.target.value })}
      placeholder={explorerOnly ? 'https://etherscan.io/tx/0x...' : 'https://...'}
      className={cn('h-9 text-sm', error && 'border-destructive ring-1 ring-destructive/40')}
      data-testid="receipt-input-url-field"
    />
    {explorerOnly && (
      <p className="text-[11px] text-muted-foreground mt-1" data-testid="receipt-input-explorer-hint">
        Ссылка на blockchain-explorer (etherscan.io, tronscan.org, bscscan.com и др.)
      </p>
    )}
  </div>
)}

{!explorerOnly && state.mode === 'file' && (/* существующий file-режим :229-321, без изменений */)}
```

### 4.2 Allowlist — единый источник (landed, `packages/shared`)

Домены (брифовый §5, верифицировано по `etherscan.service.ts`, USDT ERC-20 + разумное multi-chain
расширение): `etherscan.io` (каноничный) · `tronscan.org` · `bscscan.com` · `polygonscan.com` ·
`arbiscan.io` · `basescan.org` · `optimistic.etherscan.io` · `snowtrace.io`. Экспортированы из
`packages/shared/src/schemas/finance.ts`: `BLOCKCHAIN_EXPLORER_HOSTS: ReadonlySet<string>` (сами
домены — для hint-текста, если понадобится динамически перечислить) + `isExplorerUrl(url): boolean`
(https + allowlist-host + non-empty path). Frontend импортирует ОБА из `@crm/shared` — НЕ хардкодить
список/regex отдельно (drift-риск). Для итоговой ошибки поля предпочтителен `receiptMandatoryError`
(§2.2) — он уже вызывает `isExplorerUrl` внутри и возвращает готовое русское сообщение.

### 4.3 Discriminant per-диалог (сводная таблица)

| Диалог                        | Источник currency                                                                             | `isExplorerOnly` выражение                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `ADMIN_INCOME`                | `currency` state (locked USDT при `fundingSource===COMPANY_ACCOUNT`)                          | `effectiveCurrency === 'USDT'` (§3.1)                                             |
| `SENIOR_INCOME`/`DROP_INCOME` | `currency` state (свободный выбор)                                                            | `effectiveCurrency === 'USDT'` (та же формула — универсальный R4)                 |
| `EXPENSE`                     | `currency` state (locked USDT при `fundingSource===COMPANY_ACCOUNT`)                          | `effectiveCurrency === 'USDT'`                                                    |
| `USDT_INCOME`                 | ВСЕГДА `'USDT'` (`z.literal('USDT')` на схеме)                                                | ВСЕГДА `true`                                                                     |
| `ADMIN_TRANSFER`              | `currency` state (свободный выбор, дефолт визуально USD — не locked)                          | `effectiveCurrency === 'USDT'` — становится `true`, если юзер вручную выбрал USDT |
| `DIVIDEND`                    | Нет currency-селектора — implicit USDT (дивиденд = вывод со счёта компании)                   | ВСЕГДА `true`                                                                     |
| `PaySalaryDialog`             | `currency` state (locked USDT при account=Company; свободный при ADMIN_PERSONAL, дефолт USDT) | `currency === 'USDT'`                                                             |
| `SettleSeniorPayoutDialog`    | Идентично `PaySalaryDialog`                                                                   | `currency === 'USDT'`                                                             |

### 4.4 Копирайтинг (единственные новые русские строки)

| Контекст                             | Текст                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Hint под explorer-only URL-полем     | «Ссылка на blockchain-explorer (etherscan.io, tronscan.org, bscscan.com и др.)»                 |
| Ошибка — не-allowlist домен          | «Ссылка должна вести на поддерживаемый blockchain-explorer (etherscan.io, tronscan.org и т.п.)» |
| Ошибка — чек не прикреплён (общая)   | «Прикрепите чек или укажите ссылку на подтверждение» (существующая, без изменений)              |
| Label поля (все 9 диалогов, unified) | «Чек / подтверждение \*» (звёздочка — визуальный маркер mandatory, конвенция проекта)           |

---

## 5. Секция C — Attach/Replace UI со строки/деталей транзакции

### 5.1 `canAttachReceipt()` — единая RBAC+статус функция (DRY)

Новый небольшой файл `apps/web/app/routes/_authenticated/finance/components/receipt-permissions.ts` —
импортируется в `TransactionRow`, `TransactionDetailDialog`, `AttachReceiptSheet`. Единая логика
исключает drift между «видно в строке» и «видно в деталях» (иначе — классический баг рассинхрона RBAC
между двумя поверхностями одной функции):

```tsx
export function canAttachReceipt(
  tx: Pick<TransactionDto, 'createdBy' | 'receiptDocumentId' | 'receiptExternalUrl' | 'status'>,
  currentUserId: string | null | undefined,
  role: string,
): boolean {
  const isPrivileged = role === 'ADMIN' || role === 'ACCOUNTANT'
  const hasReceipt = !!(tx.receiptDocumentId || tx.receiptExternalUrl)
  const isAuthor = !!currentUserId && tx.createdBy === currentUserId
  // Первичный attach (нет чека) — автор МОЖЕТ независимо от статуса (брифовый §6:
  // «Первичный attach — RBAC как выше», статус НЕ упомянут как ограничитель).
  // Replace (чек уже есть) при PAID — ТОЛЬКО ADMIN/ACCOUNTANT.
  return isPrivileged || (isAuthor && (!hasReceipt || tx.status !== 'PAID'))
}
```

Это **UI-гейт** (видимость/интерактивность) — backend ОБЯЗАН реализовать ту же логику server-side
(defense-in-depth, брифовый §6) независимо от фронта; фронт не является источником авторизации.

### 5.2 Entry-point 1 — icon-кнопка/индикатор в `TransactionRow`

Новый проп `onAttachReceipt?: (tx: TransactionDto) => void`. Рендерится в существующем actions-кластере
(:477-584), после `canAdminDelete`-блока, **видим от 768px** (`md:`) — на мобайле row actions-cell уже
горизонтально скроллится (`overflow-x-auto` на уровне таблицы), добавлять туда ещё один
sub-44px тач-таргет — плохой trade-off; основной mobile-вход — §5.5 (полноразмерная кнопка в
`TransactionDetailDialog`, открывается тапом по строке):

```tsx
const hasReceipt = !!(tx.receiptDocumentId || tx.receiptExternalUrl)
const showAttach = canAttachReceipt(tx, currentUserId, role)

<div className="hidden md:inline-flex">
  {showAttach ? (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        'h-7 w-7 p-0',
        hasReceipt
          ? 'text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
      )}
      onClick={() => onAttachReceipt?.(tx)}
      title={hasReceipt ? 'Заменить чек' : 'Прикрепить чек'}
      aria-label={hasReceipt ? 'Заменить чек' : 'Прикрепить чек'}
      data-testid={`tx-row-attach-receipt-${tx.id}`}
    >
      <Receipt className="h-3.5 w-3.5" />
    </Button>
  ) : hasReceipt ? (
    <span
      className="inline-flex h-7 w-7 items-center justify-center text-emerald-400/60"
      title="Чек прикреплён"
      aria-label="Чек прикреплён"
      data-testid={`tx-row-receipt-indicator-${tx.id}`}
    >
      <Receipt className="h-3.5 w-3.5" />
    </span>
  ) : null}
</div>
```

**Состояния иконки** (сводка):

| Есть чек | `canAttachReceipt`             | Рендер                                                                                                                                   |
| -------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| нет      | да                             | Muted `Receipt`, кликабельна → открывает Sheet в режиме attach                                                                           |
| да       | да                             | Emerald `Receipt`, кликабельна → открывает Sheet в режиме replace                                                                        |
| да       | нет (напр. автор+PAID+replace) | Emerald `Receipt`, **не кликабельна** (`<span>`, не `<button>`) — честная семантика: показываем факт, не предлагаем недоступное действие |
| нет      | нет                            | Ничего не рендерим — не добавляем шум для тех, у кого нет прав действовать                                                               |

Иконка — `Receipt` (lucide-react), тот же глиф, что уже использует `receipt-panel.tsx:13` (визуальная
консистентность «этот символ = чек» по всему модулю).

### 5.3 `AttachReceiptSheet` — новый компонент

```tsx
interface AttachReceiptSheetProps {
  tx: TransactionDto | null // null = закрыт
  onClose: () => void
}

function AttachReceiptSheet({ tx, onClose }: AttachReceiptSheetProps) {
  const [receipt, setReceipt] = useState<ReceiptState>(emptyReceiptState())
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const qc = useQueryClient()

  useEffect(() => {
    if (!tx) return
    setReceipt(
      tx.receiptDocumentId
        ? receiptStateFromDocument(tx.receiptDocumentId)
        : receiptStateFromExternalUrl(tx.receiptExternalUrl),
    )
    setError(null)
  }, [tx?.id])

  const hasExisting = !!(tx?.receiptDocumentId || tx?.receiptExternalUrl)
  const isExplorerOnly = tx?.currency === 'USDT'

  const mutation = useMutation({
    mutationFn: () => {
      const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
      const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
      return financeApi.attachReceipt(tx!.id, { receiptDocumentId, receiptExternalUrl })
    },
    onSuccess: () => {
      toast.success(hasExisting ? 'Чек заменён' : 'Чек прикреплён')
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['transaction', tx?.id] })
      setConfirmOpen(false)
      onClose()
    },
    onError: (err) => setError(getApiErrorMessage(err)),
  })

  function handleSubmit() {
    const hasNew =
      (receipt.mode === 'file' && receipt.documentId) ||
      (receipt.mode === 'url' && receipt.externalUrl)
    if (!hasNew) {
      setError('Прикрепите чек или укажите ссылку на подтверждение')
      return
    }
    if (hasExisting) {
      setConfirmOpen(true)
      return
    } // replace → confirm first
    mutation.mutate()
  }

  return (
    <>
      <Sheet open={!!tx} onOpenChange={(v) => !v && onClose()}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md flex flex-col overflow-hidden"
          data-testid="attach-receipt-sheet"
        >
          <SheetHeader className="mb-2 shrink-0">
            <SheetTitle>{hasExisting ? 'Заменить чек' : 'Прикрепить чек'}</SheetTitle>
            <SheetDescription className="sr-only">
              Прикрепление подтверждающего документа к транзакции
            </SheetDescription>
          </SheetHeader>

          {tx && (
            <div className="flex-1 overflow-y-auto space-y-4">
              <div className="rounded-lg border border-border bg-muted/30 p-3 flex items-center justify-between text-sm">
                <span
                  className={cn(
                    'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                    TYPE_COLORS[tx.type],
                  )}
                >
                  {TYPE_LABELS[tx.type]}
                </span>
                <span className="font-medium tabular-nums">
                  {fmtAmount(tx.amount, tx.currency)}
                </span>
              </div>

              <ReceiptInput
                state={receipt}
                onChange={(s) => {
                  setReceipt(s)
                  setError(null)
                }}
                explorerOnly={isExplorerOnly}
                error={error ?? undefined}
              />
              {error && (
                <p
                  className="text-[11px] text-destructive"
                  data-testid="attach-receipt-sheet-error"
                >
                  {error}
                </p>
              )}
            </div>
          )}

          <SheetFooter className="mt-4 shrink-0">
            <Button variant="outline" onClick={onClose} data-testid="attach-receipt-sheet-cancel">
              Отмена
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={mutation.isPending}
              data-testid="attach-receipt-sheet-submit"
            >
              {hasExisting ? 'Заменить' : 'Прикрепить'}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="attach-receipt-confirm-replace">
          <AlertDialogHeader>
            <AlertDialogTitle>Заменить существующий чек?</AlertDialogTitle>
            <AlertDialogDescription>
              Старый файл/ссылка будут удалены без возможности восстановления.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="attach-receipt-confirm-cancel">
              Отмена
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => mutation.mutate()}
              data-testid="attach-receipt-confirm-submit"
            >
              Заменить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
```

Компонент — **generic**, не завязан на конкретный тип транзакции; работает для ЛЮБОЙ из 9+ веток
(включая уже-существующие SENIOR_INCOME/DROP_INCOME строки без чека, PAYOUT/PAYOUT_ADMIN — если
когда-нибудь потребуется, хотя сейчас они вне скоупа A5/out-of-scope).

### 5.4 `financeApi.attachReceipt` — контракт

```tsx
attachReceipt: (id: string, data: AttachReceiptDto) =>
  api.patch<TransactionDto>(`/transactions/${id}/receipt`, data).then((r) => r.data),
```

`AttachReceiptDto` — импортируется из `@crm/shared` после backend-контракта (§2.2, §6 брифа): XOR-тело
`{ receiptDocumentId? } | { receiptExternalUrl? }`.

### 5.5 Entry-point 2 — кнопка в `TransactionDetailDialog` (основной вход на мобайле)

Разместить сразу под `<ReceiptPanel tx={t} />` в правой колонке split-view (:467-469):

```tsx
<div className="min-w-0 space-y-2">
  <ReceiptPanel tx={t} />
  {canAttachReceipt(t, user?.id, user?.role ?? '') && (
    <Button
      variant="outline"
      size="sm"
      className="w-full sm:w-auto h-11 sm:h-9"
      onClick={() => setAttachOpen(true)}
      data-testid="detail-attach-receipt"
    >
      <Receipt className="h-3.5 w-3.5 mr-1.5" />
      {hasExisting ? 'Заменить чек' : 'Прикрепить чек'}
    </Button>
  )}
</div>
```

`TransactionDetailDialog` получает `const { user } = useAuth()` (уже используемый паттерн в
`CreateTransactionDialog`) + локальный `[attachOpen, setAttachOpen]` state, рендерит
`<AttachReceiptSheet tx={attachOpen ? t : null} onClose={() => setAttachOpen(false)} />` как сиблинг
`<Dialog>` в конце компонента (Sheet и Dialog — независимые Radix-порталы, конфликтов нет).

`w-full h-11` на мобайле = 44px полноширинная кнопка (hard-gate responsive-design.md); `sm:w-auto
sm:h-9` на планшете+ — компактная вторичная кнопка (row-иконка уже видна там как быстрый путь, эта
кнопка — явный/понятный дубль внутри уже открытых деталей, не избыточность, а два уровня доступа:
быстрый vs. контекстный).

### 5.6 `showReceiptPanel` — расширение gate + фикс `DROP_INCOME`

```tsx
const RECEIPT_ELIGIBLE_TYPES = new Set<TransactionDto['type']>([
  'ADMIN_INCOME',
  'SENIOR_INCOME',
  'DROP_INCOME', // ФИКС — раньше отсутствовал, хотя DROP_INCOME уже мог иметь чек (SENIOR_INCOME/DROP_INCOME оба обязательны с самого начала)
  'EXPENSE',
  'SALARY', // НОВОЕ
  'ADMIN_TRANSFER', // НОВОЕ
  'DIVIDEND_TO_ADMIN', // НОВОЕ — реальный ledger-тип дивиденда (не синтетический 'DIVIDEND' диалога)
])
const showReceiptPanel = t ? RECEIPT_ELIGIBLE_TYPES.has(t.type) : false
```

`PAYOUT`/`PAYOUT_ADMIN` — намеренно НЕ добавлены (A5 брифа, вне скоупа, у них свой on-chain
`txHash`-механизм через `payout-requests`).

### 5.7 Разграничение с `AdminEditTransactionDialog`

`AdminEditTransactionDialog` (ADMIN-only «редактировать всё» — amount/currency/category/receipt) —
**остаётся отдельным флоу**, НЕ заменяется/не мержится с `AttachReceiptSheet`. Он уже переиспользует
`ReceiptInput` (без `explorerOnly` сегодня — опционально можно добавить туда же `explorerOnly={currency
=== 'USDT'}` заодно, раз currency там тоже редактируема — низкий риск, конформность; НЕ входит в
обязательные AC этой задачи, но рекомендуется координатору/кодеру сделать заодно, чтобы не оставлять
единственный несогласованный участок). `AttachReceiptSheet` — узкоспециализированный «только чек»
инструмент, доступный НЕ только ADMIN (author-self-service), это его отличие и смысл существования.
Аналогичная рекомендация (не обязательная AC) — `EditSeniorIncomeDialog` (:40,125-132, currency
свободно редактируема) тоже может получить `explorerOnly={currency === 'USDT'}` для полной
конформности.

---

## 6. Секция D — состояние «нет чека у старой транзакции»

### 6.1 `ReceiptPanel` (detail-view) — уже решено, без изменений

`receipt-panel.tsx:67-76` уже рендерит спокойный dashed-placeholder: `FileIcon` + «Нет прикреплённого
чека» (`text-sm text-muted-foreground`, НЕ `text-destructive` — не выглядит как ошибка). `#356`-badge
lifecycle (`documents.service.ts` `deriveStatusBadge`) не завязан на UI этой фичи — он читает
`receiptDocumentId`/статус транзакции напрямую из БД; attach/replace через новый эндпоинт **обязан**
поддерживать этот derive корректным (backend-задача, не UI) — здесь только напоминание не ломать связь
document↔transaction при 1:1 replace-with-delete.

### 6.2 `TransactionRow` — приглушённый индикатор

Уже описан в §5.2 таблице состояний — muted `Receipt`-иконка ТОЛЬКО когда viewer имеет
`canAttachReceipt`. Для остальных ролей строка выглядит как сегодня (без нового визуального элемента) —
намеренное решение против шума в плотной таблице.

---

## 7. Responsive (4 класса устройств)

### 7.1 Диалоги (все 9 create/pay-флоу, §3)

| Класс              | Поведение                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Мобайл 320–639** | `CrmDialogContent max-h-[90dvh]`, body scroll — без изменений от существующего поведения. `ReceiptInput` tab-toggle full-width, каждая вкладка ≥ 44px по ширине тач-зоны (высота 32px — **ниже** 44px рекомендации; см. §9 — существующий компонент, не расширяется этой задачей, но при желании можно поднять `h-8`→`h-10`, не обязательная AC). Explorer-only URL-инпут `h-9`, full-width — нет overflow. |
| **Планшет 640+**   | Идентично мобайлу — диалоги не переходят на 2 колонки для receipt-блока (соответствует существующей 1-колоночной конвенции всех остальных полей).                                                                                                                                                                                                                                                           |
| **Ноутбук 1024+**  | Стандартный `sm:max-w-lg`/`sm:max-w-md` диалог — без изменений.                                                                                                                                                                                                                                                                                                                                             |
| **Большой 1440+**  | Диалог не растягивается сверх `max-w` — без изменений.                                                                                                                                                                                                                                                                                                                                                      |

### 7.2 `AttachReceiptSheet`

| Класс              | Поведение                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Мобайл 320–639** | `SheetContent side="right" w-full` — full-screen slide-over (паттерн `InterviewDetailSheet`). Footer-кнопки full-width `flex` (стандартный `SheetFooter`). Тач-таргеты ≥44px: `SheetFooter` кнопки — `Button` default height (`h-9`=36px) — **поднять до `h-11` на мобайле** через `className="h-11 sm:h-9"` на обеих footer-кнопках (Отмена/Прикрепить), см. §9. |
| **Планшет 640+**   | `sm:max-w-md` — капается, не full-screen.                                                                                                                                                                                                                                                                                                                         |
| **Ноутбук 1024+**  | Без изменений — тот же `sm:max-w-md`.                                                                                                                                                                                                                                                                                                                             |
| **Большой 1440+**  | Без изменений.                                                                                                                                                                                                                                                                                                                                                    |

### 7.3 `TransactionRow` icon-кнопка + `TransactionDetailDialog` кнопка

| Класс              | Поведение                                                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Мобайл 320–639** | Row-иконка **скрыта** (`hidden`) — actions-cell не получает ещё один sub-44px элемент в горизонтальный скролл. Основной вход — `TransactionDetailDialog` кнопка, `w-full h-11` (44px, full-width колонки).                         |
| **Планшет 768+**   | Row-иконка появляется (`md:inline-flex`, `h-7 w-7`=28px — соответствует существующим соседним icon-кнопкам `Edit2`/`Trash2` в том же кластере, тач через мышь/стилус на планшете — приемлемо). Detail-кнопка — `sm:w-auto sm:h-9`. |
| **Ноутбук 1024+**  | Без изменений — оба входа доступны.                                                                                                                                                                                                |
| **Большой 1440+**  | Без изменений.                                                                                                                                                                                                                     |

### 7.4 Общая верификация

Playwright на 320/375/768/1024/1280/1440/1920: нет горизонтального overflow страницы
(`document.scrollWidth <= document.documentElement.clientWidth`), `AttachReceiptSheet` открывается/
закрывается без layout-shift, `ReceiptInput` explorer-only URL-поле не переполняет диалог ни на одной
ширине, tab-toggle (не-explorer режим) остаётся 2-колоночным без переноса текста меток «Файл»/«Ссылка».

---

## 8. A11y (WCAG 2.2 AA)

| Требование                                        | Реализация                                                                                                                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Icon-only кнопка «Чек» в строке                   | Явные `aria-label` (не только `title`, как у соседних `Edit2`/`Trash2` — этот пробел НЕ наследуем для нового элемента, `aria-label` обязателен)                                                                                               |
| Не-интерактивный индикатор (replace запрещён)     | `<span>`, не `<button>` — честная семантика, `aria-label` присутствует для screen reader, но НЕ фокусируется (нет `tabIndex`, нет ложного интерактивного намёка)                                                                              |
| `Sheet` focus-trap                                | Radix `Sheet` (Dialog primitive под капотом) — focus-trap встроен, штатно                                                                                                                                                                     |
| `Sheet` Escape-close                              | Radix штатно закрывает по Escape — `onOpenChange` уже проброшен                                                                                                                                                                               |
| `AlertDialog` confirm — focus на «Отмена»         | Radix `AlertDialog` default-фокус на первый focusable (Cancel) — безопасный дефолт для деструктивного действия (замена чека)                                                                                                                  |
| Explorer-hint — не только цвет                    | Текстовый hint (не просто изменение цвета инпута) — информация не передаётся ТОЛЬКО через цвет                                                                                                                                                |
| Ошибка валидации — текст + `aria-live`?           | Текстовый `<p>` рядом с полем (существующий паттерн `fieldErrors.receipt`) — для критичных submit-ошибок достаточно, доп. `aria-live` не требуется (форма не обновляется асинхронно после фокуса пользователя)                                |
| Contrast                                          | `text-emerald-400` на `bg-card`/`bg-transparent` — уже выверенный токен (используется в `STATUS_COLORS.VALIDATED`/`PAID`); `text-muted-foreground` — выверен                                                                                  |
| Target size (icon-кнопка «Чек», ≥768px)           | `h-7 w-7` = 28px ≥ 24px WCAG 2.5.8 минимум — соответствует (project mobile-стандарт ≥44px применяется только на мобайле, где элемент вообще скрыт, см. §7.3)                                                                                  |
| Target size (Detail-кнопка, мобайл)               | `h-11` = 44px — соответствует project responsive-стандарту                                                                                                                                                                                    |
| Target size (`AttachReceiptSheet` footer, мобайл) | `h-11 sm:h-9` на обеих кнопках — см. §7.2                                                                                                                                                                                                     |
| Русский UI                                        | Все новые строки — русский (см. §4.4)                                                                                                                                                                                                         |
| Label mandatory-поля                              | `«Чек / подтверждение *»` — звёздочка визуальный маркер (existing convention); `aria-required` не добавляется explicitly (ошибка через `fieldErrors.receipt` — существующий паттерн проекта, не вводим новую конвенцию только для этого поля) |

---

## 9. Edge-cases

| Кейс                                                                                                                            | Поведение                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| USDT-транзакция, пользователь вставляет НЕ-explorer ссылку                                                                      | Submit заблокирован, `errors.receipt` = «Ссылка должна вести на поддерживаемый blockchain-explorer…» (client-side, до сетевого запроса)                                                                                                                                       |
| Переключение currency USDT→другая ПОСЛЕ ввода explorer-ссылки                                                                   | `explorerOnly` становится `false` → tab-toggle возвращается, ссылка остаётся в `state.externalUrl` (валидна как обычный http(s) url — не теряется)                                                                                                                            |
| Переключение currency другая→USDT, когда уже загружен файл                                                                      | `explorerOnly` становится `true` → авто-сброс `state` в пустой url-режим (§4.1 эффект) — файл-чек ОТВЯЗЫВАЕТСЯ от формы (не удаляется с S3, просто не используется в payload — уже загруженный документ остаётся orphan до следующего upload-cleanup, вне скоупа этой задачи) |
| Первичный attach на PAID-транзакции автором                                                                                     | Разрешено (брифовый §6 — статус не ограничивает первичный attach)                                                                                                                                                                                                             |
| Replace на PAID-транзакции НЕ-привилегированным автором                                                                         | `canAttachReceipt` = `false` → строка показывает non-interactive `<span>`-индикатор, Detail-кнопка не рендерится вовсе                                                                                                                                                        |
| Старая транзакция без чека, viewer без прав (напр. SENIOR смотрит чужую строку — на практике сценарий редок из-за data-scoping) | Ни иконка, ни кнопка не рендерятся — `ReceiptPanel` в деталях показывает «Нет прикреплённого чека» как read-only факт                                                                                                                                                         |
| `AttachReceiptSheet` открыт, но родительская транзакция удалена/изменилась в фоне (race)                                        | `mutation.onError` показывает `getApiErrorMessage(err)` в error-слоте Sheet — существующий паттерн обработки ошибок (`extractErrorMessage`/`getApiErrorMessage` уже применяются в соседних диалогах)                                                                          |
| Двойной клик Submit в `AttachReceiptSheet`                                                                                      | `disabled={mutation.isPending}` на submit-кнопке — существующий паттерн защиты от double-submit                                                                                                                                                                               |
| Company-deposit / payout-request pay / manual-confirm / confirm-payout CASH                                                     | ВНЕ скоупа (A4/A5/A6 брифа) — эта спека НЕ трогает их UI                                                                                                                                                                                                                      |
| `SALARY` reminder-создание (`CreateTransactionDialog`, тип `SALARY`)                                                            | ВНЕ скоупа (A3 — нейтральный reminder без чека; чек требуется только на pay-time через `PaySalaryDialog`, §3.2)                                                                                                                                                               |

---

## 10. Motion

Без нового motion. `ReceiptInput` уже использует sliding-pill (`framer-motion`, spring transition) для
tab-toggle — при `explorerOnly` этот toggle просто не рендерится (нет motion вообще в explorer-режиме,
что логично — нечего переключать). `AttachReceiptSheet` — стандартная Radix `Sheet` slide-in анимация
(existing `sheet.tsx` варианты). `AlertDialog` confirm — стандартный Radix fade+scale. Никаких новых
transition/duration/easing значений не вводится — всё наследуется от существующих примитивов.

---

## 11. data-testid — сводная таблица

| Элемент                                            | `data-testid`                                     |
| -------------------------------------------------- | ------------------------------------------------- |
| Explorer-hint под URL-полем (`ReceiptInput`)       | `receipt-input-explorer-hint`                     |
| Ошибка чека — `CreateTransactionDialog`            | `create-transaction-error-receipt` (существующий) |
| Ошибка чека — `PaySalaryDialog`                    | `pay-salary-error-receipt` (новый)                |
| Ошибка чека — `SettleSeniorPayoutDialog`           | `settle-senior-error-receipt` (новый)             |
| Row-иконка attach/replace                          | `tx-row-attach-receipt-${tx.id}`                  |
| Row-индикатор (не-интерактивный, «чек прикреплён») | `tx-row-receipt-indicator-${tx.id}`               |
| Detail-кнопка attach/replace                       | `detail-attach-receipt`                           |
| `AttachReceiptSheet` контейнер                     | `attach-receipt-sheet`                            |
| `AttachReceiptSheet` — ошибка                      | `attach-receipt-sheet-error`                      |
| `AttachReceiptSheet` — cancel                      | `attach-receipt-sheet-cancel`                     |
| `AttachReceiptSheet` — submit                      | `attach-receipt-sheet-submit`                     |
| Confirm-replace `AlertDialog` контейнер            | `attach-receipt-confirm-replace`                  |
| Confirm-replace — cancel                           | `attach-receipt-confirm-cancel`                   |
| Confirm-replace — submit                           | `attach-receipt-confirm-submit`                   |

---

## 12. Инструкция для кодера (КРИТИЧНО)

1. **Строй нашими компонентами** — `ReceiptInput` (расширяется, не переписывается), `Sheet`/
   `AlertDialog`/`Button`/`Badge` из shadcn/ui. НЕ вводи новые CSS-переменные/hardcoded hex/градиенты.
2. **`ReceiptInput.explorerOnly`** — единая точка правды для explorer-режима; НЕ дублируй логику
   скрытия tab-toggle в каждом из 9 диалогов отдельно — весь эффект инкапсулирован в компоненте (§4.1).
3. **`effectiveCurrency`/discriminant** — используй ТОЧНО формулы §4.3 таблицы; не изобретай
   альтернативные условия per-диалог — они должны совпадать 1:1 с backend `refineCompanyAccountUsdt`/
   `z.literal('USDT')` инвариантами, иначе фронт и бэк разойдутся по тому, когда требуется explorer-ссылка.
4. **`canAttachReceipt()`** — вынеси в отдельный файл (§5.1), импортируй ВЕЗДЕ (row/detail/sheet) —
   НЕ копируй тройное выражение в три места (drift-риск, к которому проект уже чувствителен —
   см. `.claude/agents/memory/*/lessons.md` про RBAC-рассинхрон между front-поверхностями).
5. **Backend-контракт УЖЕ landed** (`packages/shared/src/schemas/finance.ts`, wip-коммит
   `wip(shared): mandatory receipt refine + explorer allowlist + attach schema`) — импортируй буквально
   `attachReceiptSchema`/`AttachReceiptDto`/`isExplorerUrl`/`BLOCKCHAIN_EXPLORER_HOSTS`/
   `receiptMandatoryError` из `@crm/shared`, НЕ переопределяй локально. `PATCH /transactions/:id/receipt`
   контроллер/сервис — за backend-задачей (opus + security-reviewer), но shared-контракт для фронта
   готов — `AttachReceiptSheet`/`financeApi.attachReceipt` можно реализовывать сразу, не дожидаясь
   контроллера (типы уже есть; сетевой вызов до готовности эндпоинта просто вернёт 404, не блокирует
   написание UI/типов).
6. **`txHash` консолидация (§2.3)** — убери UI-инпут «TX Hash» из `PaySalaryDialog`, НЕ трогай
   `PayoutContent`/`PayoutAdminContent`-рендер (вне скоупа, A5). `SalaryContent` — легаси-fallback ряд
   `TxHashLink` условный (только если `tx.txHash && !tx.receiptDocumentId && !tx.receiptExternalUrl`).
7. **`showReceiptPanel`/`showReceipt` — расширяй по спискам §3.1/§5.6 буквально**, не «на глаз» — там
   есть намеренно исключённые типы (`PAYOUT`, `PAYOUT_ADMIN`, `SALARY`-create-reminder) — их НЕ добавлять.
8. **`AttachReceiptSheet` — единственный компонент**, переиспользуемый из ДВУХ entry-points (row +
   detail). НЕ создавай два разных Sheet/Dialog под каждый вход.
9. **Responsive** — row-иконка `hidden md:inline-flex`; Detail-кнопка `w-full h-11 sm:w-auto sm:h-9`;
   Sheet footer-кнопки `h-11 sm:h-9`. Точные классы — §7.
10. **Опциональные (не blocking AC) конформность-фиксы**, если время позволяет: `explorerOnly` в
    `AdminEditTransactionDialog`/`EditSeniorIncomeDialog` (§5.7) — низкий риск, повышает консистентность,
    НЕ обязательны для приёмки этой задачи.
11. **data-testid строго по таблице §11** — AutoTest использует их для 9-флоу mandatory-проверок +
    RBAC-матрицы attach/replace + explorer-домен валидации.

---

## 13. Fidelity-референсы (для Mode B после реализации)

`design-gate: degraded` — headless-сессия без Claude Design/браузера, `design.png` не создаётся.
Mode B fidelity-аудит после реализации сверяется против: (а) этой спеки целиком, (б) существующих
референс-компонентов без изменения их визуального языка (`ReceiptInput` tab-toggle, `ReceiptPanel`
empty-state, `FundingSourceFields` account/currency picker, `AlertDialog` confirm-паттерн из
`ValidateDialog.tsx`, `Sheet` slide-over паттерн из `InterviewDetailSheet.tsx`), (в) responsive-таблицами
§7 на всех тест-ширинах (320/375/768/1024/1280/1440/1920) — особое внимание: row-иконка скрыта <768px,
Detail-кнопка полноширинная 44px на мобайле.
