---
name: playwright-patterns
description: When AutoTest или Coder пишет Playwright E2E / flow тесты для CRM (apps/e2e). Содержит CRM-specific cookbook поверх ECC playwright knowledge: strict-mode resolution, radix-radio async submit, retries policy, testid конвенции, screenshot hygiene. Использовать перед каждым новым spec.ts файлом и при diagnosis flaky тестов.
---

# Playwright Patterns (CRM)

Custom cookbook поверх ECC playwright slot. CRM использует Playwright @1.40+, Radix UI, mock-based fixtures (`apps/e2e/tests/fixtures/`). Уроки лифтнуты из `docs/agents/memory/autotest/lessons.md` + `coder/lessons.md` (2026-05-19 — 2026-06-02).

## When to invoke

- Перед написанием нового `.spec.ts` в `apps/e2e/tests/`
- Перед редактированием существующего spec'а если меняются UI тексты / role labels
- При исследовании flaky теста (CI fail, локально passes)
- При работе с Radix компонентами (Dialog, RadioGroup, Select, DropdownMenu)
- При исправлении strict-mode locator errors
- Перед добавлением `data-testid` к новому компоненту (см. naming convention ниже)

## Patterns

### 1. Strict-mode + `getByText` — конфликт с описательными текстами

**Правило:** `getByText('...')` без `exact: true` падает strict mode, если новый описательный текст совпадает substring'ом с существующим `<label>`. Real incident: добавление подсказки «Новая команда синьора с выбранным HR и бухгалтером» в RadioGroup сломало `users.spec.ts` потому что existing `<label>Бухгалтер</label>` matched.

**Decision rule:**

- Перед добавлением role-слов («HR», «Бухгалтер», «Синьор», «Адмін», «Джун») в новый помощник-текст — `grep -rn "getByText" apps/e2e/tests/*.spec.ts` для проверки конфликтов.
- Если конфликт неизбежен — использовать `getByText('...', { exact: true })` или `getByRole('...', { name: '...' })`.
- В spec'е тоже предпочесть `getByRole('button', { name: 'X' })` вместо `getByText('X')` для UI elements.

### 2. Radix RadioGroupItem + async submit — flaky POST verification

**Правило:** В mock-based E2E submit-кнопка диалога с Zod `safeParse` часто молча падает в `toast.error` из-за гонки между Radix `RadioGroupItem` click и form.state update. POST-body тест `JOIN_DROP_TEAM` был flaky на CI.

**Decision rule:**

- Вместо `waitForRequest(POST)` тестировать UI contract: «при выборе radio surface drop-team picker», «toast.success появился».
- Полная shape POST body — лежит на Vitest unit-тестах (Coder zone), не E2E.
- Если действительно нужен POST body в E2E:
  1. Fill ВСЕ поля до радио.
  2. Click `label` (не `radio.click()`).
  3. НЕ ставить `waitForRequest` ДО submit-click — race condition.

### 3. CI retries policy

**Правило:** На GHA — `retries: 2` под `CI=1`. Локально retries=0 (видим flake сразу).

**Источник:** `apps/e2e/playwright.config.ts` секция `retries: process.env.CI ? 2 : 0`. Real incident 2026-05-30: 4 теста (team-redirect, team-empty, finance-flow, tech-autocomplete) на дефолтной локальной матрице падали из-за parallel race с TEAMS fixtures расширениями. Под CI=1 retry все прошли. Для локального dev — флак допустим, GHA shard её закроет.

### 4. data-testid convention

**Правило:** `data-testid` ОБЯЗАТЕЛЕН для:

- back-button / dialog-close / cancel-button (Playwright strict mode падает на дублях с sidebar/content nav-элементами)
- submit / confirm buttons в диалогах
- form fields (особенно autocomplete / combobox)

**Naming:**

- `kebab-case` всегда.
- Префикс компонента: `team-form-submit`, `archive-confirm-input`.
- Не использовать role-слова в `data-testid` если они уже в UI text (избегать конфликта с getByText).

