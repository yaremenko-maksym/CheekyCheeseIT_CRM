/**
 * task-drop-payout-currency — security-review PR #521 round 3, LOW-1.
 *
 * `GET /api/finance/exchange-rate?date=` existed before this task, but only
 * server-side callers (always a clean, internally-computed YYYYMMDD string)
 * ever exercised it. The date-of-record feature is the FIRST thing that
 * puts a client-suppliable value on this path — the settle dialog's own
 * preview fetch, and any other caller of this route. Not SSRF (the NBU host
 * is hardcoded in NbuCurrencyService), but an unvalidated value still
 * reaches the upstream URL as-is, which is the same cache-poisoning-shaped
 * risk the round-3 MED fix closes for the trusted internal path.
 */
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { NbuCurrencyService } from './nbu-currency.service'
import { FinanceSummaryController } from './transactions.controller'
import type { TransactionsService } from './transactions.service'

function makeController(): {
  controller: FinanceSummaryController
  getRates: ReturnType<typeof vi.fn>
} {
  const getRates = vi.fn().mockResolvedValue({ usdUah: '41.50', usdtUah: '41.50', eurUah: '44.80' })
  const nbuStub = { getRates } as unknown as NbuCurrencyService
  const svcStub = {} as TransactionsService
  const controller = new FinanceSummaryController(svcStub, nbuStub)
  return { controller, getRates }
}

describe('FinanceSummaryController.getExchangeRate — ?date= validation (LOW-1, security-review PR #521 round 3)', () => {
  it('accepts a well-formed YYYYMMDD date and forwards it verbatim', async () => {
    const { controller, getRates } = makeController()
    await controller.getExchangeRate('20260801')
    expect(getRates).toHaveBeenCalledWith('20260801')
  })

  it('accepts an OMITTED date (defaults to today inside NbuCurrencyService)', async () => {
    const { controller, getRates } = makeController()
    await controller.getExchangeRate(undefined)
    expect(getRates).toHaveBeenCalledWith(undefined)
  })

  // `getExchangeRate` is a SYNCHRONOUS method — the validation throws
  // immediately, not via a rejected Promise — so these use the sync
  // `expect(() => …).toThrow()` form, not `.rejects`.
  it("rejects a date with dashes (the settle dialog's OWN internal format, before it strips them — a real caller mistake this guards against)", () => {
    const { controller, getRates } = makeController()
    expect(() => controller.getExchangeRate('2026-08-01')).toThrow(BadRequestException)
    expect(getRates).not.toHaveBeenCalled()
  })

  it('rejects a non-numeric / malformed string', () => {
    const { controller, getRates } = makeController()
    expect(() => controller.getExchangeRate('not-a-date')).toThrow(BadRequestException)
    expect(getRates).not.toHaveBeenCalled()
  })

  it('rejects a date with the wrong digit count (7 or 9 digits)', () => {
    const { controller } = makeController()
    expect(() => controller.getExchangeRate('2026801')).toThrow(BadRequestException)
    expect(() => controller.getExchangeRate('202608011')).toThrow(BadRequestException)
  })

  it('rejects an empty string (distinct from omitted — an explicit ?date= with no value)', () => {
    const { controller, getRates } = makeController()
    expect(() => controller.getExchangeRate('')).toThrow(BadRequestException)
    expect(getRates).not.toHaveBeenCalled()
  })
})
