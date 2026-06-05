import { ConfigService } from '@nestjs/config'
import { describe, expect, it, vi } from 'vitest'
import { jwtPayloadSchema } from '@crm/shared'
import { AuthService } from './auth.service'

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string) =>
      ({
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_CALLBACK_URL: 'http://localhost/callback',
        ...overrides,
      })[key],
  } as unknown as ConfigService
}

// ---------------------------------------------------------------------------
// AC8: JWT payload must not contain legalFullName (MED #2 security fix).
// Verifies that jwtPayloadSchema only includes {id, email, role} — any
// attempt to include legalFullName is stripped by Zod strict parsing.
// ---------------------------------------------------------------------------

describe('jwtPayloadSchema (MED #2 — minimal JWT payload)', () => {
  const validInput = {
    id: '11111111-2222-3333-4444-555566667777',
    email: 'user@example.com',
    role: 'SENIOR' as const,
  }

  it('accepts minimal {id, email, role} payload', () => {
    const result = jwtPayloadSchema.parse(validInput)
    expect(result.id).toBe(validInput.id)
    expect(result.email).toBe(validInput.email)
    expect(result.role).toBe('SENIOR')
  })

  it('does NOT include legalFullName in parsed output', () => {
    // Even if legalFullName is passed (e.g. old token compat), it must be
    // stripped — jwtPayloadSchema has no legalFullName field.
    const result = jwtPayloadSchema.parse({
      ...validInput,
      legalFullName: 'Іванов Іван Іванович',
    })
    expect(Object.keys(result)).not.toContain('legalFullName')
  })

  it('does NOT include displayName, avatarUrl, seniorSharePercent in parsed output', () => {
    // Full SessionUser fields must not bleed into JWT payload.
    const result = jwtPayloadSchema.parse({
      ...validInput,
      displayName: 'Ivan',
      avatarUrl: 'https://example.com/avatar.png',
      seniorSharePercent: 26,
    })
    expect(Object.keys(result)).not.toContain('displayName')
    expect(Object.keys(result)).not.toContain('avatarUrl')
    expect(Object.keys(result)).not.toContain('seniorSharePercent')
  })

  it('rejects invalid UUID for id', () => {
    expect(() => jwtPayloadSchema.parse({ ...validInput, id: 'not-a-uuid' })).toThrow()
  })

  it('rejects unknown role', () => {
    expect(() => jwtPayloadSchema.parse({ ...validInput, role: 'SUPERUSER' })).toThrow()
  })
})

describe('AuthService', () => {
  describe('buildGoogleAuthUrl', () => {
    it('returns a valid Google OAuth URL', () => {
      const service = new AuthService(makeConfig())
      const url = service.buildGoogleAuthUrl('state-xyz')
      expect(url).toContain('accounts.google.com/o/oauth2/v2/auth')
      expect(url).toContain('client_id=client-id')
      expect(url).toContain('state=state-xyz')
      expect(url).toContain('scope=openid+email+profile')
    })

    it('embeds the redirect_uri from config', () => {
      const service = new AuthService(makeConfig({ GOOGLE_CALLBACK_URL: 'https://example.com/cb' }))
      const url = service.buildGoogleAuthUrl('s')
      expect(url).toContain(encodeURIComponent('https://example.com/cb'))
    })
  })

  describe('verifyGoogleIdToken', () => {
    it('throws when Google tokeninfo request fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
      const service = new AuthService(makeConfig())
      await expect(service.verifyGoogleIdToken('bad-token')).rejects.toThrow(
        'Google tokeninfo request failed',
      )
      vi.unstubAllGlobals()
    })

    it('throws on audience mismatch', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            sub: 'sub',
            email: 'a@b.com',
            name: 'A',
            picture: 'p',
            aud: 'wrong-client',
          }),
        }),
      )
      const service = new AuthService(makeConfig())
      await expect(service.verifyGoogleIdToken('token')).rejects.toThrow('Token audience mismatch')
      vi.unstubAllGlobals()
    })

    it('returns user info on valid token', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            sub: 'google-sub',
            email: 'user@example.com',
            name: 'Test User',
            picture: 'https://avatar.url',
            aud: 'client-id',
          }),
        }),
      )
      const service = new AuthService(makeConfig())
      const result = await service.verifyGoogleIdToken('valid-token')
      expect(result.email).toBe('user@example.com')
      expect(result.sub).toBe('google-sub')
      vi.unstubAllGlobals()
    })
  })
})
