import { routerConfigSchema, type HostedProvider } from './config'
import { pinnedModelsOnly, type ManagedModels } from './managed-models'
import {
  isOwnCapReached,
  isProviderBlocked,
  isRetired,
  isSpent,
  providerDay,
  providerRecord,
  type RouteStatePort,
} from './state'

/** The readiness answer (ADR Amendment 2026-11-08, H.3). */
export const ROUTER_READINESS = ['READY', 'LIMITS_EXHAUSTED', 'NO_ROUTE'] as const
export type RouterReadiness = (typeof ROUTER_READINESS)[number]

/**
 * How one hosted route stands (H.2): `UNAVAILABLE` (AUTH-disabled, or no model that takes this
 * call's images), `LIMIT` (own cap, the CREDIT bit, or every model it could try spent), `OTHER`
 * (anything transient or caused by the input; for readiness, a route that may answer).
 */
export type RouteEnd = 'UNAVAILABLE' | 'LIMIT' | 'OTHER'

/** H.2: limit-blocked only when the available set is non-empty and every available route is blocked. */
export function allLimitBlocked(ends: readonly RouteEnd[]): boolean {
  const available = ends.filter((e) => e !== 'UNAVAILABLE')
  return available.length > 0 && available.every((e) => e === 'LIMIT')
}

/**
 * The worker's readiness from its own route state only (H.3): spent entries, the CREDIT and AUTH
 * bits, the own-cap counters. It sends no model request and reserves no own-cap unit. A config the
 * router would refuse, or every route AUTH-disabled, is `NO_ROUTE`. Never throws: a failing state or
 * model-list read answers `NO_ROUTE`, which the collection side treats as unreachable.
 */
export async function routerReadiness(
  rawConfig: unknown,
  deps: { routeState: RouteStatePort; managedModels?: ManagedModels; now?: () => number },
): Promise<RouterReadiness> {
  try {
    const parsed = routerConfigSchema.safeParse(rawConfig)
    if (!parsed.success) return 'NO_ROUTE'
    const now = deps.now ?? Date.now
    const managedModels = deps.managedModels ?? pinnedModelsOnly
    const ends: RouteEnd[] = []
    for (const route of parsed.data.routes) {
      const p: HostedProvider = route.provider
      const snap = deps.routeState.snapshot()
      const today = providerDay(p, now())
      if (providerRecord(snap, p).auth) {
        ends.push('UNAVAILABLE')
        continue
      }
      // Not AUTH, so a blocked provider is the CREDIT bit for today.
      if (isProviderBlocked(snap, p, today) || isOwnCapReached(snap, p, route.freeLimit, today)) {
        ends.push('LIMIT')
        continue
      }
      const tryable = (await managedModels(p, route.models)).filter((m) => !isRetired(snap, p, m))
      const spentThrough = tryable.length > 0 && tryable.every((m) => isSpent(snap, p, m, today))
      ends.push(spentThrough ? 'LIMIT' : 'OTHER')
    }
    if (ends.every((e) => e === 'UNAVAILABLE')) return 'NO_ROUTE'
    return allLimitBlocked(ends) ? 'LIMITS_EXHAUSTED' : 'READY'
  } catch {
    return 'NO_ROUTE'
  }
}
