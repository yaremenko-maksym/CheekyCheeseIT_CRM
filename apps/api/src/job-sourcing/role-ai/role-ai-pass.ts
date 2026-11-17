import { type JobSourceType, sortRoles, type TechnicalRole } from '@crm/shared'
import { dbErrorLogSuffix, strictErrorStack } from '../../database/pg-errors'
import type { MeterDb } from '../metering/account-meter.store'
import { unavailableOrigin, type Unavailable } from '../../resumes/verification/inference-clients'
import { ROLE_CLASSIFIER_VERSION } from '../funnel/role-classifier'
import { createRoleAiStore } from './role-ai.store'
import {
  ROLE_AI_PROVIDER,
  type RoleAiReply,
  type RoleClassifierInput,
} from './role-classifier.client'

/** Vacancies one pass sends to the model at most (a bounded pass: the backlog waits for the next). */
export const ROLE_AI_PASS_LIMIT = 20
/** An answer below this confidence, or with no role, is UNCLEAR. */
export const ROLE_AI_MIN_CONFIDENCE = 0.7
/** Every 10 minutes. */
export const ROLE_AI_CRON = '*/10 * * * *'
/** The dirty-work reason the pass enqueues: the MATCH consumer (no partition prefix) re-installs. */
export const ROLE_AI_REASON = `ROLE_AI:${ROLE_CLASSIFIER_VERSION}`

/**
 * Failed calls one key gets at most (SR-L-1): past it the row is no candidate and stays PENDING; a
 * classifier version bump gives it a new key. Ten attempts span about four days of backoff.
 */
export const ROLE_AI_MAX_ATTEMPTS = 10
/** Thrown candidates in a row that stop the pass: a broken store, not one poison row. */
export const ROLE_AI_MAX_CONSECUTIVE_ERRORS = 3

const BACKOFF_BASE_MS = 15 * 60_000
const BACKOFF_CAP_MS = 24 * 60 * 60_000

/** The wait after a failed call, in ms: 15 minutes doubled per earlier attempt, at most 24 hours. */
export const ROLE_AI_BACKOFF = (attempts: number): number =>
  Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_CAP_MS)

/** A PENDING vacancy with its full text (the store's candidate predicate guarantees it). */
export type RoleAiCandidate = {
  id: string
  title: string
  titleKey: string
  descriptionSha256: string | null
  description: string
  categories: readonly string[]
}

export type RoleAiTerminal = {
  outcome: 'AI' | 'UNCLEAR'
  roles: readonly TechnicalRole[]
  confidence: number | null
}

/** The pass's SQL, behind a port so the loop below is unit-tested (`role-ai.store.ts`). */
export type RoleAiStore = {
  candidates(now: Date, limit: number): Promise<readonly RoleAiCandidate[]>
  /** The terminal cache row for the candidate's key, or null. */
  cached(c: RoleAiCandidate): Promise<RoleAiTerminal | null>
  /** Writes the roles (and the cache row when `writeCache`) and enqueues; false when stale. */
  applyTerminal(c: RoleAiCandidate, t: RoleAiTerminal, writeCache: boolean): Promise<boolean>
  /**
   * A FAILED cache row with one more attempt and the next backoff. False when no FAILED row was
   * written: the row was reclassified meanwhile OR an answer already exists for the key.
   */
  recordFailure(c: RoleAiCandidate, now: Date): Promise<boolean>
  /** One model call of the UTC day containing `now`; false when `limit` calls are spent. */
  reserveCall(now: Date, limit: number): Promise<boolean>
  /** Gives back a call reserved at `now` that reached no model. */
  releaseCall(now: Date): Promise<void>
}

export type RoleClassifier = { classify(input: RoleClassifierInput): Promise<RoleAiReply> }

/** Structured lines only: ids, codes and counts, never vacancy or model text. */
export type RoleAiLog = {
  log(line: object): void
  warn(line: object): void
  error(line: object, stack?: string): void
}

export type RoleAiPassResult = {
  classified: number
  unclear: number
  failed: number
  stoppedBy: string | null
}

export type RoleAiDecision =
  | { kind: 'terminal'; terminal: RoleAiTerminal }
  | { kind: 'not-configured' }
  | { kind: 'failed'; stop: boolean; reply: Unavailable }

/** Codes a next vacancy may answer differently: the pass continues past them. */
const PER_ITEM_FAILURES: ReadonlySet<string> = new Set(['INVALID_OUTPUT', 'INVALID_INPUT'])

export function decideRoleAi(reply: RoleAiReply): RoleAiDecision {
  if (reply.kind === 'ok') {
    const ai = reply.roles.length > 0 && reply.confidence >= ROLE_AI_MIN_CONFIDENCE
    return {
      kind: 'terminal',
      terminal: {
        outcome: ai ? 'AI' : 'UNCLEAR',
        roles: ai ? sortRoles(reply.roles) : [],
        confidence: reply.confidence,
      },
    }
  }
  if (reply.reason === 'NOT_CONFIGURED') return { kind: 'not-configured' }
  // Any other code is the provider's state (error, timeout, rate limit): the circuit opens.
  return { kind: 'failed', stop: !PER_ITEM_FAILURES.has(reply.reason), reply }
}

