import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransactionsService } from './transactions.service'
import { SalaryCronService } from './salary-cron.service'

/**
 * AC1 — SEC-01 salary-cron error handling.
 *
 * The cron handler (handleMonthlySalaries) must:
 *   1. Wrap the entire body in try/catch and log errors via Logger.error
 *      — an unhandled rejection would silently terminate the cron context.
 *   2. Per-row errors in createMonthlySalaries must NOT abort the whole
 *      cycle — failures are collected/logged and processing continues for
 *      the remaining employees (MED-1).
 *
 * These are unit tests: no real DB, only stub TransactionsService.
 */
describe('SalaryCronService — error handling (AC1)', () => {
  let loggerErrorSpy: ReturnType<typeof vi.spyOn>
  let loggerLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Spy on Logger prototype so all Logger instances are captured.
    loggerErrorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    loggerLogSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs an error via Logger.error when createMonthlySalaries throws, but does NOT rethrow', async () => {
    const error = new Error('DB connection lost')
    const txService = {
      createMonthlySalaries: vi.fn().mockRejectedValue(error),
    } as unknown as TransactionsService

    const cron = new SalaryCronService(txService)

    // Must resolve (not reject) — cron must not propagate the error.
    await expect(cron.handleMonthlySalaries()).resolves.toBeUndefined()

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('createMonthlySalaries'),
      expect.anything(),
    )
  })

  it('logs success when createMonthlySalaries resolves normally', async () => {
    const txService = {
      createMonthlySalaries: vi.fn().mockResolvedValue(undefined),
    } as unknown as TransactionsService

    const cron = new SalaryCronService(txService)

    await expect(cron.handleMonthlySalaries()).resolves.toBeUndefined()

    // No error should be logged on success.
    expect(loggerErrorSpy).not.toHaveBeenCalled()
    // At minimum one log call for "done".
    expect(loggerLogSpy).toHaveBeenCalled()
  })

  it('MED-1: cron resolves even when createMonthlySalaries partially logs per-employee errors', async () => {
    // Simulate MED-1 scenario: createMonthlySalaries itself does not throw
    // (the per-employee try/catch inside it absorbed the failures), but it
    // did call Logger.error for the failing employees. The outer cron must
    // still resolve successfully — scheduler is never terminated.
    const txService = {
      createMonthlySalaries: vi.fn().mockImplementation(async () => {
        // Mimic internal per-employee error logging (as MED-1 fix does).
        new Logger('TransactionsService').error('createMonthlySalaries: failed for employee emp-1')
      }),
    } as unknown as TransactionsService

    const cron = new SalaryCronService(txService)

    // Must resolve even though internal errors were logged.
    await expect(cron.handleMonthlySalaries()).resolves.toBeUndefined()

    // Logger.error was called (from within createMonthlySalaries stub) but
    // the cron's own outer catch should NOT have fired (createMonthlySalaries resolved).
    // The cron-level error message contains "cron will retry" — must NOT appear.
    const cronLevelError = loggerErrorSpy.mock.calls.find((args) =>
      String(args[0]).includes('cron will retry'),
    )
    expect(cronLevelError).toBeUndefined()
  })
})

/**
 * task-salary-month-gap-and-status security-review round 3 — the
 * bidirectional-invariant gap.
 *
 * `salary-month-gap.unit.spec.ts` proves the GAP REPORT's default month
 * tracks `previousSalaryMonthKey()`. That alone does NOT prove the CRON's
 * real handler does too — a reviewer proved this by hand: diverging
 * `handleMonthlySalaries` from the shared resolver left EVERY existing test
 * green, because `salary-cron-idempotency.integration.spec.ts` calls
 * `createMonthlySalaries(MONTH)` directly, bypassing `handleMonthlySalaries`
 * entirely — the "cannot drift apart" guarantee rested on both call sites
 * merely IMPORTING the same function, never on a test that would actually
 * catch one of them stopping.
 *
 * This test drives the REAL `handleMonthlySalaries()` entry point (the
 * `@Cron`-decorated method — same one production invokes) with a stubbed
 * `TransactionsService.createMonthlySalaries` that just RECORDS its `month`
 * argument, then asserts that argument against a LITERAL, hardcoded month
 * string for a FIXED, faked system clock — never by calling
 * `previousSalaryMonthKey()` a second time (that would be the exact
 * tautology mutation testing already caught once: `salary-month.util.ts`
 * scored 0.00%, survived `BlockStatement → {}`, because
 * `expect(x).toBe(previousSalaryMonthKey())` compares `undefined` to
 * `undefined` the moment the function body is gutted).
 */
describe('SalaryCronService — handleMonthlySalaries computes the previous month (security-review round 3)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes a LITERAL previous-month string to createMonthlySalaries for a fixed clock — never derived by re-calling previousSalaryMonthKey', async () => {
    vi.useFakeTimers()
    // 2026-08-15 (any day in August) → the cron must target July.
    vi.setSystemTime(new Date(2026, 7, 15))

    let capturedMonth: string | undefined
    const txService = {
      createMonthlySalaries: vi.fn((month: string) => {
        capturedMonth = month
        return Promise.resolve()
      }),
    } as unknown as TransactionsService

    const cron = new SalaryCronService(txService)
    await cron.handleMonthlySalaries()

    expect(capturedMonth).toBe('2026-07')
    expect(txService.createMonthlySalaries).toHaveBeenCalledTimes(1)
  })

  it('rolls over the year boundary — January 2027 clock → the cron targets December 2026', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2027, 0, 1))

    let capturedMonth: string | undefined
    const txService = {
      createMonthlySalaries: vi.fn((month: string) => {
        capturedMonth = month
        return Promise.resolve()
      }),
    } as unknown as TransactionsService

    const cron = new SalaryCronService(txService)
    await cron.handleMonthlySalaries()

    expect(capturedMonth).toBe('2026-12')
  })
})
