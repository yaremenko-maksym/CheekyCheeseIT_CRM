import type { JobMeterReservationStatus, JobMeterUnit } from '@crm/shared'
import type { ReservationResolution } from '../providers/reporting-provider'

/**
 * The reservation state machine of the shared account meter (r5 Task 3.5a), as pure decisions.
 * `account-meter.store.ts` applies them under the meter + reservation row locks; keeping the
 * decisions here is what lets the unit suite (and so the mutation gate) see every branch.
 *
 *   RESERVED --markSent--> SENT
 *   RESERVED | SENT  --> USED | UNCERTAIN
 *   RESERVED         --> RELEASED          (only provably unsent cost is released)
 *   UNCERTAIN        --> USED              (reconciliation; exactly once)
 *   X --> X is a no-op; every other move is illegal.
 */

export type SettlementPlan =
  | { kind: 'noop' }
  | { kind: 'illegal' }
  | {
      kind: 'apply'
      /** Which meter counter currently holds this reservation's amount. */
      releaseFrom: 'reserved' | 'uncertain'
      /** Move the amount into `uncertain` (a hold until reconciliation). */
      addUncertain: boolean
      /** Add the amount to `used` — only for a reservation of the meter's CURRENT window. */
      addUsed: boolean
      /** Record that the request left (if not already recorded). */
      stampSent: boolean
      stampSettled: boolean
      /** Write `used_amount = amount` on the reservation row. */
      recordUsed: boolean
    }

export function planSettlement(
  from: JobMeterReservationStatus,
  to: ReservationResolution,
  inCurrentWindow: boolean,
): SettlementPlan {
  if (from === to) return { kind: 'noop' }
  const legal =
    from === 'RESERVED' ||
    (from === 'SENT' && to !== 'RELEASED') ||
    (from === 'UNCERTAIN' && to === 'USED')
  if (!legal) return { kind: 'illegal' }
  return {
    kind: 'apply',
    releaseFrom: from === 'UNCERTAIN' ? 'uncertain' : 'reserved',
    addUncertain: to === 'UNCERTAIN',
    addUsed: to === 'USED' && inCurrentWindow,
    stampSent: to !== 'RELEASED',
    stampSettled: to !== 'UNCERTAIN',
    recordUsed: to === 'USED',
  }
}

/**
 * What the cost a caller says was ACTUALLY incurred means for a settlement, as a pure decision.
 * `null` = acceptable. The two faults are different defects and are named apart:
 *
 * - `EXCEEDS_RESERVATION`: more than was reserved. The bound is the reservation, never the
 *   caller's say-so, and it is refused rather than clamped: a clamp would write a ledger that
 *   claims less than the provider charged and nobody would see the difference.
 * - `CONTRADICTS_SETTLEMENT`: the reservation already settled (a no-op), at a different amount.
 *   The first conversion wins and is final, so a second claim that disagrees is refused rather
 *   than silently dropped — a worker that is told "fine" believes a figure the ledger does not hold.
 */
export type IncurredFault = 'EXCEEDS_RESERVATION' | 'CONTRADICTS_SETTLEMENT'

export function incurredFault(
  plan: SettlementPlan['kind'],
  incurred: number | undefined,
  reserved: number,
  recorded: number,
): IncurredFault | null {
  if (incurred === undefined) return null
  if (plan === 'noop') return incurred === recorded ? null : 'CONTRADICTS_SETTLEMENT'
  if (plan === 'apply' && incurred > reserved) return 'EXCEEDS_RESERVATION'
  return null
}

export function planMarkSent(from: JobMeterReservationStatus): 'apply' | 'noop' | 'illegal' {
  if (from === 'RESERVED') return 'apply'
  if (from === 'SENT') return 'noop'
  return 'illegal'
}

/**
 * A reservation belongs to the meter's current window iff it was taken at or after the window
 * start. A meter with no window start (LIFETIME) has a single window.
 */
export function isInCurrentWindow(windowStartedAt: Date | null, reservedAt: Date): boolean {
  return windowStartedAt === null || reservedAt.getTime() >= windowStartedAt.getTime()
}

/** `#` is the separator, which is why a metered attempt id may not contain one. */
export const reservationKeyPrefix = (attemptId: string, unit: JobMeterUnit) =>
  `${attemptId}#${unit}#`

export const reservationKey = (attemptId: string, unit: JobMeterUnit, ordinal: number) =>
  `${reservationKeyPrefix(attemptId, unit)}${ordinal}`
