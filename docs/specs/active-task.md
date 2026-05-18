# Fix: 1 оставшийся E2E тест — fixture mismatch для CLIENT_INTERVIEW

## Приоритет: КРИТИЧЕСКИЙ

Issue #12 `e2e-broken` блокирует AI Review pipeline.
Остался 1 падающий тест. Производственный код уже исправлен.
Нужно исправить только spec файлы.

## Как доставить

**Пушить напрямую в `main`** — это CI fix, разрешено согласно CLAUDE-devops.md.
НЕ создавать PR.

После push → CI запустит E2E → если все green → issue #12 закроется автоматически.

---

## Падающий тест: `tests/interviews.spec.ts:321`

### Название: "clicking 'Client →' sends move request with CLIENT_INTERVIEW stage"

### Причина (ТОЧНАЯ):

Тест открывает карточку "Acme Corp" и ищет кнопку `/client/i`.
Но **Acme Corp** в fixture (`apps/e2e/tests/fixtures.ts`, строка 185) имеет `stage: 'HR_SCREEN'`.

В `InterviewDetailSheet` кнопка "Client →" появляется ТОЛЬКО когда текущий stage = `FINAL_INTERVIEW`
(следующий stage = `CLIENT_INTERVIEW` с label = 'Client').

Для Acme Corp (HR_SCREEN) следующая кнопка = "English →" — `/client/i` не совпадает.
Поэтому `getByRole('button', { name: /client/i })` не находит элемент → 10s timeout.

**Нельзя** менять stage Acme Corp на FINAL_INTERVIEW — другие тесты (строки 155, 176, 179...)
явно проверяют, что Acme Corp находится в HR_SCREEN и имеет кнопку "English →".

### Фикс (в `apps/e2e/tests/fixtures.ts` + `apps/e2e/tests/interviews.spec.ts`):

**Шаг 1:** Добавить новый интервью в `INTERVIEWS` массив в `apps/e2e/tests/fixtures.ts`
(после существующих трёх записей):

```ts
{
  id: 'interview-4-id',
  seniorId: USERS.senior.id,
  seniorName: USERS.senior.displayName,
  hrId: USERS.hr.id,
  hrName: USERS.hr.displayName,
  companyName: 'Final Stage Corp',
  vacancyUrl: null,
  callUrl: null,
  stage: 'FINAL_INTERVIEW',
  position: 0,
  notesDomain: null,
  notesTechStack: null,
  notesTeamSize: null,
  notesBenefits: null,
  notesPaymentType: null,
  notesSalaryReview: null,
  notesGeneral: null,
  createdAt: '2024-03-01T00:00:00.000Z',
  updatedAt: '2024-03-01T00:00:00.000Z',
},
```

**Шаг 2:** В `apps/e2e/tests/interviews.spec.ts`, строка 323, заменить:
```ts
// Было:
await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
// Стало:
await page.getByRole('button').filter({ hasText: 'Final Stage Corp' }).first().click({ force: true })
```

### Почему это правильно:

- "Final Stage Corp" находится в FINAL_INTERVIEW
- Следующий stage = CLIENT_INTERVIEW → label = 'Client'
- Кнопка "Client →" появится в sheet
- `/client/i` найдёт её → тест пройдёт

---

## Итог

Только 2 файла: `apps/e2e/tests/fixtures.ts` + `apps/e2e/tests/interviews.spec.ts`.
Запушить одним коммитом прямо в `main`.
