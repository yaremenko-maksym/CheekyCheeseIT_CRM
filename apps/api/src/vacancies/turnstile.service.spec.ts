import { Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../config/env'
import { TurnstileService } from './turnstile.service'

function makeConfig(overrides: Partial<Env> = {}): ConfigService<Env, true> {
  const values: Partial<Env> = {
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    NODE_ENV: 'test',
    ...overrides,
  }
  return {
    get: (key: string) => values[key as keyof Env],
  } as unknown as ConfigService<Env, true>
}

describe('TurnstileService', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = vi.fn()
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('returns true when Cloudflare responds success: true', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    })
    const svc = new TurnstileService(makeConfig())
    await expect(svc.verify('valid-token', '1.2.3.4')).resolves.toBe(true)
  })

  it('returns false when Cloudflare responds success: false', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
    })
    const svc = new TurnstileService(makeConfig())
    await expect(svc.verify('bad-token', '1.2.3.4')).resolves.toBe(false)
  })

  it('returns false on a non-2xx HTTP response', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    })
    const svc = new TurnstileService(makeConfig())
    await expect(svc.verify('token', '1.2.3.4')).resolves.toBe(false)
  })

  it('returns false when the fetch call throws (network error / timeout)', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'))
    const svc = new TurnstileService(makeConfig())
    await expect(svc.verify('token', '1.2.3.4')).resolves.toBe(false)
  })

  it('sends secret + response + remoteip as form-encoded body', async () => {
    let capturedBody: URLSearchParams | undefined
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string, init: RequestInit) => {
        capturedBody = init.body as URLSearchParams
        return { ok: true, status: 200, json: async () => ({ success: true }) }
      },
    )
    const svc = new TurnstileService(makeConfig({ TURNSTILE_SECRET_KEY: 'my-secret' }))
    await svc.verify('the-token', '9.9.9.9')
    expect(capturedBody?.get('secret')).toBe('my-secret')
    expect(capturedBody?.get('response')).toBe('the-token')
    expect(capturedBody?.get('remoteip')).toBe('9.9.9.9')
  })

  it('logs an error at construction time when the dummy secret is used in production', () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    new TurnstileService(makeConfig({ NODE_ENV: 'production' }))
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('dev dummy secret'))
    errorSpy.mockRestore()
  })

  it('does NOT log an error at construction time with a real secret in production', () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    new TurnstileService(
      makeConfig({ NODE_ENV: 'production', TURNSTILE_SECRET_KEY: 'real-secret' }),
    )
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
