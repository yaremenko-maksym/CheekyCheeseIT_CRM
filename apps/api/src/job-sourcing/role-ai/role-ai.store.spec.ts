import { describe, expect, it } from 'vitest'
import { keyHash } from './role-ai.store'

describe('keyHash', () => {
  it('is the description sha, or "" for a vacancy without a description', () => {
    expect(keyHash({ descriptionSha256: 'ab12' })).toBe('ab12')
    expect(keyHash({ descriptionSha256: null })).toBe('')
  })
})
