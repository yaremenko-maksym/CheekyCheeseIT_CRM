/**
 * The D4 missing-inventory counter DB adapter (r5 Task 4.6 S8c; ADR
 * `docs/architecture/2026-11-01-availability-reconciliation.md`, Decisions 1 and 3).
 *
 * Wraps the pure `transitionInventoryMissCounter` (S8b) with the I/O it needs:
 *   - read a source record's `job_collection_runs` for one board + `configVersion`, map each to an
 *     `InventoryRunFact`, `.parse()` it at the trust boundary, and feed them in ASCENDING observed
 *     order (the S8b replay watermark assumes ascending — a present run after a later miss would
 *     otherwise be ignored);
 *   - read the current `job_source_record_inventory_misses` row (keyed by record + board +
 *     configVersion) into an `InventoryMissCounter | null`;
 *   - fold the runs through the pure fn and PERSIST the net result — `advance`/`close` upsert the
 *     row, `reset` UPDATEs it in place keeping the baseline + watermark (NEVER deletes), `review`
 *     touches nothing, `unchanged` writes nothing;
 *   - on a net `close`, mark the record CLOSED through the record store with the parsed evidence AND
 *     enqueue its owning opportunity dirty — in the SAME transaction, so a rollback undoes both.
 *
 * Ships DARK: nothing in production calls it. S8d wires it behind the worker-enable flag. The pure
 * state machine and the owner-frozen D4 floor stay in `derive-availability.ts`; this file only maps
 * rows and persists.
 */
import { Logger } from '@nestjs/common'
import {
  type AvailabilityEvidence,
  availabilityEvidenceSchema,
  jobCollectionCoverageSchema,
} from '@crm/shared'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { MeterDb } from '../metering/account-meter.store'
import { enqueueDirty } from '../ownership/dirty-work.store'
import type { SqlExecutor } from '../scheduling/host-state'
import { closeRecordByInventory } from '../store/source-record.store'
import {
  type CounterTransition,
  type InventoryMissCounter,
  type InventoryRunFact,
  transitionInventoryMissCounter,
} from './derive-availability'

const READ_COMMITTED = { isolationLevel: 'read committed' } as const

// Stryker disable next-line StringLiteral: the logger context is a cosmetic label in log output only; no behaviour depends on it, so there is nothing to assert
const logger = new Logger('InventoryCounterUpdater')

/** `job_dirty_work.reason` of the opportunity recompute a record closure enqueues (<= 100 chars). */
export const INVENTORY_CLOSE_REASON = 'RECORD_INVENTORY_CLOSED'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The trust-boundary schema for a run fact (S8b security LOW): a NaN/invalid `observedAt` or
 * `inventorySize` would silently disable the watermark and the drop guard, so a malformed fact is
 * rejected here and never reaches the pure fn.
 */
const runFactSchema: z.ZodType<InventoryRunFact> = z.object({
  runId: z.string().uuid(),
  board: z.string().trim().min(1).max(200),
  configVersion: z.number().int().positive(),
  outcome: z.string().min(1),
  coverage: jobCollectionCoverageSchema,
  recordPresent: z.boolean(),
  inventorySize: z.number().finite().int().nonnegative(),
  observedAt: z.string().datetime(),
})

/** Parse a mapped run fact at the boundary; throws (loud) on a malformed row. */
export function parseInventoryRunFact(raw: unknown): InventoryRunFact {
  return runFactSchema.parse(raw)
}

export interface InventoryUpdateInput {
  readonly sourceRecordId: string
  /** The FULL_INVENTORY-capable source whose runs observe this board. */
  readonly sourceId: string
  /** The source scope the counter is keyed by (e.g. `greenhouse:acme`). */
  readonly board: string
  readonly configVersion: number
}

export interface InventoryUpdateResult {
  /** The net transition applied to the DB (`unchanged` when nothing changed). */
  readonly net: CounterTransition['kind']
  /** The counter row was upserted (advance/close) or updated in place (reset). */
  readonly persisted: boolean
  /** The record was marked CLOSED and its opportunity enqueued. */
  readonly closed: boolean
  /** A >50% inventory drop (or empty inventory) sent the source to review. */
  readonly reviewed: boolean
  /** The final counter state (null when no chain exists). */
  readonly counter: InventoryMissCounter | null
}

