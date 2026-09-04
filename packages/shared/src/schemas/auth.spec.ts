import { describe, expect, it } from 'vitest'
import {
  googleCallbackSchema,
  impersonateSchema,
  jwtPayloadSchema,
  sessionUserSchema,
} from './auth'

describe('sessionUserSchema', () => {
  const valid = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    email: 'user@example.com',
    displayName: 'Test User',
    avatarUrl: null,
    role: 'ADMIN' as const,
    seniorSharePercent: 26,
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

  it('accepts null avatarUrl', () => {
    const result = sessionUserSchema.parse({ ...valid, avatarUrl: null })
    expect(result.avatarUrl).toBeNull()
  })

  it('accepts url avatarUrl', () => {
    const result = sessionUserSchema.parse({
      ...valid,
      avatarUrl: 'https://example.com/avatar.png',
    })
    expect(result.avatarUrl).toBe('https://example.com/avatar.png')
  })

  it('accepts avatarDocumentId UUID', () => {
    const result = sessionUserSchema.parse({
      ...valid,
      avatarDocumentId: '11111111-2222-4333-8444-555555555555',
    })
    expect(result.avatarDocumentId).toBe('11111111-2222-4333-8444-555555555555')
  })

  it('accepts all valid roles', () => {
    const roles = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'] as const
    for (const role of roles) {
      expect(() => sessionUserSchema.parse({ ...valid, role })).not.toThrow()
    }
  })
})

describe('jwtPayloadSchema — impersonatorId', () => {
  const base = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    email: 'admin@example.com',
    role: 'ADMIN' as const,
  }

  it('accepts payload without impersonatorId (normal session)', () => {
    expect(() => jwtPayloadSchema.parse(base)).not.toThrow()
    const result = jwtPayloadSchema.parse(base)
    expect(result.impersonatorId).toBeUndefined()
  })

  it('accepts payload with valid impersonatorId (impersonation session)', () => {
    const withImpersonator = {
      ...base,
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      email: 'target@example.com',
      role: 'SENIOR' as const,
      impersonatorId: '123e4567-e89b-12d3-a456-426614174000',
    }
    const result = jwtPayloadSchema.parse(withImpersonator)
    expect(result.impersonatorId).toBe('123e4567-e89b-12d3-a456-426614174000')
  })

  it('rejects impersonatorId that is not a UUID', () => {
    expect(() => jwtPayloadSchema.parse({ ...base, impersonatorId: 'not-a-uuid' })).toThrow()
  })
})

// CR-M-2 (security-review PR #623 closing round): `userEmailId` (SR-H-6) and
// `impersonatorUserEmailId` (SR-M-13) both carry `.uuid()` in the schema
// (see jwtPayloadSchema's own doc for why — a per-`user_emails`-row
// revocation check keyed on this id) but neither had a test pinning that
// bound the way `impersonatorId` above already does — a mutant that widened
// either back to a bare `z.string()` would have gone uncaught by all four
// unit spec files that import `jwtPayloadSchema`
// (auth.spec.ts/auth.service.spec.ts/jwt.guard.spec.ts/auth.controller.spec.ts).
describe('jwtPayloadSchema — userEmailId / impersonatorUserEmailId (SR-H-6 / SR-M-13)', () => {
  const base = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    email: 'admin@example.com',
    role: 'ADMIN' as const,
  }

  it('accepts payload without userEmailId / impersonatorUserEmailId (both optional)', () => {
    const result = jwtPayloadSchema.parse(base)
    expect(result.userEmailId).toBeUndefined()
    expect(result.impersonatorUserEmailId).toBeUndefined()
  })

  it('accepts payload with a valid userEmailId', () => {
    const withRow = { ...base, userEmailId: '11111111-2222-4333-8444-555555555555' }
    const result = jwtPayloadSchema.parse(withRow)
    expect(result.userEmailId).toBe('11111111-2222-4333-8444-555555555555')
  })

  it('rejects userEmailId that is not a UUID', () => {
    expect(() => jwtPayloadSchema.parse({ ...base, userEmailId: 'not-a-uuid' })).toThrow()
  })

  it('accepts payload with a valid impersonatorUserEmailId', () => {
    const withRow = { ...base, impersonatorUserEmailId: '11111111-2222-4333-8444-555555555555' }
    const result = jwtPayloadSchema.parse(withRow)
    expect(result.impersonatorUserEmailId).toBe('11111111-2222-4333-8444-555555555555')
  })

  it('rejects impersonatorUserEmailId that is not a UUID', () => {
    expect(() =>
      jwtPayloadSchema.parse({ ...base, impersonatorUserEmailId: 'not-a-uuid' }),
    ).toThrow()
  })
})

describe('impersonateSchema', () => {
  it('accepts a valid UUID userId', () => {
    const result = impersonateSchema.parse({ userId: '123e4567-e89b-12d3-a456-426614174000' })
    expect(result.userId).toBe('123e4567-e89b-12d3-a456-426614174000')
  })

  it('rejects non-UUID userId', () => {
    expect(() => impersonateSchema.parse({ userId: 'not-a-uuid' })).toThrow()
  })

  it('rejects missing userId', () => {
    expect(() => impersonateSchema.parse({})).toThrow()
  })
})

describe('sessionUserSchema — impersonating field', () => {
  const base = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    email: 'user@example.com',
    displayName: 'Test User',
    avatarUrl: null,
    role: 'SENIOR' as const,
    seniorSharePercent: 26,
  }

  it('accepts session without impersonating field (optional)', () => {
    const result = sessionUserSchema.parse(base)
    expect(result.impersonating).toBeUndefined()
  })

  it('accepts impersonating:true (admin acting as another user)', () => {
    const result = sessionUserSchema.parse({ ...base, impersonating: true })
    expect(result.impersonating).toBe(true)
  })

  it('accepts impersonating:false (normal session explicit)', () => {
    const result = sessionUserSchema.parse({ ...base, impersonating: false })
    expect(result.impersonating).toBe(false)
  })
})

describe('googleCallbackSchema', () => {
  const valid = {
    email: 'user@google.com',
    googleId: 'google-sub-123',
    displayName: 'Google User',
    avatarUrl: 'https://lh3.googleusercontent.com/avatar',
  }

  it('accepts a valid Google callback', () => {
    expect(() => googleCallbackSchema.parse(valid)).not.toThrow()
  })

  it('avatarUrl is optional', () => {
    const { avatarUrl: _, ...withoutAvatar } = valid
    expect(() => googleCallbackSchema.parse(withoutAvatar)).not.toThrow()
  })

  it('rejects invalid email', () => {
    expect(() => googleCallbackSchema.parse({ ...valid, email: 'bad' })).toThrow()
  })
})
