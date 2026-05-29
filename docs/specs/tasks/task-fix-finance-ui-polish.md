# task-fix-finance-ui-polish

## Агент: coder

## Приоритет: MEDIUM (UX-полировка после UT финансового/инвойс флоу)

## Ветка: chore/remove-knowledge-base (СУЩЕСТВУЮЩАЯ — фикс внутрь неё)

## Repo: yaremenko-maksym/CheekyCheeseIT_CRM

## Контекст

PM прогнал User Testing payout + invoice флоу (всё функционально работает: validate→auto-PAYOUT→pay simulate→invoice→sign→public verify). Найден батч UI-полировки. Решения по копи/формату уже приняты пользователем — см. AC.

**ВАЖНО — что уже сделано в базовом коммите этой ветки (НЕ переделывать):**

- Удалён стаб «База знаний» (route + nav + e2e nav + CLAUDE.md).
- **Фикс fallback аватаров/логотипов** уже внесён: `UserAvatar.tsx` и `ProjectLogo.tsx` теперь передают `fallbackToParent` в `<DocumentImage>` → при недоступном thumbnail показываются инициалы вместо стаб-иконки «Превью недоступно». Проверено в браузере. **Не трогай это.**

## AC

- [ ] **AC1: `TransactionRow` → forwardRef (убрать framer-motion warning + починить анимацию строк)**
  - Файл: `apps/web/app/routes/crm/finance/components/TransactionRow.tsx`
  - Сейчас `export function TransactionRow({...}) {` возвращает `<motion.tr>` (≈line 223), и оборачивается в `<AnimatePresence>` в `TransactionsTable` (`index.tsx`). Framer-motion не может навесить ref на функц-компонент → React-warning **«Function components cannot be given refs… Did you mean to use React.forwardRef()?»** логируется **на каждую строку** (≈50-60× в консоли на `/crm/finance`) + ломает enter/exit-анимацию строк.
  - Fix: обернуть `TransactionRow` в `React.forwardRef<HTMLTableRowElement, Props>`, пробросить `ref` в `<motion.tr ref={ref}>`, добавить `TransactionRow.displayName = 'TransactionRow'`. Паттерн уже есть в репо — см. `UserAvatar.tsx` (forwardRef).
  - Проверка: открыть `/crm/finance` → консоль чистая (0 повторяющихся ref-warning).

- [ ] **AC2: Унификация написания «синьер» → «синьор»** (решение пользователя: канон = **синьор**)
  - `apps/web/app/lib/invoice-labels.ts`: `'Выплата синьера'` → `'Выплата синьора'` (line ≈14) + поправить вводящий в заблуждение комментарий (lines ≈6-7, где написано «we use синьер everywhere else» — на деле наоборот, везде «синьор»).
  - `apps/api/src/invoices/invoices.service.ts` (line ≈648): `'Выплата синьера'` → `'Выплата синьора'`.
  - `apps/web/app/routes/invoice.v.$transactionId.tsx` (line ≈58): `'Акт выполненных работ (выплата синьера)'` → `'...(выплата синьора)'`.
  - `apps/web/app/components/invoices/__tests__/invoice-card.test.tsx` (lines ≈20,22): обновить ассерт + комментарий на «Выплата синьора».
  - Проверка: `grep -rn "синьер" apps packages` → 0 вхождений (только «синьор»/«синьора»).

- [ ] **AC3: Единая стратегия отображения денег** (решение пользователя)
  - **Список/таблица транзакций:** сумма всегда в **USD с префиксом `$`**. Если исходная валюта транзакции ≠ USD — конвертировать в USD по курсу (инфра курсов уже есть: `ExchangeRates` + `fmtUsd` в `apps/web/app/routes/crm/finance/constants.ts`, backend `nbu-currency.service.ts`). USDT привязан 1:1 к USD, поэтому для USDT — тривиально.
  - **Детали транзакции (`TransactionDetailDialog`) и прочие detail-диалоги (`ValidateDialog`, `PayoutDetailDialog`, invoice-диалог):** показывать **исходную валюту + исходную сумму + курс конвертации** (чтобы видно «5000 EUR @ 1.08 = $5 400»). Для USDT — «7 777,00 USDT» (+ при желании «1 USDT = 1 USD»).
  - Сейчас НЕСОГЛАСОВАННОСТЬ: таблица `$7,777.00`, `ValidateDialog`/`PayoutDetailDialog` показывают `₮5754.98` (символ Tugrik ₮, без разделителя тысяч), invoice — `7 777,00 USDT`. Убрать ad-hoc `₮`-символ.
  - Консолидировать форматирование в общие хелперы (например, `formatUsd()` для списка и `formatOriginal()` для деталей) — в `constants.ts` или `packages/shared`. Один источник правды.
  - Проверка: таблица `/crm/finance` — везде `$`; открыть деталь транзакции → исходная валюта + сумма + курс.