export function assertInput(input: InventoryUpdateInput): void {
  if (!UUID.test(input.sourceRecordId))
    throw new RangeError('sourceRecordId must be a lowercase uuid')
  if (!UUID.test(input.sourceId)) throw new RangeError('sourceId must be a lowercase uuid')
  const board = input.board.trim()
  if (board.length === 0 || board.length > 200)
    throw new RangeError('board must be 1..200 non-blank characters')
  if (!Number.isSafeInteger(input.configVersion) || input.configVersion <= 0)
    throw new RangeError('configVersion must be a positive integer')
}

/**
 * Map a DB counter row to an `InventoryMissCounter`, enforcing the paired-pointer invariant (S8b
 * CR-M-4): `lastMissRunId`/`lastMissAt` and `firstMissRunId`/`firstMissAt` are each both set or both
 * null. The staged schema stores them NOT NULL, so a half-null row means corruption — reject it.
 */
export function rowToCounter(row: Record<string, unknown>): InventoryMissCounter {
  const str = (v: unknown): string | null => (v == null ? null : String(v))
  const iso = (v: unknown): string | null =>
    v == null ? null : new Date(v as string | number | Date).toISOString()
  const firstMissRunId = str(row['first_miss_run_id'])
  const firstMissAt = iso(row['first_miss_at'])
  const lastMissRunId = str(row['last_miss_run_id'])
  const lastMissAt = iso(row['last_miss_at'])
  if ((lastMissRunId === null) !== (lastMissAt === null))
    throw new Error('inventory-miss counter: half-null last-miss pointer')
  if ((firstMissRunId === null) !== (firstMissAt === null))
    throw new Error('inventory-miss counter: half-null first-miss pointer')
  return {
    board: String(row['board']),
    configVersion: Number(row['config_version']),
    consecutiveMisses: Number(row['consecutive_misses']),
    firstMissRunId,
    firstMissAt,
    lastMissRunId,
    lastMissAt,
    lastInventorySize: Number(row['last_inventory_size']),
  }
}

async function readCounter(
  tx: SqlExecutor,
  input: InventoryUpdateInput,
): Promise<InventoryMissCounter | null> {
  const { rows } = await tx.execute(
    sql`SELECT board, config_version, consecutive_misses, first_miss_run_id, first_miss_at,
               last_miss_run_id, last_miss_at, last_inventory_size
          FROM job_source_record_inventory_misses
         WHERE source_record_id = ${input.sourceRecordId}::uuid
           AND board = ${input.board} AND config_version = ${input.configVersion}`,
  )
  return rows[0] === undefined ? null : rowToCounter(rows[0])
}

/**
 * The previous healthy inventory size for this board + configVersion (the highest VALID
 * FULL_INVENTORY `received` seen), used to seed the drop-guard baseline when no counter row exists
 * yet so the >50% guard applies on the FIRST miss too (S8b addendum). 0 when no healthy run
 * exists — a bounded gap documented in Assumptions; `seedCounter` then opens no seed.
 */
async function readBaseline(tx: SqlExecutor, input: InventoryUpdateInput): Promise<number> {
  const { rows } = await tx.execute(
    sql`SELECT max(received)::int AS base
          FROM job_collection_runs
         WHERE source_id = ${input.sourceId}::uuid AND config_version = ${input.configVersion}
           AND outcome = 'SUCCEEDED'::job_collection_outcome
           AND coverage = 'FULL_INVENTORY'::job_collection_coverage
           AND received > 0`,
  )
  const base = rows[0]?.['base']
  return base == null ? 0 : Number(base)
}

export interface RunRow {
  readonly fact: InventoryRunFact
  readonly cycleId: string | null
}

/**
 * The VALID runs the fold needs, ascending (CR-H-1 / security "unbounded history read"): only
 * `SUCCEEDED` + `FULL_INVENTORY` runs matter to the pure fn (every other run is a no-op there), so
 * they are filtered in SQL; and when a counter row already exists, only runs AFTER its watermark
 * (`observedAt > lastMissAt`) are read — the same runs the S8b replay guard would keep anyway, so a
 * cold start cannot turn purged old history into false misses and the per-run presence probe is
 * bounded, not O(history).
 */
