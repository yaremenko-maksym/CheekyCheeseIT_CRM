import { describe, expect, it } from 'vitest'
import { QUOTA_PROVIDER_ENV_KEY, readQuotaCredential, type QuotaEnvKey } from './quota-credentials'

/**
 * r5 Task 3.5a AC8. The env reader is a recording function, so "nothing reads CLOUDFLARE_*" is
 * asserted by what was actually asked for, not by searching the source text.
 */
function recordingEnv(values: Record<string, string | undefined>) {
  const asked: string[] = []
  const read = (key: QuotaEnvKey) => {
    asked.push(key)
    return values[key]
  }
  return { read, asked }
}

const CLOUDFLARE = { CLOUDFLARE_ACCOUNT_ID: 'cf-account', CLOUDFLARE_AI_TOKEN: 'cf-token' }

describe('readQuotaCredential', () => {
  it('maps each keyed provider to its own env key, and The Muse to none', () => {
    expect(QUOTA_PROVIDER_ENV_KEY).toEqual({
      jooble: 'JOOBLE_API_KEY',
      jsearch: 'RAPIDAPI_KEY',
      theirstack: 'THEIRSTACK_API_KEY',
      reed: 'REED_API_KEY',
      themuse: null,
    })
  })

  it.each([
    ['jooble', 'JOOBLE_API_KEY'],
    ['jsearch', 'RAPIDAPI_KEY'],
    ['theirstack', 'THEIRSTACK_API_KEY'],
    ['reed', 'REED_API_KEY'],
  ] as const)(
    '%s configured: the key is returned AND registered as a secret',
    (provider, envKey) => {
      const env = recordingEnv({ ...CLOUDFLARE, [envKey]: `secret-for-${provider}` })
      expect(readQuotaCredential(provider, env.read)).toEqual({
        configured: true,
        apiKey: `secret-for-${provider}`,
        secrets: [`secret-for-${provider}`],
      })
      expect(env.asked).toEqual([envKey])
    },
  )

  it.each(['jooble', 'jsearch', 'theirstack', 'reed'] as const)(
    '%s unconfigured (absent) even with Cloudflare credentials present: nothing borrowed',
    (provider) => {
      const env = recordingEnv({ ...CLOUDFLARE })
      expect(readQuotaCredential(provider, env.read)).toEqual({
        configured: false,
        apiKey: null,
        secrets: [],
      })
      expect(env.asked.some((k) => k.startsWith('CLOUDFLARE'))).toBe(false)
      expect(env.asked).toHaveLength(1)
    },
  )

  it('an empty string that reached the reader is still unconfigured, never an empty secret', () => {
    const env = recordingEnv({ REED_API_KEY: '' })
    expect(readQuotaCredential('reed', env.read)).toEqual({
      configured: false,
      apiKey: null,
      secrets: [],
    })
  })

  it('The Muse needs no key and reads no env at all', () => {
    const env = recordingEnv({ ...CLOUDFLARE })
    expect(readQuotaCredential('themuse', env.read)).toEqual({
      configured: true,
      apiKey: null,
      secrets: [],
    })
    expect(env.asked).toEqual([])
  })
})
