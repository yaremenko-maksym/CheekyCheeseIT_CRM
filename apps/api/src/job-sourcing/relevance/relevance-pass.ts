import { MAX_DECISION_QUESTIONS } from '@crm/inference'
import type { TechnicalRole } from '@crm/shared'
import { dbErrorLogSuffix, strictErrorStack } from '../../database/pg-errors'
import type { MeterDb } from '../metering/account-meter.store'
import type { RoleAiLog } from '../role-ai/role-ai-pass'
import { loadRoster } from '../runtime/recompute-inputs'
import type { RelevanceReply, RelevanceSenior, RelevanceVacancy } from './jev-relevance-grader'
import { createRelevanceStore } from './relevance.store'

/** Opportunities one pass sends to Jev at most (a bounded pass: the backlog waits for the next). */
export const RELEVANCE_PASS_LIMIT = 20
/** Every 10 minutes, 5 minutes after the role-AI pass, so the two never call Jev at one moment. */
export const RELEVANCE_CRON = '5-59/10 * * * *'
/** Failed calls one pair key gets at most; past it the pair is no candidate until its key moves. */
export const RELEVANCE_MAX_ATTEMPTS = 10
/** Per-item Jev failures in a row (bad reply, bad input) that turn Jev off for the pass. */
export const RELEVANCE_JEV_MAX_ITEM_FAILURES = 3
/** Thrown opportunities in a row that stop the pass: a broken store, not one poison row. */
export const RELEVANCE_MAX_CONSECUTIVE_ERRORS = 3

/** The wait after a failed call, in ms: 15 minutes doubled per earlier attempt, at most 24 hours. */
export const RELEVANCE_BACKOFF = (attempts: number): number =>
  Math.min(15 * 60_000 * 2 ** attempts, 86_400_000)

/** One LEAD senior of an opportunity, at the profile version its match row was evaluated with. */
export type RelevancePair = { seniorId: string; profileVersion: string }

/** A LEAD opportunity with the pairs that hold no current-key grade and are not backing off. */
export type RelevanceCandidate = {
  id: string
  title: string
  titleKey: string
  descriptionSha256: string | null
  description: string
  categories: string[]
  roles: TechnicalRole[]
  pairs: RelevancePair[]
}

export type RelevanceGrade = RelevancePair & { fit: number }

/** The pass's SQL, behind a port so the loop below is unit-tested (`relevance.store.ts`). */
export type RelevanceStore = {
  candidates(now: Date, limit: number): Promise<readonly RelevanceCandidate[]>
  /** Locks the opportunity; false when its title/description/roles moved or it became manual/closed. */
  applyGrades(c: RelevanceCandidate, grades: readonly RelevanceGrade[]): Promise<boolean>
  recordFailures(c: RelevanceCandidate, pairs: readonly RelevancePair[], now: Date): Promise<void>
}

export type RelevanceGrader = {
  grade(v: RelevanceVacancy, s: readonly RelevanceSenior[]): Promise<RelevanceReply>
}

export type RelevanceProfile = {
  roles: readonly string[]
  skills: readonly string[] | null
  /** undefined = no live version: never equals a pair's version, so the senior is never sent. */
  profileVersion: string | undefined
}

export type RelevancePassResult = { graded: number; failed: number; stoppedBy: string | null }

/** Codes a next opportunity may answer differently: counted, and only a run of them stops Jev. */
const PER_ITEM_FAILURES: ReadonlySet<string> = new Set(['INVALID_OUTPUT', 'INVALID_INPUT'])

/** A thrown error by its name and the value-free db fragment: a message may quote a parameter. */
export function logRelevanceError(log: RoleAiLog, err: unknown, opportunityId?: string): void {
  log.error(
    {
      event: 'RELEVANCE_ERROR',
      ...(opportunityId === undefined ? {} : { opportunityId }),
      error: err instanceof Error ? err.name : typeof err,
      db: dbErrorLogSuffix(err).trim(),
    },
    strictErrorStack(err),
  )
}