async function readRuns(
  tx: SqlExecutor,
  input: InventoryUpdateInput,
  sinceObservedAt: string | null,
): Promise<RunRow[]> {
  const watermark =
    sinceObservedAt === null
      ? sql``
      : sql` AND coalesce(r.ended_at, r.started_at) > ${sinceObservedAt}::timestamptz`
  const { rows } = await tx.execute(
    sql`SELECT r.id, r.outcome, r.coverage, r.config_version, r.received, r.cycle_id,
               coalesce(r.ended_at, r.started_at) AS observed_at,
               EXISTS (SELECT 1 FROM job_run_records jr
                        WHERE jr.run_id = r.id AND jr.source_record_id = ${input.sourceRecordId}::uuid)
                 AS record_present
          FROM job_collection_runs r
         WHERE r.source_id = ${input.sourceId}::uuid AND r.config_version = ${input.configVersion}
           AND r.outcome = 'SUCCEEDED'::job_collection_outcome
           AND r.coverage = 'FULL_INVENTORY'::job_collection_coverage${watermark}
         ORDER BY coalesce(r.ended_at, r.started_at) ASC, r.id ASC`,
  )
  return rows.map((r) => {
    const observedAt = r['observed_at']
    return {
      fact: parseInventoryRunFact({
        runId: String(r['id']),
        board: input.board,
        configVersion: Number(r['config_version']),
        outcome: String(r['outcome']),
        coverage: r['coverage'],
        recordPresent: r['record_present'] === true,
        inventorySize: Number(r['received']),
        observedAt: new Date(observedAt as string | number | Date).toISOString(),
      }),
      cycleId: r['cycle_id'] == null ? null : String(r['cycle_id']),
    }
  })
}

/** Seed a drop-guard baseline when no row exists so the >50% guard protects the first miss. */
export function seedCounter(
  input: InventoryUpdateInput,
  baseline: number,
): InventoryMissCounter | null {
  if (baseline <= 0) return null
  return {
    board: input.board,
    configVersion: input.configVersion,
    consecutiveMisses: 0,
    firstMissRunId: null,
    firstMissAt: null,
    lastMissRunId: null,
    lastMissAt: null,
    lastInventorySize: baseline,
  }
}

export interface Fold {
  readonly net: CounterTransition['kind']
  readonly counter: InventoryMissCounter | null
  readonly dirty: boolean
  readonly reviewed: boolean
  readonly close: {
    readonly evidence: AvailabilityEvidence
    readonly cycleId: string | null
  } | null
}

/**
 * Fold the runs through the pure fn. A write kind (advance/reset/close) marks the counter dirty and
 * carries it forward; a close records its evidence, a later reset/advance clears it (the record
 * reappeared or the chain restarted); review flags the source but does not change the counter.
 *
 * `net` and `close` are kept consistent (LOW, security "net mislabel"): a `review` after a `close`
 * flags `reviewed` but must NOT relabel `net` away from `close` — the record is still being closed,
 * so a pending close always wins the net label.
 */
export function fold(initial: InventoryMissCounter | null, runs: readonly RunRow[]): Fold {
  let counter = initial
  let net: CounterTransition['kind'] = 'unchanged'
  let dirty = false
  let reviewed = false
  let close: Fold['close'] = null
  for (const { fact, cycleId } of runs) {
    const t = transitionInventoryMissCounter(counter, fact)
    counter = t.next
    if (t.kind === 'unchanged') continue
    if (t.kind === 'review') {
      reviewed = true
      if (close === null) net = 'review'
      continue
    }
    dirty = true
    net = t.kind
    close = t.kind === 'close' ? { evidence: t.evidence, cycleId } : null
  }
  return { net, counter, dirty, reviewed, close }
}

async function persistCounter(
  tx: SqlExecutor,
  input: InventoryUpdateInput,
  c: InventoryMissCounter,
): Promise<void> {
  // A reset zeroes the chain so firstMiss is null; the staged columns are NOT NULL, so the watermark
  // (lastMiss) stands in — harmless while consecutiveMisses is 0, and it keeps last_miss_at >=
  // first_miss_at. lastMiss is always set on a real write (the paired-pointer invariant on write).
  const firstRunId = c.firstMissRunId ?? c.lastMissRunId
  const firstAt = c.firstMissAt ?? c.lastMissAt
  if (c.lastMissRunId === null || c.lastMissAt === null || firstRunId === null || firstAt === null)
    throw new Error('inventory-miss counter: refusing to persist a null watermark')
  await tx.execute(
    sql`INSERT INTO job_source_record_inventory_misses
          (source_record_id, board, config_version, consecutive_misses, first_miss_run_id,
           first_miss_at, last_miss_run_id, last_miss_at, last_inventory_size, updated_at)
        VALUES (${input.sourceRecordId}::uuid, ${input.board}, ${input.configVersion},
                ${c.consecutiveMisses}, ${firstRunId}::uuid, ${firstAt}::timestamptz,
                ${c.lastMissRunId}::uuid, ${c.lastMissAt}::timestamptz, ${c.lastInventorySize},
                clock_timestamp())
        ON CONFLICT (source_record_id, board, config_version) DO UPDATE SET
          consecutive_misses = EXCLUDED.consecutive_misses,
          first_miss_run_id = EXCLUDED.first_miss_run_id,
          first_miss_at = EXCLUDED.first_miss_at,
          last_miss_run_id = EXCLUDED.last_miss_run_id,
          last_miss_at = EXCLUDED.last_miss_at,
          last_inventory_size = EXCLUDED.last_inventory_size,
          updated_at = clock_timestamp()`,
  )
}

