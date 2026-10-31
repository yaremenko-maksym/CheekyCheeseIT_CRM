import type { JobExclusionDto, JobSourceType } from '@crm/shared'
import { and, asc, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../../database/schema'
import {
  type JobPosting,
  jobBridgeDeliveries,
  jobPostings,
  jobSources,
  jobSuggestions,
} from '../../database/schema'
import type { DrizzleTx } from '../../database/types'
import { describeDbError, findPgError } from '../../database/pg-errors'
import { findMatchingExclusion } from '../filtering'
import type { NormalizedPosting } from '../job-source.provider'
import { assertOwned, isRunFenced, type RunHandle } from '../ownership/run-ownership'
import { contentVersion } from './content-version'

/**
 * A posting delivery whose job_postings row could be neither inserted (ON CONFLICT DO NOTHING) nor
 * read back by fingerprint — a data-level dead end for THIS version, so the row is marked INVALID
 * (terminal) rather than retried forever. A changed item gets a new content version and a fresh row.
 */
export class PostingUnresolvableError extends Error {
  constructor(readonly fingerprint: string) {
    super(`posting fingerprint ${fingerprint} neither created nor found`)
    this.name = 'PostingUnresolvableError'
  }
}

/**
 * CR-M-1: does this error mean the DELIVERY ROW itself is bad (mark INVALID, terminal, that row
 * only) rather than the infrastructure being momentarily unavailable? Only a data-level failure is
 * terminal: a Postgres data-exception (SQLSTATE class 22) or integrity-constraint violation (class
 * 23), or the explicit unresolvable-posting dead end. A fencing/lost-lease error and any transient
 * fault (deadlock 40P01, lock timeout 55P03, a connection blip, anything with no pg error at all)
 * is NOT terminal — it is re-thrown so the row stays PENDING and the next DOU run retries it. A
 * transient fault must never silently drop a posting from the legacy feed.
 */
export function isTerminalDeliveryError(err: unknown): boolean {
  if (isRunFenced(err)) return false
  if (err instanceof PostingUnresolvableError) return true
  const pg = findPgError(err)
  if (pg === null) return false
  const sqlClass = String(pg['code']).slice(0, 2)
  return sqlClass === '22' || sqlClass === '23'
}

/**
 * The LEGACY providers the bridge may write a `LEGACY_*` row for — today only DOU, which mirrors the
 * table's `ck_job_bridge_legacy_only` CHECK (`provider = 'DOU_RSS'`). When a second legacy source
 * ships, this set and that CHECK relax together.
 */
const LEGACY_BRIDGE_PROVIDERS: ReadonlySet<JobSourceType> = new Set<JobSourceType>(['DOU_RSS'])

/** SR-M-1: the table boundary was handed a run that is not a LEGACY run of the claimed source. */
export class NonLegacyBridgeError extends Error {
  constructor(detail: string) {
    super(`bridge delivery refused: ${detail}`)
    this.name = 'NonLegacyBridgeError'
  }
}

/**
 * SR-M-1 (defense-in-depth): enforce the ADR's T1/drain invariant AT THE TABLE BOUNDARY, not only at
 * the upstream service gate — assert the run's source kind is LEGACY and the row's actual
 * `job_sources.type` equals `run.sourceType`. A future caller that reaches these helpers without the
 * service's `collectViaBridge` / `claimLegacyRun` gates still cannot write a `LEGACY_*` row for a
 * non-LEGACY source.
 */
async function assertLegacyBridgeRun(tx: DrizzleTx, run: BridgeRun): Promise<void> {
  if (!LEGACY_BRIDGE_PROVIDERS.has(run.sourceType)) {
    throw new NonLegacyBridgeError(`run source type ${run.sourceType} is not a LEGACY provider`)
  }
  const [src] = await tx
    .select({ type: jobSources.type })
    .from(jobSources)
    .where(eq(jobSources.id, run.sourceId))
    .limit(1)
  if (!src || src.type !== run.sourceType) {
    throw new NonLegacyBridgeError(
      `run source type ${run.sourceType} != job_sources.type ${src?.type ?? 'missing'}`,
    )
  }
}

/**
 * r5 Task 4.6 S6d — the durable bridge delivery (ADR `2026-10-31-dou-bridge-run-ownership.md`,
 * section 2). The service's flag-on branch calls T1 enqueue, then the two drains; each is fenced
 * (`assertOwned`) and crash-idempotent per the ADR crash table. New logic lives here, not in the
 * ~1160-line service.
 *
 *   T1  enqueue        one tx, the COMPLETE postings array, ON CONFLICT DO NOTHING
 *   T3  posting drain  one tx per PENDING LEGACY_POSTING row of the source, in enqueue order
 *   T4  suggestion     one tx per PENDING LEGACY_SUGGESTION row, the roster read ONCE per pass
 */

const READ_COMMITTED = { isolationLevel: 'read committed' } as const

type Db = NodePgDatabase<typeof schema>

/** The run the bridge delivers under: its fencing handle, source and (LEGACY) type. */
export interface BridgeRun {
  readonly handle: RunHandle
  readonly sourceId: string
  readonly sourceType: JobSourceType
}

/** One eligible senior and their exclusion set, read ONCE per drain pass (ADR batching, AC6). */
export interface RosterSenior {
  readonly seniorId: string
  /** Mutable to match `findMatchingExclusion`'s parameter (it only reads the list). */
  readonly exclusions: JobExclusionDto[]
}

export interface PostingDrainResult {
  readonly created: number
  readonly duplicate: number
  readonly invalid: number
}

/**
 * CR-M-2: the collection DTO's per-run counts. In a normal collection every fetched posting is
 * created, invalid, or a duplicate, so `fetched - created - invalid` is the duplicate count
 * `persistPostings` keeps (barrier parity). After a crash the drain also delivers a predecessor's
 * leftover PENDING rows, so `created` can exceed `fetched`; the clamp keeps `duplicates` at zero (and
 * non-negative, as `JobCollectionResultDto.duplicates` requires) — there were no duplicates among
 * the fetched set in that recovery case.
 */
export function bridgeResultCounts(
  fetched: number,
  created: number,
  invalid: number,
): { fetched: number; created: number; invalid: number; duplicates: number } {
  return { fetched, created, invalid, duplicates: Math.max(0, fetched - created - invalid) }
}

/** The job_postings insert columns, from the stored NormalizedPosting payload. */
function toPostingInsert(sourceId: string, posting: NormalizedPosting) {
  return {
    sourceType: posting.sourceType,
    sourceId,
    externalId: posting.externalId,
    url: posting.url,
    title: posting.title,
    companyName: posting.companyName,
    companyNameNormalized: posting.companyNameNormalized,
    location: posting.location,
    descriptionMd: posting.descriptionMd,
    publishedAt: posting.publishedAt,
    fingerprint: posting.fingerprint,
  }
}

/** The stored jsonb payload back to a NormalizedPosting (publishedAt is an ISO string in jsonb). */
function payloadToPosting(payload: unknown): NormalizedPosting {
  const p = payload as NormalizedPosting & { publishedAt: string | Date | null }
  return {
    ...p,
    publishedAt:
      p.publishedAt == null
        ? null
        : p.publishedAt instanceof Date
          ? p.publishedAt
          : new Date(p.publishedAt),
  }
}

/**
 * T1 — enqueue one LEGACY_POSTING delivery row per element of the COMPLETE array, one transaction,
 * `ON CONFLICT (consumer, identity, version) DO NOTHING`. An item the observation validator would
 * refuse still enqueues here: the legacy feed never depends on the store (ADR "complete array").
 */
export async function enqueueLegacyPostings(
  db: Db,
  run: BridgeRun,
  postings: readonly NormalizedPosting[],
): Promise<void> {
  if (postings.length === 0) return
  await db.transaction(async (tx) => {
    await assertOwned(tx, run.handle)
    await assertLegacyBridgeRun(tx, run)
    await tx
      .insert(jobBridgeDeliveries)
      .values(
        postings.map((p) => ({
          sourceId: run.sourceId,
          provider: run.sourceType,
          consumer: 'LEGACY_POSTING' as const,
          identityKey: p.fingerprint,
          contentVersion: contentVersion(p),
          payload: p,
          enqueuedByRun: run.handle.runId,
        })),
      )
      .onConflictDoNothing({
        target: [
          jobBridgeDeliveries.consumer,
          jobBridgeDeliveries.identityKey,
          jobBridgeDeliveries.contentVersion,
        ],
      })
  }, READ_COMMITTED)
}

/**
 * T3 — for each PENDING LEGACY_POSTING row of the SOURCE (not only this run), in enqueue order, one
 * tx per row: assertOwned; insert job_postings ON CONFLICT (fingerprint) DO NOTHING RETURNING id;
 * created → a PENDING LEGACY_SUGGESTION row (posting_id); duplicate → the existing id; the delivery
 * row → DONE (CREATED | DUPLICATE). A row the DB refuses → a separate tx marks it INVALID, logged.
 */
export async function drainPostings(
  db: Db,
  run: BridgeRun,
  log: (message: string) => void,
): Promise<PostingDrainResult> {
  const pending = await db
    .select({
      id: jobBridgeDeliveries.id,
      contentVersion: jobBridgeDeliveries.contentVersion,
      payload: jobBridgeDeliveries.payload,
    })
    .from(jobBridgeDeliveries)
    .where(
      and(
        eq(jobBridgeDeliveries.sourceId, run.sourceId),
        eq(jobBridgeDeliveries.consumer, 'LEGACY_POSTING'),
        eq(jobBridgeDeliveries.status, 'PENDING'),
      ),
    )
    .orderBy(asc(jobBridgeDeliveries.createdAt))

  let created = 0
  let duplicate = 0
  let invalid = 0

  for (const row of pending) {
    try {
      const outcome = await db.transaction(async (tx): Promise<'CREATED' | 'DUPLICATE'> => {
        await assertOwned(tx, run.handle)
        await assertLegacyBridgeRun(tx, run)
        const posting = payloadToPosting(row.payload)
        const [ins] = await tx
          .insert(jobPostings)
          .values(toPostingInsert(run.sourceId, posting))
          .onConflictDoNothing({ target: jobPostings.fingerprint })
          .returning({ id: jobPostings.id })

        let postingId: string
        let kind: 'CREATED' | 'DUPLICATE'
        if (ins) {
          postingId = ins.id
          kind = 'CREATED'
          await tx
            .insert(jobBridgeDeliveries)
            .values({
              sourceId: run.sourceId,
              provider: run.sourceType,
              consumer: 'LEGACY_SUGGESTION' as const,
              identityKey: posting.fingerprint,
              contentVersion: row.contentVersion,
              payload: {},
              postingId,
              enqueuedByRun: run.handle.runId,
            })
            .onConflictDoNothing({
              target: [
                jobBridgeDeliveries.consumer,
                jobBridgeDeliveries.identityKey,
                jobBridgeDeliveries.contentVersion,
              ],
            })
        } else {
          const [existing] = await tx
            .select({ id: jobPostings.id })
            .from(jobPostings)
            .where(eq(jobPostings.fingerprint, posting.fingerprint))
            .limit(1)
          if (!existing) throw new PostingUnresolvableError(posting.fingerprint)
          postingId = existing.id
          kind = 'DUPLICATE'
        }
        await tx
          .update(jobBridgeDeliveries)
          .set({
            status: 'DONE',
            outcome: kind,
            postingId,
            deliveredByRun: run.handle.runId,
            deliveredAt: new Date(),
          })
          .where(eq(jobBridgeDeliveries.id, row.id))
        return kind
      }, READ_COMMITTED)
      if (outcome === 'CREATED') created += 1
      else duplicate += 1
    } catch (err: unknown) {
      // CR-M-1: a fencing/lost-lease or transient-infrastructure error must NOT terminally drop the
      // posting — re-throw so the row stays PENDING and the next DOU run retries it. Only a
      // data-level failure marks the row INVALID (terminal, this row only).
      if (!isTerminalDeliveryError(err)) throw err
      invalid += 1
      const reason = describeDbError(err) ?? (err instanceof Error ? err.message : String(err))
      log(`Bridge posting delivery ${row.id} refused, marked INVALID: ${reason}`)
      // Per-row isolation (MED-2): a separate transaction, still fenced.
      await db.transaction(async (tx) => {
        await assertOwned(tx, run.handle)
        await tx
          .update(jobBridgeDeliveries)
          .set({
            status: 'INVALID',
            outcome: reason.slice(0, 200),
            deliveredByRun: run.handle.runId,
            deliveredAt: new Date(),
          })
          .where(eq(jobBridgeDeliveries.id, row.id))
      }, READ_COMMITTED)
    }
  }
  return { created, duplicate, invalid }
}

/** The suggestion fan-out for the drained postings — the seam T4 drains through (SPEC-M-2 spies it). */
export type CreateSuggestions = (
  tx: DrizzleTx,
  postings: readonly JobPosting[],
  roster: readonly RosterSenior[],
) => Promise<number>

/**
 * The `createSuggestions` body for the drained postings, inside the caller's transaction: offer each
 * posting to every roster senior its exclusions do not match, `ON CONFLICT (posting_id, senior_id) DO
 * NOTHING` (so an already-answered APPLIED/REJECTED suggestion is never rewritten). Returns the count
 * inserted.
 */
export const createSuggestionsForPostings: CreateSuggestions = async (tx, postings, roster) => {
  let n = 0
  for (const posting of postings) {
    const candidates = roster
      .filter((s) => findMatchingExclusion(posting, s.exclusions) === null)
      .map((s) => ({ postingId: posting.id, seniorId: s.seniorId }))
    if (candidates.length > 0) {
      const rows = await tx
        .insert(jobSuggestions)
        .values(candidates)
        .onConflictDoNothing()
        .returning({ id: jobSuggestions.id })
      n += rows.length
    }
  }
  return n
}

/**
 * T4 — for each PENDING LEGACY_SUGGESTION row of the source, one tx per row: assertOwned; the
 * `createSuggestions` body for that one posting, INSIDE the tx, against the roster read ONCE (AC6);
 * the row → DONE, suggestions_created. The row's existence (with its posting_id) IS the retry input,
 * so `createSuggestions` is only ever called with a real posting, never an empty list (AC4) — a row
 * whose posting vanished is marked DONE without a fan-out. Returns the total suggestions created.
 */
export async function drainSuggestions(
  db: Db,
  run: BridgeRun,
  roster: readonly RosterSenior[],
  createSuggestions: CreateSuggestions = createSuggestionsForPostings,
): Promise<number> {
  const pending = await db
    .select({ id: jobBridgeDeliveries.id, postingId: jobBridgeDeliveries.postingId })
    .from(jobBridgeDeliveries)
    .where(
      and(
        eq(jobBridgeDeliveries.sourceId, run.sourceId),
        eq(jobBridgeDeliveries.consumer, 'LEGACY_SUGGESTION'),
        eq(jobBridgeDeliveries.status, 'PENDING'),
      ),
    )
    .orderBy(asc(jobBridgeDeliveries.createdAt))

  let total = 0
  for (const row of pending) {
    const inserted = await db.transaction(async (tx): Promise<number> => {
      await assertOwned(tx, run.handle)
      const [posting] = await tx
        .select()
        .from(jobPostings)
        .where(eq(jobPostings.id, row.postingId as string))
        .limit(1)
      // Only ever call the fan-out with the real posting this row carries — never an empty list.
      const n = posting ? await createSuggestions(tx, [posting], roster) : 0
      await tx
        .update(jobBridgeDeliveries)
        .set({
          status: 'DONE',
          suggestionsCreated: n,
          deliveredByRun: run.handle.runId,
          deliveredAt: new Date(),
        })
        .where(eq(jobBridgeDeliveries.id, row.id))
      return n
    }, READ_COMMITTED)
    total += inserted
  }
  return total
}

/**
 * T5 — stamp `last_collected_at`, FENCED (CR-M-4). Every bridge write is owned (ADR): a run that lost
 * its lease between the last drain tx and T5 fails `assertOwned` here and writes nothing, so a
 * superseded executor cannot mark the source collected.
 */
export async function markCollected(db: Db, run: BridgeRun): Promise<void> {
  await db.transaction(async (tx) => {
    await assertOwned(tx, run.handle)
    const now = new Date()
    await tx
      .update(jobSources)
      .set({ lastCollectedAt: now, updatedAt: now })
      .where(eq(jobSources.id, run.sourceId))
  }, READ_COMMITTED)
}
