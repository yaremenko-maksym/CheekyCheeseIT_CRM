import type { JobSourceTriggerMode, JobSourceType } from '@crm/shared'
import { type SQL, sql } from 'drizzle-orm'
import type { DrizzleTx } from '../../database/types'
import type { JobSourceRegistry } from '../registry/job-source-registry'
import type { RegisteredAdapter } from '../registry/registered-adapter'
import { sourceAcceptsTrigger } from '../scheduling/due-policy'
import { JobSourceDeliberateStopError } from '../source-budget.error'
import type { ClaimedRun, LedgerDb, ManualClaim } from './job-run-ledger'
import type { ManualRefusal } from './ledger-policy'

/**
 * r5 Task 4.6 S6c — THE LEGACY CLAIM (DOU bridge ADR `2026-10-31-dou-bridge-run-ownership.md`,
 * D-1). DOU gets a run row, epoch, lease and fencing through `JobRunLedger.claimLegacyRun`, the
 * mirror of `claimGate`: this path accepts ONLY the LEGACY kind and `claimGate` keeps refusing it,
 * so the two claim paths stay disjoint by kind (SR-M-23 "allow is the kind"). No cadence term, no
 * manifest gate, no host slot: DOU has none of them. The run's ending is run-row-only (`account`,
 * Q5): no failure cap, no backoff, the SR-M-17 guarantee. Dark: nothing calls it until S6d.
 *
 * It lives here, not in `job-run-ledger.ts`, to keep that file from growing; the ledger lends it
 * its private steps (`readCycle`, `insertRun`) and the one writer of the run row stays the ledger.
 */

/** The `adapter_version` a LEGACY run row records: the DOU provider version. */
export const LEGACY_RUN_ADAPTER_VERSION = 'dou-rss-legacy/1'

/**
 * A second concurrent collection of the same source (the single-flight index, `23505`): a
 * deliberate stop, refused before the budget is charged, so it spent nothing (ADR Q2).
 */
export class JobSourceRunBusyError extends JobSourceDeliberateStopError {
  readonly budgetExhausted = false

  constructor(readonly sourceId: string) {
    super(
      `Source ${sourceId}: a collection is already running, so this one did not start and spent nothing.`,
    )
    this.name = 'JobSourceRunBusyError'
  }
}

/** Whether a registered adapter is the LEGACY contract (DOU). */
export function isLegacyKind(adapter: RegisteredAdapter | undefined): boolean {
  return adapter?.contract === 'LEGACY'
}

/**
 * The LEGACY claim's terms on the locked row, or null: the kind first, then `enabled` and the
 * trigger mode exactly as `collectAll` filters them today, nothing more.
 */
export function legacyClaimRefusal(
  adapter: RegisteredAdapter | undefined,
  row: Readonly<Record<string, unknown>>,
  trigger: JobSourceTriggerMode,
): ManualRefusal | null {
  if (!isLegacyKind(adapter)) return 'NOT_ACTIVATABLE'
  if (row['enabled'] !== true) return 'DISABLED'
  if (!sourceAcceptsTrigger(row['trigger_mode'] as JobSourceTriggerMode, trigger)) {
    return 'TRIGGER_MODE'
  }
  return null
}

export interface LegacyClaimInput {
  readonly cycleId: string
  readonly owner: string
  /** A uuid; the ledger refuses anything else `NOT_FOUND` before calling here. */
  readonly sourceId: string
  /** A MANUAL cycle's own actor; a SCHEDULED cycle takes none. */
  readonly actor?: string | undefined
}

/** What the ledger lends the claim: its database, registry and private steps. */
export interface LegacyClaimSteps {
  readonly db: LedgerDb
  readonly registry: JobSourceRegistry
  readonly lockTimeoutMs: number
  /** The ledger's run account key expression (the meter's key, or `#source:<id>`). */
  readonly runAccountKey: SQL
  readonly readCycle: (
    cycleId: string,
  ) => Promise<{ id: string; trigger: string; requestedBy: string | null }>
  readonly insertRun: (
    tx: DrizzleTx,
    row: Record<string, unknown>,
    cycle: { id: string; trigger: string },
    adapterVersion: string,
  ) => Promise<ClaimedRun>
  readonly sqlState: (error: unknown) => string | undefined
}

/**
 * One READ COMMITTED transaction under `lock_timeout` (as `claimSource`): lock the source row, check
 * the terms, insert the run. A refusal writes nothing; a single-flight violation rolls back and is
 * `JobSourceRunBusyError`; a lock wait past the timeout is `LOCK_TIMEOUT`.
 */
export async function claimLegacy(
  input: LegacyClaimInput,
  steps: LegacyClaimSteps,
): Promise<ManualClaim> {
  const cycle = await steps.readCycle(input.cycleId)
  const actorOk =
    cycle.trigger === 'MANUAL' ? cycle.requestedBy === input.actor : input.actor === undefined
  if (!actorOk) {
    throw new RangeError('claimLegacyRun: a manual cycle needs its own actor, a scheduled one none')
  }
  try {
    return await steps.db.transaction(
      async (tx): Promise<ManualClaim> => {
        await tx.execute(
          sql`SELECT set_config('lock_timeout', ${`${steps.lockTimeoutMs}ms`}, true)`,
        )
        const { rows } = await tx.execute(
          sql`SELECT job_sources.*, ${steps.runAccountKey} AS run_account_key
            FROM job_sources WHERE job_sources.id = ${input.sourceId}::uuid FOR UPDATE OF job_sources`,
        )
        const row = rows[0]
        if (row === undefined) return { kind: 'REFUSED', reason: 'NOT_FOUND' }
        const adapter = steps.registry.get(row['type'] as JobSourceType)
        const refusal = legacyClaimRefusal(adapter, row, cycle.trigger as JobSourceTriggerMode)
        if (refusal !== null) return { kind: 'REFUSED', reason: refusal }
        const run = await steps.insertRun(tx, row, cycle, LEGACY_RUN_ADAPTER_VERSION)
        return { kind: 'CLAIMED', run }
      },
      { isolationLevel: 'read committed' },
    )
  } catch (error) {
    const code = steps.sqlState(error)
    if (code === '55P03') return { kind: 'REFUSED', reason: 'LOCK_TIMEOUT' }
    if (code === '23505') throw new JobSourceRunBusyError(input.sourceId)
    throw error
  }
}
