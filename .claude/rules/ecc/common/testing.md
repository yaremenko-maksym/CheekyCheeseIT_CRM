---
paths:
  - '**/*.ts'
  - '**/*.tsx'
---

# Testing Requirements

Coverage policy задаётся per task-файл: каждая задача ОБЯЗАНА иметь явные AC на
unit/E2E/regression тесты; для security-critical логики (auth/finance/RBAC) тесты
MANDATORY, не optional. TDD workflow — через skill `superpowers:test-driven-development`.

## Test Types

1. **Unit** — функции, утилиты, компоненты (Vitest)
2. **Integration** — API endpoints + БД; RBAC guards проверять против **реальной БД**
   (`crm_qa`) с assertion на 403/404 — mocked E2E НЕ доказывает backend guard
   (урок повторялся 3×, см. lessons)
3. **E2E** — критичные user flows (Playwright, `apps/e2e`; перед написанием spec —
   skill `playwright-patterns`)

## Test Structure (AAA Pattern)

```typescript
test('calculates similarity correctly', () => {
  // Arrange
  const vector1 = [1, 0, 0]
  const vector2 = [0, 1, 0]

  // Act
  const similarity = calculateCosineSimilarity(vector1, vector2)

  // Assert
  expect(similarity).toBe(0)
})
```

### Test Naming

Use descriptive names that explain the behavior under test:

```typescript
test('returns empty array when no markets match query', () => {})
test('throws error when API key is missing', () => {})
test('falls back to substring search when Redis is unavailable', () => {})
```
