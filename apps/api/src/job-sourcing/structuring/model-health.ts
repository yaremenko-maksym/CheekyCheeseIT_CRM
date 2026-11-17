import {
  ATTEMPT_CODES,
  HOSTED_PROVIDERS,
  type ExtractionWorkerReply,
  type WorkerReadiness,
} from '@crm/inference'
import { kyivToday } from '@crm/shared'
import { z } from 'zod'
import { MODEL_ROUTE_VALUES, type ModelHealthFlag, type ModelRoute } from '../../database/schema'
import { boundedWrite } from '../runtime/bounded-write'

/** A write that never settles must not hold a cycle (`prepareCycle`, `finish`) behind it. */
export const MODEL_HEALTH_WRITE_TIMEOUT_MS = 5_000
/** Below the client wait: the server cancels a write before the client stops waiting for it. */
export const MODEL_HEALTH_SERVER_TIMEOUT_MS = MODEL_HEALTH_WRITE_TIMEOUT_MS - 2_000

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
  code: z.enum(ATTEMPT_CODES),
})
const disabledSchema = z.looseObject({
  route: z.enum(HOSTED_PROVIDERS),
  code: z.enum(['AUTH', 'CREDIT']),
})
/**
 * Limit codes count toward `MODEL_LIMITS_EXHAUSTED` only, never `HOSTED_ROUTES_DEAD` (H.2): one cause,
 * one flag. A limit clears itself at the provider reset; a dead route needs the owner.
 */
const LIMIT_CODE_LIST = ['CAP', 'SPENT_DAY', 'CREDIT'] as const
const LIMIT_CODES: ReadonlySet<string> = new Set(LIMIT_CODE_LIST)
/**
 * The `EXHAUSTED` reasons that say nothing of a dead route: a limit (H.2), or a `FIT` skip that asked
 * the route nothing. Any other reason, a malformed one, an empty, absent or non-array `reasons` is
 * evidence: a malformed event must never hide a dead route (SR-L-1).
 */
const harmlessReasonSchema = z.looseObject({
  route: z.enum(HOSTED_PROVIDERS),
  code: z.enum([...LIMIT_CODE_LIST, 'FIT']),
})
const isDeadEvidence = (reasons: unknown): boolean =>
  !Array.isArray(reasons) ||
  reasons.length === 0 ||
  reasons.some((r) => !harmlessReasonSchema.safeParse(r).success)
// The router sends `servedModel` only on a 2xx RETIRED; its 404 shape has none and is no refusal.
const answeredRetiredSchema = z.looseObject({
  route: z.enum(HOSTED_PROVIDERS),
  servedModel: z.string().min(1),
})

export type ModelHealthCycle = {
  /** Health only: the readiness preflight asks no model (H.3), so its reply carries no route evidence. */
  onPreflightReply(reply: ExtractionWorkerReply): void
  onReply(reply: ExtractionWorkerReply): void
  /** The port result of one model call: a success or the H.2 stop moves `MODEL_LIMITS_EXHAUSTED`. */
  onResult(result: { ok: boolean; code?: string }): void
  preflightDone(readiness: WorkerReadiness['readiness']): Promise<void>
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
      // A write still queued for a pool connection when the wait ends can run later, so the line
      // below means "not confirmed"; a stale flag is repaired by that flag's next write. A late
      // claim marks flags emitted with no log line: that cycle's emission is lost, the next re-emits.
      return await boundedWrite(write(), MODEL_HEALTH_WRITE_TIMEOUT_MS)
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
      let callOk = false
      let limitsHit = false
      let health: ExtractionWorkerReply['health'] | undefined

      const count = (route: ModelRoute, code: string) => {
        const key = `${route}/${code}`
        const row = counts.get(key) ?? { route, code, count: 0 }
        row.count += 1
        counts.set(key, row)
      }

      const onEvent = (event: ExtractionWorkerReply['events'][number]) => {
        if (event.type === 'ATTEMPT') {
          const attempt = attemptSchema.safeParse(event)
          // A `local` attempt is read but never counted: the route left in H1, yet a pre-H1 worker
          // still sends it during a deploy, and the DB CHECK keeps `local` for historic rows.
          if (!attempt.success) {
            log.error('MODEL_REPLY_EVENT_REFUSED type=ATTEMPT')
          } else if (attempt.data.route !== 'local') {
            count(attempt.data.route, attempt.data.code)
            if (attempt.data.code === 'OK') hostedOk = true
            // An aborted call says nothing about the route (ADR §5.5 item 3), a limit says it is
            // limited, not dead (H.2).
            const code = attempt.data.code
            if (code !== 'ABORTED' && !LIMIT_CODES.has(code)) hostedSeen = true
          }
        } else if (event.type === 'EXHAUSTED') {
          if (isDeadEvidence(event['reasons'])) hostedSeen = true
        } else if (event.type === 'RETIRED') {
          if (answeredRetiredSchema.safeParse(event).success) hostedOk = true
        } else if (event.type === 'PROVIDER_DISABLED') {
          const disabled = disabledSchema.safeParse(event)
          if (!disabled.success) {
            log.error('MODEL_REPLY_EVENT_REFUSED type=PROVIDER_DISABLED')
            return
          }
          if (!LIMIT_CODES.has(disabled.data.code)) hostedSeen = true
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
        onResult: (result) => {
          if (result.ok) callOk = true
          else if (result.code === 'LIMITS_EXHAUSTED') limitsHit = true
        },
        preflightDone: async (readiness) => {
          // NO_ROUTE or no answer: the worker or its routes (H.3). Neither says anything of limits.
          await setFlag(
            'MODEL_UNREACHABLE',
            readiness === 'NO_ROUTE' || readiness === 'UNREACHABLE',
          )
          if (readiness === 'READY' || readiness === 'LIMITS_EXHAUSTED') {
            await setFlag('MODEL_LIMITS_EXHAUSTED', readiness === 'LIMITS_EXHAUSTED')
          }
          await applyHealth()
          await emit()
        },
        finish: async () => {
          // shortcut: the counters, the hosted evidence and the replies' health codes are written
          // only here. A cycle that never calls finish() loses all three: the next finished cycle
          // repairs the flags, the counts stay lost. A reply landing after finish() (an abandoned
          // call) is not counted, and a failed addRouteCounts write loses that cycle's counts (best
          // effort, by decision). Upgrade to a write per reply if a decision ever rests on the
          // exact count.
          const day = kyivToday()
          const rows = [...counts.values()].map((row) => ({ day, ...row }))
          counts.clear()
          if (rows.length > 0) await safely('ADD_ROUTE_COUNTS', () => store.addRouteCounts(rows))
          if (hostedOk) await setFlag('HOSTED_ROUTES_DEAD', false)
          else if (hostedSeen) await setFlag('HOSTED_ROUTES_DEAD', true)
          // The stop latches the cycle, so it is the cycle's last word over an earlier success.
          if (limitsHit) await setFlag('MODEL_LIMITS_EXHAUSTED', true)
          else if (callOk) await setFlag('MODEL_LIMITS_EXHAUSTED', false)
          await applyHealth()
          await emit()
        },
      }
    },
  }
}
