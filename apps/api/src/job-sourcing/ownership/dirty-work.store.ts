import {
  type JobDirtyWorkEntityKind,
  jobDirtyWorkEntityKindSchema,
  jobErrorCodeSchema,
  type JobSourceType,
  jobSourceTypeSchema,
} from '@crm/shared'
import { type SQL, sql } from 'drizzle-orm'
import { JOB_HANDLE_MAX } from '../../database/schema/job-patterns'
import type { SqlExecutor } from '../scheduling/host-state'

/**
 * The dirty-work claim store (r5 Task 4.6, slice S3): the queue half of the dirty/recompute worker.
 * Producers write `job_dirty_work` rows in their own transaction; a consumer claims a batch,
 * recomputes, and completes or fails each row. No worker lives here (S4a); only the statements.
 *
 * FENCING follows the run-ownership idiom (ADR 2026-10-24-job-source-run-ownership.md): a claim
 * hands out `(id, claim_owner, fencing_epoch)`, and every later write by the holder names all
 * three plus "still CLAIMED, lease alive". Claim and lease recovery both bump the epoch, so a
 * holder whose lease expired can never complete or fail the row again — not even after another
 * claimer took it, and not between expiry and recovery either.
 *
 * VERSIONS: a row is DONE only if its `target_version` is still the entity's current version;
 * otherwise it is DEFERRED (terminal, not a failure): a newer row for the newer version exists or
 * the entity is gone. The current version is read in the completing statement itself.
 */

/** MP-05: the initial batch. */
export const DIRTY_BATCH_DEFAULT = 200
/** The most rows one claim may lock (each stays locked only for the claim statement). */
export const DIRTY_BATCH_MAX = 1000
/** How long a claim is held before recovery may return it. */
export const DIRTY_LEASE_DEFAULT_MS = 5 * 60_000
/** A lease longer than this would hide a dead worker for too long. */
export const DIRTY_LEASE_MAX_MS = 60 * 60_000
/** Attempts (failures and expired leases together) before a row is FAILED. */
export const DIRTY_MAX_ATTEMPTS_DEFAULT = 5
export const DIRTY_MAX_ATTEMPTS_CAP = 20
/** `last_error_code` of a DEFERRED row whose version moved on. */
export const VERSION_STALE = 'VERSION_STALE'
/** `last_error_code` of a DEFERRED row whose entity no longer exists. */
export const ENTITY_MISSING = 'ENTITY_MISSING'
/** `last_error_code` written by recovery for a lease that expired. */
export const LEASE_EXPIRED = 'LEASE_EXPIRED'
/**
 * SFS U10 (ADR 6a): the free-text `reason` of a SOURCE_RECORD dirty row that asks a run to fetch a
 * posting's detail on demand. No DDL — `reason` is free text (`ck_job_dirty_work_reason_*`), and
 * the `(entity_kind, entity_id, target_version, reason)` unique key makes a second enqueue for the
 * same record version a no-op: the detail is fetched once.
 */
export const DETAIL_FETCH = 'DETAIL_FETCH'
/** `ck_job_dirty_work_reason_bounded`. */
const REASON_MAX = 100

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * DERIVED VERSION (r5 Task 4.6 S5, decision D2: no DDL, no version column). SENIOR, EXCLUSION and
 * PROJECT_CLIENT have no revision of their own, so their version is the entity's own enqueue
 * count: the highest `target_version` among its `job_dirty_work` rows. A producer enqueues
 * `max + 1` under a per-entity advisory lock (`enqueueDerivedDirty`), so the counter
 *   - never decreases: nothing prunes `job_dirty_work` (pinned by `dirty-work.retention-guard.spec.ts`;
 *     the rule a future retention must follow is at `NEW_STORE_CLEANUP_DISABLED`) and no statement
 *     rewrites `target_version`;
 *     an entity's delete / archive / restore is just one more enqueue, never a reset;
 *   - is time-free: two writes in the same microsecond, or a clock stepping back, still get
 *     distinct, increasing versions (an `updated_at` function cannot promise that);
 *   - is cheap: one index probe on `idx_job_dirty_work_entity (entity_kind, entity_id)`.
 * A row completes DONE only while it is the entity's newest row; an older one is DEFERRED
 * (VERSION_STALE) because the newer row redoes its work. The entity row itself may be gone
 * (a deleted exclusion still has to be fanned out), so ENTITY_MISSING never applies here.
 */
