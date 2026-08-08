import { test } from './fixtures'

// Debug-only file — оригинальный скрипт писал /tmp файл для ручной диагностики
// диалога редактирования. Не является полноценным тестом, заменён реальными
// тестами в users.spec.ts.
// Same as debug.spec.ts: an intentionally-empty, permanently-skipped tombstone
// (its real coverage now lives in users.spec.ts, per the note above), so there
// is no assertion to restore. Deletion proposed separately. (task-lint-teeth)
// eslint-disable-next-line playwright/expect-expect
test.skip('TODO: debug users edit dialog — manual diagnostic script, not a real test', async ({
  asAdmin: _page,
}) => {
  // Intentionally empty
})
