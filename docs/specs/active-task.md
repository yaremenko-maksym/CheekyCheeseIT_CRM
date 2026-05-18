# Fix: 1 оставшийся E2E тест — strict mode в finance spec

## Приоритет: КРИТИЧЕСКИЙ

Issue #12 `e2e-broken` блокирует AI Review pipeline.
Остался 1 падающий тест в `tests/finance-senior-flow.spec.ts`.
Производственный код менять не нужно.

## Как доставить

**Пушить напрямую в `main`** — это CI fix, разрешено согласно CLAUDE-devops.md.
НЕ создавать PR.

---

## Падающий тест: `tests/finance-senior-flow.spec.ts:157`

### Название: "SENIOR не может создать транзакцию без чека — показывается ошибка"

### Ошибка (ТОЧНАЯ):

```
strict mode violation: getByRole('dialog').getByText(/прикрепите чек|подтверждение/i) resolved to 2 elements
```

Playwright strict mode: locator возвращает 2 элемента вместо 1.
Текст `/прикрепите чек|подтверждение/i` встречается в диалоге дважды
(например, в label и в validation message — или в двух разных местах UI).

### Фикс (в `apps/e2e/tests/finance-senior-flow.spec.ts`, строка ~160):

```ts
// Было:
await expect(page.getByRole('dialog').getByText(/прикрепите чек|подтверждение/i)).toBeVisible()

// Стало:
await expect(page.getByRole('dialog').getByText(/прикрепите чек|подтверждение/i).first()).toBeVisible()
```

### Как найти точную строку:

```bash
grep -n "прикрепите чек\|подтверждение" apps/e2e/tests/finance-senior-flow.spec.ts
```

Добавить `.first()` ко ВСЕМ вхождениям этого locator в данном тесте.

---

## Итог

Только 1 файл: `apps/e2e/tests/finance-senior-flow.spec.ts`.
Запушить одним коммитом прямо в `main`.
