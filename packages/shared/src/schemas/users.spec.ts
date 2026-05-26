import { describe, expect, it } from 'vitest'
import { updateProfileSchema, adminUpdateUserSchema } from './users'

/**
 * Avatar storage now lives in the documents table; the profile schemas accept
 * a `avatarDocumentId` UUID FK and an `avatarUrl` (Google / dicebear fallback)
 * but no longer the legacy `avatarOverride` base64 column (dropped in 0013).
 *
 * Tests here pin the surface so a refactor can't silently bring back the
 * inline-base64 XSS surface this avatar field used to host before PHASE 6.
 */
describe('avatarDocumentId validation', () => {
  // Valid v4-style UUID (third group starts with 4, fourth with 8/9/a/b).
  const validUuid = '123e4567-e89b-42d3-a456-426614174000'

  it('accepts a valid UUID in updateProfileSchema', () => {
    expect(updateProfileSchema.safeParse({ avatarDocumentId: validUuid }).success).toBe(true)
  })

  it('accepts a valid UUID in adminUpdateUserSchema', () => {
    expect(adminUpdateUserSchema.safeParse({ avatarDocumentId: validUuid }).success).toBe(true)
  })

  it('accepts null (clears the custom avatar)', () => {
    expect(updateProfileSchema.safeParse({ avatarDocumentId: null }).success).toBe(true)
    expect(adminUpdateUserSchema.safeParse({ avatarDocumentId: null }).success).toBe(true)
  })

  it('rejects non-UUID strings (no more base64 / data: URLs)', () => {
    expect(updateProfileSchema.safeParse({ avatarDocumentId: 'data:image/png;base64,AAAA' }).success).toBe(false)
    expect(updateProfileSchema.safeParse({ avatarDocumentId: 'https://example.com/x.png' }).success).toBe(false)
    expect(updateProfileSchema.safeParse({ avatarDocumentId: 'not-a-uuid' }).success).toBe(false)
  })
})
