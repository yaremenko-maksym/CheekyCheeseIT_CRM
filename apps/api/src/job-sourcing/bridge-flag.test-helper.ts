import type { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env'
import type { JobRunLedger } from './ownership/job-run-ledger'
import { JobSourceRunBusyError } from './ownership/legacy-run-claim'

/**
 * The compatibility barrier (r5 Task 4.6 S6a) runs its suites for both values of
 * `JOB_QUEUE_BRIDGE_ENABLED`. Specs build `JobSourcingService` by hand, so the flag reaches it as a
 * fake `ConfigService` passed as the 4th constructor argument; only `get` is ever called on it.
 */
export const BRIDGE_FLAG_VALUES = [false, true] as const

export function bridgeConfig(flagOn: boolean): ConfigService<Env, true> {
  return {
    get: (key: string) => (key === 'JOB_QUEUE_BRIDGE_ENABLED' ? flagOn : undefined),
  } as unknown as ConfigService<Env, true>
}

// Stryker disable next-line StringLiteral: a placeholder id for a TEST double; no product behaviour reads it.
const FAKE_SOURCE_ID = '00000000-0000-4000-8000-0000000000f0'

/**
 * A ledger double for the flag-ON UNIT barrier (S6d): every unit case throws before T1 (an empty or
 * throwing provider, or a budget refusal), so `openCycle` / `claimLegacyRun` / `finish` are the only
 * methods reached and none touches the recording db double. `claimBusy` refuses the claim before the
 * budget is charged — the single-flight divergence (ADR §1 / Q2). The real DB drains are proven in
 * the integration barrier, which builds a REAL ledger.
 */
export function fakeBridgeLedger(
  opts: { claimBusy?: boolean; sourceId?: string } = {},
): JobRunLedger {
  // Stryker disable next-line LogicalOperator: a TEST double's id default; callers pass their own id.
  const sourceId = opts.sourceId ?? FAKE_SOURCE_ID
  return {
    openCycle: async () => ({ cycleId: '00000000-0000-4000-8000-0000000000c0' }),
    claimLegacyRun: async () => {
      if (opts.claimBusy) throw new JobSourceRunBusyError(sourceId)
      return {
        kind: 'CLAIMED' as const,
        run: {
          runId: '00000000-0000-4000-8000-0000000000a1',
          ownerToken: 'dou-bridge-spec:tok',
          fencingEpoch: 1,
          sourceId,
          cycleId: '00000000-0000-4000-8000-0000000000c0',
          attemptId: 'run-a1',
          accountKey: `#source:${sourceId}`,
          sourceType: 'DOU_RSS' as const,
          checkpoint: null,
        },
      }
    },
    finish: async () => undefined,
  } as unknown as JobRunLedger
}
