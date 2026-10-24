/**
 * SR-795-M-1 / owner decision D-3 — `financeApi.getSalaryParts` asks the right
 * endpoint with the right params, and REFUSES a body that is not the contract.
 *
 * Written because the mutation gate reported the whole method mutable to
 * `() => undefined`, its params object to `{}` and its path to `''` with every
 * test still passing (CR-H-2 / SR-M-2): the component specs mock `financeApi`
 * wholesale, so nothing executed this method's `.parse()` or its URL. A panel
 * whose request silently went to the wrong path would simply never appear —
 * and never appearing is also what an empty month looks like, so the failure
 * would be invisible exactly where it matters.
 *
 * Mirrors `finance-api-cascade-preview.test.ts`, including its static-import
 * note: `vi.mock` is hoisted, and a top-level dynamic import crashes Stryker's
 * runner.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const get = vi.fn()
vi.mock('@/lib/axios', () => ({ api: { get: (...args: unknown[]) => get(...args) } }))

import { financeApi } from '../api'

const RECEIVER = '11111111-1111-4111-8111-111111111111'
const VALID = {
  receiverId: RECEIVER,
  month: '2026-09',
  parts: [
    {
      id: '22222222-2222-4222-8222-000000000001',
      amount: 1500,
      currency: 'USD',
      status: 'PENDING',
      salaryOrigin: 'MANUAL',
      txDate: '2026-09-30T00:00:00.000Z',
      notes: 'part 1',
    },
  ],
}

beforeEach(() => {
  get.mockReset()
})

describe('financeApi.getSalaryParts', () => {
  it('GETs /finance/salary-parts with the receiver and month as params', async () => {
    get.mockResolvedValue({ data: VALID })

    const result = await financeApi.getSalaryParts(RECEIVER, '2026-09')

    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/finance/salary-parts', {
      params: { receiverId: RECEIVER, month: '2026-09' },
    })
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0]?.amount).toBe(1500)
  })

  it('returns the parsed body, not the axios envelope', async () => {
    get.mockResolvedValue({ data: VALID })
    const result = await financeApi.getSalaryParts(RECEIVER, '2026-09')
    expect(result).toEqual(VALID)
    expect(result).not.toHaveProperty('data')
  })

  it('refuses a body that is not the contract', async () => {
    // A status the DTO does not admit. Left unparsed it would reach
    // `STATUS_LABEL_MESSAGES[part.status]` and render `undefined` next to a
    // money figure.
    get.mockResolvedValue({
      data: { ...VALID, parts: [{ ...VALID.parts[0], status: 'CANCELLED' }] },
    })
    await expect(financeApi.getSalaryParts(RECEIVER, '2026-09')).rejects.toThrow()

    get.mockResolvedValue({ data: { receiverId: RECEIVER, month: '2026-09' } })
    await expect(financeApi.getSalaryParts(RECEIVER, '2026-09')).rejects.toThrow()
  })
})
