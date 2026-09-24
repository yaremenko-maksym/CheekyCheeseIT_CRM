import { describe, expect, it } from 'vitest'
import { addLegendEntrySchema, legendSchema, upsertLegendSchema } from './legends'

// task-i18n-stage4-task5: no spec file existed for this schema before this
// task. `legendSchema.fullName` and `upsertLegendSchema.fullName` share one
// code (`zod.FULL_NAME_REQUIRED`, COPY-L-shared-17 — they used to say
// "ФИО"/"Имя" for the same field); `upsertLegendSchema.dateOfBirth` reuses
// `zod.DATE_FORMAT_YYYYMMDD` (task-i18n-stage4-task4) instead of a new code.

const uuid = '123e4567-e89b-12d3-a456-426614174000'

describe('legendSchema.fullName', () => {
  it('rejects an empty fullName, with the FULL_NAME_REQUIRED code', () => {
    const result = legendSchema.safeParse({
      id: uuid,
      projectId: uuid,
      fullName: '',
      dateOfBirth: null,
      address: null,
      presentedRole: null,
      presentedStack: null,
      backstory: null,
      hobbies: null,
      notes: null,
      entries: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(result.success).toBe(false)
    expect(result.success ? undefined : result.error.issues[0]?.message).toBe(
      'zod.FULL_NAME_REQUIRED',
    )
  })
})

describe('upsertLegendSchema', () => {
  const valid = { fullName: 'Іван Іванов' }

  it('accepts a minimal valid payload', () => {
    expect(() => upsertLegendSchema.parse(valid)).not.toThrow()
  })

  it('rejects an empty fullName, with the same FULL_NAME_REQUIRED code as legendSchema', () => {
    const result = upsertLegendSchema.safeParse({ ...valid, fullName: '' })
    expect(result.success).toBe(false)
    expect(result.success ? undefined : result.error.issues[0]?.message).toBe(
      'zod.FULL_NAME_REQUIRED',
    )
  })

  it('accepts a well-formed dateOfBirth', () => {
    expect(() => upsertLegendSchema.parse({ ...valid, dateOfBirth: '1990-01-15' })).not.toThrow()
  })

  it('rejects a malformed dateOfBirth, reusing the DATE_FORMAT_YYYYMMDD code', () => {
    const result = upsertLegendSchema.safeParse({ ...valid, dateOfBirth: '15/01/1990' })
    expect(result.success).toBe(false)
    expect(result.success ? undefined : result.error.issues[0]?.message).toBe(
      'zod.DATE_FORMAT_YYYYMMDD',
    )
  })

  it('accepts a null dateOfBirth', () => {
    expect(() => upsertLegendSchema.parse({ ...valid, dateOfBirth: null })).not.toThrow()
  })
})

describe('addLegendEntrySchema', () => {
  it('accepts a non-empty text', () => {
    expect(() => addLegendEntrySchema.parse({ text: 'Первая встреча с клиентом' })).not.toThrow()
  })

  it('rejects an empty text, with the LEGEND_TEXT_REQUIRED code', () => {
    const result = addLegendEntrySchema.safeParse({ text: '' })
    expect(result.success).toBe(false)
    expect(result.success ? undefined : result.error.issues[0]?.message).toBe(
      'zod.LEGEND_TEXT_REQUIRED',
    )
  })

  it('rejects text over 5000 characters', () => {
    expect(() => addLegendEntrySchema.parse({ text: 'a'.repeat(5001) })).toThrow()
  })
})
