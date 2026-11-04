import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { JobQueueScope } from './queue-scope'

/**
 * r5 Task 6.3 — the decisions of the queue's write paths, free of SQL so each branch is pinned by
 * a unit test. `JobQueueActionsService` runs them inside the write transaction, after its locks.
 */

/** What is stored of an existing submission to decide a re-submission; never returned as is. */
export interface ExistingSubmission {
  readonly id: string
  readonly state: 'TAKEN' | 'RELEASED'
  readonly scopeKind: 'TEAM' | 'STUDIO'
  readonly teamId: string | null
  readonly version: number
}

/** A scope that may write: NONE has already answered 404. */
export type WriteScope = Exclude<JobQueueScope, { kind: 'NONE' }>

export const scopeTeamId = (scope: WriteScope): string | null =>
  scope.kind === 'TEAM' ? scope.teamId : null

/**
 * What a submit does about the (opportunity, senior) row it found.
 *
 *   INSERT   no row;
 *   UPDATE   the actor's own scope's cancelled row, at the version the client named;
 *   REPLACE  ANOTHER scope's cancelled row: DELETE + INSERT, so the actor gets a new id and version
 *            1 and cannot infer that the row existed (owner decision A3);
 *   STALE    the generic version conflict;
 *   ELSEWHERE another scope's LIVE row: the bare `{ submittedElsewhere: true }`, nothing else.
 *
 * A foreign cancelled row answers exactly as no row does on EVERY input: `expectedVersion` present
 * is STALE for both, absent writes a first submission for both. That is the A3 rule, and the tests
 * pin the two inputs side by side.
 */
export type SubmitDecision =
  | { readonly kind: 'INSERT' }
  | { readonly kind: 'UPDATE'; readonly id: string; readonly version: number }
  | { readonly kind: 'REPLACE'; readonly id: string }
  | { readonly kind: 'STALE' }
  | { readonly kind: 'ELSEWHERE' }

export function decideSubmit(
  existing: ExistingSubmission | null,
  scope: WriteScope,
  expectedVersion: number | undefined,
): SubmitDecision {
  const own =
    existing !== null && existing.scopeKind === scope.kind && existing.teamId === scopeTeamId(scope)
  if (existing !== null && !own) {
    if (existing.state === 'TAKEN') return { kind: 'ELSEWHERE' }
    return expectedVersion === undefined ? { kind: 'REPLACE', id: existing.id } : { kind: 'STALE' }
  }
  if (existing === null)
    return expectedVersion === undefined ? { kind: 'INSERT' } : { kind: 'STALE' }
  if (existing.state === 'TAKEN' || existing.version !== expectedVersion) return { kind: 'STALE' }
  return { kind: 'UPDATE', id: existing.id, version: existing.version }
}

/**
 * A dismissal is keyed on its scope, so no foreign row can be found here. A first dismiss names no
 * version; a re-dismiss (live or undone) names the row's.
 */
export function decideDismiss(
  existingVersion: number | null,
  expectedVersion: number | undefined,
): 'INSERT' | 'UPDATE' | 'STALE' {
  if (existingVersion === null) return expectedVersion === undefined ? 'INSERT' : 'STALE'
  return existingVersion === expectedVersion ? 'UPDATE' : 'STALE'
}

/**
 * The digest of a request's identity, compared on a retry. The inputs are named by the caller in a
 * fixed order; an array, so that `['a,b']` and `['a', 'b']` cannot collide.
 */
export function requestFingerprint(parts: ReadonlyArray<string | number | boolean | null>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/**
 * What an action row's `reason` carries (ids and a digest, no free text and no name, so the
 * writer's "sanitized" obligation holds): the request's digest and what a retry must answer.
 * The log has no column for a senior or a submission (`subject_user_id` is REASSIGNED-only by CHECK
 * and the log has no FK to the assignments), so without this a retry could not be answered from the
 * log, and reading the assignment instead could return another team's replacement row (A3).
 */
const actionReplaySchema = z.object({
  fp: z.string(),
  submissionId: z.string().uuid().optional(),
  seniorId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
  submittedAt: z.string().datetime().optional(),
  dismissReason: z.string().optional(),
})
export type ActionReplay = z.infer<typeof actionReplaySchema>

/**
 * The stored replay, or `null` when it cannot be read: a reason the retention job redacted to its
 * token, or a row another writer logged. Such a key cannot be proved to be this request, so the
 * caller answers `JOB_QUEUE_IDEMPOTENCY_CONFLICT`, never a guess.
 */
export function parseActionReplay(reason: unknown): ActionReplay | null {
  if (typeof reason !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(reason)
  } catch {
    return null
  }
  const result = actionReplaySchema.safeParse(parsed)
  return result.success ? result.data : null
}

/** A timestamp as the driver returns it (a `Date`, or text when its parser is overridden). */
export function isoInstant(value: unknown): string {
  return new Date(value as Date | string).toISOString()
}
