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
 *      the remaining employees.
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
})
