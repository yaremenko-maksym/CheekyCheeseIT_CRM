/**
 * Unit tests for AuditInterceptor — no DB, no NestJS runtime.
 *
 * Strategy: mock AuditLogService and UsersService with vi.fn(), then call
 * `intercept()` directly and await the Observable the handler emits.
 * The tests verify п.2: when legalFullName changes, two audit records are
 * written — one `legal_name_change` and one generic action — and both carry
 * the redacted token (п.1 enforced by the real AuditLogService.diff).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { of, lastValueFrom } from 'rxjs'
import type { CallHandler, ExecutionContext } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import { AuditInterceptor } from './audit.interceptor'
import { AuditLogService, REDACTED_TOKEN } from '../../users/audit-log.service'
import type { AuditChange } from '@crm/shared'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-uuid',
    email: 'test@example.com',
    displayName: 'Test User',
    role: 'SENIOR',
    legalFullName: 'Іваненко Іван',
    phone: null,
    telegram: null,
    googleId: 'gid',
    walletUsdtErc20: null,
    walletUsdtLabel: null,
    bankUahRecipient: null,
    bankUahIban: null,
    bankUahRnokpp: null,
    bankUahBankName: null,
    ...overrides,
  }
}

function makeExecutionContext(userId: string, targetId?: string): ExecutionContext {
  const request = {
    user: { id: userId, role: 'ADMIN' },
    params: targetId ? { id: targetId } : {},
  }
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
  } as unknown as ExecutionContext
}

function makeCallHandler(): CallHandler {
  return { handle: () => of('response') }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

describe('AuditInterceptor — legal_name_change (п.2)', () => {
  let interceptor: AuditInterceptor
  let auditLogService: AuditLogService
  let usersService: { findById: ReturnType<typeof vi.fn> }
  let reflector: Reflector
  let recordSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    recordSpy = vi.fn().mockResolvedValue(undefined)

    // Use the real AuditLogService.diff to get correct PII-redaction (п.1)
    // but mock only the DB-dependent `record()` method.
    auditLogService = new AuditLogService(null as never)
    auditLogService.record = recordSpy

    usersService = { findById: vi.fn() }

    reflector = {
      get: vi.fn().mockReturnValue('profile_edit'),
    } as unknown as Reflector

    interceptor = new AuditInterceptor(reflector, auditLogService, usersService as never)
  })

  it('writes two records when legalFullName changes: legal_name_change then generic', async () => {
    const before = makeUser({ legalFullName: 'Іваненко Іван' })
    const after = makeUser({ legalFullName: 'Петренко Петро' })

    usersService.findById
      .mockResolvedValueOnce(before) // snapshot before
      .mockResolvedValueOnce(after) // snapshot after

    const ctx = makeExecutionContext('actor-uuid', 'user-uuid')
    const observable = await interceptor.intercept(ctx, makeCallHandler())
    await lastValueFrom(observable)

    expect(recordSpy).toHaveBeenCalledTimes(2)

    // First call: dedicated legal_name_change
    const firstCall = recordSpy.mock.calls[0]![0] as {
      action: string
      changes: Record<string, AuditChange>
    }
    expect(firstCall.action).toBe('legal_name_change')
    expect(firstCall.changes).toHaveProperty('legalFullName')
    // Values must be redacted (п.1 enforced by real diff())
    expect(firstCall.changes['legalFullName']!.before).toBe(REDACTED_TOKEN)
    expect(firstCall.changes['legalFullName']!.after).toBe(REDACTED_TOKEN)

    // Second call: generic profile_edit
    const secondCall = recordSpy.mock.calls[1]![0] as {
      action: string
      changes: Record<string, AuditChange>
    }
    expect(secondCall.action).toBe('profile_edit')
    expect(secondCall.changes).toHaveProperty('legalFullName')
    expect(secondCall.changes['legalFullName']!.before).toBe(REDACTED_TOKEN)
    expect(secondCall.changes['legalFullName']!.after).toBe(REDACTED_TOKEN)
  })

  it('writes only one record when legalFullName does NOT change', async () => {
    const before = makeUser({ displayName: 'Old Name', legalFullName: 'Іваненко Іван' })
    const after = makeUser({ displayName: 'New Name', legalFullName: 'Іваненко Іван' })

    usersService.findById.mockResolvedValueOnce(before).mockResolvedValueOnce(after)

    const ctx = makeExecutionContext('actor-uuid', 'user-uuid')
    const observable = await interceptor.intercept(ctx, makeCallHandler())
    await lastValueFrom(observable)

    expect(recordSpy).toHaveBeenCalledTimes(1)
    const call = recordSpy.mock.calls[0]![0] as { action: string }
    expect(call.action).toBe('profile_edit')
  })

  it('writes zero records when nothing changed', async () => {
    const user = makeUser()
    usersService.findById.mockResolvedValueOnce(user).mockResolvedValueOnce(user)

    const ctx = makeExecutionContext('actor-uuid', 'user-uuid')
    const observable = await interceptor.intercept(ctx, makeCallHandler())
    await lastValueFrom(observable)

    // record() early-returns on empty changes — it is never called
    expect(recordSpy).not.toHaveBeenCalled()
  })

  it('skips interception when no action decorator found', async () => {
    ;(reflector.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined)

    usersService.findById.mockResolvedValue(makeUser())

    const ctx = makeExecutionContext('actor-uuid', 'user-uuid')
    const observable = await interceptor.intercept(ctx, makeCallHandler())
    await lastValueFrom(observable)

    expect(recordSpy).not.toHaveBeenCalled()
  })

  it('legal_name_change entry contains ONLY legalFullName in its changes map', async () => {
    const before = makeUser({ legalFullName: 'Іваненко Іван', displayName: 'Same' })
    const after = makeUser({ legalFullName: 'Петренко Петро', displayName: 'Same' })

    usersService.findById.mockResolvedValueOnce(before).mockResolvedValueOnce(after)

    const ctx = makeExecutionContext('actor-uuid', 'user-uuid')
    const observable = await interceptor.intercept(ctx, makeCallHandler())
    await lastValueFrom(observable)

    const firstCall = recordSpy.mock.calls[0]![0] as {
      action: string
      changes: Record<string, AuditChange>
    }
    expect(firstCall.action).toBe('legal_name_change')
    expect(Object.keys(firstCall.changes)).toEqual(['legalFullName'])
  })

  // ── MED-3: best-effort audit — record() failure must not propagate ────────

  it('MED-3: returns response even when record() throws (best-effort audit)', async () => {
    // Simulate DB outage: record() always rejects
    recordSpy.mockRejectedValue(new Error('DB connection lost'))

    const before = makeUser({ displayName: 'Old Name' })
    const after = makeUser({ displayName: 'New Name' })

    usersService.findById.mockResolvedValueOnce(before).mockResolvedValueOnce(after)

    // Spy on logger.error to verify the error is logged (not silently swallowed)
    const loggerErrorSpy = vi.spyOn(interceptor['logger'], 'error').mockImplementation(() => {})

    const ctx = makeExecutionContext('actor-uuid', 'user-uuid')
    const observable = await interceptor.intercept(ctx, makeCallHandler())

    // Must resolve without throwing even though record() failed
    const result = await lastValueFrom(observable)
    expect(result).toBe('response')

    // Error must be logged loudly
    expect(loggerErrorSpy).toHaveBeenCalledOnce()
    expect(loggerErrorSpy.mock.calls[0]![0]).toContain('Failed to persist audit record')
  })
})
