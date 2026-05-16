import { ConfigService } from '@nestjs/config'
import { describe, expect, it, vi } from 'vitest'
import { AuthService } from './auth.service'

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string) =>
      ({ GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CALLBACK_URL: 'http://localhost/callback', ...overrides }[key]),
  } as unknown as ConfigService
}

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
