# task-fix-pr-167 — резолв MED-находки security review

## Агент: coder

## target_branch: chore/pending-live-fixes (PR #167, ветка СУЩЕСТВУЕТ — git checkout)

## Контекст

Security review PR #167 (Verdict: APPROVE) дал MED-находку: фронт пустил JUNIOR на
`/crm/finance` (useRoleGuard allow-list), backend `transactions.service.ts` (~423-424)
корректно фильтрует `findAll` для JUNIOR по `receiverId` (только своя зарплата), но
**backend guard-теста на сценарий «JUNIOR → findAll» нет** — логика регрессионно-хрупкая.
Существующий `rbac-f1-f2.spec.ts` покрывает HR/findAll и JUNIOR/payout-requests, но не JUNIOR/findAll.
Класс инцидента «mocked-E2E false confidence» (рецидив 3×) — тест ОБЯЗАН быть integration на real-DB,
НЕ mocked-E2E.

## Конкретные изменения

- `apps/api/src/**/rbac-*.spec.ts` (или соседний integration spec рядом с существующими
  finance RBAC тестами — найди через ast-grep, не плоди новый файл без нужды):
  добавить real-DB кейсы: JUNIOR вызывает GET /api/transactions (findAll) →
  получает ТОЛЬКО транзакции с `receiverId = self` (типа SALARY), чужие SENIOR_INCOME /
  PAYOUT / прочие НЕ возвращаются; пустой результат для джуна без транзакций — `[]`, не 403.

## AC

1. Integration-тест JUNIOR/findAll на real-DB зелёный и падает при снятии фильтра (проверить red→green).
2. Полный локальный гейт перед push: typecheck + unit + `pnpm --filter @crm/e2e test`.
3. Коммит в ветку chore/pending-live-fixes с `ac_verified: 1,2` (НЕ wip), push.

## Запрещено

- Трогать apps/e2e/\*\* (зона AutoTest — расскип finance.spec.ts сделает AutoTest отдельно).
- Менять продуктовый код transactions.service.ts (он корректен) — только тест.
