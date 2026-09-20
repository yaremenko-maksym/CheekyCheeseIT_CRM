/**
 * ZodExceptionFilter unit tests — LOW-6: info-disclosure hardening.
 *
 * Verifies:
 *   - Finance-critical routes + non-ADMIN → generic 'Invalid request body' (no field paths)
 *   - Finance-critical routes + ADMIN → full Zod field-path errors
 *   - Non-finance routes + any role → full Zod field-path errors
 */
import { describe, expect, it } from 'vitest'
import { ArgumentsHost, HttpStatus } from '@nestjs/common'
import { ZodError } from 'zod'
import { z } from 'zod'
import { ZodExceptionFilter } from './zod-exception.filter'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeZodError(): ZodError {
  const schema = z.object({ amount: z.number(), currency: z.enum(['USDT']) })
  const result = schema.safeParse({ amount: 'not-a-number', currency: 'INVALID' })
  if (result.success) throw new Error('Expected failure')
  return result.error
}

function makeHost(url: string, role?: string): ArgumentsHost {
  const sent: unknown[] = []
  const reply = {
    status: (code: number) => ({
      send: (body: unknown) => {
        sent.push({ code, body })
      },
    }),
    _sent: sent,
  }

  const request = {
    url,
    user: role ? { role } : undefined,
  }

  return {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost
}

function capture(host: ArgumentsHost): { code: number; body: unknown } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sent = (host.switchToHttp().getResponse() as any)._sent as Array<{
    code: number
    body: unknown
  }>
  return sent[0] ?? { code: 0, body: null }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ZodExceptionFilter — finance routes (non-ADMIN)', () => {
  const filter = new ZodExceptionFilter()
  const zodErr = makeZodError()

  it.each([
    '/api/transactions',
    '/api/transactions/some-uuid',
    '/api/payout-requests',
    '/api/finance',
    '/api/finance/summary',
    '/api/company-account',
    '/api/pending-settlements',
    '/api/pending-obligations',
    '/api/balances',
  ])('returns generic message for %s with SENIOR role', (url) => {
    const host = makeHost(url, 'SENIOR')
    filter.catch(zodErr, host)
    const { body } = capture(host)
    expect((body as Record<string, unknown>)['message']).toBe('Invalid request body')
    expect((body as Record<string, unknown>)['errors']).toBeUndefined()
  })

  it.each(['JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'])(
    'returns generic message for finance route with %s role',
    (role) => {
      const host = makeHost('/api/transactions', role)
      filter.catch(zodErr, host)
      const { body } = capture(host)
      expect((body as Record<string, unknown>)['message']).toBe('Invalid request body')
      expect((body as Record<string, unknown>)['errors']).toBeUndefined()
    },
  )

  it('returns generic message when user is unauthenticated on finance route', () => {
    const host = makeHost('/api/transactions') // no role
    filter.catch(zodErr, host)
    const { body } = capture(host)
    expect((body as Record<string, unknown>)['message']).toBe('Invalid request body')
  })
})

describe('ZodExceptionFilter — finance routes (ADMIN gets full detail)', () => {
  const filter = new ZodExceptionFilter()
  const zodErr = makeZodError()

  it('returns full Zod error detail for ADMIN on finance route', () => {
    const host = makeHost('/api/transactions', 'ADMIN')
    filter.catch(zodErr, host)
    const { body } = capture(host)
    expect((body as Record<string, unknown>)['message']).toBe('Validation failed')
    expect(Array.isArray((body as Record<string, unknown>)['errors'])).toBe(true)
    expect(((body as Record<string, unknown>)['errors'] as unknown[]).length).toBeGreaterThan(0)
  })
})

describe('ZodExceptionFilter — non-finance routes (full detail for all)', () => {
  const filter = new ZodExceptionFilter()
  const zodErr = makeZodError()

  it.each(['/api/users', '/api/tos/accept', '/api/contracts', '/api/notifications'])(
    'returns full field-path detail for %s with non-ADMIN role',
    (url) => {
      const host = makeHost(url, 'SENIOR')
      filter.catch(zodErr, host)
      const { body } = capture(host)
      expect((body as Record<string, unknown>)['message']).toBe('Validation failed')
      expect(Array.isArray((body as Record<string, unknown>)['errors'])).toBe(true)
    },
  )

  it('returns 400 status code', () => {
    const host = makeHost('/api/users', 'SENIOR')
    filter.catch(zodErr, host)
    const { code } = capture(host)
    expect(code).toBe(HttpStatus.BAD_REQUEST)
  })
})

// task-i18n-stage4-task4 (Step 7) — the SAME response can carry a mix of
// migrated (code-shaped) and not-yet-migrated (prose-shaped) issues; each
// issue is classified on its OWN `message`, independent of its neighbours.
describe('ZodExceptionFilter — migrated vs non-migrated issues (task-i18n-stage4-task4)', () => {
  const filter = new ZodExceptionFilter()

  function mixedZodError(): ZodError {
    return new ZodError([
      { code: 'custom', path: ['bankUahRnokpp'], message: 'zod.RNOKPP_FORMAT' },
      { code: 'custom', path: ['email'], message: 'Некорректный email' },
    ])
  }

  it('returns { path, code, message } (EN fallback) for a migrated issue, { path, message } for a legacy one, in the same response', () => {
    const host = makeHost('/api/users', 'SENIOR')
    filter.catch(mixedZodError(), host)
    const { body } = capture(host)
    const errors = (body as Record<string, unknown>)['errors'] as Array<Record<string, unknown>>

    const migrated = errors.find((e) => e['path'] === 'bankUahRnokpp')
    expect(migrated).toEqual({
      path: 'bankUahRnokpp',
      code: 'RNOKPP_FORMAT',
      message: 'The tax ID must contain 10 digits',
    })

    const legacy = errors.find((e) => e['path'] === 'email')
    expect(legacy).toEqual({ path: 'email', message: 'Некорректный email' })
  })

  it('a message that merely starts with "zod." but is not a real registry code falls back to legacy shape (defensive)', () => {
    const err = new ZodError([{ code: 'custom', path: ['x'], message: 'zod.NOT_A_REAL_CODE' }])
    const host = makeHost('/api/users', 'SENIOR')
    filter.catch(err, host)
    const { body } = capture(host)
    const errors = (body as Record<string, unknown>)['errors'] as Array<Record<string, unknown>>
    expect(errors[0]).toEqual({ path: 'x', message: 'zod.NOT_A_REAL_CODE' })
  })

  it('on a finance-critical route, a migrated issue is still hidden from non-ADMIN (existing info-disclosure guard is unaffected)', () => {
    const host = makeHost('/api/transactions', 'SENIOR')
    filter.catch(mixedZodError(), host)
    const { body } = capture(host)
    expect((body as Record<string, unknown>)['message']).toBe('Invalid request body')
    expect((body as Record<string, unknown>)['errors']).toBeUndefined()
  })
})
