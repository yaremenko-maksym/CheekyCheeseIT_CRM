/**
 * task-cascade-preview-ui (task 5) — `financeApi.getEditCascadePreview` asks
 * the right endpoint and REFUSES a body that is not the contract.
 *
 * The `.parse()` in that method is the whole point of it existing rather than
 * the component calling `api.get` inline: a plan that reached the panel
 * malformed would render `undefined` where a money figure belongs. Every other
 * spec in this task mocks `financeApi` wholesale, so without this file the
 * parse is never executed by anything — and it is the one line whose removal is
 * invisible until a server change makes it matter.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const get = vi.fn()
// `vi.mock` is hoisted above the import below, so a STATIC import is correct
// here. A top-level `await import(...)` also works under plain vitest but
// crashes Stryker's runner on the initial test run («Cannot convert object to
// primitive value») — measured, and the reason this is written the plain way.
vi.mock('@/lib/axios', () => ({ api: { get: (...args: unknown[]) => get(...args) } }))

import { financeApi } from '../api'

const VALID = {
  editable: true,
  blockedReason: null,
  plan: {
    sourceId: '11111111-1111-4111-8111-111111111111',
    sourceAmountChanged: true,
    oldSourceAmount: 20000,
    newSourceAmount: 25000,
    sourceCurrency: 'USDT',
    derivatives: [],
    sourceWarnings: [],
  },
  version: 'v1',
}

beforeEach(() => {
  get.mockReset()
})

describe('financeApi.getEditCascadePreview', () => {
  it('API-1. asks the row-scoped preview endpoint with the proposed amount', async () => {
    get.mockResolvedValue({ data: VALID })

    await financeApi.getEditCascadePreview('tx-1', 25000)

    expect(get).toHaveBeenCalledWith('/transactions/tx-1/edit-preview', {
      params: { amount: 25000 },
    })
  })

  it('API-2. returns the parsed plan', async () => {
    get.mockResolvedValue({ data: VALID })

    const result = await financeApi.getEditCascadePreview('tx-1', 25000)

    expect(result.version).toBe('v1')
    expect(result.plan?.newSourceAmount).toBe(25000)
  })

  it('API-3. rejects a response that is not the contract, instead of rendering it', async () => {
    // `newSourceAmount` as a string is exactly the shape that would reach the
    // panel and print «25000» while every arithmetic around it silently became
    // string concatenation.
    get.mockResolvedValue({ data: { ...VALID, plan: { ...VALID.plan, newSourceAmount: '25000' } } })

    await expect(financeApi.getEditCascadePreview('tx-1', 25000)).rejects.toThrow()
  })
})
