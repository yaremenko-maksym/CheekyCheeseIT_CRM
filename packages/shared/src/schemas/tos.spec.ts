import { describe, expect, it } from 'vitest'
import { createTosVersionSchema } from './tos'

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
