import { test } from '@playwright/test'

// Debug-only file — оригинальный скрипт писал в /tmp файл для ручной диагностики.
// Не является полноценным тестом и не должен запускаться в CI.

// `playwright/expect-expect` correctly reports the body below as having no
// assertion — it is an intentionally-empty, permanently-skipped placeholder
// left where a manual diagnostic script used to live, not a test that lost its
// assertions. Disabled here rather than repaired because there is nothing to
// assert: the block is a tombstone. Deleting the file outright is the better
// end state and is proposed separately — it was left out of the lint task so a
// tooling PR does not quietly remove spec files. (task-lint-teeth)
// eslint-disable-next-line playwright/expect-expect
test.skip('TODO: debug interviews render — manual diagnostic script, not a real test', async () => {
  // Intentionally empty
})
