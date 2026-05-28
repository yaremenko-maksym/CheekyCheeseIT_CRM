# task-fix-transactions-sort-timestamps

## Агент: coder

## Приоритет: MEDIUM (UX bug — confusing order на главной finance странице)

## Ветка: fix/transactions-sort-timestamps (НОВАЯ, base = main)

## Контекст

На странице `/crm/finance` транзакции отображаются в неправильном порядке.

### Воспроизведение

1. Залогиниться как SENIOR
2. Создать новую транзакцию SENIOR_INCOME (например $4,000) сегодняшней датой
3. Открыть `/crm/finance`
4. **Ожидается:** новая транзакция #1 в таблице
5. **Фактически:** новая транзакция показана #4 — выше неё PAYOUT'ы (даже более ранние по реальному времени создания)

### Root cause (диагностировано PM через ast-grep + DB inspection + curl API)

1. **Backend** (`apps/api/src/finance/transactions.service.ts:118`):

   ```ts
   orderBy: [desc(transactions.createdAt)]
   ```

   API возвращает корректный порядок по `createdAt DESC`. Verified: `GET /api/transactions` возвращает $4,000 (createdAt 08:17) первым.

2. **Frontend** (`apps/web/app/routes/crm/finance/index.tsx:257-262`) — пере-сортировка с дефолтным `sortKey='date'`, `sortDir='desc'`:

   ```ts
   if (sortKey === 'date')
     return (
       mul *
       (new Date(a.txDate ?? a.createdAt).getTime() - new Date(b.txDate ?? b.createdAt).getTime())
     )
   ```

3. **Почему именно фронт ломает порядок:**
   - SENIOR_INCOME (новый): `txDate = "2026-05-28T00:00:00.000Z"` (midnight — потому что юзер выбирает только дату `<input type="date">`)
   - SENIOR_PAYOUT: `txDate = null` → fallback на `createdAt = "2026-05-28T07:37:20.136Z"` (полное время создания)
   - DESC: 07:37 > 00:00 → payout первым, income четвёртым

### Что хочет юзер (verbatim)

> «думаю тут проблема в том как фронт и бек передают время друг другу, в идеале делать это таймстемпом, чтобы мы в случае чего могли точно определить время того или иного события»

То есть: хранить **полные timestamps** (с временем) для бизнес-времени транзакций, а не midnight даты.

### DB schema (verified через postgres MCP)

`transactions.tx_date`, `created_at`, `updated_at` — все `timestamp without time zone`, precision 6 (микросекунды). **Schema не требует изменений** — просто backend должен сохранять полное время, а frontend — стабильно сортировать.

## AC

- [ ] **AC1: Backend сохраняет txDate с реальным временем при создании транзакции**
  - В `apps/api/src/finance/transactions.service.ts` метод `create()` (или wherever новая transaction creates) — если юзер передал `txDate` как date-only (например `"2026-05-28"` который парсится в midnight UTC), backend дополняет реальным временем создания.
  - Стратегия: использовать `new Date()` для time-of-day компоненты, но сохранить выбранную дату:
    ```ts
    // Если юзер выбрал дату — комбинировать с current time
    const now = new Date()
    const userDate = new Date(input.txDate) // midnight UTC
    const txDateWithTime = new Date(
      userDate.getFullYear(),
      userDate.getMonth(),
      userDate.getDate(),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds(),
    )
    ```
  - ИЛИ простой подход: `txDate = input.txDate ?? new Date()` (без time-mixing — если юзер выбрал прошедшую дату, использовать её midnight как сейчас; если today — использовать current time)
  - Выбери подход — обоснуй комментарием в коде (одна строка)