### 5. Двойные archive-confirm dialogs

**Правило:** В CRM есть ДВА разных компонента архивирования:

| Компонент                                 | testids                                                                 | Использование        |
| ----------------------------------------- | ----------------------------------------------------------------------- | -------------------- |
| `components/users/ArchiveConfirmDialog`   | `archive-confirm-dialog`                                                | Архив user'а         |
| `components/archive/ArchiveConfirmDialog` | `archive-confirm-input` + `archive-confirm-submit` (БЕЗ wrapper testid) | Архив team / project |

При написании spec'а — определи какой именно компонент рендерится. НЕ копируй testids между ними.

### 6. Screenshot hygiene

**Правило:** Debug screenshots — В `/tmp/autotest-<runid>/`, **НЕ** в `apps/e2e/`. Чужие commit'ы потом подметают их через `git add .`.

**Implementation:**

```ts
const runId = process.env.GITHUB_RUN_ID || Date.now()
const debugDir = `/tmp/autotest-${runId}`
await page.screenshot({ path: `${debugDir}/team-form.png` })
```

### 7. Atomicity UI text + spec

**Правило:** При смене UI текстов — обновить selector'ы в `spec.ts` В ТОМ ЖЕ commit'е что и UI. Расхождение → flaky E2E на main.

**Mechanism:** Coder в задаче «изменить UI text» включает 2 файла в diff (component.tsx + spec.ts) или явно отмечает в task что spec тоже обновлён.

### 8. Interaction tests для autocomplete / combobox

**Правило (для Vitest, но релевантно как контекст):** Interaction tests обязательны для autocomplete/combobox/dropdown — `Tab + ArrowDown` коммит highlighted option должен быть unit-тестом, не только Enter. Smoke-test «Enter добавляет» пропустил Tab-баг в TechAutocomplete.

**E2E side:** Не полагаться на «type X → submit». Проверять что выбор happens через keyboard navigation (`page.keyboard.press('ArrowDown')` + `Enter`) + через mouse click — оба пути.

### 9. userEvent setup для unit testing (cross-reference)

**Правило (Vitest+RTL):** `userEvent.setup({ delay: null })` стабилизирует тесты — иначе race conditions с `act()` warnings.

Применять во всех Vitest interaction тестах (по умолчанию).

## Anti-patterns

| ❌ Don't                                                  | ✅ Do                                                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `page.getByText('Бухгалтер')` для button click            | `page.getByRole('button', { name: 'Бухгалтер' })`                                        |
| `radio.click()` + immediate `waitForRequest(POST)`        | Click label → wait for UI contract (toast/visible field) → assertions без waitForRequest |
| Debug screenshots в `apps/e2e/debug-*.png` в репо         | `/tmp/autotest-<runid>/*.png` (git-ignored)                                              |
| UI text change без spec.ts update в том же commit         | Atomic commit: component.tsx + spec.ts вместе                                            |
| `it.skip('...flaky...')` для пропуска нестабильного теста | Изолировать root cause (race / timing / async) + добавить retry в config                 |
| `--no-verify` чтобы пропихнуть push с failing E2E         | Запустить тест в isolation, добавить `it.retry(2)` локально, push без --no-verify        |

## References

- Source lessons (lifted 2026-06-03):
  - `docs/agents/memory/autotest/lessons.md` (2026-05-18 — 2026-05-30)
  - `docs/agents/memory/coder/lessons.md` (2026-05-19, 2026-05-21, 2026-05-30, 2026-06-02 строки про testids / strict-mode / no-verify ban)
- Project config: `apps/e2e/playwright.config.ts`, `apps/e2e/tests/fixtures/`
- Related agent docs:
  - `docs/agents/autotest.md` секция "Anti-patterns" (Phase 4 будет вычищена в пользу этого skill)
  - `docs/agents/coder.md` §6.1 (testids checklist по типам компонентов)
- Related skills:
  - `dev-flow-resilience` (для E2E + watchdog interaction)
  - `superpowers:test-driven-development`, `superpowers:systematic-debugging`