/**
 * One bounded pass. Each candidate's gradable pairs (live profile version equal to the match
 * row's) go to Jev in chunks of 50, OUTSIDE any transaction; the store then applies the collected
 * grades once under the opportunity lock. NOT_CONFIGURED stops the pass with no write; a provider
 * code records the chunk's failures and stops the pass; a per-item code records them, and a run of
 * three stops Jev for the pass. Logs carry ids, codes and counts only. Never throws.
 */
export async function runRelevanceLoop(p: {
  store: RelevanceStore
  jev: RelevanceGrader
  profiles: ReadonlyMap<string, RelevanceProfile>
  log: RoleAiLog
  now: Date
  limit: number
}): Promise<RelevancePassResult> {
  const r: RelevancePassResult = { graded: 0, failed: 0, stoppedBy: null }
  let candidates: readonly RelevanceCandidate[]
  try {
    candidates = await p.store.candidates(p.now, p.limit)
  } catch (err: unknown) {
    logRelevanceError(p.log, err)
    return { ...r, stoppedBy: 'ERROR' }
  }
  let itemFailures = 0
  let thrownInRow = 0
  for (const c of candidates) {
    const pairs = c.pairs.filter(
      (x) => p.profiles.get(x.seniorId)?.profileVersion === x.profileVersion,
    )
    if (pairs.length === 0) continue
    const vacancy = {
      title: c.title,
      description: c.description,
      categories: c.categories,
      roles: c.roles,
    }
    try {
      const grades: RelevanceGrade[] = []
      for (let i = 0; i < pairs.length && r.stoppedBy === null; i += MAX_DECISION_QUESTIONS) {
        const chunk = pairs.slice(i, i + MAX_DECISION_QUESTIONS)
        // Built field by field: a profile's other fields (and the pair's id) never reach Jev.
        const seniors = chunk.map((x) => {
          const { roles, skills } = p.profiles.get(x.seniorId) as RelevanceProfile
          return { roles, skills }
        })
        const reply = await p.jev.grade(vacancy, seniors)
        if (reply.kind === 'ok') {
          itemFailures = 0
          chunk.forEach((x, j) => grades.push({ ...x, fit: reply.fits[j] as number }))
          continue
        }
        if (reply.reason === 'NOT_CONFIGURED') {
          p.log.warn({ event: 'RELEVANCE_SKIPPED', reason: 'NOT_CONFIGURED' })
          r.stoppedBy = 'NOT_CONFIGURED'
          break
        }
        await p.store.recordFailures(c, chunk, p.now)
        r.failed += chunk.length
        p.log.warn({
          event: 'RELEVANCE_JEV_FAILED',
          opportunityId: c.id,
          reason: reply.reason,
          pairs: chunk.length,
        })
        const perItem = PER_ITEM_FAILURES.has(reply.reason)
        if (!perItem || ++itemFailures >= RELEVANCE_JEV_MAX_ITEM_FAILURES)
          r.stoppedBy = reply.reason
      }
      if (grades.length > 0 && (await p.store.applyGrades(c, grades))) r.graded += grades.length
      thrownInRow = 0
    } catch (err: unknown) {
      logRelevanceError(p.log, err, c.id)
      if (++thrownInRow >= RELEVANCE_MAX_CONSECUTIVE_ERRORS) r.stoppedBy = 'ERROR'
    }
  }
  p.log.log({ event: 'RELEVANCE_PASS', candidates: candidates.length, ...r })
  return r
}

/** The production pass: the roster read once, the loop over the Postgres store. */
export async function runRelevancePass(deps: {
  db: MeterDb
  jev: RelevanceGrader
  log: RoleAiLog
  now: () => Date
  limit?: number
}): Promise<RelevancePassResult> {
  const roster = await loadRoster(deps.db)
  const profiles = new Map<string, RelevanceProfile>()
  for (const s of roster.profiles) {
    const profileVersion = roster.versions.get(s.seniorId)?.profile
    profiles.set(s.seniorId, { roles: s.roles, skills: s.skills, profileVersion })
  }
  return runRelevanceLoop({
    store: createRelevanceStore(deps.db),
    jev: deps.jev,
    profiles,
    log: deps.log,
    now: deps.now(),
    limit: deps.limit ?? RELEVANCE_PASS_LIMIT,
  })
}
