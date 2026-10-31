import type { JobExclusionDto, JobSourceType } from '@crm/shared'
import { and, asc, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../../database/schema'
import { jobBridgeDeliveries, jobPostings, jobSuggestions } from '../../database/schema'
import { describeDbError } from '../../database/pg-errors'
import { findMatchingExclusion } from '../filtering'
import type { NormalizedPosting } from '../job-source.provider'
import { assertOwned, type RunHandle } from '../ownership/run-ownership'
import { contentVersion } from './content-version'

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
          if (!existing)
            throw new Error(`posting fingerprint ${posting.fingerprint} neither created nor found`)
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

/**
 * T4 — for each PENDING LEGACY_SUGGESTION row of the source, one tx per row: assertOwned; the
 * createSuggestions body for that one posting, INSIDE the tx, against the roster read ONCE (AC6);
 * the row → DONE, suggestions_created. The row's existence IS the retry input, so the fan-out is
 * never called with an empty list (AC4). Returns the total suggestions created.
 */
export async function drainSuggestions(
  db: Db,
  run: BridgeRun,
  roster: readonly RosterSenior[],
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
      let n = 0
      if (posting) {
        const candidates = roster
          .filter((s) => findMatchingExclusion(posting, s.exclusions) === null)
          .map((s) => ({ postingId: posting.id, seniorId: s.seniorId }))
        if (candidates.length > 0) {
          const rows = await tx
            .insert(jobSuggestions)
            .values(candidates)
            .onConflictDoNothing()
            .returning({ id: jobSuggestions.id })
          n = rows.length
        }
      }
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