const DERIVED_VERSION = sql`SELECT max(d.target_version) FROM job_dirty_work d
  WHERE d.entity_kind = w.entity_kind AND d.entity_id = w.entity_id`

/** The entity's current version, by kind. A kind with no version source is refused. */
const CURRENT_VERSION: Partial<Record<JobDirtyWorkEntityKind, SQL>> = {
  // Correlated on `w`, the dirty row being completed (see `complete`).
  SOURCE_RECORD: sql`SELECT observation_seq FROM job_source_record_heads WHERE source_record_id = w.entity_id`,
  OPPORTUNITY: sql`SELECT revision FROM job_opportunities WHERE id = w.entity_id`,
  SENIOR: DERIVED_VERSION,
  EXCLUSION: DERIVED_VERSION,
  PROJECT_CLIENT: DERIVED_VERSION,
}

/** The kinds whose version is derived from their own dirty rows. */
export const DERIVED_VERSION_KINDS = ['SENIOR', 'EXCLUSION', 'PROJECT_CLIENT'] as const
export type DerivedVersionKind = (typeof DERIVED_VERSION_KINDS)[number]

/**
 * The kinds a claim hands out by default: exactly those `completeDirty` can finish. A row of any
 * other kind stays PENDING, untouched, until its version source exists (CR-M-2).
 */
export const CLAIMABLE_KINDS = Object.keys(CURRENT_VERSION) as readonly JobDirtyWorkEntityKind[]

/** What a claimer holds for one row. */
export interface DirtyWorkHandle {
  readonly id: string
  readonly owner: string
  readonly fencingEpoch: number
  readonly entityKind: JobDirtyWorkEntityKind
}

export interface ClaimedDirtyWork extends DirtyWorkHandle {
  readonly entityId: string
  readonly targetVersion: number
  readonly reason: string
  readonly retryCount: number
}

export interface ClaimOptions {
  readonly owner: string
  readonly batchSize?: number
  readonly leaseMs?: number
  /** Kinds to claim; default `CLAIMABLE_KINDS`. A kind with no version source is refused. */
  readonly kinds?: readonly JobDirtyWorkEntityKind[]
}

export interface RetryOptions {
  readonly maxAttempts?: number
}

export type CompleteOutcome = 'DONE' | 'DEFERRED'
export type FailOutcome = 'RETRY' | 'FAILED'

/** The holder no longer owns the row: another epoch, another owner, a lease gone, or not CLAIMED. */
export class DirtyWorkFencedError extends Error {
  readonly code = 'DIRTY_WORK_FENCED' as const

  constructor(message = 'the dirty-work row is not held by this claimer') {
    super(message)
    this.name = 'DirtyWorkFencedError'
  }
}

/** A completion of a kind that has no version source yet. */
export class DirtyKindUnsupportedError extends Error {
  readonly code = 'DIRTY_KIND_UNSUPPORTED' as const

  constructor(kind: string) {
    super(`dirty work of kind ${kind} has no version source yet`)
    this.name = 'DirtyKindUnsupportedError'
  }
}

function boundedInt(name: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new RangeError(`${name} must be an integer in 1..${max}, got ${value}`)
  return value
}

function assertOwner(owner: string): void {
  if (typeof owner !== 'string' || owner.length === 0 || owner.length > JOB_HANDLE_MAX)
    throw new RangeError(`owner must be 1..${JOB_HANDLE_MAX} characters`)
}

function assertHandle(h: DirtyWorkHandle): void {
  if (
    !UUID.test(h.id) ||
    typeof h.owner !== 'string' ||
    h.owner.length === 0 ||
    h.owner.length > JOB_HANDLE_MAX ||
    !Number.isSafeInteger(h.fencingEpoch) ||
    h.fencingEpoch < 1
  )
    throw new DirtyWorkFencedError('a malformed dirty-work handle holds nothing')
}

