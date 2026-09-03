/**
 * PersonalEmailInviteMailerService.sendInvite() — unit tests.
 *
 * task-user-emails-invite. Zero prior coverage (mutation gate, `--changed`:
 * 59 NoCoverage mutants — every call site in `users.service.ts` mocks this
 * service away entirely, so nothing in the unit suite ever executed a
 * single line of the retry loop, the not-configured branch, or the
 * telemetry payload). Structure mirrors `contact.service.spec.ts`'s own
 * retry tests (`ContactService.sendWithRetry` — same 2-attempt/500ms-
 * backoff shape, real `setTimeout` rather than faked, per that file's
 * established convention).
 *
 * Second pass (still task-user-emails-invite): a first version of this file
 * left 21 mutants surviving — `config.get`'s SECOND argument (`{infer:
 * true}`) was invisible because the mock's `get` ignored it; `escapeHtml`'s
 * `&`/`"`/`'` branches were untested because the one XSS fixture used only
 * `<`/`>`; the backoff `sleep()` call was never actually asserted to have
 * happened, only its downstream effect (a second send). Each fix below is
 * annotated with which survivor(s) it kills.
 */
import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env'
import type { ResendMailerService, SendEmailInput } from '../contact/resend-mailer.service'
import type { TelemetryErrorsService } from '../telemetry/telemetry-errors.service'
import { PersonalEmailInviteMailerService } from './personal-email-invite-mailer.service'

/**
 * `get` is a `vi.fn()` (not a bare arrow) — kills the `{ infer: true }` →
 * `{}` / `true` → `false` ObjectLiteral/BooleanLiteral survivors on both
 * `config.get('FRONTEND_URL', …)` and `config.get('CONTACT_PUBLIC_EMAIL', …)`:
 * tests below assert the exact second argument each call carried, which a
 * mock ignoring that argument could never do.
 */
function makeConfig(values: Record<string, string>): {
  config: ConfigService<Env, true>
  get: ReturnType<typeof vi.fn>
} {
  const get = vi.fn((key: string) => values[key])
  return { config: { get } as unknown as ConfigService<Env, true>, get }
}

function makeHarness(
  opts: {
    isConfigured?: boolean
    sendImpl?: (input: SendEmailInput) => Promise<void>
    env?: Record<string, string>
  } = {},
) {
  const mailer = {
    isConfigured: opts.isConfigured ?? true,
    send: opts.sendImpl ? vi.fn(opts.sendImpl) : vi.fn().mockResolvedValue(undefined),
  } as unknown as ResendMailerService
  const telemetry = {
    recordError: vi.fn().mockResolvedValue(undefined),
  } as unknown as TelemetryErrorsService
  const { config, get: configGet } = makeConfig(
    opts.env ?? {
      FRONTEND_URL: 'https://app.cheekycheese.tech',
      CONTACT_PUBLIC_EMAIL: 'hr@cheekycheese.tech',
    },
  )
  const svc = new PersonalEmailInviteMailerService(mailer, telemetry, config)
  return { svc, mailer, telemetry, configGet }
}

const INPUT = {
  to: 'ivan.personal@gmail.com',
  displayName: 'Иван Петров',
  rawToken: 'a'.repeat(64),
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PersonalEmailInviteMailerService — constructor reads config with the expected args', () => {
  it('reads FRONTEND_URL and CONTACT_PUBLIC_EMAIL, both with { infer: true }', () => {
    const { configGet } = makeHarness()
    expect(configGet).toHaveBeenCalledWith('FRONTEND_URL', { infer: true })
    expect(configGet).toHaveBeenCalledWith('CONTACT_PUBLIC_EMAIL', { infer: true })
  })

  it('strips a trailing slash from FRONTEND_URL before appending /api (no double slash in the link)', async () => {
    const { svc, mailer } = makeHarness({
      env: {
        FRONTEND_URL: 'https://app.cheekycheese.tech/',
        CONTACT_PUBLIC_EMAIL: 'hr@cheekycheese.tech',
      },
    })
    await svc.sendInvite(INPUT)
    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as SendEmailInput
    expect(call.html).toContain(`https://app.cheekycheese.tech/api/auth/invite/${INPUT.rawToken}`)
    expect(call.html).not.toContain('.tech//api')
  })
})

describe('PersonalEmailInviteMailerService.sendInvite — RESEND_API_KEY not configured', () => {
  it('does not call mailer.send, records a telemetry error, does not throw', async () => {
    const { svc, mailer, telemetry } = makeHarness({ isConfigured: false })
    // copy-review PR #623 (COPY-M-1): sendInvite now reports delivery outcome —
    // "not configured" is a delivery failure, same as an exhausted retry.
    await expect(svc.sendInvite(INPUT)).resolves.toBe(false)
    expect(mailer.send).not.toHaveBeenCalled()
    expect(telemetry.recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'API',
        message: 'Personal-email invite not sent — RESEND_API_KEY not configured',
        route: '/api/users',
      }),
    )
  })

  it('logs a warning naming the reason (not an empty/generic message)', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const { svc } = makeHarness({ isConfigured: false })
    await svc.sendInvite(INPUT)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('RESEND_API_KEY not configured'))
  })
})

