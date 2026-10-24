import type { JobMeterUnit } from '@crm/shared'
import type {
  CollectionContext,
  MeterReservation,
  ReservationResolution,
} from '../job-sourcing/providers/reporting-provider'
import type { FakeContext } from './fake-collection-context'

/**
 * The metered half of a collection context for the quota adapters' specs: a meter that RECORDS,
 * in one ordered log shared with the fetch seam, so "reserve before markSent before fetch before
 * reconcile" is an assertion about a sequence rather than about four separate counters.
 *
 * It records and refuses; it does not account. Counter VALUES (used / reserved / uncertain) are
 * asserted against the real store in the quota adapters' integration spec, because a fake that
 * re-implemented the arithmetic would be a second implementation to keep in step.
 */

export interface MeteredHarness {
  ctx: CollectionContext
  /** `reserve`, `markSent`, `fetch`, `reconcile:<resolution>` in the order they happened. */
  events: string[]
  reserved: Array<{ unit: JobMeterUnit; amount: number }>
  settled: Array<{ id: string; resolution: ReservationResolution; incurred?: number }>
}

export function meteredContext(
  f: FakeContext,
  opts: {
    /** Registered secrets the worker would pass. Default none: the adapter must add its own. */
    secrets?: readonly string[]
    /** The Nth `reserve` (1-based) is refused, as a spent budget is. */
    refuseOnReserve?: number
  } = {},
): MeteredHarness {
  const events: string[] = []
  const reserved: MeteredHarness['reserved'] = []
  const settled: MeteredHarness['settled'] = []
  let reserves = 0
  const ctx: CollectionContext = {
    ...f.ctx,
    secrets: opts.secrets ?? [],
    async fetchText(request) {
      events.push('fetch')
      return f.ctx.fetchText(request)
    },
    meter: {
      async reserve(unit, amount): Promise<MeterReservation | null> {
        reserves += 1
        events.push('reserve')
        reserved.push({ unit, amount })
        if (opts.refuseOnReserve === reserves) return null
        return { id: `res-${reserves}`, unit, amount }
      },
      async markSent() {
        events.push('markSent')
      },
      async reconcile(reservation, resolution, incurred) {
        events.push(`reconcile:${resolution}`)
        settled.push({
          id: reservation.id,
          resolution,
          ...(incurred === undefined ? {} : { incurred }),
        })
      },
    },
  }
  return { ctx, events, reserved, settled }
}
