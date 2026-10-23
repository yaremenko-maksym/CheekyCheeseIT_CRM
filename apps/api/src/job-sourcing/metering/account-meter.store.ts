import {
  jobAccountKeySchema,
  jobMeterUnitSchema,
  jobMeterWindowSchema,
  type JobMeterUnit,
  type JobMeterWindow,
} from '@crm/shared'
import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import * as schema from '../../database/schema'
import { jobAccountMeterReservations, jobAccountMeters } from '../../database/schema'
import { JOB_HANDLE_MAX } from '../../database/schema/job-patterns'
import type { DrizzleTx } from '../../database/types'
import type {
  CollectionContext,
  MeterReservation,
  ReservationResolution,
} from '../providers/reporting-provider'
import { rollWindow } from './meter-window'
import {
  isInCurrentWindow,
  planMarkSent,
  planSettlement,
  reservationKey,
  reservationKeyPrefix,
} from './meter-transitions'

/**
 * The Postgres-backed shared account meter (r5 Task 3.5a): the implementation of
 * `CollectionContext.meter` against `job_account_meters` / `job_account_meter_reservations`.
 *
 * ONE BINDING = one (account, attempt, run, cycle). Every unit the account bills in has its own
 * meter row (the schema's key is (account, unit, window)), so request / record / model / money
 * units never share a counter: `windows` names, per unit, which of that unit's meter rows this
 * binding draws on. A unit not named there is refused, never charged to another unit.
 *
 * THE INVARIANTS, AND WHERE EACH ONE LIVES
 *
 * - Spend guard. Every operation takes the meter row lock FIRST (`SELECT … FOR UPDATE`), then
 *   the reservation row. The capacity test is a single conditional `UPDATE` —
 *   `used + reserved + uncertain + cost <= limit` evaluated by Postgres on the locked row — and
 *   the table's own CHECK is the backstop. NULL limit = unlimited, the schema's single meaning.
 *   A refusal is `null` (COST_STOP), never an error.
 * - Idempotent attempt reservation, committed before I/O. The reservation key is
 *   `<attemptId>#<unit>#<n>`, where `n` counts this binding's paid requests of that unit. A retry
 *   of the same attempt (a fresh binding, nothing in memory) replays the same keys: a key still
 *   RESERVED — provably never sent — is RETURNED as-is (counters unchanged); a key whose request
 *   already left (SENT / UNCERTAIN / USED) or was released is skipped, and the retry's request
 *   reserves anew, because it really is a second paid request.
 * - Release only provably unsent cost. RELEASED is legal only from RESERVED. SENT and later can
 *   only become UNCERTAIN (held) or USED. Both of those are also legal straight from RESERVED,
 *   because the collection loop reports a request that threw mid-flight as UNCERTAIN without the
 *   transport having marked it SENT: the direction that errs is toward a hold, never a release.
 * - Exactly-once conversion. A second USED is a no-op; every other move out of a settled state is
 *   refused (`ILLEGAL_TRANSITION`). The amount converted is the STORED one, never the caller's.
 * - Window rollover. A meter row is reset in place, lazily, under the same lock, by the first
 *   operation at or after `resets_at`: `used` returns to 0; outstanding `reserved` / `uncertain`
 *   stay, because they are holds of the window they were taken in. When such a reservation later
 *   settles, its reservation row records the spend, and its cost does NOT enter the new window's
 *   `used` (it was W's, and W's counter is gone). A reservation belongs to the current window iff
 *   `reserved_at >= window_started_at`.
 * - Ownership. A binding settles only reservations it could have taken: same meter row (account +
 *   unit), and a key under its own attempt. Anything else is `FOREIGN_RESERVATION`.
 *
 * The clock is the DATABASE's `now()`, the same clock `reserved_at` defaults to, so the window a
 * reservation belongs to is decided by one clock.
 */

