/**
 * GoogleIndexingService — unit tests (task-google-indexing-api AC1/AC2/AC3/AC4).
 *
 * `signIndexingJwt` is exercised directly (AC3 "JWT-структура ... верифицируема
 * публичным ключом из пары, сгенерённой в тесте") against a throwaway RSA
 * keypair generated in this file — no fixture keys committed anywhere.
 *
 * The service itself is exercised with a stubbed `global.fetch` — no real
 * network calls. `ConfigService<Env, true>` is stubbed with a plain object
 * exposing `.get(key)`, matching the pattern used by
 * vacancies.integration.spec.ts's `fakeConfigService`.
 */
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { Logger } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../config/env'
import { GoogleIndexingService, signIndexingJwt } from './google-indexing.service'

function decodeBase64url(segment: string): Buffer {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(padded, 'base64')
}

function makeRsaKeyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}

describe('signIndexingJwt', () => {
  it('produces a 3-segment JWT with the correct RS256 header, claims, and a verifiable signature', () => {
    const { publicKey, privateKey } = makeRsaKeyPair()
    const nowSec = 1_800_000_000
    const jwt = signIndexingJwt('sa@my-project.iam.gserviceaccount.com', privateKey, nowSec)

    const parts = jwt.split('.')
    expect(parts).toHaveLength(3)
    const [headerSeg, claimsSeg, signatureSeg] = parts as [string, string, string]

    const header = JSON.parse(decodeBase64url(headerSeg).toString('utf8')) as Record<
      string,
      unknown
    >
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' })

    const claims = JSON.parse(decodeBase64url(claimsSeg).toString('utf8')) as Record<
      string,
      unknown
    >
    expect(claims).toEqual({
      iss: 'sa@my-project.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/indexing',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3_600,
    })

    // Signature verifies against the MATCHING public key from the same pair.
    const signingInput = `${headerSeg}.${claimsSeg}`
    const verifier = createVerify('RSA-SHA256')
    verifier.update(signingInput)
    verifier.end()
    expect(verifier.verify(publicKey, decodeBase64url(signatureSeg))).toBe(true)
  })

  it('a signature produced with a DIFFERENT key pair does NOT verify (sanity check on the harness itself)', () => {
    const pairA = makeRsaKeyPair()
    const pairB = makeRsaKeyPair()
    const jwt = signIndexingJwt('sa@x.iam.gserviceaccount.com', pairA.privateKey, 1_000)
    const [headerSeg, claimsSeg, signatureSeg] = jwt.split('.') as [string, string, string]
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${headerSeg}.${claimsSeg}`)
    verifier.end()
    expect(verifier.verify(pairB.publicKey, decodeBase64url(signatureSeg))).toBe(false)
  })
})

describe('GoogleIndexingService', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function makeConfig(env: Partial<Record<keyof Env, unknown>>): ConfigService<Env, true> {
    return { get: (key: string) => env[key as keyof Env] } as unknown as ConfigService<Env, true>
  }

  describe('AC2 — no-op mode without env keys', () => {
    it('warns once at construction and never calls fetch on notifyUpdated/notifyDeleted', async () => {
      const svc = new GoogleIndexingService(makeConfig({}))
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/GOOGLE_INDEXING_SA_EMAIL/)

      await expect(
        svc.notifyUpdated('https://cheekycheese.tech/careers/x/'),
      ).resolves.toBeUndefined()
      await expect(
        svc.notifyDeleted('https://cheekycheese.tech/careers/x/'),
      ).resolves.toBeUndefined()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('stays no-op when only ONE of the two env vars is set', async () => {
      const svc = new GoogleIndexingService(
        makeConfig({ GOOGLE_INDEXING_SA_EMAIL: 'sa@x.iam.gserviceaccount.com' }),
      )
      await svc.notifyUpdated('https://cheekycheese.tech/careers/x/')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('does NOT warn when both env vars are configured', () => {
      const { privateKey } = makeRsaKeyPair()
      new GoogleIndexingService(
        makeConfig({
          GOOGLE_INDEXING_SA_EMAIL: 'sa@x.iam.gserviceaccount.com',
          GOOGLE_INDEXING_SA_KEY_B64: Buffer.from(privateKey).toString('base64'),
        }),
      )
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })

  describe('AC3 — with fake keys: correct JWT auth + right URL/type notifications', () => {
    function makeEnabledService() {
      const { privateKey } = makeRsaKeyPair()
      return new GoogleIndexingService(
        makeConfig({
          GOOGLE_INDEXING_SA_EMAIL: 'sa@x.iam.gserviceaccount.com',
          GOOGLE_INDEXING_SA_KEY_B64: Buffer.from(privateKey).toString('base64'),
        }),
      )
    }

    function mockTokenThenPublish(publishStatus = 200) {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'fake-access-token', expires_in: 3600 }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: publishStatus < 300,
          status: publishStatus,
          json: async () => ({}),
        } as unknown as Response)
    }

    it('notifyUpdated exchanges the JWT for a token then POSTs URL_UPDATED with the exact URL (trailing slash preserved)', async () => {
      const svc = makeEnabledService()
      mockTokenThenPublish()

      await svc.notifyUpdated('https://cheekycheese.tech/careers/senior-react-developer/')

      expect(fetchMock).toHaveBeenCalledTimes(2)
      const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(tokenUrl).toBe('https://oauth2.googleapis.com/token')
      expect(String(tokenInit.body)).toContain(
        'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer',
      )

      const [publishUrl, publishInit] = fetchMock.mock.calls[1] as [string, RequestInit]
      expect(publishUrl).toBe('https://indexing.googleapis.com/v3/urlNotifications:publish')
      expect(publishInit.headers).toMatchObject({ Authorization: 'Bearer fake-access-token' })
      expect(JSON.parse(String(publishInit.body))).toEqual({
        url: 'https://cheekycheese.tech/careers/senior-react-developer/',
        type: 'URL_UPDATED',
      })
    })

    it('notifyDeleted POSTs URL_DELETED', async () => {
      const svc = makeEnabledService()
      mockTokenThenPublish()

      await svc.notifyDeleted('https://cheekycheese.tech/careers/senior-react-developer/')

      const [, publishInit] = fetchMock.mock.calls[1] as [string, RequestInit]
      expect(JSON.parse(String(publishInit.body))).toEqual({
        url: 'https://cheekycheese.tech/careers/senior-react-developer/',
        type: 'URL_DELETED',
      })
    })

    it('caches the access token across calls — a second notify within the TTL does NOT re-fetch a token', async () => {
      const svc = makeEnabledService()
      mockTokenThenPublish()
      await svc.notifyUpdated('https://cheekycheese.tech/careers/a/')
      // Second call: only ONE more fetch (the publish call) — token reused.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as unknown as Response)
      await svc.notifyUpdated('https://cheekycheese.tech/careers/b/')

      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
  })

  describe('AC4 — fail-soft: Google API errors never throw / never reject', () => {
    it('a non-2xx from the publish endpoint resolves (does not throw) and logs a warning', async () => {
      const { privateKey } = makeRsaKeyPair()
      const svc = new GoogleIndexingService(
        makeConfig({
          GOOGLE_INDEXING_SA_EMAIL: 'sa@x.iam.gserviceaccount.com',
          GOOGLE_INDEXING_SA_KEY_B64: Buffer.from(privateKey).toString('base64'),
        }),
      )
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'tok', expires_in: 3600 }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({}),
        } as unknown as Response)

      await expect(
        svc.notifyUpdated('https://cheekycheese.tech/careers/x/'),
      ).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'))
    })

    it('a network error (fetch rejects) during the token exchange resolves (does not throw)', async () => {
      const { privateKey } = makeRsaKeyPair()
      const svc = new GoogleIndexingService(
        makeConfig({
          GOOGLE_INDEXING_SA_EMAIL: 'sa@x.iam.gserviceaccount.com',
          GOOGLE_INDEXING_SA_KEY_B64: Buffer.from(privateKey).toString('base64'),
        }),
      )
      fetchMock.mockRejectedValueOnce(new Error('network unreachable'))

      await expect(
        svc.notifyDeleted('https://cheekycheese.tech/careers/x/'),
      ).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('network unreachable'))
    })
  })
})
