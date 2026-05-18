# Fix: 8 оставшихся E2E тестов — финальный раунд разблокировки main

## Приоритет: КРИТИЧЕСКИЙ

Issue #12 `e2e-broken` блокирует весь AI Review pipeline.
Предыдущие раунды сократили количество с 33 до 8. Все 8 разобраны ниже с точными патчами.

## Как доставить

**Пушить напрямую в `main`** — это CI fix, разрешено согласно CLAUDE-devops.md.
НЕ создавать PR.

После push → CI запустит E2E → если все green → issue #12 закроется автоматически.

## Предыдущий failing run

https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/actions/runs/26012372926

---

## ГРУППА 1: `tests/interviews.spec.ts` — 2 теста

### 1а. Строка 321: "clicking Client → sends move request with CLIENT_INTERVIEW stage"

**Причина:** После открытия карточки (click { force: true }) открывается Sheet с анимацией.
Кнопка `/client/i` внутри Sheet анимируется, Playwright считает элемент "not stable" и таймаут при обычном `.click()`.

**Фикс (в `apps/e2e/tests/interviews.spec.ts`, строка ~330):**
```ts
// Было:
await page.getByRole('button', { name: /client/i }).click()
// Стало:
await page.getByRole('button', { name: /client/i }).click({ force: true })
```

### 1б. Строка 335: "CLIENT_INTERVIEW is in correct position in stage flow"

**Причина:** `page.locator('[data-stage]')` — атрибут `data-stage` не существует в KanbanColumn.
KanbanColumn рендерит `{STAGE_LABELS[stage]}` как текст внутри `<span>`.

STAGE_LABELS: `FINAL_INTERVIEW → 'Final'`, `CLIENT_INTERVIEW → 'Client'`, `OFFER_RECEIVED → 'Offer'`

**Фикс (в `apps/e2e/tests/interviews.spec.ts`, строки 338-341):**
```ts
// Было:
const stageColumns = page.locator('[data-stage]')
await expect(stageColumns.filter({ hasText: 'Final' }).first()).toBeVisible()
await expect(stageColumns.filter({ hasText: 'Client' }).first()).toBeVisible()
await expect(stageColumns.filter({ hasText: 'Offer' }).first()).toBeVisible()

// Стало:
await expect(page.getByText('Final', { exact: true }).first()).toBeVisible()
await expect(page.getByText('Client', { exact: true }).first()).toBeVisible()
await expect(page.getByText('Offer', { exact: true }).first()).toBeVisible()
```

---

## ГРУППА 2: `tests/navigation.spec.ts` — 2 теста

### 2а. Строка 112: "SENIOR sidebar → Команда stays in CRM"

**Причина:** SENIOR с 1 командой автоматически редиректится с `/crm/team` на `/crm/team/team-1-id`.
После редиректа h1 = "Alpha Team", тест ищет `h1.filter({ hasText: /команд/i })` → не находит.

**Фикс (в `apps/e2e/tests/navigation.spec.ts`, внутри SENIOR describe-блока, строки 111-123):**
Заменить тело `for`-цикла в SENIOR describe:
```ts
test(`sidebar → ${route.label} stays in CRM`, async ({ asSenior: page }) => {
  await page.goto('/crm/dashboard')
  await page.waitForLoadState('networkidle')

  await page.click(`a[href="${route.href}"]`)

  // Handle team redirect for SENIOR (single team → detail page)
  if (route.href === '/crm/team') {
    await page.waitForURL('**/crm/team/**', { timeout: 8_000 })
    await page.waitForLoadState('networkidle')
    await assertStayedInCrm(page, route.href)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 })
  } else {
    await page.waitForURL(`**${route.href}**`, { timeout: 8_000 })
    await page.waitForLoadState('networkidle')
    await assertStayedInCrm(page, route.href)
    await expect(page.locator('h1').filter({ hasText: route.heading }).first()).toBeVisible({ timeout: 10_000 })
  }
})
```

### 2б. Строка 156: "JUNIOR sidebar → Команда stays in CRM"

**Причина:** `page.getByRole('heading')` без `.first()` — на странице детали команды несколько
заголовков (h1 "Alpha Team" + несколько CardTitle h3). Playwright strict mode: "resolved to multiple elements".

**Фикс (в `apps/e2e/tests/navigation.spec.ts`, строка 169):**
```ts
// Было:
await expect(page.getByRole('heading')).toBeVisible({ timeout: 10_000 })
// Стало:
await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 10_000 })
```

---

## ГРУППА 3: `tests/team.spec.ts` — 4 теста

### 3а. Строка 201: "renders team detail page with all sections"

**Причина:** `getByText('Статистика')` находит 2 элемента:
1. Пункт nav sidebar (только для ADMIN)
2. `<CardTitle>Статистика</CardTitle>` на детальной странице

**Фикс (строка ~215):**
```ts
// Было:
await expect(page.getByText('Статистика')).toBeVisible()
// Стало:
await expect(page.getByText('Статистика').first()).toBeVisible()
```

### 3б. Строка 220: "shows members grouped by role"

**Причина:** `getByText('Синьор')` находит Badge в секции участников И Span в боковой статистике.
Аналогично 'HR' и 'Бухгалтер'.

**Фикс (строки ~224-226):**
```ts
// Было:
await expect(page.getByText('Синьор')).toBeVisible()
await expect(page.getByText('HR')).toBeVisible()
await expect(page.getByText('Бухгалтер')).toBeVisible()
// Стало:
await expect(page.getByText('Синьор').first()).toBeVisible()
await expect(page.getByText('HR').first()).toBeVisible()
await expect(page.getByText('Бухгалтер').first()).toBeVisible()
```

### 3в. Строка 350: "JUNIOR sees all team members (read-only access)"

**Причина:** Та же проблема — несколько элементов для 'HR', 'Синьор', 'Бухгалтер'.

**Фикс (строки ~358-360):**
```ts
// Было:
await expect(page.getByText('HR')).toBeVisible()
await expect(page.getByText('Синьор')).toBeVisible()
await expect(page.getByText('Бухгалтер')).toBeVisible()
// Стало:
await expect(page.getByText('HR').first()).toBeVisible()
await expect(page.getByText('Синьор').first()).toBeVisible()
await expect(page.getByText('Бухгалтер').first()).toBeVisible()
```

### 3г. Строка 373: "team cards are clickable and navigate to detail page"

**Причина:** Overlay link (`absolute inset-0 z-10`) внутри `motion.div` с анимацией opacity.
Playwright блокируется на actionability check. `{ force: true }` обходит это.

**Фикс (строка ~377):**
```ts
// Было:
await page.locator('a[href^="/crm/team/"]').first().click()
// Стало:
await page.locator('a[href^="/crm/team/"]').first().click({ force: true })
```

---

## Итог

Все 8 изменений — исключительно в спек-файлах (`apps/e2e/tests/`). Производственный код менять не нужно.
Запушить одним коммитом прямо в `main`.
