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
 *
 *   `reserve` HAS TWO REFUSAL SHAPES, and a caller must handle both (R2-SR-M-1). A refusal by the
 *   CAPACITY test above is `null` — a COST_STOP, never an error, because "the budget is spent" is
 *   a normal outcome the collection loop stops cleanly on. A refusal by the per-unit sanity
 *   ceiling (`MAX_RESERVATION_AMOUNT`) THROWS `INVALID_AMOUNT`, because an amount that large is a
 *   defect in the cost estimate rather than a budget condition, and must be seen rather than
 *   quietly treated as "no room". The ceiling is checked BEFORE the capacity test, so an amount
 *   within the ceiling but over the limit still returns `null` rather than throwing.
 * - Idempotent attempt reservation, committed before I/O. The reservation key is
 *   `<attemptId>#<unit>#<n>`, where `n` counts this binding's paid requests of that unit. A retry
 *   of the same attempt (a fresh binding, nothing in memory) replays the same keys: a key still
 *   RESERVED is RETURNED as-is (counters unchanged); a key whose request already left (SENT /
 *   UNCERTAIN / USED) or was released is skipped, and the retry's request reserves anew, because
 *   it really is a second paid request.
 *
 *   **CALLER PRECONDITION, not a guarantee of this store (SR-H-1): at most ONE live executor per
 *   `attemptId`.** The replay walk hands back a RESERVED row on the reading that RESERVED means
 *   "the request never left". That reading is only sound when the executor which took the row is
 *   gone. RESERVED is equally the state of a live worker one millisecond before it sends, and the
 *   store holds no evidence either way. Measured, by the security review of PR #1103: six
 *   concurrent bindings carrying one `attemptId` received ONE reservation between them; two of
 *   them each sent a real request of cost 2 and the meter recorded `used = 2`. Four units left
 *   the account, two were charged, and the second `reconcile` was a silent no-op — so the second
 *   worker believes it was charged. N overlapping executors of one attempt cost N x amount and
 *   charge once, which is the OVERSPEND direction.
 *
 *   Why the precondition is not enforced here, and what would enforce it. The distinguishing fact
 *   would have to come from the caller, and the port cannot carry it today:
 *   `CollectionContext.run` offers `{ sourceId, cycleId, attemptId, fencingEpoch }` and no owner
 *   token. `fencingEpoch` looks like the answer and is NOT one yet — the schema calls it a
 *   monotonic fencing epoch but immediately states the monotonicity is a WORKER OBLIGATION ("the
 *   database stores and bounds the epoch; it cannot know whose turn it is"), and no code in this
 *   repository ever writes it: `fencing_epoch` has `.default(1)` and a `> 0` CHECK, the lease
 *   columns `owner_token` / `lease_expires_at` appear in no file but the schema, and the lease
 *   recovery that would increment it (plan Task 2.5) is not implemented. Folding a constant 1
 *   into the reservation key would therefore separate nothing — the probe above reproduces
 *   unchanged — while making the file look fenced. That is the defect this comment exists to
 *   stop, reintroduced one layer down.
 *
 *   So the exclusivity must be established by whoever claims the run under a lease, and asserted
 *   where it is established. Tracked as BACKLOG-followups 308; until then, a caller that may run
 *   two executors of one `attemptId` concurrently must not share an `attemptId` between them.
 * - Release only provably unsent cost. RELEASED is legal only from RESERVED. SENT and later can
 *   only become UNCERTAIN (held) or USED. Both of those are also legal straight from RESERVED,
 *   because the collection loop reports a request that threw mid-flight as UNCERTAIN without the
 *   transport having marked it SENT: the direction that errs is toward a hold, never a release.
 *
 *   THE ORDERING THIS RESTS ON, as a contract (SR-M-1 / SPEC-H-1): "provably unsent" is only
 *   provable if `markSent` has COMMITTED before the request is written to the socket. Nothing in
 *   this file can enforce that, and nothing calls `markSent` yet — `CollectionContext.meter`, the
 *   port the collection loop actually sees, carries only `reserve` and `reconcile`, so in
 *   production SENT is never recorded today. Measured consequence (security review of PR #1103):
 *   a reservation whose request physically left, released because `markSent` never committed,
 *   took the meter from `{reserved 4}` to all zeroes with 4 units really spent. What protects the
 *   loop today is not this guard but `collectJsonPages`, which sets `resolution = 'UNCERTAIN'`
 *   BEFORE calling `fetchText`. Wiring `markSent` into the transport, or formally retiring the
 *   SENT bullet, is owned by Task 3.5b and tracked as BACKLOG-followups 308, item 1.
 * - Exactly-once conversion. A second USED is a no-op; every other move out of a settled state is
 *   refused (`ILLEGAL_TRANSITION`). The amount converted is the STORED one, never the caller's.
 *   `used` is therefore an UPPER BOUND ON spend, not spend: the full reserved worst case is
 *   converted, because `reconcile` carries no actual cost, and once written there is no path to
 *   correct the row. Safe for overspend and wrong for accounting — nothing downstream may report
 *   `used` to the owner as money actually billed. Widening the port to carry the incurred cost is
 *   owned by Task 3.5b and tracked as BACKLOG-followups 308, item 2 (SR-M-3 / SPEC-M-3).
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

/**
 * SR-M-2 — the per-unit SANITY ceiling on a single reservation amount.
 *
 * `limit_amount IS NULL` means "the provider published no limit", which is the schema's single
 * meaning and must stay that way. It does NOT mean "no sanity bound": with no ceiling, one bad
 * cost estimate against an unlimited meter wrote `reserved = 9007199254740991` — nine billion
 * dollars of held spend on a `USD_MICROS` meter — and the counters are read back as JS numbers,
 * so a second such reservation leaves the representable range before the bigint column objects.
 *
 * These are BUG bounds, not budget decisions, which is why crossing one is an `INVALID_AMOUNT`
 * error and not a `null` COST_STOP: a COST_STOP tells the caller "no room, stop cleanly", and a
 * cost estimate this size is not a budget condition, it is a defect to be seen. Each is orders of
 * magnitude above any real single request, so a correct caller never meets one:
 *
 * - `REQUEST` / `MODEL_CALL`: one paid request, or the model calls one request fans out into.
 * - `RECORD`: per-returned-record credits; the largest documented page of the sources in Task 3.5b
 *   is 50 records (TheirStack's `limit` maximum), so 100k is four orders of magnitude of headroom.
 * - `USD_MICROS`: 1e6 micros = USD 1, so this is USD 1,000 for ONE request.
 */
export const MAX_RESERVATION_AMOUNT: Readonly<Record<JobMeterUnit, number>> = {
  REQUEST: 10_000,
  RECORD: 100_000,
  MODEL_CALL: 10_000,
  USD_MICROS: 1_000_000_000,
}

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
  /**
   * Next request ordinal per unit.
   *
   * SR-H-1 — NOT an optimisation, whatever an earlier edition of this comment said. It is load
   * bearing: it is what stops two concurrent paid requests OF THIS BINDING from computing the
   * same ordinal and the second one "finding" the first's RESERVED row. Delete it and
   * `concurrent paid requests on ONE binding never share a reservation` starts failing, with
   * three requests sharing one hold.
   *
   * What it does NOT do, and cannot: it is per process. Two bindings in two processes carrying
   * the same `attemptId` each start at ordinal 1 and do share a reservation — see the CALLER
   * PRECONDITION in the file docblock. The map is the in-process half of an invariant whose
   * cross-process half is the caller's to provide.
   */
  const nextOrdinal = new Map<JobMeterUnit, number>()

  function windowOf(unit: JobMeterUnit): JobMeterWindow {
    const window = binding.windows[unit]
    if (window === undefined) {
      throw new AccountMeterError('UNIT_NOT_BOUND', `this binding does not meter ${unit}`)
    }
    return window
  }

  async function dbNow(tx: DrizzleTx): Promise<Date> {
    // Stryker disable next-line StringLiteral: this is the SQL text itself — any other string is
    // either a syntax error Postgres rejects or a different clock, and a unit double supplies the
    // rows whatever the text says, so no unit test can distinguish it. What verifies it is the
    // window-rollover block of account-meter.store.integration.spec.ts, which rolls a real meter
    // against the real server clock.
    const { rows } = await tx.execute<{ now: Date }>(sql`SELECT now() AS now`)
    const now = rows[0]?.now
    return now instanceof Date ? now : new Date(String(now))
  }

  /** Lock the meter row, then apply a due window reset in place. Returns the current row. */
  async function lockMeter(tx: DrizzleTx, where: SQL | undefined): Promise<MeterRow> {
    // Stryker disable next-line StringLiteral: row locking is observable only under real
    // concurrency — a mocked query returns its rows with or without FOR UPDATE. What verifies it
    // is the multi-worker exhaustion case in the integration spec (N concurrent reservers against
    // room for K, exactly K succeed), which fails outright if this lock is not taken.
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
    // SR-M-2: the bound applies whatever the meter's limit is, because an unlimited meter is
    // exactly the case that had no ceiling at all. Checked before the unit is resolved to a
    // window so that an absurd amount is refused identically for a bound and an unbound unit.
    const ceiling = MAX_RESERVATION_AMOUNT[unit]
    if (amount > ceiling) {
      throw new AccountMeterError(
        'INVALID_AMOUNT',
        `a single ${unit} reservation of ${amount} exceeds the sanity ceiling of ${ceiling}`,
      )
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

      /**
       * Replay walk: reuse a still-RESERVED key, skip keys whose request already left.
       *
       * CR-M-4 — one SELECT per ordinal, inside the transaction that holds the account-wide
       * meter row lock, so every worker on this account queues behind the walk.
       *
       * WHAT BOUNDS IT: the walk visits one row per paid request of this attempt that has ALREADY
       * departed, on this meter. That is `k`, the paid requests of a single collection attempt,
       * which the collection loop bounds by its page budget and its deadline — a run that cannot
       * finish is cut by the deadline, not by the meter — so `k` is tens, not thousands.
       *
       * HOW OFTEN IT RUNS (R2-CR-M-2, correcting an earlier edition of this comment that claimed
       * "at most once per binding"): `nextOrdinal` advances only on a successful reservation or a
       * reuse. The two refusal paths return or throw BEFORE it is set — a COST_STOP returns `null`
       * when the capacity test refuses, and `AMOUNT_MISMATCH` throws — so after either, the next
       * `reserve` on this binding re-walks from the same ordinal. The walk is therefore O(k) per
       * reserve in the worst case and O(1) once a reservation has succeeded, not O(k) once.
       * Re-walking after a COST_STOP is cheap in the case that matters, because a COST_STOP
       * normally ends the attempt rather than being retried.
       *
       * It stays a loop because `k` is small and the round trips are the cheapest part of a
       * transaction that already holds the meter row lock; a single ordered `starts_with` range
       * query would be an optimisation, not a correctness fix. (An earlier edition justified the
       * loop by its per-ordinal `FOR UPDATE` serialising racing bindings. That was decorative:
       * the meter row lock taken above already serialises every binding on this meter for the
       * whole transaction, so no two walks on one meter overlap.) Revisit if a source ever bills
       * per page over a long cursor walk.
       */
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
      // Stryker disable next-line ObjectLiteral: emptying this projection changes WHICH COLUMNS
      // Postgres returns, and a unit double hands back its own rows regardless of the projection
      // — so the mutant is indistinguishable without a server to do the projecting. What verifies
      // it is every settlement case in the integration spec: with no `meterId` selected, the
      // meter lookup below gets undefined and real settlement stops working.
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
          // Stryker disable next-line StringLiteral: this is SQL evaluated by Postgres, and a
          // mocked query applies no predicate at all, so the mutant returns the same rows as the
          // original. What verifies it is the ownership block of the integration spec — the seven
          // crafted attempt ids (prefix neighbours longer and shorter, `%`, `_`, trailing space)
          // all refused, and the security reviewer's two-account probe, which needs the companion
          // `accountKey` predicate above to be the deciding one.
          sql`starts_with(${jobAccountMeterReservations.attemptId}, ${reservationKeyPrefix(binding.attemptId, claim.unit)})`,
        ),
      )
      // Stryker disable next-line StringLiteral: as on the meter lock above — a row lock is
      // observable only under real concurrency. Verified by the integration spec's concurrent
      // settlement and two-writer race cases, not by any mock.
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