/** `id AND owner AND epoch AND kind AND CLAIMED AND lease alive` — the one holder predicate. */
function heldBy(h: DirtyWorkHandle): SQL {
  return sql`id = ${h.id}::uuid AND claim_owner = ${h.owner} AND fencing_epoch = ${h.fencingEpoch}
    AND entity_kind = ${h.entityKind} AND status = 'CLAIMED' AND lease_expires_at > clock_timestamp()`
}

/** The statements, exported so the unit spec can render them. */
export const dirtyWorkStatements = {
  enqueue: (
    kind: JobDirtyWorkEntityKind,
    id: string,
    version: number,
    reason: string,
    cycleId: string | null,
  ): SQL =>
    sql`INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason, cycle_id)
        VALUES (${kind}, ${id}::uuid, ${version}, ${reason}, ${cycleId}::uuid)
        ON CONFLICT (entity_kind, entity_id, target_version, reason) DO NOTHING
        RETURNING id`,

  /** Serialises the producers of one derived entity until their transaction ends. */
  lockDerived: (kind: DerivedVersionKind, id: string): SQL =>
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`job_dirty_work:${kind}:${id}`}, 0))`,

  /** The derived version an entity is at now: 0 before its first enqueue. */
  derivedVersion: (kind: DerivedVersionKind, id: string): SQL =>
    sql`SELECT coalesce(max(target_version), 0) AS v FROM job_dirty_work
         WHERE entity_kind = ${kind} AND entity_id = ${id}::uuid`,

  claim: (
    owner: string,
    batchSize: number,
    leaseMs: number,
    kinds: readonly JobDirtyWorkEntityKind[],
  ): SQL =>
    sql`WITH picked AS (
          SELECT id FROM job_dirty_work
           WHERE status = 'PENDING'
             AND entity_kind IN (${sql.join(
               kinds.map((k) => sql`${k}`),
               sql`, `,
             )})
           ORDER BY created_at, id
           LIMIT ${batchSize}
           FOR UPDATE SKIP LOCKED)
        UPDATE job_dirty_work d
           SET status = 'CLAIMED', claim_owner = ${owner}, claimed_at = clock_timestamp(),
               lease_expires_at = clock_timestamp() + ${leaseMs}::int * interval '1 millisecond',
               fencing_epoch = d.fencing_epoch + 1
          FROM picked
         WHERE d.id = picked.id
     RETURNING d.id, d.entity_kind, d.entity_id, d.target_version, d.reason, d.fencing_epoch,
               d.retry_count`,

  /**
   * SFS U10: claim up to `batchSize` PENDING `DETAIL_FETCH` rows whose SOURCE_RECORD belongs to one
   * source (its `source_type` and `namespace`), oldest first, skipping rows another claimer holds.
   * `FOR UPDATE OF d` locks only the dirty row, never the joined source record.
   */
  claimDetailForSource: (
    owner: string,
    sourceType: JobSourceType,
    namespace: string,
    batchSize: number,
    leaseMs: number,
  ): SQL =>
    sql`WITH picked AS (
          SELECT d.id FROM job_dirty_work d
            JOIN job_source_records sr ON sr.id = d.entity_id
           WHERE d.status = 'PENDING' AND d.entity_kind = 'SOURCE_RECORD' AND d.reason = ${DETAIL_FETCH}
             AND sr.source_type = ${sourceType}::job_source_type AND sr.namespace = ${namespace}
           ORDER BY d.created_at, d.id
           LIMIT ${batchSize}
           FOR UPDATE OF d SKIP LOCKED)
        UPDATE job_dirty_work d
           SET status = 'CLAIMED', claim_owner = ${owner}, claimed_at = clock_timestamp(),
               lease_expires_at = clock_timestamp() + ${leaseMs}::int * interval '1 millisecond',
               fencing_epoch = d.fencing_epoch + 1
          FROM picked
         WHERE d.id = picked.id
     RETURNING d.id, d.entity_kind, d.entity_id, d.target_version, d.reason, d.fencing_epoch,
               d.retry_count`,

  complete: (h: DirtyWorkHandle, current: SQL): SQL =>
    sql`WITH cur AS (SELECT (${current}) AS v FROM job_dirty_work w WHERE w.id = ${h.id}::uuid)
        UPDATE job_dirty_work
           SET status = CASE WHEN cur.v = target_version THEN 'DONE' ELSE 'DEFERRED' END::job_dirty_work_status,
               last_error_code = CASE WHEN cur.v IS NULL THEN ${ENTITY_MISSING}
                                      WHEN cur.v = target_version THEN NULL
                                      ELSE ${VERSION_STALE} END,
               claim_owner = NULL, lease_expires_at = NULL, completed_at = clock_timestamp()
          FROM cur
         WHERE ${heldBy(h)}
     RETURNING status`,

  fail: (h: DirtyWorkHandle, errorCode: string, maxAttempts: number): SQL =>
    sql`UPDATE job_dirty_work
           SET retry_count = retry_count + 1,
               status = CASE WHEN retry_count + 1 >= ${maxAttempts} THEN 'FAILED' ELSE 'PENDING' END::job_dirty_work_status,
               completed_at = CASE WHEN retry_count + 1 >= ${maxAttempts} THEN clock_timestamp() END,
               last_error_code = ${errorCode}, claim_owner = NULL, lease_expires_at = NULL
         WHERE ${heldBy(h)}
     RETURNING status`,

  recover: (batchSize: number, maxAttempts: number): SQL =>
    sql`WITH expired AS (
          SELECT id FROM job_dirty_work
           WHERE status = 'CLAIMED' AND lease_expires_at <= clock_timestamp()
           ORDER BY lease_expires_at, id
           LIMIT ${batchSize}
           FOR UPDATE SKIP LOCKED)
        UPDATE job_dirty_work d
           SET retry_count = d.retry_count + 1, fencing_epoch = d.fencing_epoch + 1,
               status = CASE WHEN d.retry_count + 1 >= ${maxAttempts} THEN 'FAILED' ELSE 'PENDING' END::job_dirty_work_status,
               completed_at = CASE WHEN d.retry_count + 1 >= ${maxAttempts} THEN clock_timestamp() END,
               last_error_code = ${LEASE_EXPIRED}, claim_owner = NULL, lease_expires_at = NULL
          FROM expired
         WHERE d.id = expired.id
     RETURNING d.status`,
}

/**
 * Enqueue one unit of dirty work in the caller's (producer's) transaction. A duplicate on
 * `(kind, entity, version, reason)` is a no-op, never a 23505: `{ inserted: false }` (the first
 * row, and its `cycle_id`, stand). `cycleId` ties the work to the collection cycle that produced it.
 */
export async function enqueueDirty(
  tx: SqlExecutor,
  kind: JobDirtyWorkEntityKind,
  entityId: string,
  version: number,
  reason: string,
  cycleId?: string,
): Promise<{ inserted: boolean }> {
  const k = jobDirtyWorkEntityKindSchema.parse(kind)
  if (!UUID.test(entityId)) throw new RangeError('entityId must be a lowercase uuid')
  boundedInt('version', version, Number.MAX_SAFE_INTEGER)
  if (reason.trim().length === 0 || reason.length > REASON_MAX)
    throw new RangeError(`reason must be non-blank and at most ${REASON_MAX} characters`)
  if (cycleId !== undefined && !UUID.test(cycleId))
    throw new RangeError('cycleId must be a lowercase uuid')
  const { rows } = await tx.execute(
    dirtyWorkStatements.enqueue(k, entityId, version, reason, cycleId ?? null),
  )
  return { inserted: rows.length > 0 }
}

function derivedKind(kind: JobDirtyWorkEntityKind): DerivedVersionKind {
  const k = jobDirtyWorkEntityKindSchema.parse(kind)
  if (!(DERIVED_VERSION_KINDS as readonly string[]).includes(k))
    throw new DirtyKindUnsupportedError(k)
  return k as DerivedVersionKind
}

/** The entity's current derived version (see DERIVED VERSION); 0 before its first enqueue. */
export async function currentDerivedVersion(
  db: SqlExecutor,
  kind: JobDirtyWorkEntityKind,
  entityId: string,
): Promise<number> {
  const k = derivedKind(kind)
  if (!UUID.test(entityId)) throw new RangeError('entityId must be a lowercase uuid')
  const { rows } = await db.execute(dirtyWorkStatements.derivedVersion(k, entityId))
  return Number(rows[0]?.['v'] ?? 0)
}

/**
 * Enqueue dirty work for a SENIOR / EXCLUSION / PROJECT_CLIENT at the next derived version, in the
 * producer's transaction. The advisory lock makes `max + 1` safe under READ COMMITTED: a second
 * producer of the same entity waits for the first to commit and then sees its row, so two writes
 * never share a version and an `ON CONFLICT` can never swallow the later one.
 */
export async function enqueueDerivedDirty(
  tx: SqlExecutor,
  kind: JobDirtyWorkEntityKind,
  entityId: string,
  reason: string,
): Promise<{ inserted: boolean; version: number }> {
  const k = derivedKind(kind)
  if (!UUID.test(entityId)) throw new RangeError('entityId must be a lowercase uuid')
  await tx.execute(dirtyWorkStatements.lockDerived(k, entityId))
  const version = (await currentDerivedVersion(tx, k, entityId)) + 1
  const { inserted } = await enqueueDirty(tx, k, entityId, version, reason)
  return { inserted, version }
}

/** The kinds a claim may name: at least one, each with a version source. */
function claimKinds(kinds: readonly JobDirtyWorkEntityKind[]): readonly JobDirtyWorkEntityKind[] {
  if (kinds.length === 0) throw new RangeError('kinds must name at least one kind')
  for (const kind of kinds) {
    if (CURRENT_VERSION[jobDirtyWorkEntityKindSchema.parse(kind)] === undefined)
      throw new DirtyKindUnsupportedError(kind)
  }
  return kinds
}

/**
 * Claim up to `batchSize` PENDING rows, oldest first, skipping rows another claimer holds locked.
 * One statement: two concurrent claimers never receive the same row.
 */
export async function claimDirtyBatch(
  db: SqlExecutor,
  opts: ClaimOptions,
): Promise<ClaimedDirtyWork[]> {
  assertOwner(opts.owner)
  const batchSize = boundedInt('batchSize', opts.batchSize ?? DIRTY_BATCH_DEFAULT, DIRTY_BATCH_MAX)
  const leaseMs = boundedInt('leaseMs', opts.leaseMs ?? DIRTY_LEASE_DEFAULT_MS, DIRTY_LEASE_MAX_MS)
  const kinds = claimKinds(opts.kinds ?? CLAIMABLE_KINDS)
  const { rows } = await db.execute(
    dirtyWorkStatements.claim(opts.owner, batchSize, leaseMs, kinds),
  )
  // The batch is picked oldest-first; the order of the returned rows carries no meaning.
  return rows.map((r) => ({
    id: String(r['id']),
    owner: opts.owner,
    fencingEpoch: Number(r['fencing_epoch']),
    entityKind: jobDirtyWorkEntityKindSchema.parse(r['entity_kind']),
    entityId: String(r['entity_id']),
    targetVersion: Number(r['target_version']),
    reason: String(r['reason']),
    retryCount: Number(r['retry_count']),
  }))
}

export interface ClaimDetailOptions {
  readonly owner: string
  /** The source whose pending detail rows this run may fetch: its type and namespace. */
  readonly source: { readonly type: JobSourceType; readonly namespace: string }
  readonly batchSize?: number
  readonly leaseMs?: number
}

/**
 * SFS U10 (ADR 6a, change #4): claim up to `batchSize` PENDING `DETAIL_FETCH` rows whose record
 * shares this run's source (`source_type` + `namespace`), oldest first, skipping rows held by
 * another claimer. The run then fetches each posting's detail inside its own ledger run, so a
 * row's fetch is bound by every rule of the source's run (host budget, fencing, byte caps).
 */
export async function claimDetailFetchForSource(
  db: SqlExecutor,
  opts: ClaimDetailOptions,
): Promise<ClaimedDirtyWork[]> {
  assertOwner(opts.owner)
  const sourceType = jobSourceTypeSchema.parse(opts.source.type)
  if (typeof opts.source.namespace !== 'string')
    throw new RangeError('source.namespace must be a string')
  const batchSize = boundedInt('batchSize', opts.batchSize ?? DIRTY_BATCH_DEFAULT, DIRTY_BATCH_MAX)
  const leaseMs = boundedInt('leaseMs', opts.leaseMs ?? DIRTY_LEASE_DEFAULT_MS, DIRTY_LEASE_MAX_MS)
  const { rows } = await db.execute(
    dirtyWorkStatements.claimDetailForSource(
      opts.owner,
      sourceType,
      opts.source.namespace,
      batchSize,
      leaseMs,
    ),
  )
  return rows.map((r) => ({
    id: String(r['id']),
    owner: opts.owner,
    fencingEpoch: Number(r['fencing_epoch']),
    entityKind: jobDirtyWorkEntityKindSchema.parse(r['entity_kind']),
    entityId: String(r['entity_id']),
    targetVersion: Number(r['target_version']),
    reason: String(r['reason']),
    retryCount: Number(r['retry_count']),
  }))
}

/**
 * Finish a held row: DONE when its target version is still current, DEFERRED otherwise
 * (`VERSION_STALE`, or `ENTITY_MISSING` when the entity is gone). A stale handle is refused.
 */
export async function completeDirty(tx: SqlExecutor, h: DirtyWorkHandle): Promise<CompleteOutcome> {
  assertHandle(h)
  const current = CURRENT_VERSION[h.entityKind]
  if (current === undefined) throw new DirtyKindUnsupportedError(h.entityKind)
  const { rows } = await tx.execute(dirtyWorkStatements.complete(h, current))
  const status = rows[0]?.['status']
  if (status === undefined) throw new DirtyWorkFencedError()
  return status === 'DONE' ? 'DONE' : 'DEFERRED'
}

/**
 * Record a failed attempt: back to PENDING while attempts remain, FAILED (terminal) once
 * `maxAttempts` attempts have been spent. A stale handle is refused.
 */
export async function failDirty(
  tx: SqlExecutor,
  h: DirtyWorkHandle,
  errorCode: string,
  opts: RetryOptions = {},
): Promise<FailOutcome> {
  assertHandle(h)
  const code = jobErrorCodeSchema.parse(errorCode)
  const maxAttempts = boundedInt(
    'maxAttempts',
    opts.maxAttempts ?? DIRTY_MAX_ATTEMPTS_DEFAULT,
    DIRTY_MAX_ATTEMPTS_CAP,
  )
  const { rows } = await tx.execute(dirtyWorkStatements.fail(h, code, maxAttempts))
  const status = rows[0]?.['status']
  if (status === undefined) throw new DirtyWorkFencedError()
  return status === 'FAILED' ? 'FAILED' : 'RETRY'
}

/**
 * Return CLAIMED rows whose lease expired to PENDING with a bumped epoch (the old holder is fenced
 * out), counting the expiry as a spent attempt so a row that kills its worker cannot loop forever.
 */
export async function recoverExpiredDirty(
  db: SqlExecutor,
  opts: RetryOptions & { readonly batchSize?: number } = {},
): Promise<{ requeued: number; failed: number }> {
  const batchSize = boundedInt('batchSize', opts.batchSize ?? DIRTY_BATCH_DEFAULT, DIRTY_BATCH_MAX)
  const maxAttempts = boundedInt(
    'maxAttempts',
    opts.maxAttempts ?? DIRTY_MAX_ATTEMPTS_DEFAULT,
    DIRTY_MAX_ATTEMPTS_CAP,
  )
  const { rows } = await db.execute(dirtyWorkStatements.recover(batchSize, maxAttempts))
  const failed = rows.filter((r) => r['status'] === 'FAILED').length
  return { requeued: rows.length - failed, failed }
}
