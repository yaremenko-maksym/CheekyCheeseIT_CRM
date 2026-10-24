import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { PayoutRequestsController, TransactionsController } from './transactions.controller'
import type { TransactionsService } from './transactions.service'

/**
 * CR-M-1 — the `backdateReason` passthroughs on `confirmPayout` and
 * `manualConfirmPayout` had no test at any level, so the claim "the no-coverage
 * mutants are pre-existing" did not hold for those new lines.
 *
 * What there is to get wrong here is not the forwarding itself but the
 * CONDITIONAL SPREAD. `exactOptionalPropertyTypes` refuses an explicit
 * `undefined` on an optional property, so each field is spread only when it is
 * neither `undefined` nor `null` — and the schema makes `backdateReason`
 * `.optional().nullable()`, so `null` is a value a real client sends. A mutant
 * that drops the null half, or inverts the condition, changes which keys reach
 * the service: an absent key means "no reason", while `backdateReason: null`
 * reaching the policy would be a key that exists and is empty. Both are
 * asserted below, because `toEqual` on the options object pins the exact key
 * set rather than just the values.
 *
 * The controller is instantiated directly with a stub service — no Nest DI, no
 * HTTP. These routes' RBAC is covered separately by
 * `finance-controller-guards.rbac.integration.spec.ts`; this file is only about
 * what the controller hands the service.
 */

const ADMIN = { id: 'admin-1', role: 'ADMIN' } as SessionUser
const PAYOUT_ID = 'payout-tx-1'
const RECIPIENT = 'a0000000-0000-4000-8000-000000000001'
const HASH = `0x${'ab12'.repeat(16)}`

function build() {
  const confirmPayout = vi.fn().mockResolvedValue({ payout: null, confirmed: null })
  const manualConfirmPayout = vi.fn().mockResolvedValue(undefined)
  const svc = { confirmPayout, manualConfirmPayout } as unknown as TransactionsService
  // `confirmPayout` is a /transactions route; `manualConfirm` is a
  // /payout-requests one, so they live on two controllers over the same service.
  return {
    ctrl: new TransactionsController(svc),
    payoutCtrl: new PayoutRequestsController(svc),
    confirmPayout,
    manualConfirmPayout,
  }
}

/** The options object the controller passed as its 4th / 3rd argument. */
const optionsOf = (spy: ReturnType<typeof vi.fn>, argIndex: number) =>
  spy.mock.calls[0]![argIndex] as Record<string, unknown>

describe('TransactionsController.confirmPayout — backdateReason passthrough', () => {
  it('forwards a supplied reason alongside the date', () => {
    const { ctrl, confirmPayout } = build()
    ctrl.confirmPayout(
      PAYOUT_ID,
      {
        recipientAdminId: RECIPIENT,
        method: 'CASH',
        txDate: '2026-06-10',
        backdateReason: 'cash handed over in January',
      },
      ADMIN,
    )
    expect(optionsOf(confirmPayout, 3)).toEqual({
      method: 'CASH',
      txDate: '2026-06-10',
      backdateReason: 'cash handed over in January',
    })
  })

  it('omits the key entirely when no reason is sent', () => {
    const { ctrl, confirmPayout } = build()
    ctrl.confirmPayout(
      PAYOUT_ID,
      { recipientAdminId: RECIPIENT, method: 'CASH', txDate: '2026-06-10' },
      ADMIN,
    )
    const options = optionsOf(confirmPayout, 3)
    expect(options).not.toHaveProperty('backdateReason')
    expect(options).toEqual({ method: 'CASH', txDate: '2026-06-10' })
  })

  it('omits the key when the client sends an explicit null, rather than forwarding null', () => {
    const { ctrl, confirmPayout } = build()
    ctrl.confirmPayout(
      PAYOUT_ID,
      { recipientAdminId: RECIPIENT, method: 'CASH', txDate: '2026-06-10', backdateReason: null },
      ADMIN,
    )
    expect(optionsOf(confirmPayout, 3)).not.toHaveProperty('backdateReason')
  })

  it('forwards a reason even with no date — the policy, not the controller, decides whether it is usable', () => {
    const { ctrl, confirmPayout } = build()
    ctrl.confirmPayout(
      PAYOUT_ID,
      { recipientAdminId: RECIPIENT, method: 'CRYPTO', txHash: HASH, backdateReason: 'late' },
      ADMIN,
    )
    const options = optionsOf(confirmPayout, 3)
    expect(options['backdateReason']).toBe('late')
    expect(options).not.toHaveProperty('txDate')
  })
})

describe('TransactionsController.manualConfirm — backdateReason passthrough', () => {
  it('forwards a supplied reason alongside the date and note', () => {
    const { payoutCtrl, manualConfirmPayout } = build()
    payoutCtrl.manualConfirm(
      PAYOUT_ID,
      {
        method: 'CASH',
        note: 'wired',
        txDate: '2026-06-10',
        backdateReason: 'settled offline in Q1',
      },
      ADMIN,
    )
    expect(optionsOf(manualConfirmPayout, 3)).toEqual({
      note: 'wired',
      txDate: '2026-06-10',
      backdateReason: 'settled offline in Q1',
    })
  })

  it('omits the key when no reason is sent', () => {
    const { payoutCtrl, manualConfirmPayout } = build()
    payoutCtrl.manualConfirm(PAYOUT_ID, { method: 'CASH', txDate: '2026-06-10' }, ADMIN)
    expect(optionsOf(manualConfirmPayout, 3)).not.toHaveProperty('backdateReason')
  })

  it('omits the key when the client sends an explicit null', () => {
    const { payoutCtrl, manualConfirmPayout } = build()
    payoutCtrl.manualConfirm(
      PAYOUT_ID,
      { method: 'CASH', txDate: '2026-06-10', backdateReason: null },
      ADMIN,
    )
    expect(optionsOf(manualConfirmPayout, 3)).not.toHaveProperty('backdateReason')
  })
})
