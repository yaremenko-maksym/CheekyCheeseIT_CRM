# task-fix-e2e-unit-tests-after-batch2

## Агент: autotest
## Приоритет: critical
## Ветка: claude/youthful-hermann-8df1d5 (PR #28 — already open)

## КРИТИЧЕСКИ ВАЖНО

- **Это fix-задача в существующую ветку** — не создавай новую.
- `git fetch origin && git checkout claude/youthful-hermann-8df1d5 && git pull origin claude/youthful-hermann-8df1d5`
- Все тесты должны пройти локально + в CI после твоего push'а.
- Push в эту же ветку → PR #28 обновится автоматически.

## Что сломалось

После пуш-серии (коммиты `43513eb`, `a4520f6`, `e01b3de`) в PR #28 упало **16 unit-тестов**:

### Группа A — `apps/api/src/users/users-access.service.spec.ts` (2 теста)

Матрица `UsersAccessService.getViewPermissions` поменялась в `43513eb`:
- Добавлен tab `documents` для ADMIN и SELF (для всех кому раньше показывались `requisites`)
- SELF + SENIOR **БОЛЬШЕ НЕ ПОЛУЧАЕТ** tab `interviews` (он переехал в кнопку header в UI). У ADMIN viewing SENIOR `interviews` остался.

Падающие тесты:
1. `ADMIN viewing SENIOR includes Собеседования (7 tabs)` — теперь не 7, а 8 (добавился `documents`)
2. `SELF — SENIOR sees own tabs including Собеседования (no audit)` — теперь self-SENIOR НЕ имеет `interviews`, имеет `documents`

Также проверь существующий тест `ADMIN viewing JUNIOR sees 6 tabs (no Собеседования)` — у него ожидается 6 tabs, но теперь должно быть 7 (`documents` добавлен).

**Что обновить:**
- Тест `ADMIN viewing JUNIOR`: ожидание становится 7 tabs включая `documents`
- Тест `ADMIN viewing SENIOR`: 8 tabs total, включает и `documents` и `interviews`
- Тест `SELF — SENIOR`: arrayContaining `['overview', 'finance', 'projects', 'team', 'requisites', 'documents']` (БЕЗ `interviews`). И добавь explicit `expect(p.tabs).not.toContain('interviews')`.

Файл фикстуры `makeUser` уже обновлён под новые колонки (`paymentMethod`, `walletUsdtErc20`, etc.) — ничего там менять не надо.

### Группа B — `apps/api/src/users/users.service.spec.ts` (14 тестов)

После коммита `10b2e97` `UsersService.createUser` пишет seed audit-event:

```ts
await this.auditLogService.record({ actorId: null, targetId: created.id, action: 'profile_created', changes: {...} })
```

В существующих тестах `new UsersService(db, accessService)` создавался без `auditLogService` (третьим аргументом), поэтому `this.auditLogService` undefined → `TypeError: Cannot read properties of undefined (reading 'record')`.

**Что обновить:**
1. В фабрике / в каждом тесте where `UsersService` создаётся — добавить третий аргумент `auditLogService`:
   ```ts
   const auditLogService = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogService
   const service = new UsersService(db as never, accessService as never, auditLogService)
   ```
2. Импортируй `AuditLogService` из `./audit-log.service` для типизации.
3. Для тестов, проверяющих что записан `profile_created` event, можешь добавить `expect(auditLogService.record).toHaveBeenCalledWith(...)` — но это optional, главное чтобы тесты не падали.

Список 14 падающих тестов (все они конструируют `new UsersService(...)`):
- `creates a JUNIOR user without a project`
- `creates a JUNIOR user and assigns them to a project when projectId provided`
- `creates a JUNIOR with null projectId — no project assignment`
- `stores telegram and phone when provided`
- `creates a SENIOR and auto-creates a team with the senior as sole member`
- `creates a SENIOR team with HR and accountant members`
- `creates a SENIOR team with HR only (no accountant)`
- `auto-names the team after the senior displayName`
- `creates a HR user with only a users insert (no team, no project)`
- `creates a ACCOUNTANT user with only a users insert (no team, no project)`
- `stores techStack when provided for any role`
- `stores custom seniorSharePercent for SENIOR`
- `uses default 26% when no seniorSharePercent provided for SENIOR`
- `stores monthlySalary for non-SENIOR roles`

## Acceptance

1. `cd apps/api && pnpm test` — **0 failed, все passed** (sanity: текущее `2 failed | 4 passed (6)` test files, `16 failed | 71 passed (87)` tests → ожидаемо `6 passed, 87 passed`)
2. `pnpm exec turbo typecheck --force` — 4/4 packages OK
3. `pnpm exec turbo lint --force` — 0 warnings
4. CI на PR #28 (Typecheck · Lint · Unit Tests job) проходит зелёным.

## После завершения

Закоммить отдельным коммитом:
```
test(api): fix unit tests after batch 2 — add auditLogService mock + update RBAC matrix expectations

- users.service.spec.ts: add auditLogService mock (third constructor arg) to
  all 14 tests that construct UsersService — they previously failed with
  "Cannot read properties of undefined (reading 'record')" after seed
  audit-event was added to createUser in 10b2e97
- users-access.service.spec.ts: update tab-count expectations to include
  the new "documents" tab (added in 43513eb) and remove "interviews" from
  SELF-SENIOR expectations (interviews moved from tab to header link)
```

Push в `claude/youthful-hermann-8df1d5`, дождись зелёного CI.

## Контекст

Если нужно понимание изменений в матрице/createUser:
- `apps/api/src/users/users-access.service.ts` — getViewPermissions, текущая матрица
- `apps/api/src/users/users.service.ts:107-117` — auditLogService.record call в createUser

Не трогай production-код. Только specs.
