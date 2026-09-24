import { describe, expect, it } from 'vitest'
import { TOS_ACCEPT_IMPERSONATION_MESSAGE, createTosVersionSchema } from './tos'

// task-i18n-stage4-task5: no test existed for createTosVersionSchema before
// this task. Reuses `zod.DOCUMENT_BODY_REQUIRED` — same code as
// contracts.ts's two bodyMarkdown fields and employee-contracts.ts's (same
// "must not be empty" rule, previously three near-identical Russian literals
// differing only in "контракта"/"ToS").
describe('createTosVersionSchema.bodyMarkdown', () => {
  it('accepts a non-empty body', () => {
    expect(() => createTosVersionSchema.parse({ bodyMarkdown: '# Terms of Service' })).not.toThrow()
  })

  it('rejects an empty body, with the DOCUMENT_BODY_REQUIRED code', () => {
    const result = createTosVersionSchema.safeParse({ bodyMarkdown: '' })
    expect(result.success).toBe(false)
    expect(result.success ? undefined : result.error.issues[0]?.message).toBe(
      'zod.DOCUMENT_BODY_REQUIRED',
    )
  })
})

/**
 * Fix-раунд 3 (task-680, SR-M-3). Литерал — SSOT для серверного 403 на
 * `POST /tos/accept` и клиентского пояснения под кнопкой принятия ToS
 * (`AcceptTosStep.tsx`). Мутационный гейт в `packages/shared` видит ТОЛЬКО
 * тесты этого пакета — ассертация в `apps/api`/`apps/web` на тот же
 * импортированный литерал этот мутант не убивает, потому что три пакета
 * гоняются раздельно (`mutation-gate-runbook.md`, «3-package matrix»).
 */
describe('TOS_ACCEPT_IMPERSONATION_MESSAGE', () => {
  it('точный текст — форма как у отказа по подписи контракта; без точки на конце', () => {
    expect(TOS_ACCEPT_IMPERSONATION_MESSAGE).toBe(
      'Пока вы вошли как другой сотрудник, принять условия использования за него нельзя — это должен сделать он сам',
    )
  })
})
