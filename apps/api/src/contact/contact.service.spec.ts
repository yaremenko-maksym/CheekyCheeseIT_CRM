/**
 * ContactService.submit() — unit tests for the public contact-form pipeline.
 *
 * Every dependency (DatabaseService, TurnstileService, ResendMailerService,
 * TelemetryErrorsService, ConfigService) is mocked so each branch (task AC2-5)
 * is exercised in isolation, deterministically, without a real Postgres/Resend
 * — mirrors `applications.service.spec.ts`'s harness pattern. Real-DB ADMIN
 * lookup + real-Turnstile-dummy-secret + rate-limit-429 coverage lives in
 * `contact.integration.spec.ts` (feedback_mocked_e2e_guards lesson: a mocked
 * spec alone cannot prove the real SQL `WHERE role = 'ADMIN'` or the real
 * ThrottlerGuard actually enforce the contract).
 */
import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../config/env'
import type { DatabaseService } from '../database/database.service'
import type { TelemetryErrorsService } from '../telemetry/telemetry-errors.service'
import type { TurnstileService } from '../vacancies/turnstile.service'
import { ContactService } from './contact.service'
import type { ResendMailerService, SendEmailInput } from './resend-mailer.service'

const VALID_FIELDS = {
  name: 'Ivan Petrenko',
  email: 'ivan@example.com',
  message: 'We would like to discuss a new project with your team.',
  turnstileToken: 'tok-123',
}

interface Harness {
  svc: ContactService
  turnstile: { verify: ReturnType<typeof vi.fn> }
  mailer: { isConfigured: boolean; send: ReturnType<typeof vi.fn> }
  telemetry: { recordError: ReturnType<typeof vi.fn> }
}

function makeHarness(
  opts: {
    turnstileValid?: boolean
    admins?: { email: string }[]
    mailerConfigured?: boolean
    sendImpl?: (input: SendEmailInput) => Promise<void>
    publicEmail?: string
  } = {},
): Harness {
  const turnstile = { verify: vi.fn().mockResolvedValue(opts.turnstileValid ?? true) }
  const mailer = {
    isConfigured: opts.mailerConfigured ?? true,
    send: opts.sendImpl ? vi.fn(opts.sendImpl) : vi.fn().mockResolvedValue(undefined),
  }
  const telemetry = { recordError: vi.fn().mockResolvedValue(undefined) }
  const db = {
    db: {
      select: (_fields?: unknown) => ({
        from: (_table: unknown) => ({
          where: async (_pred: unknown) =>
            opts.admins ?? [
              { email: 'admin1@cheekycheese.tech' },
              { email: 'admin2@cheekycheese.tech' },
            ],
        }),
      }),
    },
  }
  const config = {
    get: (key: string) =>
      key === 'CONTACT_PUBLIC_EMAIL' ? (opts.publicEmail ?? 'hr@cheekycheese.tech') : undefined,
  }

  const svc = new ContactService(
    db as unknown as DatabaseService,
    turnstile as unknown as TurnstileService,
    mailer as unknown as ResendMailerService,
    telemetry as unknown as TelemetryErrorsService,
    config as unknown as ConfigService<Env, true>,
  )

  return { svc, turnstile, mailer, telemetry }
}