/** A thrown error by its name and the value-free db fragment: a message may quote a parameter. */
export function logRoleAiError(log: RoleAiLog, err: unknown, opportunityId?: string): void {
  log.error(
    {
      event: 'ROLE_AI_ERROR',
      ...(opportunityId === undefined ? {} : { opportunityId }),
      error: err instanceof Error ? err.name : typeof err,
      db: dbErrorLogSuffix(err).trim(),
    },
    strictErrorStack(err),
  )
}

/**
 * One bounded pass. Each candidate is answered from the cache or by one model call made OUTSIDE any
 * transaction; the store then re-checks the row under its lock. A provider failure writes FAILED
 * with backoff and stops the pass; NOT_CONFIGURED stops it with no write. A spent daily budget
 * makes no further call, but cached answers are still applied. A thrown candidate gets a FAILED
 * backoff and the pass goes on, until the failure cannot be written or several throw in a row.
 * Never throws.
 */
export async function runRoleAiLoop(p: {
  store: RoleAiStore
  client: RoleClassifier
  log: RoleAiLog
  now: Date
  limit: number
  dailyBudget: number
}): Promise<RoleAiPassResult> {
  const r: RoleAiPassResult = { classified: 0, unclear: 0, failed: 0, stoppedBy: null }
  let candidates: readonly RoleAiCandidate[]
  try {
    candidates = await p.store.candidates(p.now, p.limit)
  } catch (err: unknown) {
    logRoleAiError(p.log, err)
    return { ...r, stoppedBy: 'ERROR' }
  }
  const count = (t: RoleAiTerminal) => {
    if (t.outcome === 'AI') r.classified += 1
    else r.unclear += 1
  }
  let budgetSpent = false
  let thrownInRow = 0
  for (const c of candidates) {
    try {
      const cached = await p.store.cached(c)
      if (cached !== null) {
        if (await p.store.applyTerminal(c, cached, false)) count(cached)
        thrownInRow = 0
        continue
      }
      if (budgetSpent) continue
      if (!(await p.store.reserveCall(p.now, p.dailyBudget))) {
        budgetSpent = true
        r.stoppedBy = 'DAILY_BUDGET'
        p.log.log({ event: 'ROLE_AI_SKIPPED', reason: 'DAILY_BUDGET' })
        continue
      }
      const reply = await p.client.classify({
        title: c.title,
        description: c.description,
        categories: c.categories,
      })
      const d = decideRoleAi(reply)
      thrownInRow = 0
      if (d.kind === 'not-configured') {
        await p.store.releaseCall(p.now)
        p.log.log({ event: 'ROLE_AI_SKIPPED', reason: 'NOT_CONFIGURED' })
        r.stoppedBy = 'NOT_CONFIGURED'
        break
      }
      if (d.kind === 'terminal') {
        if (await p.store.applyTerminal(c, d.terminal, true)) count(d.terminal)
        continue
      }
      // A row reclassified meanwhile is not this pass's failure: no count, no warning.
      if (await p.store.recordFailure(c, p.now)) {
        r.failed += 1
        p.log.warn({
          event: 'ROLE_AI_FAILED',
          opportunityId: c.id,
          ...unavailableOrigin(ROLE_AI_PROVIDER, d.reply),
        })
      }
      if (d.stop) {
        r.stoppedBy = d.reply.reason
        break
      }
    } catch (err: unknown) {
      logRoleAiError(p.log, err, c.id)
      thrownInRow += 1
      // The poison row gets its backoff, so it cannot take the head of every pass (CR-M-3).
      const written = await recordThrown(p, c)
      if (written === 'recorded') r.failed += 1
      if (written === 'write-threw' || thrownInRow >= ROLE_AI_MAX_CONSECUTIVE_ERRORS) {
        r.stoppedBy = 'ERROR'
        break
      }
    }
  }
  p.log.log({ event: 'ROLE_AI_PASS', candidates: candidates.length, ...r })
  return r
}

/**
 * The failure of a thrown candidate: 'recorded' (a FAILED row was written), 'stale' (the row or key
 * moved on, so nothing was written), or 'write-threw' (the store is down).
 */
type ThrownRecord = 'recorded' | 'stale' | 'write-threw'

async function recordThrown(
  p: { store: RoleAiStore; log: RoleAiLog; now: Date },
  c: RoleAiCandidate,
): Promise<ThrownRecord> {
  try {
    return (await p.store.recordFailure(c, p.now)) ? 'recorded' : 'stale'
  } catch (err: unknown) {
    logRoleAiError(p.log, err, c.id)
    return 'write-threw'
  }
}

/** The production pass: the loop over the Postgres store. */
export function runRoleAiPass(deps: {
  db: MeterDb
  client: RoleClassifier
  log: RoleAiLog
  now: () => Date
  onDemandTypes: readonly JobSourceType[]
  dailyBudget: number
  limit?: number
  /** The day's call meter row; the default is the production one. */
  meterAccountKey?: string
}): Promise<RoleAiPassResult> {
  return runRoleAiLoop({
    store: createRoleAiStore(deps.db, deps.onDemandTypes, deps.meterAccountKey),
    client: deps.client,
    log: deps.log,
    now: deps.now(),
    limit: deps.limit ?? ROLE_AI_PASS_LIMIT,
    dailyBudget: deps.dailyBudget,
  })
}
