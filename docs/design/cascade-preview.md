# Design Spec — Предпросмотр каскада при правке оплаченной транзакции (task 5/6)

> **Design tier:** 1 (новая поверхность — предпросмотр денежных последствий правки) с элементами
> Tier 2 (правка 4 существующих финансовых поверхностей, которые эта новая поверхность обязана
> согласованно расширить: `AdminEditTransactionDialog`, `TransactionRow`, `TransactionDetailDialog`,
> `SettleSeniorPayoutDialog`).
> **design-gate:** degraded (Claude Design не задействован — headless-сессия без владельца в
> контуре, текстовая спека Mode E). Fidelity-аудит после реализации (Mode B) сверяется против ЭТОЙ
> спеки + существующих референс-компонентов (`SettleSeniorPayoutDialog` summary-card,
> `CreateTransactionDialog` obligation-preview banner, `AmountCurrencyInput` conversion-hint), не
> против `design.png`.
> **Status:** coder-ready
> **Ветка фичи:** следующая после `feat(finance): drop top-up` (task 3b, PR #608) в декомпозиции
> `docs/architecture/2026-08-22-paid-transaction-edit-cascade.md`
> **Источники (архитектура, читать перед реализацией):**
>
> - `docs/architecture/2026-08-22-paid-transaction-edit-cascade.md` — AC3/AC4/AC6 (что такое
>   каскад, как считается версия, риск-лист)
> - `docs/architecture/2026-08-23-cascade-apply-ledger-term.md` — §1.2/§1.7/§1.12/§1.14 (когда
>   применение реально откажет — эта спека выводит из них Save-gating правило ниже)
> - `docs/architecture/2026-08-23-drop-topup-triplet.md` — §Ответ 1/5 (доплата по дропу, триплет)
> - `packages/shared/src/schemas/edit-cascade.ts` — контракт, из которого спека выведена буквально
>   (символы `resolveEditCascade`, `resolveDerivative`, `cascadeWarningCodeSchema`,
>   `cascadeEditPreviewResponseSchema`, `classifyEditedRowLedgerFact`, `CASCADE_LEDGER_FACT_MESSAGES`,
>   `floorAmountAtAccumulator`, `isCascadeAmountEdit`)
> - `apps/api/src/finance/transactions.service.ts` — символы `getEditCascadePreview`,
>   `applyEditCascade` (Phase 1 = точное условие, когда Save обязан быть недоступен — см. §4.4)

---

## Резюме UX-решений (executive summary)

1. **Не новый диалог — расширение существующего `AdminEditTransactionDialog`.** Каскад — это
   следствие правки суммы уже оплаченной строки, а не отдельное действие. Новый компонент
   `CascadeImpactPanel` встраивается ПОД полем суммы в уже существующем диалоге и появляется
   ровно тогда, когда админ действительно набрал другое число на `status === 'PAID'` строке.
   Никакого отдельного «шага предпросмотра» с собственной кнопкой «Далее» — предпросмотр живой,
   как cascade-preview из бэкенда и обязательство-preview в `CreateTransactionDialog`
   (`admin-income-obligation-preview` — прямой визуальный референс).
2. **Предпросмотр — не то же самое, что «строка редактируема».** Контракт (`isCascadeAmountEdit`)
   отвечает на вопрос «блокирует ли что-то ЭТУ правку» только когда сумма реально отличается от
   сохранённой. Поэтому поле суммы никогда не блокируется превентивно (это потребовало бы
   зондирующего запроса, которого контракт не предусматривает) — отказ обнаруживается тем же
   движением, что и сам каскад: полем набрали другое число → через 400 мс debounce ушёл
   `GET .../edit-preview` → пришёл `blockedReason`.
3. **Save-gating — не «редактируемо/нет», а точное зеркало `applyEditCascade`'s Phase 1.**
   Предпросмотр может честно показать план, который сервер всё равно отклонит (два случая:
   `NO_SHARE_SNAPSHOT`, `OBLIGATION_CURRENCY_MISMATCH` — блокируют всегда; `NON_USDT_CURRENCY` —
   блокирует только когда `needsReconfirm === true`). Кнопка «Сохранить» дизейблится по ТОЧНО этому
   предикату (§4.4), а не по эвристике «есть ли warnings» — иначе либо пропускаем гарантированный
   400, либо блокируем то, что сервер реально примет (переплата, к примеру, — не блокирует).
4. **«Вернётся в ожидание выплаты» — главный визуальный сигнал, не мелкий бейдж.** `needsReconfirm`
   — это ядро всей задачи владельца («после сохранения производные, если они были оплачены,
   возвращаются в PENDING»). У такой строки в плане — акцентная рамка (`border-amber-500/30`), не
   нейтральная.
5. **Мобильная таблица производных — карточки, не горизонтальный скролл.** Существующий паттерн
   `TransactionRow`/`ActiveTransactionsTable` на мобайле — `overflow-x-auto` всей таблицы; это
   существующий, отдельно живущий компромисс главного списка, НЕ прецедент для новой поверхности.
   Задание прямо требует другого для этой таблицы — ниже card-стек по образцу
   `SettleSeniorPayoutDialog`'s summary-card (`rounded-lg border border-border bg-muted/30 p-3
space-y-1`).
6. **«Уже выплачено / к доплате» — три поверхности одним источником данных, не одна.** Список
   (`TransactionRow`), детали (`TransactionDetailDialog`), и — важно — **сводка в
   `SettleSeniorPayoutDialog`**, которая СЕГОДНЯ показывает `tx.amount` (полное обязательство) как
   «Сумма» и после этой задачи это станет вводящей в заблуждение цифрой на строке с частичным
   накопителем: оператор увидит 130, а спишется 30. Все три требуют одного и того же поля на wire
   (`settledAmount`/`settledCurrency`), которого сегодня НЕТ на `TransactionDto` — см. §14, п.1.
7. **Триплет факта платежа (originalAmount/exchangeRate) — да, входит в задачу 5, минимально.**
   Данные уже на wire (`TransactionDto.originalAmount/originalCurrency/exchangeRate`, экспортированы
   `mapTx`'ом сегодня), не хватает только отображения. Добавляется ОДНИМ блоком в
   `TransactionDetailDialog` по образцу существующего `Row` (icon+label+value), потому что это
   прямо объясняет ДВА новых отказа этой же задачи (`PAYMENT_FACT_RECORDED`,
   `SOURCE_ORIGINAL_AMOUNT_SET`) — без него отказ называет носителя, которого оператор не может
   увидеть нигде в интерфейсе. Обоснование полностью — §7.
8. **409 (устаревший предпросмотр) — честный тупик с одной кнопкой, не тихий пересчёт.** Тот же
   принцип, что весь ADR: сервер прямо говорит «мир изменился», UI показывает это дословно и даёт
   ОДНО действие — «Обновить предпросмотр» (перезапрашивает `GET`), Save остаётся недоступной, пока
   план не обновлён.

---

## 1. Компонент-инвентарь

### 1.1 Существующие (переиспользуются как есть или расширяются)

| Компонент                                    | Файл                                                            | Роль в этой фиче                                                                                                                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdminEditTransactionDialog`                 | `.../finance/components/dialogs/AdminEditTransactionDialog.tsx` | **Расширяется** — debounce+preview-запрос, встраивает `CascadeImpactPanel`, Save-gating (§4)                                                                                                                                                |
| `AmountCurrencyInput`                        | `apps/web/app/components/ui/amount-currency-input.tsx`          | Без изменений — существующее поле суммы, откуда берётся типизируемое значение                                                                                                                                                               |
| `TransactionRow`                             | `.../finance/components/TransactionRow.tsx`                     | **Расширяется** — доп. строка «Выплачено / Осталось» в ячейке суммы для `*_PENDING_PAYMENT` (§5.1)                                                                                                                                          |
| `TransactionDetailDialog`, `Row`             | `.../finance/components/dialogs/TransactionDetailDialog.tsx`    | **Расширяется** — «Уже выплачено» блок (§5.2) + «Факт платежа» блок для триплета (§7)                                                                                                                                                       |
| `SettleSeniorPayoutDialog`                   | `.../finance/components/dialogs/SettleSeniorPayoutDialog.tsx`   | **Расширяется** — summary-card заменяет «Сумма» на «К доплате» когда есть накопитель (§5.3) — **корректирующий фикс**, не косметика                                                                                                         |
| `financeApi.adminUpdateTransaction`          | `.../finance/api.ts`                                            | Payload расширяется `cascadeVersion` при cascade-правке (уже в `AdminUpdateTransactionDto`, поле есть в контракте)                                                                                                                          |
| `Badge`                                      | `apps/web/app/components/ui/badge.tsx`                          | Готовые status-варианты + произвольные `className` для новых предупреждений (нет варианта «warning» — используем tailwind-классы по конвенции `TYPE_COLORS`/`STATUS_COLORS`, см. §8)                                                        |
| `Skeleton`                                   | `apps/web/app/components/ui/skeleton.tsx`                       | Loading-состояние панели (тот же паттерн, что `AmountCurrencyInput`'s conversion-hint skeleton)                                                                                                                                             |
| `Button`, `Label`                            | `apps/web/app/components/ui/*`                                  | Стандартные примитивы                                                                                                                                                                                                                       |
| `fmtAmount`, `TYPE_LABELS`, `STATUS_LABELS`  | `.../finance/constants.ts`                                      | Форматирование сумм/лейблов — переиспользуется без изменений                                                                                                                                                                                |
| `parseStrictAmount`, `normalizeDecimalInput` | `apps/web/app/lib/utils.ts`                                     | Без изменений — уже используются в `AdminEditTransactionDialog`                                                                                                                                                                             |
| `getApiErrorMessage`                         | `apps/web/app/lib/axios-utils.ts`                               | **Заменяет** локальный `mutation.error instanceof Error ? ...` в `AdminEditTransactionDialog` — сегодняшняя проверка не извлекает текст из axios-ответа backend'а, а именно backend-текст здесь — единственное объяснение отказа (см. §4.5) |

### 1.2 Новые

| Компонент                          | Тип                 | Назначение                                                                                                                                      | Файл (предлагаемый)                                                                      |
| ---------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `CascadeImpactPanel`               | Новый компонент     | Ядро задачи — рендерит все состояния предпросмотра (§4.2): loading / заблокировано / пусто / план / устарело / сеть                             | `.../finance/components/dialogs/CascadeImpactPanel.tsx`                                  |
| `CascadeDerivativeRow`             | Новый под-компонент | Одна производная строка — desktop `<tr>` + mobile card, общий источник данных (§4.3)                                                            | Внутри `CascadeImpactPanel.tsx` (не выносить отдельным файлом — используется только там) |
| `financeApi.getEditCascadePreview` | Новый API-метод     | `api.get<CascadeEditPreviewResponse>(\`/transactions/\${id}/edit-preview\`, { params: { amount } }).then(r => r.data)`                          | `.../finance/api.ts`                                                                     |
| `CASCADE_BLOCKED_REASON_MESSAGES`  | Новая константа     | Русский текст для ВСЕХ 6 значений `blockedReason` — 4 уже готовы в `@crm/shared` (`CASCADE_LEDGER_FACT_MESSAGES`), 2 новых пишутся здесь (§4.6) | `.../finance/constants.ts` (рядом с `STATUS_LABELS`)                                     |

**Координация с уже смерженным контрактом.** `packages/shared/src/schemas/edit-cascade.ts` уже
в `main` (задачи 2/3/3b, PR #603/#607/#608) — импортировать буквально: `cascadeEditPreviewQuerySchema`,
`cascadeEditPreviewResponseSchema`, `CascadeEditPreviewResponse`, `CascadePlan`, `CascadeDerivativePlan`,
`CascadeWarning`, `CASCADE_LEDGER_FACT_MESSAGES`, `amountsDiffer`. Backend-эндпоинты (`GET
:id/edit-preview`, `PATCH :id/admin-edit` с `cascadeVersion`) — тоже уже в `main`. Эта задача —
**чисто фронтенд**.

---

## 2. Direction (5 вопросов — наследует `foundation.md`, ничего нового не вводит)

| Вопрос           | Ответ применительно к этому экрану                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose          | ADMIN исправляет ошибку в уже проведённой сумме и ДО сохранения видит денежные последствия — что откатится, сколько уже не вернуть, что заблокировано и почему. |
| Audience         | ADMIN, редко (правка PAID-строки — не рутинная операция), высокая цена ошибки — экран обязан быть избыточно ясным, а не компактным любой ценой.                 |
| Tone             | dense · quiet · scannable, как весь модуль финансов. Никакой драматизации («Осторожно!!!») — факты и числа говорят сами.                                        |
| Memorable detail | Единственный акцентный сигнал на весь экран — тёплая amber-рамка у строки, которая «вернётся в ожидание выплаты». Всё остальное — нейтральный `border-border`.  |
| Constraints      | Наследует `AdminEditTransactionDialog`: `sm:max-w-md`→динамически шире при наличии плана; Tailwind v4 токены; WCAG 2.2 AA; 320–1440; тёмная тема; русский UI.   |

---

## 3. Token-map

Только существующие семантические токены (`apps/web/app/styles/globals.css`) + уже принятый в
проекте расширенный tailwind-палитра для статусных акцентов (тот же класс, каким пользуются
`STATUS_COLORS`/`TYPE_COLORS` в `constants.ts` — не новая практика, продолжение существующей).

| Назначение                                                                                                        | Токен / класс                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Поверхность панели / summary-card                                                                                 | `bg-muted/30` + `border-border` (тот же паттерн, что `SettleSeniorPayoutDialog` summary-card)                                                                 |
| Строка «вернётся в ожидание выплаты» (needsReconfirm)                                                             | `border-amber-500/30 bg-amber-500/5` (тот же оттенок, что `STATUS_COLORS.PENDING_PAYMENT`)                                                                    |
| Блокирующее предупреждение (`NO_SHARE_SNAPSHOT`, `OBLIGATION_CURRENCY_MISMATCH`, блокирующий `NON_USDT_CURRENCY`) | `border-destructive/30 bg-destructive/5 text-destructive`                                                                                                     |
| Неблокирующее предупреждение (`OVERPAYMENT`, `SIGNED_INVOICE`, небл. `NON_USDT_CURRENCY`)                         | `border-amber-500/30 bg-amber-500/5 text-amber-400` (тот же класс, что `STATUS_COLORS.PENDING`)                                                               |
| Отказ (`editable: false`, весь блок)                                                                              | `border-destructive/30 bg-destructive/5 text-destructive` (тот же паттерн, что «Транзакцию нельзя редактировать» в существующем `AdminEditTransactionDialog`) |
| Информационная плашка (обычный план без предупреждений)                                                           | `border-primary/20 bg-primary/5` (буквально тот же класс, что `admin-income-obligation-preview` в `CreateTransactionDialog`)                                  |
| Числа                                                                                                             | `tabular-nums font-medium`                                                                                                                                    |
| Radius                                                                                                            | `rounded-lg` (панель) / `rounded-md` (внутренние карточки строк) — концентричность по `foundation.md` §3                                                      |

Никакого сырого hex/oklch, никаких purple-градиентов, никакого нового варианта `Badge` — все
акценты через существующие Tailwind-классы, уже используемые в этом же модуле (`STATUS_COLORS`).

---

## 4. Экран A (ядро) — Предпросмотр до сохранения

### 4.1 Триггер и данные

`AdminEditTransactionDialog` уже держит `amount: string` state. Добавляется:

```
debouncedAmount (400ms setTimeout, тот же паттерн, что use-contract-tokens.ts)
  → parsedAmount = parseStrictAmount(debouncedAmount)
  → shouldPreview =
        tx?.status === 'PAID' &&
        Number.isFinite(parsedAmount) && parsedAmount > 0 &&
        amountsDiffer(parsedAmount, Number(tx.amount))   // amountsDiffer из @crm/shared — ТА ЖЕ функция, что и на сервере
```

```
useQuery({
  queryKey: ['cascade-preview', tx?.id, parsedAmount],
  queryFn: () => financeApi.getEditCascadePreview(tx!.id, parsedAmount),
  enabled: shouldPreview,
  retry: false,   // 400/403/404 не транзиентны — незачем 3× ретраить и держать пользователя в loading-состоянии
})
```

**Почему `retry: false` — не мелочь, а часть UX-контракта.** React Query по умолчанию делает до 3
повторов на ошибке; отказ (`editable: false`) — это ОТВЕТ 200 с `blockedReason`, а не HTTP-ошибка
(см. §4.6), так что retry вообще не про блокирующий сценарий. Он важен для настоящих сетевых
сбоев — без `retry: false` разрыв связи держал бы панель в `isLoading` секундами, маскируя
сетевую ошибку под «считаем».

`status !== 'PAID'` — весь этот раздел не рендерится вообще, поведение диалога идентично сегодняшнему
(обычная правка суммы без каскада, как для `VALIDATED`/`PENDING` строк).

### 4.2 Состояния `CascadeImpactPanel`

Панель рендерится ТОЛЬКО когда `tx.status === 'PAID'` И `amount` state отличается от исходного
(`amountsDiffer(parseStrictAmount(amount), Number(tx.amount))`) — до этого момента поле суммы
выглядит как обычное поле, никакой панели под ним.

| #   | Состояние                                                                 | Что показывает                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Loading** (`isFetching`, debounce ещё не выстрелил ИЛИ запрос в полёте) | `Skeleton` строка `h-4 w-40` + текст «Пересчитываем связанные выплаты…» (`text-xs text-muted-foreground`) — тот же visual weight, что `AmountCurrencyInput`'s `isFetching` skeleton |
| 2   | **Сетевая ошибка** (query `isError`, НЕ 4xx с телом — `!err.response`)    | `border-destructive/30` строка: «Не удалось загрузить предпросмотр — проверьте соединение» + кнопка «Повторить» (`refetch()`)                                                       |
| 3   | **Заблокировано** (`editable: false`)                                     | §4.6 — отдельный блок, ЗАМЕНЯЕТ панель целиком (нет смысла показывать план, которого нет)                                                                                           |
| 4   | **Пусто** (`editable: true`, `plan.derivatives.length === 0`)             | §4.7 — компактная строка-подтверждение                                                                                                                                              |
| 5   | **План с производными** (`plan.derivatives.length > 0`)                   | §4.3 — ядро, таблица/карточки                                                                                                                                                       |
| 6   | **Устарело** (409 от `PATCH` при сохранении)                              | §4.8 — отдельный блок, показывается ПОВЕРХ последнего успешного плана (план остаётся видимым, но неактуальным — помечен)                                                            |

Между состояниями 1↔5 не должно быть layout-shift сильнее необходимого: панель всегда занимает
позицию сразу под `AmountCurrencyInput`, минимальная высота не фиксируется искусственно (контент
диктует), но loading-skeleton занимает примерно ту же высоту, что типичный однострочный «пусто»-ответ
— так, чтобы диалог не «прыгал» на каждое нажатие клавиши при debounce.

### 4.3 Ядро — план с производными

**Заголовок панели:** «Что изменится при сохранении» (`text-xs font-medium text-muted-foreground`,
не заголовок диалога — подзаголовок секции, по шкале `foundation.md` §4 «Card / KPI label»).

**Строка суммы источника** (всегда, когда план непуст) — компактная, одна строка:

```
Сумма источника: {fmtAmount(oldSourceAmount, sourceCurrency)} → {fmtAmount(newSourceAmount, sourceCurrency)}
```

`tabular-nums`, стрелка `ArrowRight` (lucide-react, уже используется в `TransactionRow`/`FromTo`
для той же семантики «было → стало»).

**Source warnings** (`plan.sourceWarnings`, если непусто) — рендерятся строками ПЕРЕД таблицей
производных, каждая — `border-amber-500/30 bg-amber-500/5` строка с текстом ИЗ ОТВЕТА СЕРВЕРА
(`warning.message`), verbatim, никогда не переписывается на фронте (см. §4.5 «один текст, а не два
описания»).

**Таблица/карточки производных** — по одной на `plan.derivatives[i]`. Desktop (`sm:` и шире) —
таблица; мобайл (`<640px`) — card-стек. См. §4.3.1/§4.3.2 для anatomy, §9 для полного responsive-
разбора.

#### 4.3.1 Что показывает одна производная (общий набор полей, оба layout)

| Поле                        | Источник                                                                           | Формат                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Получатель / тип            | `TYPE_LABELS[derivative.type]` + получатель (см. ниже — частично неполно, §14 п.2) | Badge `TYPE_COLORS[type]` + подпись под ним, если получатель известен                                                                    |
| Было → Стало                | `derivative.oldAmount` → `derivative.newAmount`, `derivative.currency`             | `tabular-nums`; если `newAmount === null` — «Стало: —» с destructive-подсветкой (это и есть `NO_SHARE_SNAPSHOT`, см. ниже)               |
| Уже выплачено               | `derivative.settledAmount`, `derivative.settledCurrency`                           | Рендерится ТОЛЬКО если `settledAmount > 0`. `fmtAmount(settledAmount, settledCurrency ?? currency)`                                      |
| К доплате                   | `derivative.remainingToPay`                                                        | `fmtAmount(remainingToPay, currency)`, либо «—» с `title` = текст `NON_USDT_CURRENCY`-предупреждения, если `remainingToPay === null`     |
| Вернётся в ожидание выплаты | `derivative.needsReconfirm`                                                        | Badge amber «⟲ Вернётся в ожидание выплаты» (иконка `RotateCcw`, уже используется в проекте для «Восстановить» — та же метафора «откат») |
| Предупреждения              | `derivative.warnings[]`                                                            | Список чипов/строк, текст **verbatim из ответа**, см. §4.5. Иконка по severity: `AlertCircle` (destructive) / `AlertTriangle` (amber)    |

**Получатель — что можно показать сегодня без нового API-поля (важно, читать перед реализацией).**
`CascadeDerivativePlan` НЕ содержит `receiverId`/`receiverName` — только `id`/`type`/суммы (см. §14
п.2 для полного разбора и предложенного фикса). Без нового поля:

- для `type === 'SENIOR_PENDING_PAYOUT'` — переиспользовать **уже переданный** `tx.receiverName`
  (источник — `ADMIN_INCOME`/`SENIOR_INCOME`, чей получатель И ЕСТЬ синьор, см. `FromTo`'s кейс
  `ADMIN_INCOME`/`SENIOR_INCOME` в `TransactionRow.tsx`) — подпись «Синьору {tx.receiverName}»;
- для `type === 'DROP_PENDING_PAYOUT'` — имя недостижимо из уже загруженных данных, подпись
  ограничивается «Доля дропа» (без имени) — честно, не выдумывать.

### 4.3.2 Desktop-таблица (`sm:` 640px и шире)

Обычная HTML-таблица, стиль — 1:1 с существующей `<table>` из `TransactionRow.tsx`/
`ActiveTransactionsTable.tsx` (не оборачивать в shadcn `Table`-примитив — модуль финансов уже
последовательно использует сырые `<table>`-элементы, вводить второй способ строить таблицу в том же
модуле — не консистентность):

```
<table className="w-full text-sm">
  <thead>
    <tr className="border-b border-border/50 text-xs text-muted-foreground">
      <th className="text-left py-2 px-3 font-medium">Получатель</th>
      <th className="text-right py-2 px-3 font-medium">Было → Стало</th>
      <th className="text-right py-2 px-3 font-medium">Выплачено</th>
      <th className="text-right py-2 px-3 font-medium">К доплате</th>
      <th className="text-left py-2 px-3 font-medium">Статус</th>
    </tr>
  </thead>
  <tbody>{/* CascadeDerivativeRow × N, border-b border-border/50 last:border-0, needsReconfirm → border-l-2 border-l-amber-500 */}</tbody>
</table>
```

Строка с `needsReconfirm === true` получает `border-l-2 border-l-amber-500` (левый акцентный
бордер) — единственная строка-«прожектор» на весь экран, по `foundation.md` memorable-detail
принципу («жёлтый = здесь действие/внимание»).

### 4.3.3 Мобильная карточка (`<640px`)

Card-стек, `space-y-2`, каждая карточка — `rounded-lg border border-border bg-muted/30 p-3 space-y-1.5
text-sm` (буквально паттерн `SettleSeniorPayoutDialog` summary-card), needsReconfirm-карточка —
`border-amber-500/30 bg-amber-500/5` вместо нейтральной:

```
┌─────────────────────────────────────┐
│ [Badge: Ожидаемая выплата синьору]   │
│ Синьору Иван Петров                  │
│ ─────────────────────────────────    │
│ Было → Стало      8 000 → 10 000 USDT│
│ Выплачено                 5 000 USDT │
│ К доплате                  5 000 USDT│
│ ⟲ Вернётся в ожидание выплаты        │
└─────────────────────────────────────┘
```

Каждая строка внутри карточки — `flex justify-between` (label слева muted, значение справа
`tabular-nums font-medium`) — тот же паттерн, что уже 1:1 использует `SettleSeniorPayoutDialog`.
Каждое поле умещается на одной строке при 320px (самое длинное значение — сумма с валютой,
≤ ~14 символов, метки короткие — «Было → Стало», «Выплачено», «К доплате» — не переносятся).

### 4.4 Save-gating — точная формула

```
canSave =
  editable !== false &&
  (plan === null || plan.derivatives.every(d =>
    d.newAmount !== null &&
    !d.warnings.some(w => w.code === 'OBLIGATION_CURRENCY_MISMATCH') &&
    !(d.needsReconfirm && d.warnings.some(w => w.code === 'NON_USDT_CURRENCY'))
  ))
```

Это ТОЧНОЕ зеркало трёх отказов `applyEditCascade`'s Phase 1, которые видны из плана:
`derivativePlan.newAmount === null` (нет снимка доли), `OBLIGATION_CURRENCY_MISMATCH` (безусловный
отказ), `needsReconfirm && NON_USDT_CURRENCY` (отказ ТОЛЬКО при реальном откате). **Специально НЕ
включены в формулу** ещё два внутренних отказа `applyEditCascade` (расхождение
`amount`↔`settled_amount` на company-funded строке, отсутствующий `settled_amount` на легаси-
строке до #599) — они **не выражены warning-кодом в `CascadeDerivativePlan`** (это внутренние
проверки инварианта, не часть публичного плана), поэтому фронт не может их предсказать. Это
осознанный, редкий (по архитектурному анализу — «сегодня пусто по теореме») край: Save может
теоретически всё равно вернуть 400 на легаси-строке. Обрабатывается не превентивным UI-запретом
(которого построить нельзя), а честным отображением серверного текста ошибки при сабмите (§4.5) —
ни один существующий класс кейсов не остаётся без объяснения, просто узнаётся на разных шагах.

`OVERPAYMENT` **намеренно не входит** в предикат — переплата НЕ блокирует ни `resolveEditCascade`,
ни `applyEditCascade` (строка остаётся `PAID`, ничего не записывается по ней, см. AC7 задачи 3) —
это предупреждение для человека, не отказ системы.

Save-кнопка при `canSave === false` — `disabled`, рядом (не внутри title/tooltip — предупреждение
обязано быть видимым без наведения, WCAG 2.2 SC 1.4.13) строка `text-xs text-destructive`:
«Сохранить нельзя, пока не устранены проблемы в предпросмотре ниже» (общая, не дублирует
конкретные тексты предупреждений — они уже показаны построчно).

### 4.5 Один текст, не два описания (критично для кодера)

Все тексты предупреждений/отказов, которые крутятся ВОКРУГ денег — приходят с сервера
(`warning.message`, `CASCADE_LEDGER_FACT_MESSAGES[reason]`, ошибка `PATCH`) и рендерятся
**verbatim**. Фронт НЕ переписывает и не сокращает их своими словами. Это прямое продолжение
принципа, зафиксированного в самом `edit-cascade.ts`: «task 5's UI can show the same sentence
without restating it». Единственные тексты, которые пишет ЭТА спека — это лейблы полей/секций
(«Уже выплачено», «Что изменится при сохранении» и т.п.), НЕ денежные объяснения.

**Ошибка сохранения (`PATCH` 400/409/500)** — рендерится через `getApiErrorMessage(err)`
(`apps/web/app/lib/axios-utils.ts`), НЕ через сегодняшнюю проверку `mutation.error instanceof Error
? mutation.error.message : null` в `AdminEditTransactionDialog` — эта проверка не извлекает тело
axios-ответа (`error.response.data.message`), а именно там лежит единственный текст, объясняющий,
почему отказал сервер. Это правка существующего бага соседним движением (тот же файл, тот же
diff), не отдельная задача.

### 4.6 Заблокировано (`editable: false`)

Заменяет ВСЮ панель (не показывается план — плана нет, `plan: null`). Единый блок, стиль —
расширение уже существующего в `AdminEditTransactionDialog` "Транзакцию нельзя редактировать"
(`flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3
text-sm text-destructive`), с иконкой `Ban` (lucide-react — «средство не доступно», отличается от
уже занятого в этом же диалоге `AlertCircle`, который используется для ошибок формы):

```tsx
<div
  className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive"
  data-testid="cascade-blocked-banner"
>
  <Ban className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
  <span>{CASCADE_BLOCKED_REASON_MESSAGES[blockedReason]}</span>
</div>
```

Save-кнопка `disabled`.

**`CASCADE_BLOCKED_REASON_MESSAGES` — 6 значений, 4 готовы, 2 новых:**

```ts
import { CASCADE_LEDGER_FACT_MESSAGES, type CascadeEditPreviewBlockedReason } from '@crm/shared'

export const CASCADE_BLOCKED_REASON_MESSAGES: Record<CascadeEditPreviewBlockedReason, string> = {
  ...CASCADE_LEDGER_FACT_MESSAGES, // PAYMENT_FACT_RECORDED / SETTLED_AMOUNT_RECORDED / CLOSES_OBLIGATION / ONCHAIN_DEPOSIT
  PAYOUT_FAMILY:
    'Это строка выплаты — сумма подтверждена исполненным переводом, она не редактируется. Ошибку исправляйте сторнирующей транзакцией.',
  LINKED_TO_PAYOUT_REQUEST:
    'Эта строка включена в оформленную заявку на выплату — сумма уже использована в расчёте перевода, она не редактируется. Исправляйте сторнирующей транзакцией.',
}
```

Формулировки двух новых строк написаны по образцу четырёх уже принятых (называют носителя суммы +
дают средство), проверено `Skill('copywriting')` на этой же сессии — тот же регистр, та же длина,
никакого нового тона.

### 4.7 Пусто — правка не порождает каскада

`editable: true`, `plan.derivatives.length === 0` (`ADMIN_INCOME` без букинга, `EXPENSE`,
`DIVIDEND_TO_ADMIN` и т.п. — строки, у которых просто нет производных):

```
border-primary/20 bg-primary/5 (тот же класс, что admin-income-obligation-preview)
«Эта сумма не связана с выплатами — пересчитывать нечего»
```

Одна строка, без иконки — сознательно самый тихий из всех статусов панели (это НЕ предупреждение,
это подтверждение, что правка простая).

### 4.8 Устарело — 409 при сохранении

Save нажата → сервер вернул `ConflictException` (409, точный текст: «Данные изменились с момента
предпросмотра — обновите предпросмотр правки и повторите сохранение», рендерится verbatim, §4.5).

Визуально — ЗАМЕНЯЕТ последний план сверху (план остаётся виден под ним, слегка приглушённый
`opacity-60 pointer-events-none`, чтобы оператор видел, ЧТО именно устарело, а не терял контекст):

```tsx
<div
  className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-sm text-amber-400"
  data-testid="cascade-stale-banner"
>
  <span>{conflictMessage /* verbatim с сервера */}</span>
  <Button
    size="sm"
    variant="outline"
    onClick={() => refetchPreview()}
    data-testid="cascade-refresh-preview"
  >
    <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
    Обновить предпросмотр
  </Button>
</div>
```

`RefreshCw` — та же иконка, что уже используется в проекте как дефолтный «recompute» индикатор
(`TransactionDetailDialog`'s `StatusIcon` default case). После клика — `refetch()` того же
react-query запроса из §4.1 (не новый запрос, тот же), план ниже обновляется, приглушение снимается,
Save снова доступна (при `canSave`).

---

## 5. Экран B — «Уже выплачено / к доплате»

Три поверхности, один источник правды (`tx.settledAmount`/`tx.settledCurrency`, §14 п.1). Рендерится
ТОЛЬКО когда `settledAmount != null && settledAmount > 0` — на подавляющем большинстве строк (нет
накопителя вообще) не меняется НИЧЕГО.

### 5.1 `TransactionRow` — список транзакций

В ячейке суммы (там же, где уже рендерится строка «Доля: X%» для `SENIOR_INCOME` — тот же слот,
тот же `text-[11px] text-muted-foreground font-normal` стиль, компактная подпись под основной
суммой), для `type ∈ {SENIOR_PENDING_PAYOUT, DROP_PENDING_PAYOUT}` с `settledAmount > 0`:

```tsx
{
  ;(tx.type === 'SENIOR_PENDING_PAYOUT' || tx.type === 'DROP_PENDING_PAYOUT') &&
    tx.settledAmount != null &&
    tx.settledAmount > 0 && (
      <p className="text-[11px] text-amber-400 font-normal" data-testid={`tx-row-settled-${tx.id}`}>
        Выплачено {fmtAmount(tx.settledAmount, tx.settledCurrency ?? tx.currency)}
        {tx.settledCurrency == null || tx.settledCurrency === tx.currency
          ? ` · осталось ${fmtAmount(Number(tx.amount) - tx.settledAmount, tx.currency)}`
          : ''}
      </p>
    )
}
```

Цвет `amber` (не нейтральный `text-muted-foreground`, как «Доля: X%») — это состояние, которого
раньше не существовало в системе и на которое стоит обратить внимание сканирующего список
оператора, но не настолько тревожное, чтобы быть `destructive`.

### 5.2 `TransactionDetailDialog` — детали

Новый `Row` сразу после существующего `Row` с суммой, тем же паттерном (`icon+label+value`):

```tsx
{
  ;(t.type === 'SENIOR_PENDING_PAYOUT' || t.type === 'DROP_PENDING_PAYOUT') &&
    t.settledAmount != null &&
    t.settledAmount > 0 && (
      <Row icon={<Wallet className="h-4 w-4" />} label="Выплачено">
        <span className="tabular-nums">
          {fmtAmount(t.settledAmount, t.settledCurrency ?? t.currency)}
        </span>
        {(t.settledCurrency == null || t.settledCurrency === t.currency) && (
          <span className="block text-xs text-muted-foreground mt-0.5">
            К доплате: {fmtAmount(Number(t.amount) - t.settledAmount, t.currency)}
          </span>
        )}
      </Row>
    )
}
```

`Wallet` — уже импортирован в модуле (`TransactionRow.tsx`), несёт устойчивую метафору «деньги/счёт».

### 5.3 `SettleSeniorPayoutDialog` — сводка перед оплатой (корректирующий фикс, не косметика)

Сегодняшний блок:

```tsx
<div className="flex justify-between">
  <span className="text-muted-foreground">Сумма</span>
  <span className="font-medium tabular-nums">{fmtAmount(tx.amount, tx.currency)}</span>
</div>
```

Показывает `tx.amount` — ПОЛНОЕ обязательство. После задач 3/3b оно может отличаться от того, что
реально спишется при нажатии «Отметить как оплачено» (сервер платит остаток, `remainingOwed`).
Меняется на:

```tsx
{
  tx.settledAmount != null && tx.settledAmount > 0 ? (
    <>
      <div className="flex justify-between">
        <span className="text-muted-foreground">Обязательство</span>
        <span className="font-medium tabular-nums">{fmtAmount(tx.amount, tx.currency)}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">Уже выплачено</span>
        <span className="font-medium tabular-nums text-amber-400">
          {fmtAmount(tx.settledAmount, tx.settledCurrency ?? tx.currency)}
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">К доплате сейчас</span>
        <span className="font-semibold tabular-nums">
          {fmtAmount(Number(tx.amount) - tx.settledAmount, tx.currency)}
        </span>
      </div>
    </>
  ) : (
    <div className="flex justify-between">
      <span className="text-muted-foreground">Сумма</span>
      <span className="font-medium tabular-nums">{fmtAmount(tx.amount, tx.currency)}</span>
    </div>
  )
}
```

Обычный случай (нет накопителя — подавляющее большинство settle'ов) визуально не меняется вовсе —
это ветка `else`, byte-for-byte сегодняшний JSX.

**Драма-условие: DROP с накопителем > 0 сегодня недоступен для доплаты вовсе** (см.
`docs/architecture/2026-08-23-drop-topup-triplet.md` — задача 3b снимает отказ AC15(a) для дропа,
но по декомпозиции она СЛЕДУЕТ, а не предшествует этой; если задача 3b ещё не смёржена на момент
реализации задачи 5 — `SettleSeniorPayoutDialog` для `DROP_PENDING_PAYOUT` с `settledAmount > 0`
не откроется вовсе (сервер отклонит попытку каскадной правки дохода раньше — строка не сможет
дойти до состояния «PENDING с накопителем» для дропа). Проверить фактическое состояние `main` перед
реализацией — если 3b уже смёржена (PR #608, по task-файлу это уже так), этот параграф снимается,
доплата дропа работает идентично сеньору.

---

## 6. Экран C — Пометка переплаты

Не отдельный экран — часть §4.3.1 (поле «Предупреждения» строки-производной) + §5 (список/детали).
`OVERPAYMENT` warning — рендерится amber-строкой ВНУТРИ карточки/строки производной, текст verbatim
с сервера («Уже выплачено N — пересчитанная доля M меньше выплаченного, строка остаётся
оплаченной»). Дополнительно: строка-производная с этим warning'ом **не получает** `needsReconfirm`-
акцент (переплата логически исключает откат — сервер и так гарантирует это через
`resolveDerivative`, UI просто не рисует две противоречащие пометки на одной строке).

**Вне области предпросмотра, но связанная поверхность:** если у строки УЖЕ есть переплата
(`overpaid`, не только что вычисленная, а сохранённая в прошлом решении оператора «оставить как
есть») — списочное/детальное отображение из §5 её не подсвечивает отдельно (`OVERPAYMENT` — код
плана предпросмотра, не постоянное свойство строки; строка просто остаётся `PAID` с суммой меньше
`settledAmount`, что уже видно из «Выплачено N / осталось —» — при `newAmount < settledAmount`
вычисление «осталось» в §5.1/5.2 даст отрицательное число). **Фикс: `Math.max(0, ...)` в
формулах §5.1/5.2** — «осталось» никогда не показывает отрицательное, при переплате рендерится
«осталось 0» (не «-100» — отрицательный долг нечитаем и противоречит формулировке «к доплате»).

---

## 7. Триплет факта платежа — `TransactionDetailDialog` «Факт платежа»

### 7.1 Находка и решение

Архитектурная находка (`2026-08-23-drop-topup-triplet.md`, «Найденное попутно»): `originalAmount`/
`originalCurrency`/`exchangeRate` уже в `TransactionDto` (экспортированы `mapTx`'ом), но `apps/web`
не читает их нигде, кроме двух комментариев в `PaySalaryDialog.tsx`. Оператор не видит «сколько было
должно и по какому курсу закрыли» вообще, включая обычные зарплаты — не только каскадные сценарии.

**Решение: да, входит в задачу 5.** Обоснование:

1. **Нулевая цена по API** — данные уже на wire, это чисто фронтенд-работа (в отличие от §14, где
   нужен новый бэкенд-эндпоинт/поле).
2. **Прямая связь с новыми отказами этой же задачи.** `PAYMENT_FACT_RECORDED` (блокирующий отказ
   §4.6) называет носителя («на этой строке зафиксирован факт платежа») — но оператор, увидев отказ,
   сегодня НЕ МОЖЕТ проверить это утверждение нигде в UI. Отказ без возможности проверить его
   причину — хуже, чем отказ с возможностью. Это тот же довод, что уже двигал design-gate: «отказ
   называет средство, а не просто запрещает» — но средство бесполезно, если факт, из-за которого
   отказали, невидим.
3. **Не расширяет DOM бесплатно.** Рендерится ОДНИМ `Row`-блоком, ТОЛЬКО когда `originalAmount !==
null` (условие уже существует как предикат в `classifyEditedRowLedgerFact`) — на подавляющем
   большинстве строк не меняется ничего.

### 7.2 Anatomy

Новый `Row` в `TransactionDetailDialog`, сразу после существующего блока суммы, видим для
ADMIN/ACCOUNTANT (та же privileged-проверка, что уже используется в файле для остальных audit-
полей — `originalAmount` не персональные данные третьих лиц, но это внутренняя бухгалтерская
деталь, не для SENIOR/DROP/JUNIOR/HR):

```tsx
{
  privileged && t.originalAmount !== null && (
    <Row icon={<Percent className="h-4 w-4" />} label="Факт платежа">
      <span className="tabular-nums">
        Обязательство: {fmtAmount(t.originalAmount, t.originalCurrency ?? t.currency)}
      </span>
      {t.exchangeRate !== null && (
        <span className="block text-xs text-muted-foreground mt-0.5 tabular-nums">
          Применённый курс: ×{Number(t.exchangeRate).toFixed(4)}
        </span>
      )}
    </Row>
  )
}
```

`Percent` — уже импортирован в `TransactionDetailDialog.tsx` (используется для доли синьора/дропа),
переиспользуется — та же метафора «коэффициент/пересчёт».

---

## 8. A11y (WCAG 2.2 AA)

| Требование                                                  | Реализация                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Отказ/предупреждение — не только цвет                       | Иконка (`Ban`/`AlertCircle`/`AlertTriangle`/`RotateCcw`) + текст ВСЕГДА рядом с цветным акцентом — никогда цвет как единственный носитель смысла                                                                                                                                                                                                                          |
| Save disabled — причина видна без наведения                 | Текстовая строка рядом с кнопкой (§4.4), НЕ только `title`/`disabled`-атрибут (SC 1.4.13, SC 4.1.2)                                                                                                                                                                                                                                                                       |
| Loading-состояние объявляется screen reader'у               | `aria-live="polite"` — НЕ на всём контейнере `CascadeImpactPanel` (это озвучивало бы ВСЮ таблицу производных заново при каждом изменении одной строки — хуже, чем отсутствие live-региона), а на узком статус-элементе внутри (одна строка «Пересчитываем…»/«Готово» с `aria-atomic="true"`), который меняет текст, а не на широком контейнере, чьи дети меняются целиком |
| Focus не теряется при появлении/исчезновении панели         | Панель монтируется/размонтируется ниже поля суммы, НЕ между полем и кнопками — фокус, оставленный в `AmountCurrencyInput`, не прыгает                                                                                                                                                                                                                                     |
| Target-size (кнопка «Обновить предпросмотр»)                | `size="sm"` Button — стандартная высота ≥24px (WCAG-минимум); на мобайле весь dialog footer уже подчиняется 44px-конвенции `CrmDialogFooter`                                                                                                                                                                                                                              |
| Contrast                                                    | `text-amber-400`/`text-destructive` на `bg-card`/`bg-muted` — уже выверенные токены (используются в `STATUS_COLORS`), не новые значения                                                                                                                                                                                                                                   |
| Таблица производных — заголовки читаемы screen reader'ом    | `<th scope="col">` на всех 5 заголовков desktop-таблицы (не было явного `scope` в существующих finance-таблицах — новая, не наследуемая правка, добавляется явно как улучшение, а не регресс)                                                                                                                                                                             |
| Мобильная карточка — семантика вместо `<table>`             | `<dl>`/`<div>` со связкой label→value через видимую типографику (не полагаться на визуальный `flex justify-between` как единственный носитель связи — использовать `<dt>`/`<dd>` пары либо `aria-label` на карточке, формулирующий получателя целиком)                                                                                                                    |
| Декоративные иконки в новых плашках                         | `Ban`/`AlertCircle`/`AlertTriangle`/`RotateCcw`/`RefreshCw` — `aria-hidden` (см. пример кода §4.6); текст рядом несёт весь смысл, иконка не дублируется в `aria-label`                                                                                                                                                                                                    |
| Кнопки «Обновить предпросмотр» / «Повторить» — не icon-only | Иконка + видимый текстовый лейбл в одной кнопке — отдельный `aria-label` не требуется (в отличие от icon-only кнопок вроде `Edit2`/`Trash2` в `TransactionRow`, у которых `aria-label` обязателен)                                                                                                                                                                        |
| Русский UI                                                  | Все новые строки — русский (см. §4.6, §4.7, §5, §7)                                                                                                                                                                                                                                                                                                                       |

---

## 9. Responsive (4 класса устройств)

### 9.1 `AdminEditTransactionDialog` + `CascadeImpactPanel`

| Класс         | Ширина    | Поведение                                                                                                                                                                                                                                                                                                                                              |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Мобильный** | 320 / 375 | `CrmDialogContent` `w-full` без `maxWidth`-ограничения снизу (существующее поведение). `CascadeImpactPanel` — card-стек (§4.3.3), `space-y-2`, каждая карта full-width. Save-кнопка внутри `CrmDialogFooter` — full-width `flex-col-reverse` (уже существующий паттерн диалога), ≥44px                                                                 |
| **Планшет**   | 768       | `sm:max-w-md` (без плана) / `sm:max-w-2xl` (с производными) — маленький скачок ширины при появлении плана допустим (контент реально другой), НЕ считается layout-jank. Карточки остаются card-стеком (таблица включается только с 640px — планшет 768px ЭТО уже ≥640px, значит на 768px уже desktop-таблица, не карточки — см. точный брейкпоинт ниже) |
| **Ноутбук**   | 1024/1280 | `sm:max-w-2xl`, desktop-таблица (§4.3.2), 5 колонок помещаются без переноса                                                                                                                                                                                                                                                                            |
| **Большой**   | 1440/1920 | Диалог НЕ растягивается сверх `max-w-2xl` — центрирован, как и все остальные диалоги модуля                                                                                                                                                                                                                                                            |

**Точный брейкпоинт card↔table:** `sm:` (640px) — единственный порог во всём файле; 768px (планшет)
уже получает desktop-таблицу. Это НАМЕРЕННОЕ решение: 5 колонок с короткими значениями (суммы,
статусы) умещаются на 640px без сжатия хуже, чем card-стек читается на такой ширине — таблица
плотнее, а плотность — приоритет CRM (`foundation.md` Tone). Единственный класс с card-стеком —
чисто мобильный (320–639).

### 9.2 `TransactionRow` (список)

Новая подпись «Выплачено X · осталось Y» — рендерится на ВСЕХ классах устройств (это не layout-
элемент, а дополнительная строка текста внутри уже существующей ячейки суммы, которая на мобайле
уже участвует в горизонтальном скролле всей таблицы — существующий, отдельно живущий компромисс,
эта задача его не расширяет и не сужает).

### 9.3 `TransactionDetailDialog` / `SettleSeniorPayoutDialog`

Оба уже проходят полный responsive-цикл (`CrmDialogContent` `max-h-[90dvh]`, scroll body). Новые
`Row`/summary-строки — обычные блочные элементы внутри уже адаптивного контейнера, не требуют
собственных брейкпоинтов.

### 9.4 Verification

Playwright на 320/375/768/1024/1280/1440/1920: нет горизонтального overflow страницы
(`document.scrollWidth <= document.documentElement.clientWidth`); на 320px карточки производных не
обрезают текст сумм (проверить самое длинное реалистичное значение — 6-значная сумма + 4 символа
валюты); переключение card↔table на границе 640px не даёт «дыры» (оба layout взаимоисключающе
`hidden`/видимы, не оба одновременно в DOM с visual overlap).

---

## 10. Motion

Наследует `foundation.md` §7 — только compositor-friendly свойства. Появление/исчезновение
`CascadeImpactPanel` — НЕ анимируется layout-высотой (запрещено `foundation.md` §7 явно); допустим
`opacity`-fade (150ms ease-out) на смену состояний ВНУТРИ панели (loading→план, план→заблокировано),
но не обязателен — самый дешёвый вариант (без анимации, мгновенная замена контента) тоже приемлем
и не требует нового кода. `RotateCcw`/`RefreshCw` иконки — статичны, без spin-анимации (spin
уместен только для активного in-flight индикатора, а `isFetching`-состояние уже покрыто отдельным
Skeleton-блоком §4.2).

---

## 11. Edge-cases

| Кейс                                                                                                                          | Поведение                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Оператор набрал новую сумму, затем стёр обратно до исходной                                                                   | `shouldPreview` становится `false` (`amountsDiffer` возвращает `false`) — панель размонтируется, Save ведёт себя как обычная (не-каскадная) правка                                                                                                                                                                                                                                                           |
| Оператор быстро печатает (несколько цифр подряд)                                                                              | Debounce 400ms — запрос уходит один раз после паузы в наборе, не на каждое нажатие                                                                                                                                                                                                                                                                                                                           |
| `newAmount === null` (`NO_SHARE_SNAPSHOT`) на единственной производной                                                        | Строка/карточка показывает «Стало: —» destructive-подсветкой, warning-текст verbatim, Save заблокирована формулой §4.4                                                                                                                                                                                                                                                                                       |
| Прямая правка уже откаченной `PENDING_PAYMENT`-производной (не через каскад — статус не `PAID`) с суммой ниже `settledAmount` | Каскадная панель НЕ рендерится (`status !== 'PAID'`), но сервер применит `floorAmountAtAccumulator` молча. Минимальный edge-fix: если `tx.settledAmount != null && parsedAmount < tx.settledAmount`, показать НЕ-каскадную, простую подсказку под полем суммы (`text-xs text-muted-foreground`): «Сумма не может быть ниже уже выплаченного ({fmtAmount(tx.settledAmount, ...)}) — будет сохранено как есть» |
| Диалог открыт, `tx` меняется извне (react-query инвалидация после чужого действия)                                            | Не в скоупе этой задачи — существующее поведение `AdminEditTransactionDialog` (`useEffect` на `tx` перезаполняет форму) не меняется; редкий кейс, отдельно не решается                                                                                                                                                                                                                                       |
| Очень длинная сумма (близко к `MAX_TRANSACTION_AMOUNT`)                                                                       | `tabular-nums`, без `whitespace-nowrap` в card-режиме (может перенестись на вторую строку — допустимо, `flex justify-between` не ломается), `whitespace-nowrap` в table-режиме (колонка достаточно широкая)                                                                                                                                                                                                  |
| Пустой ответ сети / таймаут                                                                                                   | §4.2 состояние 2 — «Не удалось загрузить предпросмотр» + «Повторить»                                                                                                                                                                                                                                                                                                                                         |
| `blockedReason` внезапно приходит `null`, но `editable: false` (не должно случиться по контракту, но защита)                  | Fallback-текст «Правка суммы для этой строки недоступна» — не крашить рендер на неизвестном ключе `Record`                                                                                                                                                                                                                                                                                                   |

---

## 12. data-testid — сводная таблица

| Элемент                                              | `data-testid`                                         |
| ---------------------------------------------------- | ----------------------------------------------------- |
| Панель предпросмотра (контейнер, все состояния)      | `cascade-impact-panel`                                |
| Loading-состояние                                    | `cascade-preview-loading`                             |
| Заблокировано                                        | `cascade-blocked-banner`                              |
| Пусто (нет каскада)                                  | `cascade-preview-empty`                               |
| План — строка суммы источника                        | `cascade-source-amount`                               |
| Производная (desktop-строка / mobile-карточка)       | `cascade-derivative-${derivative.id}`                 |
| Бейдж «вернётся в ожидание выплаты»                  | `cascade-derivative-reconfirm-${derivative.id}`       |
| Warning-строка производной                           | `cascade-derivative-warning-${derivative.id}-${code}` |
| Устаревший предпросмотр (409)                        | `cascade-stale-banner`                                |
| Кнопка «Обновить предпросмотр»                       | `cascade-refresh-preview`                             |
| Кнопка «Повторить» (сетевая ошибка)                  | `cascade-preview-retry`                               |
| `TransactionRow` подпись «Выплачено/осталось»        | `tx-row-settled-${tx.id}`                             |
| `TransactionDetailDialog` Row «Выплачено»            | `tx-detail-settled`                                   |
| `TransactionDetailDialog` Row «Факт платежа»         | `tx-detail-payment-fact`                              |
| `SettleSeniorPayoutDialog` строка «К доплате сейчас» | `settle-senior-remaining`                             |

---

## 13. Инструкция для кодера (КРИТИЧНО)

1. **Backend уже в `main`.** `GET /transactions/:id/edit-preview`, `PATCH
:id/admin-edit` с `cascadeVersion`, весь контракт `packages/shared/src/schemas/edit-cascade.ts` —
   не пишутся заново, импортируются буквально. Эта задача — фронтенд-only.
2. **`amountsDiffer` — импорт из `@crm/shared`, не переизобретать.** Это ТА ЖЕ функция, которой
   сервер решает, изменилась ли сумма (`toFixed(6)`-сравнение) — вторая копия немедленно разойдётся
   с сервером на границе округления.
3. **Save-gating — строго формула §4.4.** Не «есть ли warnings» (переплата не блокирует), не
   «`editable === true`» само по себе (план может быть editable, но конкретная производная внутри
   всё равно заблокирует apply).
4. **Все денежные тексты — verbatim с сервера** (§4.5). Не сокращать, не переписывать «для
   краткости» — сообщения уже прошли через `Skill('copywriting')`/security-review на бэкенде.
5. **`getApiErrorMessage`, не локальная проверка** — заменить существующий
   `mutation.error instanceof Error ? ... : null` в `AdminEditTransactionDialog` (см. §4.5).
6. **`CascadeImpactPanel` — новый файл, не встраивать инлайн в `AdminEditTransactionDialog`.**
   Логика состояний (§4.2) достаточно объёмна, чтобы диалог не разросся до нечитаемого размера —
   тот же принцип, по которому `ReceiptInput`/`FundingSourceFields` вынесены отдельно.
7. **Derivative row — ОДИН компонент с двумя рендерами (`hidden sm:table-row` / `sm:hidden`),
   не два раздельных файла.** Источник данных общий, расхождение только в разметке — паттерн уже
   используется в модуле (`hidden md:inline-flex` в `TransactionRow.tsx`).
8. **`SettleSeniorPayoutDialog`-фикс (§5.3) — не опциональная косметика, обязательный AC.** Без
   него summary-card показывает неверную цифру перед необратимым денежным действием.
9. **`retry: false` на preview-запросе** (§4.1) — не убирать «для единообразия» с остальными
   `useQuery` в модуле; здесь у него другая роль.
10. **Responsive-брейкпоинт card↔table — `sm:` (640px), не `md:` (768px)** (§9.1) — сознательное
    расхождение с общим паттерном модуля («планшет = card-стек» из `foundation.md`), обоснование
    там же.
11. **`settledAmount`/`settledCurrency` на `TransactionDto` — нужны ДО начала этой задачи** (§14
    п.1). Если поле ещё не добавлено на бэкенде — это блокер, не «доделаем потом»: без него §5 и
    §4.3.1 («Выплачено») не реализуемы честно.

---

## 14. Чего не хватает в API для внятного экрана

Три находки, каждая — вход для отдельной мини-задачи (backend + `packages/shared`), не решается
молчаливым изменением контракта в рамках задачи 5 (Coder-frontend её реализовать не может сам —
зона `packages/shared`/`apps/api` не его).

### 14.1 `TransactionDto` не несёт `settledAmount`/`settledCurrency` (блокирует §5 целиком)

**Факт, проверенный по коду.** `transactionSchema`
(`packages/shared/src/schemas/finance.ts`) перечисляет `originalAmount`/`originalCurrency`/
`exchangeRate`, но НЕ `settledAmount`/`settledCurrency`/`settledSharePercent` — эти три колонки
существуют в `transactions`-таблице (добавлены задачей 1, PR #599) и используются ВНУТРИ
`loadCascadeSnapshot`/`applyEditCascade`, но `mapTx` (символ в `transactions.service.ts`) их не
прокидывает наружу. Поскольку любой ответ API идёт через `transactionSchema.parse()`, поле физически
срезается, даже если бы кто-то случайно попытался его вернуть.

**Почему это блокирует именно задачу 5, а не только «было бы неплохо».** Требование #2 постановки
(«PENDING-строка с уже выплачено/к доплате в списке финансов») и корректирующий фикс §5.3
(`SettleSeniorPayoutDialog`) физически не читают эти числа ниоткуда без этого поля — вычислить их
на фронте нечем, они не выводимы из уже экспонируемых полей.

**Предложение (минимальное, без обсуждения — просто конкретика для координатора):**

```ts
// packages/shared/src/schemas/finance.ts, transactionSchema
settledAmount: z.string().nullable().optional(),
settledCurrency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).nullable().optional(),
```

```ts
// apps/api/src/finance/transactions.service.ts, mapTx — рядом с originalAmount/originalCurrency
settledAmount: tx.settledAmount,
settledCurrency: tx.settledCurrency,
```

**Видимость (RBAC) — вопрос для координатора/security-reviewer, не решаю сам.** `amount`/`currency`
уже видны получателю строки + ADMIN/ACCOUNTANT (обычная counterparty-маскировка `mapTx` их не
трогает — это не персональные данные третьей стороны). `settledAmount` — та же по природе величина
(«сколько из уже видимой суммы уже выплачено»), напрашивается та же видимость без дополнительной
маскировки, но это решение по RBAC-поверхности, не дизайнерское — фиксирую как открытый вопрос,
не как решённый факт.

### 14.2 `CascadeDerivativePlan` не несёт получателя (сужает §4.3.1)

**Факт.** `cascadeDerivativePlanSchema` (`packages/shared/src/schemas/edit-cascade.ts`) содержит
`id`/`type`/суммы/предупреждения — НЕ `receiverId`/`receiverName`. Резолвер (`resolveDerivative`) —
чистая функция без доступа к БД, а `loadCascadeSnapshot` (символ, `transactions.service.ts`) грузит
только те поля, что нужны арифметике каскада; получатель туда не входит.

**Практическое следствие, уже отражённое в спеке (§4.3.1):** для `SENIOR_PENDING_PAYOUT` экран
может честно показать имя (переиспользуя `tx.receiverName` источника — та же персона), но для
`DROP_PENDING_PAYOUT` — нет, получатель отображается безымянно («Доля дропа»). На проекте с ОБЕИМИ
производными сразу (сеньор + дроп) это создаёт видимую асимметрию в одной и той же таблице — один
ряд с именем, другой без.

**Предложение:** добавить `receiverId`/`receiverName` (nullable) в `cascadeDerivativePlanSchema`,
заполнять в `getEditCascadePreview` тем же способом, каким `mapTx` уже резолвит `receiver.displayName`
для обычных транзакций (join уже есть в других запросах сервиса — не новый паттерн, просто
`loadCascadeSnapshot`'s запрос сегодня его не выбирает для производных).

### 14.3 Часть отказов `applyEditCascade` не видна в `GET /edit-preview` (частично снижает §4.4)

**Факт.** Два внутренних инварианта — расхождение `transactions.amount` ↔ `settled_amount` на
company-funded строке (аддендум §1.2) и отсутствующий `settled_amount` на легаси-строке до #599
(аддендум §1.14) — проверяются ТОЛЬКО внутри `applyEditCascade`, читая `snap.amount`/
`snap.settledAmount` напрямую, и НЕ выражены `CascadeWarning`-кодом в `resolveDerivative`. Чистый
резолвер (`resolveEditCascade`), который использует и `GET`, и `PATCH`, эти два условия вообще не
вычисляет — значит превью не может их предсказать по конструкции, не только по недосмотру.

**Почему это НЕ тот же класс проблемы, что 14.1/14.2 (не требую фикса).** Оба случая — по
архитектурному анализу аддендума — **сегодня пусты в проде** («по теореме», не «по недостатку
данных для проверки»): первый требует строки, отредактированной ДО задачи 0 (#598), второй —
settle'а ДО задачи 1 (#599). Добавлять warning-код ради населения, которое пусто по конструкции —
именно тот anti-pattern, который сама архитектура задачи явно запрещает («не делать каскад
рекурсивным про запас», AC5 п.8 основного ADR — тот же довод, другое место). Спека обрабатывает
этот редкий случай честно (§4.4 — «обрабатывается не превентивным UI-запретом, а отображением
серверного текста ошибки при сабмите»), а не молчанием — Save в этом крайнем случае может вернуть
400 уже ПОСЛЕ прохождения клиентской проверки, и это **корректное, ожидаемое** поведение системы,
а не пробел в этой спеке.

---

## 15. Fidelity-референсы (для Mode B после реализации)

`design-gate: degraded` — headless-сессия без Claude Design/браузера, `design.png` не создаётся.
Mode B fidelity-аудит после реализации сверяется против:

1. **Этой спеки целиком** — состояния §4.2, Save-gating формула §4.4, три поверхности §5.
2. **Существующих референс-компонентов без изменения их визуального языка:**
   `admin-income-obligation-preview` banner (`CreateTransactionDialog.tsx`) — визуальный эталон для
   §4.7 «пусто»; summary-card (`SettleSeniorPayoutDialog.tsx`) — эталон для §4.3.3/§5.3;
   conversion-hint skeleton (`AmountCurrencyInput.tsx`) — эталон для §4.2 loading; «Транзакцию
   нельзя редактировать» banner (`AdminEditTransactionDialog.tsx`, текущий) — эталон для §4.6.
3. **Responsive-таблицей §9 на всех тест-ширинах** (320/375/768/1024/1280/1440/1920) — особое
   внимание: брейкпоинт card↔table на 640px (НЕ 768px — сознательное расхождение с
   `foundation.md`'s общим паттерном, см. §9.1), никакого горизонтального overflow на 320px.
4. **Save-gating живьём:** на фикстуре с `NO_SHARE_SNAPSHOT`/`OBLIGATION_CURRENCY_MISMATCH`/
   заблокированным `NON_USDT_CURRENCY`+`needsReconfirm` — кнопка «Сохранить» реально `disabled`, не
   просто визуально приглушена по недосмотру CSS.