export type AccountMeterErrorCode =
  | 'INVALID_BINDING'
  | 'INVALID_AMOUNT'
  | 'UNIT_NOT_BOUND'
  | 'METER_NOT_FOUND'
  | 'AMOUNT_MISMATCH'
  | 'FOREIGN_RESERVATION'
  | 'ILLEGAL_TRANSITION'

export class AccountMeterError extends Error {
  constructor(
    readonly code: AccountMeterErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AccountMeterError'
  }
}

/**
 * Room left in `attempt_id` (bounded by `JOB_HANDLE_MAX`) for the `#<unit>#<n>` suffix. The
 * longest unit is `USD_MICROS` / `MODEL_CALL` (10 characters), so the suffix is 12 characters
 * plus the ordinal; 32 leaves the ordinal 20 digits, more than any attempt will ever issue.
 */
const KEY_SUFFIX_ROOM = 32
export const MAX_METERED_ATTEMPT_ID = JOB_HANDLE_MAX - KEY_SUFFIX_ROOM

const bindingSchema = z.object({
  accountKey: jobAccountKeySchema,
  windows: z
    .partialRecord(jobMeterUnitSchema, jobMeterWindowSchema)
    .refine((w) => Object.keys(w).length > 0, 'at least one unit must be metered'),
  attemptId: z
    .string()
    .max(MAX_METERED_ATTEMPT_ID)
    .regex(/[^\s]/, 'attempt id must not be blank')
    // `#` separates the attempt from the request suffix in a reservation key; an attempt id that
    // contained one could prefix-match ANOTHER attempt's keys and settle its reservations.
    .refine((id) => !id.includes('#'), 'attempt id must not contain #'),
  cycleId: z.uuid(),
  runId: z.uuid().nullable(),
})

export interface AccountMeterBinding {
  /** A credential-free account identity, e.g. `jsearch:rapidapi-main`. */
  accountKey: string
  /** Per billed unit, which window's meter row this binding draws on. */
  windows: Partial<Record<JobMeterUnit, JobMeterWindow>>
  /** The run's attempt id — stable across retries of the same attempt. */
  attemptId: string
  cycleId: string
  /** NULL for a reservation that is not a collection attempt (e.g. a model call). */
  runId: string | null
}

/** The port the collection loop sees, plus the transport's own claim that a request left. */
export interface AccountMeter extends Readonly<CollectionContext['meter']> {
  /** RESERVED -> SENT, when the request leaves the process. Idempotent on SENT. */
  markSent(reservation: MeterReservation): Promise<void>
}

export type MeterDb = NodePgDatabase<typeof schema>

type MeterRow = typeof jobAccountMeters.$inferSelect
type ReservationRow = typeof jobAccountMeterReservations.$inferSelect

