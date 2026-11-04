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
  /** NULL for a STUDIO row: `ck_job_queue_assignments_scope_shape` ties the two together. */
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
  if (existing === null) {
    return expectedVersion === undefined ? { kind: 'INSERT' } : { kind: 'STALE' }
  }
  if (existing.teamId !== scopeTeamId(scope)) {
    if (existing.state === 'TAKEN') return { kind: 'ELSEWHERE' }
    return expectedVersion === undefined ? { kind: 'REPLACE', id: existing.id } : { kind: 'STALE' }
  }
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
 * What an action row's `reason` carries: the request's digest and the non-personal part of a retry's
 * answer, no free text and no person. A retry takes the senior from its digest-verified request (a
 * cancel: from the in-scope row its id names) and the assignee from the actor or that row. The log
 * has no FK to the assignments, and the row's own version and timestamps may have moved on, so the
 * submission id and instant of the earlier success are kept here.
 */
const actionReplaySchema = z.object({
  fp: z.string(),
  submissionId: z.string().uuid().optional(),
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
  let parsed: unknown
  try {
    parsed = JSON.parse(reason as string)
  } catch {
    // Not JSON: `parsed` stays undefined, and the schema below refuses it.
  }
  const result = actionReplaySchema.safeParse(parsed)
  return result.success ? result.data : null
}

/** A timestamp as the driver returns it (a `Date`, or text when its parser is overridden). */
export function isoInstant(value: unknown): string {
  return new Date(value as Date | string).toISOString()
}