- [ ] **AC4 (minor): Валидация формы создания транзакции**
  - `apps/web/app/routes/crm/finance/components/dialogs/CreateTransactionDialog.tsx`: сейчас при пустом сабмите показывается ТОЛЬКО «Некорректная сумма» (одна ошибка, баннер снизу), хотя проект и чек тоже обязательны/пусты.
  - Fix: показывать ошибки по ВСЕМ невалидным полям (проект, чек, сумма), желательно inline рядом с полем, а не одним общим баннером.

- [ ] **AC5 (minor): Обрезка имён в таблице**
  - `apps/web/app/routes/crm/finance/components/TransactionRow.tsx` — компонент `Party` использует `truncate max-w-28` (≈112px) → «Oleksiy Kovale…», «CheekyChees…» даже при свободном месте.
  - Fix: увеличить лимит (например `max-w-40`/`max-w-48` или адаптивно), чтобы имена влезали когда есть место. `title`-атрибут для полного имени оставить.

- [ ] **AC6 (minor): Стилизованная страница «Not Found»**
  - Catch-all/404 сейчас рендерит голый текст «Not Found» (виден, напр., на несуществующем роуте). Найти `notFoundComponent` (root route / `__root.tsx`).
  - Fix: стилизованный empty-state (иконка + сообщение + ссылка «На главную» → `/crm`). В стиле остальных пустых состояний приложения.

- [ ] **AC7 (minor): Console-ошибки Google GSI/FedCM на login**
  - `/crm/login` (`apps/web/app/routes/crm_/login.tsx`) — Google Identity Services / FedCM сыплет console-ошибки когда нет Google-сессии (`[GSI_LOGGER] FedCM get() rejects with NetworkError`, «Not signed in with the identity provider»). Шумно, но безвредно.
  - Fix (low priority): инициализировать GSI лениво/по клику или обернуть в try/catch, чтобы не засорять консоль. Если рискованно — пропустить и оставить заметку.

## Файлы (ожидаемые изменения)

- `apps/web/app/routes/crm/finance/components/TransactionRow.tsx` — AC1 (forwardRef) + AC5 (max-w)
- `apps/web/app/lib/invoice-labels.ts` — AC2
- `apps/api/src/invoices/invoices.service.ts` — AC2
- `apps/web/app/routes/invoice.v.$transactionId.tsx` — AC2
- `apps/web/app/components/invoices/__tests__/invoice-card.test.tsx` — AC2 (тест)
- `apps/web/app/routes/crm/finance/constants.ts` + диалоги (`ValidateDialog`, `PayoutDetailDialog`, `TransactionDetailDialog`, invoice-диалог) — AC3
- `apps/web/app/routes/crm/finance/components/dialogs/CreateTransactionDialog.tsx` — AC4
- `apps/web/app/routes/__root.tsx` (или где notFoundComponent) — AC6
- `apps/web/app/routes/crm_/login.tsx` — AC7

## Definition of Done

- ac_verified: 1,2,3,4,5,6 (7 — best-effort, можно skip с заметкой)
- `pnpm typecheck` pass
- `pnpm lint` pass
- `pnpm test` pass (включая обновлённый invoice-card.test.tsx)
- `pnpm --filter @crm/e2e test` локально pass перед push (правило проекта — валидный код на remote)
- Коммитить по AC (или логическими группами): AC1, AC2, AC3, minors
- НЕ ставить лейблы (PM管理ит merge)

## Out of scope

- Фикс аватаров/логотипов (#2) — УЖЕ сделан в базовом коммите, не трогать
- Удаление базы знаний — уже сделано
- Конвертация экзотических валют сверх того что поддерживают текущие NBU-курсы
- Новые E2E на эти изменения (AutoTest сделает отдельно после merge)

## Заметки для Coder

- target_branch: `chore/remove-knowledge-base` УЖЕ существует с базовым коммитом (knowledge removal + avatar fix + этот task-файл). Создай рабочую ветку ОТ неё: `git checkout chore/remove-knowledge-base && git checkout -b fix/finance-ui-polish` ИЛИ работай прямо на ветке, согласовав с PM. PM смержит результат обратно в `chore/remove-knowledge-base`.
- Перед началом — `git log --oneline -3` чтобы убедиться что база содержит avatar fix + knowledge removal.
- AC3 (валюта) — самый объёмный; если упрёшься в архитектуру курсов, оставь заметку в PR и сделай минимально-корректный вариант (таблица `$`, детали — исходная валюта).
- Проверяй UI через `pnpm dev` + браузер после каждого AC (особенно AC1 — консоль, AC3 — таблица vs детали).
