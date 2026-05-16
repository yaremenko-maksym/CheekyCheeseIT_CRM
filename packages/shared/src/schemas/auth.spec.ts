import { describe, expect, it } from 'vitest'
import { googleCallbackSchema, sessionUserSchema } from './auth'

describe('sessionUserSchema', () => {
  const valid = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    email: 'user@example.com',
    displayName: 'Test User',
    avatar: null,
    role: 'ADMIN' as const,
  }

  it('accepts a valid session user', () => {
    expect(() => sessionUserSchema.parse(valid)).not.toThrow()
  })

  it('rejects unknown role', () => {
    expect(() => sessionUserSchema.parse({ ...valid, role: 'SUPERADMIN' })).toThrow()
  })

  it('rejects invalid UUID', () => {
    expect(() => sessionUserSchema.parse({ ...valid, id: 'not-a-uuid' })).toThrow()
  })

  it('rejects invalid email', () => {
    expect(() => sessionUserSchema.parse({ ...valid, email: 'not-an-email' })).toThrow()
  })

  it('accepts null avatar', () => {
    const result = sessionUserSchema.parse({ ...valid, avatar: null })
    expect(result.avatar).toBeNull()
  })

  it('accepts url avatar', () => {
    const result = sessionUserSchema.parse({ ...valid, avatar: 'https://example.com/avatar.png' })
    expect(result.avatar).toBe('https://example.com/avatar.png')
  })

  it('accepts all valid roles', () => {
    const roles = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'] as const
    for (const role of roles) {
      expect(() => sessionUserSchema.parse({ ...valid, role })).not.toThrow()
    }
  })
})

describe('googleCallbackSchema', () => {
  const valid = {
    email: 'user@google.com',
    googleId: 'google-sub-123',
    displayName: 'Google User',
    avatar: 'https://lh3.googleusercontent.com/avatar',
  }

  it('accepts a valid Google callback', () => {
    expect(() => googleCallbackSchema.parse(valid)).not.toThrow()
  })

  it('avatar is optional', () => {
    const { avatar: _, ...withoutAvatar } = valid
    expect(() => googleCallbackSchema.parse(withoutAvatar)).not.toThrow()
  })

  it('rejects invalid email', () => {
    expect(() => googleCallbackSchema.parse({ ...valid, email: 'bad' })).toThrow()
  })
})