describe('PersonalEmailInviteMailerService.sendInvite — happy path', () => {
  it('sends exactly once with the exact subject, recipient, and a link embedding the raw token', async () => {
    const { svc, mailer } = makeHarness()
    await svc.sendInvite(INPUT)

    expect(mailer.send).toHaveBeenCalledTimes(1)
    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as SendEmailInput
    expect(call.to).toEqual([INPUT.to])
    // Spec §11: subject is the exact approved string, no "Запрос на …" prefix
    // (this is the one email that is NOT a request).
    expect(call.subject).toBe('Доступ к CRM CheekyCheeseIT')
    expect(call.html).toContain(`/auth/invite/${INPUT.rawToken}`)
    expect(call.text).toContain(`/auth/invite/${INPUT.rawToken}`)
    // The link is built off FRONTEND_URL + /api, not a hardcoded host.
    expect(call.html).toContain('https://app.cheekycheese.tech/api/auth/invite/')
    expect(call.replyTo).toBe('hr@cheekycheese.tech')
  })

  it('escapes every one of the five HTML-significant characters in displayName, individually', async () => {
    const { svc, mailer } = makeHarness()
    // One fixture per character — a fixture combining them would still kill
    // each mutant, but a per-character table names exactly which escape
    // broke if one ever regresses.
    const cases: Array<[string, string]> = [
      ['&', '&amp;'],
      ['<', '&lt;'],
      ['>', '&gt;'],
      ['"', '&quot;'],
      ["'", '&#39;'],
    ]
    for (const [raw, escaped] of cases) {
      await svc.sendInvite({ ...INPUT, displayName: `x${raw}y` })
      const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls.at(
        -1,
      )?.[0] as SendEmailInput
      expect(call.html).toContain(`x${escaped}y`)
      expect(call.html).not.toContain(`x${raw}y`)
    }
  })

  // COPY-L-2 (copy-review PR #623 round 4): greets by the FIRST word only,
  // TRIMMED — a `MethodExpression` mutant collapsing the whole
  // `.trim().split(/\s+/)[0]` chain down to the bare `input.displayName`
  // survived every other test in this file, because none of them use a
  // displayName with LEADING whitespace (the one shape that makes the
  // trimmed and untrimmed results actually differ).
  it('greets by the first word only, trimmed — not the full display name', async () => {
    const { svc, mailer } = makeHarness()
    await svc.sendInvite({ ...INPUT, displayName: '  Oleksiy Kovalenko  ' })
    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as SendEmailInput
    expect(call.text.startsWith('Oleksiy,')).toBe(true)
    expect(call.text).not.toContain('Kovalenko')
    expect(call.html).toContain('Oleksiy,')
    expect(call.html).not.toContain('Kovalenko')
  })

  it('spec §11: exactly one button (one <a href> in the HTML body)', async () => {
    const { svc, mailer } = makeHarness()
    await svc.sendInvite(INPUT)
    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as SendEmailInput
    expect(call.html.match(/<a /g)).toHaveLength(1)
  })

  it('spec §11: the last line is the protective disclaimer, not a thank-you', async () => {
    const { svc, mailer } = makeHarness()
    await svc.sendInvite(INPUT)
    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as SendEmailInput
    const lines = call.text.trim().split('\n')
    expect(lines[lines.length - 1]).toBe('Если письмо пришло по ошибке, не переходите по ссылке.')
    expect(call.text.toLowerCase()).not.toContain('спасибо')
  })

  it('the plain-text body is the exact 8-line structure — greeting, blank, promise, cost-of-inaction, blank, link, blank, disclaimer', async () => {
    const { svc, mailer } = makeHarness()
    await svc.sendInvite(INPUT)
    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as SendEmailInput
    const link = call.html.match(/href="([^"]+)"/)?.[1]
    expect(link).toBeTruthy()
    // copy-review PR #623 (COPY-H-1/M-4/L-2): rewritten body — button/copy
    // name the actual outcome, state the cost of doing nothing, greet by
    // FIRST name only (INPUT.displayName is two words — 'Иван Петров').
    const firstName = INPUT.displayName.split(' ')[0]
    expect(call.text).toBe(
      [
        `${firstName}, этот адрес добавили в CRM CheekyCheeseIT как ваш личный.`,
        '',
        'Подтвердите его — тогда входить можно будет и с рабочего адреса, и с этого.',
        'Пока не подтвердите, вход работает только по рабочему.',
        '',
        link,
        '',
        'Если письмо пришло по ошибке, не переходите по ссылке.',
      ].join('\n'),
    )
  })
})

