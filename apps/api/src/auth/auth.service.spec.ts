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

/**
 * Replace the service's private OAuth2Client with a stub whose verifyIdToken
 * returns a ticket exposing the given payload. Lets us exercise the
 * email_verified / signature-failure branches without a real Google round-trip.
 */
function stubVerifyIdToken(
  service: AuthService,
  impl: () => { getPayload: () => Record<string, unknown> | undefined },
) {
  const client = { verifyIdToken: vi.fn().mockImplementation(async () => impl()) }
  ;(service as unknown as { oauthClient: typeof client }).oauthClient = client
  return client
}

// ---------------------------------------------------------------------------
// AC8: JWT payload must not contain legalFullName (MED #2 security fix).
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
    const result = jwtPayloadSchema.parse({
      ...validInput,
      legalFullName: 'Іванов Іван Іванович',
    })
    expect(Object.keys(result)).not.toContain('legalFullName')
  })

  it('does NOT include displayName, avatarUrl, seniorSharePercent in parsed output', () => {
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

  // -------------------------------------------------------------------------
  // verifyGoogleIdToken — One-Tap path. Now verifies the token LOCALLY via
  // OAuth2Client.verifyIdToken (signature/iss/aud/exp) AND rejects unverified
  // emails (audit HIGH #1 + LOW #4).
  // -------------------------------------------------------------------------
  describe('verifyGoogleIdToken (audit HIGH #1 + LOW #4)', () => {
    it('throws when verifyIdToken rejects (bad signature / aud / expired)', async () => {
      const service = new AuthService(makeConfig())
      const client = {
        verifyIdToken: vi.fn().mockRejectedValue(new Error('Wrong recipient')),
      }
      ;(service as unknown as { oauthClient: typeof client }).oauthClient = client

      await expect(service.verifyGoogleIdToken('forged-token')).rejects.toThrow(
        'Google ID token verification failed',
      )
      // The audience must be passed to the verifier — local aud enforcement.
      expect(client.verifyIdToken).toHaveBeenCalledWith({
        idToken: 'forged-token',
        audience: 'client-id',
      })
    })

    it('REJECTS a verified-signature token whose email_verified is false (HIGH #1)', async () => {
      const service = new AuthService(makeConfig())
      stubVerifyIdToken(service, () => ({
        getPayload: () => ({
          sub: 'google-sub',
          email: 'user@example.com',
          name: 'Test',
          picture: 'p',
          email_verified: false,
        }),
      }))

      await expect(service.verifyGoogleIdToken('token')).rejects.toThrow(
        'Google account email is not verified',
      )
    })

    it('REJECTS when email_verified is missing entirely (HIGH #1 — fail closed)', async () => {
      const service = new AuthService(makeConfig())
      stubVerifyIdToken(service, () => ({
        getPayload: () => ({
          sub: 'google-sub',
          email: 'user@example.com',
          name: 'Test',
          picture: 'p',
          // no email_verified
        }),
      }))

      await expect(service.verifyGoogleIdToken('token')).rejects.toThrow(
        'Google account email is not verified',
      )
    })

    it('throws when payload is undefined', async () => {
      const service = new AuthService(makeConfig())
      stubVerifyIdToken(service, () => ({ getPayload: () => undefined }))

      await expect(service.verifyGoogleIdToken('token')).rejects.toThrow(
        'Google ID token has no payload',
      )
    })

    it('returns identity on a verified token (email_verified: true)', async () => {
      const service = new AuthService(makeConfig())
      stubVerifyIdToken(service, () => ({
        getPayload: () => ({
          sub: 'google-sub',
          email: 'user@example.com',
          name: 'Test User',
          picture: 'https://avatar.url',
          email_verified: true,
        }),
      }))

      const result = await service.verifyGoogleIdToken('valid-token')
      expect(result.sub).toBe('google-sub')
      expect(result.email).toBe('user@example.com')
      expect(result.name).toBe('Test User')
    })

    it('accepts the string "true" serialisation of email_verified', async () => {
      const service = new AuthService(makeConfig())
      stubVerifyIdToken(service, () => ({
        getPayload: () => ({
          sub: 'google-sub',
          email: 'user@example.com',
          email_verified: 'true',
        }),
      }))

      const result = await service.verifyGoogleIdToken('valid-token')
      expect(result.email).toBe('user@example.com')
    })
  })

  // -------------------------------------------------------------------------
  // getGoogleUserInfo — OAuth2 callback path. Now hits the OIDC userinfo
  // endpoint and rejects unverified emails (audit HIGH #2 defence in depth).
  // -------------------------------------------------------------------------
  describe('getGoogleUserInfo (audit HIGH #2)', () => {
    it('throws when userinfo request fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))
      const service = new AuthService(makeConfig())
      await expect(service.getGoogleUserInfo('bad-access-token')).rejects.toThrow(
        'Google userinfo failed',
      )
      vi.unstubAllGlobals()
    })

    it('REJECTS userinfo with email_verified false (HIGH #2)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            sub: 'google-sub',
            email: 'user@example.com',
            name: 'Test',
            picture: 'p',
            email_verified: false,
          }),
        }),
      )
      const service = new AuthService(makeConfig())
      await expect(service.getGoogleUserInfo('token')).rejects.toThrow(
        'Google account email is not verified',
      )
      vi.unstubAllGlobals()
    })

    it('REJECTS userinfo without any verified flag (HIGH #2 — fail closed)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            sub: 'google-sub',
            email: 'user@example.com',
            name: 'T',
            picture: 'p',
          }),
        }),
      )
      const service = new AuthService(makeConfig())
      await expect(service.getGoogleUserInfo('token')).rejects.toThrow(
        'Google account email is not verified',
      )
      vi.unstubAllGlobals()
    })

    it('returns identity (id=sub) on verified userinfo', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            sub: 'google-sub',
            email: 'user@example.com',
            name: 'Test User',
            picture: 'https://avatar.url',
            email_verified: true,
          }),
        }),
      )
      const service = new AuthService(makeConfig())
      const result = await service.getGoogleUserInfo('token')
      expect(result.id).toBe('google-sub')
      expect(result.email).toBe('user@example.com')
      expect(result.name).toBe('Test User')
      vi.unstubAllGlobals()
    })

    it('accepts the legacy verified_email alias when set to true', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            sub: 'google-sub',
            email: 'user@example.com',
            verified_email: true,
          }),
        }),
      )
      const service = new AuthService(makeConfig())
      const result = await service.getGoogleUserInfo('token')
      expect(result.id).toBe('google-sub')
      vi.unstubAllGlobals()
    })
  })
})
