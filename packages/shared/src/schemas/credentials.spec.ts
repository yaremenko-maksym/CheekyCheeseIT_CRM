import { describe, expect, it } from 'vitest'
import { createCredentialSchema, updateCredentialSchema } from './credentials'

// task-i18n-stage4-task5: no spec file existed for this schema before this
// task — added alongside the zod.CREDENTIAL_LABEL_REQUIRED /
// zod.CREDENTIAL_PASSWORD_REQUIRED code migration so the mutation gate has
// something to execute on these two branches.

describe('createCredentialSchema', () => {
  const valid = { label: 'Prod DB', password: 'hunter2' }

  it('accepts a minimal valid payload', () => {
    expect(() => createCredentialSchema.parse(valid)).not.toThrow()
  })

  it('rejects an empty label, with the CREDENTIAL_LABEL_REQUIRED code', () => {
    const result = createCredentialSchema.safeParse({ ...valid, label: '' })
    expect(result.success).toBe(false)
    expect(result.success ? undefined : result.error.issues[0]?.message).toBe(
      'zod.CREDENTIAL_LABEL_REQUIRED',
    )
  })

  it('rejects a whitespace-only label (trimmed before the min-length check)', () => {
    expect(() => createCredentialSchema.parse({ ...valid, label: '   ' })).toThrow(
      'zod.CREDENTIAL_LABEL_REQUIRED',
    )
  })

  it('rejects an empty password, with the CREDENTIAL_PASSWORD_REQUIRED code', () => {
    const result = createCredentialSchema.safeParse({ ...valid, password: '' })
    expect(result.success).toBe(false)
    expect(result.success ? undefined : result.error.issues[0]?.message).toBe(
      'zod.CREDENTIAL_PASSWORD_REQUIRED',
    )
  })

  it('accepts optional login/url/notes as absent', () => {
    expect(() => createCredentialSchema.parse(valid)).not.toThrow()
  })
})

describe('updateCredentialSchema', () => {
  it('accepts an empty patch (all fields optional)', () => {
    expect(() => updateCredentialSchema.parse({})).not.toThrow()
  })

  it('accepts an empty password (means "do not change")', () => {
    expect(() => updateCredentialSchema.parse({ password: '' })).not.toThrow()
  })

  it('rejects an explicit empty label, with the CREDENTIAL_LABEL_REQUIRED code', () => {
    const result = updateCredentialSchema.safeParse({ label: '' })
    expect(result.success).toBe(false)
    expect(result.success ? undefined : result.error.issues[0]?.message).toBe(
      'zod.CREDENTIAL_LABEL_REQUIRED',
    )
  })
})