describe('PersonalEmailInviteMailerService.sendInvite — retry policy (2 attempts, 500ms backoff)', () => {
  it('retries once on a transient failure, then succeeds — sleeps exactly once, in between, and logs the attempt/reason', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    let calls = 0
    const { svc, mailer } = makeHarness({
      sendImpl: async () => {
        calls++
        if (calls === 1) throw new Error('Resend API HTTP 500')
        return undefined
      },
    })
    await expect(svc.sendInvite(INPUT)).resolves.toBe(true)
    expect(mailer.send).toHaveBeenCalledTimes(2)
    // Kills: sleep()'s body emptied (BlockStatement, line ~49 — setTimeout
    // never invoked at all) AND every `if (attempt < MAX_SEND_ATTEMPTS)`
    // mutant that would make this EITHER 0 (condition flipped to false /
    // body emptied) OR observably wrong under the `attempt >= …` inversion
    // (which skips the sleep on the FIRST failed attempt specifically —
    // the only one this test ever makes).
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 500)
    // Kills the per-attempt warn-log StringLiteral mutant (`` empty template
    // survives if nothing ever reads the message content).
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('sendInvite(): Resend send attempt 1/2 failed: Resend API HTTP 500'),
    )
  })

  it('exhausts both attempts → sleeps exactly once (never after the LAST attempt)', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    const { svc, mailer, telemetry } = makeHarness({
      sendImpl: async () => {
        throw new Error('Resend API HTTP 500: rate limited')
      },
    })
    await expect(svc.sendInvite(INPUT)).resolves.toBe(false)
    expect(mailer.send).toHaveBeenCalledTimes(2)
    // Kills the `if (true)` / `attempt <= MAX_SEND_ATTEMPTS` mutants, which
    // would sleep after BOTH failures (count 2) instead of only between
    // them (count 1) — the second sleep would be pure waste, delaying an
    // already-decided failure.
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    // LOW-3 (security-review PR #623 round 4): meta.reason is the extracted
    // `HTTP <status>` prefix ONLY, never the raw error message — Resend's
    // response body (the ": rate limited" suffix here) is provider text
    // that sometimes echoes back the rejected recipient address.
    expect(telemetry.recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'API',
        message: 'Personal-email invite delivery failed after retries',
        route: '/api/users',
        meta: { reason: 'Resend API HTTP 500' },
      }),
    )
    // PII note (module doc): the recipient address must never appear in the
    // telemetry call.
    const [telemetryCall] = (telemetry.recordError as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
    ]
    expect(JSON.stringify(telemetryCall)).not.toContain(INPUT.to)
  })

  // LOW-3 follow-up: `safeErrorReason`'s two OTHER branches — an Error whose
  // message does NOT look like "Resend API HTTP …" (falls back to the
  // constructor name), and a THROWN VALUE that isn't an Error at all (e.g. a
  // network layer throwing a plain string) — had zero coverage; only the
  // "matches the HTTP-status shape" branch was ever exercised.
  it('a non-HTTP-shaped Error falls back to its constructor name (not the raw message)', async () => {
    const { svc, telemetry } = makeHarness({
      sendImpl: async () => {
        throw new TypeError('fetch failed: getaddrinfo ENOTFOUND api.resend.com')
      },
    })
    await expect(svc.sendInvite(INPUT)).resolves.toBe(false)
    expect(telemetry.recordError).toHaveBeenCalledWith(
      expect.objectContaining({ meta: { reason: 'TypeError' } }),
    )
  })

  // The `^` anchor matters: an error whose message merely CONTAINS "Resend
  // API HTTP …" partway through (not at the very start) must NOT be
  // reported as that status — an unanchored match would wrongly extract a
  // status code from text that only happens to quote the phrase.
  it('a message that only CONTAINS the HTTP-status phrase (not at the start) falls back to the constructor name', async () => {
    const { svc, telemetry } = makeHarness({
      sendImpl: async () => {
        throw new Error('wrapped: Resend API HTTP 500')
      },
    })
    await expect(svc.sendInvite(INPUT)).resolves.toBe(false)
    expect(telemetry.recordError).toHaveBeenCalledWith(
      expect.objectContaining({ meta: { reason: 'Error' } }),
    )
  })

  it('a non-Error thrown value resolves to false with reason "unknown" (does not crash)', async () => {
    const { svc, telemetry } = makeHarness({
      // Deliberately non-Error — mirrors a raw string a lower layer could throw.
      sendImpl: async () => {
        throw 'connection reset'
      },
    })
    await expect(svc.sendInvite(INPUT)).resolves.toBe(false)
    expect(telemetry.recordError).toHaveBeenCalledWith(
      expect.objectContaining({ meta: { reason: 'unknown' } }),
    )
  })
})
