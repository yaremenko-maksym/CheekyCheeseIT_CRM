import { Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../config/env'
import { ResendMailerService } from './resend-mailer.service'

function makeConfig(overrides: Partial<Env> = {}): ConfigService<Env, true> {
  const values: Partial<Env> = {
    RESEND_API_KEY: 'test-key',
    CONTACT_FROM_EMAIL: 'site@cheekycheese.tech',
    ...overrides,
  }
  return {
    get: (key: string) => values[key as keyof Env],
  } as unknown as ConfigService<Env, true>
}

const INPUT = {
  to: ['admin@cheekycheese.tech'],
  subject: 'Заявка с сайта — Ivan',
  text: 'plain body',
  html: '<p>html body</p>',
  replyTo: 'ivan@example.com',
}

describe('ResendMailerService', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = vi.fn()
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('isConfigured is true when RESEND_API_KEY is set', () => {
    const svc = new ResendMailerService(makeConfig())
    expect(svc.isConfigured).toBe(true)
  })

  it('isConfigured is false when RESEND_API_KEY is unset, and logs one boot warning', () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const svc = new ResendMailerService(makeConfig({ RESEND_API_KEY: undefined }))
    expect(svc.isConfigured).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('RESEND_API_KEY is not configured'),
    )
    warnSpy.mockRestore()
  })

  it('send() throws (defensive) when called while unconfigured, without ever calling fetch', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const svc = new ResendMailerService(makeConfig({ RESEND_API_KEY: undefined }))
    await expect(svc.send(INPUT)).rejects.toThrow(/RESEND_API_KEY is not configured/)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('posts JSON to the Resend API with from/to/subject/text/html/reply_to + Bearer auth', async () => {
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init: RequestInit) => {
        capturedUrl = url
        capturedInit = init
        return { ok: true, status: 200 }
      },
    )
    const svc = new ResendMailerService(makeConfig({ RESEND_API_KEY: 'my-secret-key' }))
    await svc.send(INPUT)

    expect(capturedUrl).toBe('https://api.resend.com/emails')
    expect(capturedInit?.method).toBe('POST')
    expect((capturedInit?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer my-secret-key',
    )
    const body = JSON.parse(capturedInit?.body as string)
    expect(body).toEqual({
      from: 'site@cheekycheese.tech',
      to: INPUT.to,
      subject: INPUT.subject,
      text: INPUT.text,
      html: INPUT.html,
      reply_to: INPUT.replyTo,
    })
  })

  it('throws on a non-2xx HTTP response', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"message":"invalid from address"}',
    })
    const svc = new ResendMailerService(makeConfig())
    await expect(svc.send(INPUT)).rejects.toThrow(/Resend API HTTP 422/)
  })

  it('throws when the fetch call itself throws (network error / timeout)', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'))
    const svc = new ResendMailerService(makeConfig())
    await expect(svc.send(INPUT)).rejects.toThrow(/network down/)
  })
})
