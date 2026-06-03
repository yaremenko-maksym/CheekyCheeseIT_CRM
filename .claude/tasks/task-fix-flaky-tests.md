# task-fix-flaky-tests

## Агент: coder

## Приоритет: high

## Ветка: fix/flaky-tests

## Контекст

Unit-тесты в `apps/web` имеют flaky тесты, которые периодически падают в CI из-за timeout-ов и нестабильного async-поведения. Задача — найти все нестабильные тесты и сделать тест-сьют максимально стабильным.

## Известная проблема

**`apps/web/app/components/ui/__tests__/phone-input.test.tsx`**

- Тест: `PhoneInput component > can switch countries multiple times and type after each`
- Симптом: `Error: Test timed out in 15000ms` — срабатывает нестабильно (локально падает, но на main проходит за 3.8 сек)
- Причина: вероятно накопленный async state при multiple country switches + typing, медленный jsdom
- Фикс: изолировать каждый switch/type шаг через `await userEvent.setup()` с правильным `delay: null`, использовать `waitFor` с реалистичным timeout, возможно разбить тест на более мелкие шаги или увеличить vitest timeout для этого конкретного теста через `{ timeout: 30000 }`

## Что нужно сделать

1. **Аудит всех тестовых файлов** в `apps/web/app/**/__tests__/` и `apps/api/src/**/*.spec.ts`:
   - Найти тесты без явного timeout (полагаются на дефолт 5000ms или 15000ms) с async операциями
   - Найти тесты с `userEvent` без `userEvent.setup()` (прямые вызовы устарели и медленны)
   - Найти тесты использующие `setTimeout`/`sleep` вместо `waitFor`

2. **Исправить `phone-input.test.tsx`**:
   - Инициализировать `userEvent.setup({ delay: null })` один раз в `beforeEach` или в начале теста
   - Для теста с multiple country switches: добавить явный timeout `{ timeout: 30000 }` или разбить на подтесты
   - Убедиться что все `fireEvent`/`userEvent` вызовы awaited корректно

3. **Исправить все найденные нестабильные паттерны**:
   - Заменить `userEvent.click(...)` → `await user.click(...)` (setup pattern)
   - Добавить `await screen.findBy...` вместо `screen.getBy...` где нужно ждать async обновления
   - Убрать `setTimeout`/magic sleeps, заменить на `waitFor`

4. **Проверить**: после правок запустить `pnpm --filter @crm/web test` минимум 2 раза подряд и убедиться что все тесты проходят стабильно

## Запрещено трогать

- Сами компоненты (только тестовые файлы)
- E2E тесты в `apps/e2e/` (за них AutoTest)
- API-файлы если там нет unit-тестов с проблемами

## Acceptance criteria

- [ ] `pnpm --filter @crm/web test` проходит 100% стабильно (проверить дважды)
- [ ] `pnpm --filter @crm/api test` проходит (если есть)
- [ ] Нет тестов полагающихся на магические sleep/setTimeout
- [ ] Все `userEvent` вызовы используют setup-паттерн
- [ ] Конкретно: `PhoneInput > can switch countries multiple times` проходит стабильно
