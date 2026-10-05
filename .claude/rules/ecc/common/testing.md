---
paths:
  - '**/*.ts'
  - '**/*.tsx'
---

# Testing Requirements

Coverage policy is set per task file: every task MUST have explicit AC for
unit/E2E/regression tests; for security-critical logic (auth/finance/RBAC) tests are
MANDATORY, not optional. TDD workflow — via the skill `superpowers:test-driven-development`.

## Test Types

1. **Unit** — functions, utilities, components (Vitest)
2. **Integration** — API endpoints + DB; verify RBAC guards against the **real DB**
   (`crm_qa`) with an assertion on 403/404 — a mocked E2E does NOT prove a backend guard
   (the lesson recurred 3×, see lessons)
3. **E2E** — critical user flows (Playwright, `apps/e2e`; before writing a spec —
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