- [ ] **AC2: Frontend sort использует createdAt как primary fallback + tie-breaker**
  - В `apps/web/app/routes/crm/finance/index.tsx:257-262` функция `sort`:
    ```ts
    if (sortKey === 'date') {
      const aTime = new Date(a.txDate ?? a.createdAt).getTime()
      const bTime = new Date(b.txDate ?? b.createdAt).getTime()
      if (aTime !== bTime) return mul * (aTime - bTime)
      // Тай-брейкер: createdAt — гарантия стабильности при equal txDate
      return mul * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    }
    ```
  - Цель: даже если AC1 не покрывает все исторические midnight записи — сортировка стабильно даёт правильный порядок по createdAt при равных txDate.

- [ ] **AC3: Историческая корректность не сломана**
  - Существующие seed-данные (с midnight txDate) — порядок может измениться (теперь tie-breaker по createdAt), но это правильно — записи с реальным временем теперь на правильных местах
  - НЕ нужна миграция данных — задача fix-forward only

- [ ] **AC4: Unit test для sort comparator**
  - В `apps/web/app/routes/crm/finance/__tests__/sort.test.ts` (или ближайший подходящий location) — тест что comparator корректно сортирует:
    - 2 транзакции с одинаковым `txDate` но разным `createdAt` → tie-breaker сортирует по `createdAt`
    - 2 транзакции: одна с null txDate, другая с midnight txDate → comparator использует createdAt для both и сортирует корректно
  - Если есть utility extract — выделить sort comparator в чистую функцию для тестирования

- [ ] **AC5: E2E smoke**
  - Не требуется новый E2E если flow покрыт existing tests. Если нужно — добавить scenario в `apps/e2e/tests/finance-senior-flow.spec.ts`:
    - Создать новую SENIOR_INCOME → assert она #1 в таблице
  - Опционально — AutoTest сделает после merge

## Файлы (ожидаемые изменения)

- `apps/api/src/finance/transactions.service.ts` — AC1 (txDate logic)
- `apps/web/app/routes/crm/finance/index.tsx` — AC2 (sort tie-breaker)
- `apps/web/app/routes/crm/finance/__tests__/sort.test.ts` (новый) — AC4

## Definition of Done

- ac_verified: 1,2,3,4
- Manual smoke (на dev mode):
  1. Залогиниться как SENIOR
  2. Создать новую SENIOR_INCOME сегодняшней датой
  3. Открыть /crm/finance — она должна быть #1
  4. Verify backend `GET /api/transactions` возвращает txDate с временем (не midnight)
- Unit tests pass: `pnpm test`
- Typecheck pass: `pnpm typecheck`
- ESLint pass: `pnpm lint`
- E2E локально перед push: `pnpm --filter @crm/e2e test`

## Out of scope

- Migration исторических данных (legacy midnight txDate остаются)
- Изменение `<input type="date">` на datetime picker во фронте — юзер не просил datetime UI
- Изменение DB schema — уже timestamp(6), достаточно

## Заметки для Coder

- Base branch: **main** (не feature/invoice-ui). Делать `git checkout main && git pull && git checkout -b fix/transactions-sort-timestamps`
- Получить task file: `git checkout claude/musing-jang-a12f39 -- docs/specs/tasks/task-fix-transactions-sort-timestamps.md`
- ВАЖНО: PR #56 ещё открыт — если возникнет merge conflict при merge этого fix → разрешаем при merge каждого PR
- Не трогать backend orderBy на line 118 — он корректный (createdAt DESC). Trust API, fix frontend sort.

## Дополнительный контекст: что юзер увидел (для clarity)

Юзеру отдан скриншот /crm/finance после создания нового прихода $4,000 28.05.26.
Видит:

1. Выплата $8,222.14 от 28.05.26 — Оплачено
2. Выплата $3,330 от 28.05.26 — Оплачено
3. Выплата $5,328 от 28.05.26 — Оплачено
4. **Приход синьора $4,000 от 28.05.26 — Ожидает** (должен быть #1)

После fix:

1. **Приход синьора $4,000 от 28.05.26 — Ожидает** (новый created 08:17 — #1)
2. Выплата $8,222.14 от 28.05.26 (created 07:37)
3. Выплата $3,330 от 28.05.26 (created 07:01)
4. Выплата $5,328 от 28.05.26 (created 06:55)
