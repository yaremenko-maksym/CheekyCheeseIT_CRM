import { HOSTED_PROVIDERS, type ExtractionWorkerReply } from '@crm/inference'
import { z } from 'zod'
import { MODEL_ROUTE_VALUES, type ModelHealthFlag, type ModelRoute } from '../../database/schema'
import { JOB_ERROR_CODE_PATTERN } from '../../database/schema/job-patterns'

export type RouteCount = { day: string; route: ModelRoute; code: string; count: number }

/** The durable side of ADR §5.3. Every call may fail; the handler below absorbs it. */
export type ModelHealthStore = {
  addRouteCounts(rows: RouteCount[]): Promise<void>
  raiseFlag(flag: ModelHealthFlag): Promise<void>
  clearFlag(flag: ModelHealthFlag): Promise<void>
  /** The raised flags not yet emitted for this cycle, marked as emitted in the same step. */
  claimEmissions(cycleId: string): Promise<ModelHealthFlag[]>
}

export type ModelHealthLog = { error(line: string): void; warn(line: string): void }

// The reply is untrusted (ADR §2.4): nothing reaches a counter or a log line unchecked.
const attemptSchema = z.looseObject({
  route: z.enum(MODEL_ROUTE_VALUES),
  code: z.string().regex(new RegExp(JOB_ERROR_CODE_PATTERN)),
})
const disabledSchema = z.looseObject({
  route: z.enum(HOSTED_PROVIDERS),
  code: z.enum(['AUTH', 'CREDIT']),
})

export type ModelHealthCycle = {
  /** Health only: the preflight runs a local-only config, so its own `FELL_TO_LOCAL` is no fall. */
  onPreflightReply(reply: ExtractionWorkerReply): void
  onReply(reply: ExtractionWorkerReply): void
  preflightDone(reached: boolean): Promise<void>
  finish(): Promise<void>
}

/**
 * The collection-side consumer of the worker's replies (ADR §5.3, SR-M-3 from PR #1275). Lines carry
 * fixed codes only. A failed write logs and moves on, so it can never change an extraction result.
 * The once-per-process memory lives here because the wiring is built once per process.
 */
export function createModelHealth(deps: { store: ModelHealthStore; log: ModelHealthLog }): {
  beginCycle(cycleId: string): ModelHealthCycle
} {
  const { store, log } = deps
  const disabledSeen = new Set<string>()

  const safely = async <T>(op: string, write: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await write()
    } catch {
      log.error(`MODEL_HEALTH_WRITE_FAILED op=${op}`)
      return undefined
    }
  }
  const setFlag = (flag: ModelHealthFlag, raised: boolean) =>
    raised
      ? safely('RAISE_FLAG', () => store.raiseFlag(flag))
      : safely('CLEAR_FLAG', () => store.clearFlag(flag))

  return {
    beginCycle(cycleId) {
      const counts = new Map<string, Omit<RouteCount, 'day'>>()
      let hostedSeen = false
      let hostedOk = false
      let health: ExtractionWorkerReply['health'] | undefined

      const count = (route: ModelRoute, code: string) => {
        const key = `${route}/${code}`
        const row = counts.get(key) ?? { route, code, count: 0 }
        row.count += 1
        counts.set(key, row)
      }

      const onEvent = (event: ExtractionWorkerReply['events'][number]) => {
        if (event.type === 'FELL_TO_LOCAL') {
          count('local', 'FELL_TO_LOCAL')
          // A local-only config names no hosted route, and has none to call dead.
          if (Array.isArray(event.reasons) && event.reasons.length > 0) hostedSeen = true
        } else if (event.type === 'ATTEMPT') {
          const attempt = attemptSchema.safeParse(event)
          if (!attempt.success) {
            log.error('MODEL_REPLY_EVENT_REFUSED type=ATTEMPT')
          } else if (attempt.data.route !== 'local') {
            count(attempt.data.route, attempt.data.code)
            if (attempt.data.code === 'OK') hostedOk = true
            // An aborted call says nothing about the route (ADR §5.5 item 3).
            if (attempt.data.code !== 'ABORTED') hostedSeen = true
          }
        } else if (event.type === 'PROVIDER_DISABLED') {
          const disabled = disabledSchema.safeParse(event)
          if (!disabled.success) {
            log.error('MODEL_REPLY_EVENT_REFUSED type=PROVIDER_DISABLED')
            return
          }
          hostedSeen = true
          const line = `MODEL_PROVIDER_DISABLED route=${disabled.data.route} code=${disabled.data.code}`
          if (!disabledSeen.has(line)) log.error(line)
          disabledSeen.add(line)
        }
      }

      const applyHealth = async () => {
        if (health === undefined) return
        await setFlag('MODEL_LIST_STALE', health.modelListStale)
        await setFlag('FAILED_JOB_DAILY', health.failedJobs.includes('daily'))
        await setFlag('FAILED_JOB_CHAIN', health.failedJobs.includes('chain'))
      }

      // A log line is the emission (ADR §5.3 (c)); alerts to admins are out of this task's scope.
      const emit = async () => {
        const flags = await safely('CLAIM_EMISSIONS', () => store.claimEmissions(cycleId))
        for (const flag of flags ?? []) log.warn(`MODEL_HEALTH_FLAG flag=${flag}`)
      }

      return {
        onPreflightReply: (reply) => {
          health = reply.health
        },
        onReply: (reply) => {
          health = reply.health
          reply.events.forEach(onEvent)
        },
        preflightDone: async (reached) => {
          await setFlag('MODEL_UNREACHABLE', !reached)
          await applyHealth()
          await emit()
        },
        finish: async () => {
          // shortcut: counters are written here, not per reply, so a crashed cycle loses its own
          // counts and a reply landing after finish() (an abandoned call) is not counted; upgrade to
          // a write per reply if a decision ever rests on the exact count.
          const day = new Date().toISOString().slice(0, 10)
          const rows = [...counts.values()].map((row) => ({ day, ...row }))
          counts.clear()
          if (rows.length > 0) await safely('ADD_ROUTE_COUNTS', () => store.addRouteCounts(rows))
          if (hostedOk) await setFlag('HOSTED_ROUTES_DEAD', false)
          else if (hostedSeen) await setFlag('HOSTED_ROUTES_DEAD', true)
          await applyHealth()
          await emit()
        },
      }
    },
  }
}