describe('ContactService.submit()', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  it('honeypot: non-empty website field mimics success WITHOUT touching turnstile/mailer', async () => {
    const result = await h.svc.submit(
      { ...VALID_FIELDS, website: 'http://spam.example' },
      '1.2.3.4',
    )
    expect(result).toEqual({ ok: true })
    expect(h.turnstile.verify).not.toHaveBeenCalled()
    expect(h.mailer.send).not.toHaveBeenCalled()
  })

  it('honeypot: empty website field proceeds normally', async () => {
    const result = await h.svc.submit({ ...VALID_FIELDS, website: '' }, '1.2.3.4')
    expect(result).toEqual({ ok: true })
    expect(h.turnstile.verify).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-object body without throwing before the honeypot check', async () => {
    await expect(h.svc.submit('not-an-object', '1.2.3.4')).rejects.toThrow()
    expect(h.turnstile.verify).not.toHaveBeenCalled()
  })

  it('rejects invalid field shape (message too short) via Zod', async () => {
    await expect(h.svc.submit({ ...VALID_FIELDS, message: 'short' }, '1.2.3.4')).rejects.toThrow()
    expect(h.turnstile.verify).not.toHaveBeenCalled()
  })

  it('turnstile invalid → BadRequestException, mailer never called', async () => {
    h = makeHarness({ turnstileValid: false })
    await expect(h.svc.submit(VALID_FIELDS, '1.2.3.4')).rejects.toThrow(BadRequestException)
    expect(h.mailer.send).not.toHaveBeenCalled()
  })

  it('Resend not configured → ServiceUnavailableException with the CONTACT_PUBLIC_EMAIL fallback', async () => {
    h = makeHarness({ mailerConfigured: false, publicEmail: 'hr@cheekycheese.tech' })
    await expect(h.svc.submit(VALID_FIELDS, '1.2.3.4')).rejects.toThrow(ServiceUnavailableException)
    await expect(h.svc.submit(VALID_FIELDS, '1.2.3.4')).rejects.toThrow(/hr@cheekycheese\.tech/)
  })

  it('no ADMIN recipients → BadGatewayException, mailer never called', async () => {
    h = makeHarness({ admins: [] })
    await expect(h.svc.submit(VALID_FIELDS, '1.2.3.4')).rejects.toThrow(BadGatewayException)
    expect(h.mailer.send).not.toHaveBeenCalled()
  })

  it('happy path: sends once to every ADMIN email, reply_to = the visitor email', async () => {
    const result = await h.svc.submit(VALID_FIELDS, '1.2.3.4')
    expect(result).toEqual({ ok: true })
    expect(h.mailer.send).toHaveBeenCalledTimes(1)
    const input = h.mailer.send.mock.calls[0]![0] as SendEmailInput
    expect(input.to).toEqual(['admin1@cheekycheese.tech', 'admin2@cheekycheese.tech'])
    expect(input.replyTo).toBe('ivan@example.com')
    expect(input.subject).toContain('Ivan Petrenko')
    expect(input.text).toContain(VALID_FIELDS.message)
  })

  it('subject includes the company name when provided', async () => {
    await h.svc.submit({ ...VALID_FIELDS, company: 'Acme Inc' }, '1.2.3.4')
    const input = h.mailer.send.mock.calls[0]![0] as SendEmailInput
    expect(input.subject).toBe('Заявка с сайта — Ivan Petrenko, Acme Inc')
    expect(input.text).toContain('Компания: Acme Inc')
    expect(input.html).toContain('Acme Inc')
  })

  it('sanitizes CRLF out of name/company/email before they reach subject/replyTo (header-injection defense)', async () => {
    // The injection primitive is the literal CR/LF character starting a NEW
    // header line — "Bcc:" as plain text on the SAME line is harmless (no
    // mail client interprets it as a header once the newline is gone), so
    // this asserts the actual security property (no raw CR/LF reaches the
    // header-adjacent fields), not that the word "Bcc" itself disappears.
    await h.svc.submit(
      {
        ...VALID_FIELDS,
        name: 'Ivan\r\nBcc: attacker@evil.example',
        company: 'Acme\nInc',
        email: 'ivan@example.com', // Zod .email() rejects a literal CRLF-embedded address anyway
      },
      '1.2.3.4',
    )
    const input = h.mailer.send.mock.calls[0]![0] as SendEmailInput
    // `subject`/`replyTo` are single-value fields — no legitimate `\n` at
    // all, so a bare no-CRLF assertion is exact here.
    expect(input.subject).not.toMatch(/[\r\n]/)
    expect(input.replyTo).not.toMatch(/[\r\n]/)
    // `html` legitimately joins several `<p>` lines with `\n` (this
    // service's OWN template, not user input) — so instead of asserting
    // "no \n anywhere", assert the "Имя" line itself is a SINGLE line: the
    // raw CRLF the visitor submitted is gone (collapsed to a space), "Bcc:"
    // surviving as ordinary text on ONE line is expected and not itself
    // dangerous (the injection primitive is the newline, not the substring).
    const nameLine = input.html.split('\n').find((line) => line.includes('Ivan'))
    expect(nameLine).toContain('Ivan Bcc: attacker@evil.example')
    expect(nameLine).not.toMatch(/[\r\n]/)
  })

  it('escapes HTML in the message body so it cannot inject markup into the ADMIN mail client', async () => {
    await h.svc.submit(
      { ...VALID_FIELDS, message: 'Hello <script>alert(1)</script> "quoted" & stuff' },
      '1.2.3.4',
    )
    const input = h.mailer.send.mock.calls[0]![0] as SendEmailInput
    expect(input.html).not.toContain('<script>')
    expect(input.html).toContain('&lt;script&gt;')
    expect(input.html).toContain('&quot;quoted&quot;')
    expect(input.html).toContain('&amp;')
    // The plain-text body is untouched (no HTML-escaping needed there).
    expect(input.text).toContain('<script>alert(1)</script>')
  })

  it('retries once on a transient send failure, then succeeds', async () => {
    let calls = 0
    h = makeHarness({
      sendImpl: async () => {
        calls++
        if (calls === 1) throw new Error('Resend API HTTP 500')
      },
    })
    const result = await h.svc.submit(VALID_FIELDS, '1.2.3.4')
    expect(result).toEqual({ ok: true })
    expect(h.mailer.send).toHaveBeenCalledTimes(2)
    expect(h.telemetry.recordError).not.toHaveBeenCalled()
  })

  it('exhausts retries → BadGatewayException + logs a telemetry error (no PII)', async () => {
    h = makeHarness({
      sendImpl: async () => {
        throw new Error('Resend API HTTP 500: boom')
      },
    })
    await expect(h.svc.submit(VALID_FIELDS, '1.2.3.4')).rejects.toThrow(BadGatewayException)
    expect(h.mailer.send).toHaveBeenCalledTimes(2)
    expect(h.telemetry.recordError).toHaveBeenCalledTimes(1)
    const call = h.telemetry.recordError.mock.calls[0]![0]
    expect(call.source).toBe('API')
    expect(call.route).toBe('/api/public/contact')
    expect(JSON.stringify(call)).not.toContain(VALID_FIELDS.email)
    expect(JSON.stringify(call)).not.toContain(VALID_FIELDS.name)
  })
})