/** Enqueue every active owning opportunity of the record for recompute (S4a/S8d re-derive it). */
async function enqueueOwners(
  tx: SqlExecutor,
  sourceRecordId: string,
  cycleId: string | null,
): Promise<void> {
  const { rows } = await tx.execute(
    sql`SELECT os.opportunity_id, o.revision
          FROM job_opportunity_sources os
          JOIN job_opportunities o ON o.id = os.opportunity_id
         WHERE os.source_record_id = ${sourceRecordId}::uuid AND os.unlinked_at IS NULL`,
  )
  for (const row of rows) {
    await enqueueDirty(
      tx,
      'OPPORTUNITY',
      String(row['opportunity_id']),
      Number(row['revision']),
      INVENTORY_CLOSE_REASON,
      cycleId ?? undefined,
    )
  }
}

/**
 * Lock the source record and verify it belongs to `sourceId` (SR-M-1 / SR-M-2). The `FOR UPDATE OF r`
 * serialises with the observation writer (which locks the same row), so a run still in flight that
 * re-lists the record commits BEFORE this reads the runs — no false close on a reappearing record.
 * The record↔source tie is (source_type, namespace), the only link a MISSING record has to a board:
 * a mismatched (sourceId, sourceRecordId) pair matches no row and is refused, never closing an
 * arbitrary record.
 */
async function lockAndVerifyRecord(tx: SqlExecutor, input: InventoryUpdateInput): Promise<void> {
  const { rows } = await tx.execute(
    sql`SELECT r.id
          FROM job_source_records r
          JOIN job_sources s ON s.id = ${input.sourceId}::uuid
         WHERE r.id = ${input.sourceRecordId}::uuid
           AND r.source_type = s.type AND r.namespace = s.namespace
         FOR UPDATE OF r`,
  )
  if (rows.length === 0)
    throw new RangeError(
      'inventory-miss: the source record does not belong to the given source (mismatched or missing)',
    )
}

/**
 * Update the record's missing-inventory counter from its run history and, on a net close, mark it
 * CLOSED and enqueue its opportunity — all in one transaction. Idempotent: the S8b replay watermark
 * makes a re-run over the same runs a no-op, and the dirty-work `ON CONFLICT` dedups the enqueue.
 */
export async function updateInventoryMissCounter(
  db: MeterDb,
  input: InventoryUpdateInput,
): Promise<InventoryUpdateResult> {
  assertInput(input)
  return db.transaction(async (tx) => {
    await lockAndVerifyRecord(tx, input)
    const stored = await readCounter(tx, input)
    const initial = stored ?? seedCounter(input, await readBaseline(tx, input))
    const runs = await readRuns(tx, input, stored?.lastMissAt ?? null)
    const result = fold(initial, runs)

    let persisted = false
    if (result.dirty && result.counter !== null) {
      await persistCounter(tx, input, result.counter)
      persisted = true
    }

    let closed = false
    if (result.close !== null) {
      // Parse at the write boundary before any side effect (the store re-parses defensively).
      const evidence = availabilityEvidenceSchema.parse(result.close.evidence)
      // Guarded: an already-CLOSED record returns false → no duplicate enqueue (CR-M-1 / SR-M-1).
      closed = await closeRecordByInventory(tx, input.sourceRecordId, evidence)
      if (closed) await enqueueOwners(tx, input.sourceRecordId, result.close.cycleId)
    }

    // Structured trace, no PII — board/config/counts only (SPEC-M-1).
    const trace = `board=${input.board} configVersion=${input.configVersion} consecutiveMisses=${result.counter?.consecutiveMisses ?? 0} inventorySize=${result.counter?.lastInventorySize ?? 0} scanned=${runs.length}`
    if (result.close !== null)
      logger.log(`inventory-miss close${closed ? '' : ' (no-op, already closed)'}: ${trace}`)
    else if (result.reviewed) logger.warn(`inventory-miss review: ${trace}`)

    return {
      net: result.net,
      persisted,
      closed,
      reviewed: result.reviewed,
      counter: result.counter,
    }
  }, READ_COMMITTED)
}