export function createAccountMeter(db: MeterDb, rawBinding: AccountMeterBinding): AccountMeter {
  const parsed = bindingSchema.safeParse(rawBinding)
  if (!parsed.success) {
    throw new AccountMeterError(
      'INVALID_BINDING',
      `the meter binding is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    )
  }
  const binding = parsed.data
  /** Next request ordinal per unit. In memory ONLY as an optimisation of the replay walk. */
  const nextOrdinal = new Map<JobMeterUnit, number>()

  function windowOf(unit: JobMeterUnit): JobMeterWindow {
    const window = binding.windows[unit]
    if (window === undefined) {
      throw new AccountMeterError('UNIT_NOT_BOUND', `this binding does not meter ${unit}`)
    }
    return window
  }

  async function dbNow(tx: DrizzleTx): Promise<Date> {
    const { rows } = await tx.execute<{ now: Date }>(sql`SELECT now() AS now`)
    const now = rows[0]?.now
    return now instanceof Date ? now : new Date(String(now))
  }

  /** Lock the meter row, then apply a due window reset in place. Returns the current row. */
  async function lockMeter(tx: DrizzleTx, where: SQL | undefined): Promise<MeterRow> {
    const [meter] = await tx.select().from(jobAccountMeters).where(where).for('update')
    if (meter === undefined) {
      throw new AccountMeterError(
        'METER_NOT_FOUND',
        'no meter row exists for this account, unit and window',
      )
    }
    const next = rollWindow(meter.window, meter.resetsAt, await dbNow(tx))
    if (next === null) return meter
    const [rolled] = await tx
      .update(jobAccountMeters)
      .set({
        used: 0,
        windowStartedAt: next.windowStartedAt,
        resetsAt: next.resetsAt,
        updatedAt: sql`now()`,
      })
      .where(eq(jobAccountMeters.id, meter.id))
      .returning()
    return rolled ?? meter
  }

  async function reserve(unit: JobMeterUnit, amount: number): Promise<MeterReservation | null> {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new AccountMeterError('INVALID_AMOUNT', 'a reservation amount is a positive integer')
    }
    const window = windowOf(unit)

    return db.transaction(async (tx) => {
      const meter = await lockMeter(
        tx,
        and(
          eq(jobAccountMeters.accountKey, binding.accountKey),
          eq(jobAccountMeters.unit, unit),
          eq(jobAccountMeters.window, window),
        ),
      )

      // Replay walk: reuse a still-RESERVED key, skip keys whose request already left.
      let ordinal = nextOrdinal.get(unit) ?? 1
      for (;;) {
        const key = reservationKey(binding.attemptId, unit, ordinal)
        const [existing] = await tx
          .select()
          .from(jobAccountMeterReservations)
          .where(
            and(
              eq(jobAccountMeterReservations.meterId, meter.id),
              eq(jobAccountMeterReservations.attemptId, key),
            ),
          )
          .for('update')
        if (existing === undefined) break
        if (existing.status === 'RESERVED') {
          if (existing.amount !== amount) {
            throw new AccountMeterError(
              'AMOUNT_MISMATCH',
              `a retry asked ${amount} for a request reserved at ${existing.amount}`,
            )
          }
          nextOrdinal.set(unit, ordinal + 1)
          return { id: existing.id, unit, amount: existing.amount }
        }
        ordinal += 1
      }

      // The capacity test, evaluated by Postgres on the locked row.
      const charged = await tx
        .update(jobAccountMeters)
        .set({
          reserved: sql`${jobAccountMeters.reserved} + ${amount}`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(jobAccountMeters.id, meter.id),
            or(
              isNull(jobAccountMeters.limitAmount),
              sql`${jobAccountMeters.used} + ${jobAccountMeters.reserved} + ${jobAccountMeters.uncertain} + ${amount} <= ${jobAccountMeters.limitAmount}`,
            ),
          ),
        )
        .returning({ id: jobAccountMeters.id })
      if (charged.length === 0) return null

      const [created] = await tx
        .insert(jobAccountMeterReservations)
        .values({
          meterId: meter.id,
          attemptId: reservationKey(binding.attemptId, unit, ordinal),
          runId: binding.runId,
          cycleId: binding.cycleId,
          amount,
        })
        .returning({ id: jobAccountMeterReservations.id })
      if (created === undefined) throw new Error('the reservation insert returned no row')
      nextOrdinal.set(unit, ordinal + 1)
      return { id: created.id, unit, amount }
    })
  }

  const foreign = () =>
    new AccountMeterError('FOREIGN_RESERVATION', 'this binding does not own that reservation')

  /**
   * The checks a claim must pass before any query: a reservation id is a uuid, and its unit is one
   * this binding meters. Returns the window of that unit's meter row.
   */
  function claimedWindow(claim: MeterReservation): JobMeterWindow {
    const window = binding.windows[claim.unit]
    if (window === undefined || !z.uuid().safeParse(claim.id).success) throw foreign()
    return window
  }

  /**
   * Lock (meter, then reservation) for a reservation this binding owns. The meter is found
   * through the reservation, but the lock ORDER is still meter-first, the same order `reserve`
   * takes, so the two can never deadlock against each other.
   */
  async function lockOwned(
    tx: DrizzleTx,
    claim: MeterReservation,
    window: JobMeterWindow,
  ): Promise<{ meter: MeterRow; row: ReservationRow }> {
    const [peek] = await tx
      .select({ meterId: jobAccountMeterReservations.meterId })
      .from(jobAccountMeterReservations)
      .where(eq(jobAccountMeterReservations.id, claim.id))
    if (peek === undefined) throw foreign()

    const meter = await lockMeter(
      tx,
      and(
        eq(jobAccountMeters.id, peek.meterId),
        eq(jobAccountMeters.accountKey, binding.accountKey),
        eq(jobAccountMeters.unit, claim.unit),
        eq(jobAccountMeters.window, window),
      ),
    ).catch((error: unknown) => {
      if (error instanceof AccountMeterError && error.code === 'METER_NOT_FOUND') throw foreign()
      throw error
    })
    const [row] = await tx
      .select()
      .from(jobAccountMeterReservations)
      .where(
        and(
          eq(jobAccountMeterReservations.id, claim.id),
          eq(jobAccountMeterReservations.meterId, meter.id),
          sql`starts_with(${jobAccountMeterReservations.attemptId}, ${reservationKeyPrefix(binding.attemptId, claim.unit)})`,
        ),
      )
      .for('update')
    if (row === undefined) throw foreign()
    return { meter, row }
  }

  const illegal = (from: string, to: string) =>
    new AccountMeterError('ILLEGAL_TRANSITION', `a ${from} reservation cannot become ${to}`)

  async function markSent(claim: MeterReservation): Promise<void> {
    const window = claimedWindow(claim)
    await db.transaction(async (tx) => {
      const { row } = await lockOwned(tx, claim, window)
      const plan = planMarkSent(row.status)
      if (plan === 'noop') return
      if (plan === 'illegal') throw illegal(row.status, 'SENT')
      await tx
        .update(jobAccountMeterReservations)
        .set({ status: 'SENT', sentAt: sql`now()` })
        .where(eq(jobAccountMeterReservations.id, row.id))
    })
  }

  async function reconcile(
    claim: MeterReservation,
    resolution: ReservationResolution,
  ): Promise<void> {
    const window = claimedWindow(claim)
    await db.transaction(async (tx) => {
      const { meter, row } = await lockOwned(tx, claim, window)
      const plan = planSettlement(
        row.status,
        resolution,
        isInCurrentWindow(meter.windowStartedAt, row.reservedAt),
      )
      if (plan.kind === 'noop') return
      if (plan.kind === 'illegal') throw illegal(row.status, resolution)

      // The STORED amount, never the caller's claim.
      const amount = row.amount
      const hold =
        plan.releaseFrom === 'uncertain' ? jobAccountMeters.uncertain : jobAccountMeters.reserved

      await tx
        .update(jobAccountMeters)
        .set({
          [plan.releaseFrom]: sql`${hold} - ${amount}`,
          ...(plan.addUncertain
            ? { uncertain: sql`${jobAccountMeters.uncertain} + ${amount}` }
            : {}),
          ...(plan.addUsed ? { used: sql`${jobAccountMeters.used} + ${amount}` } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(jobAccountMeters.id, meter.id))

      await tx
        .update(jobAccountMeterReservations)
        .set({
          status: resolution,
          ...(plan.stampSent ? { sentAt: row.sentAt ?? sql`now()` } : {}),
          ...(plan.stampSettled ? { settledAt: sql`now()` } : {}),
          ...(plan.recordUsed ? { usedAmount: amount } : {}),
        })
        .where(eq(jobAccountMeterReservations.id, row.id))
    })
  }

  return { reserve, reconcile, markSent }
}
