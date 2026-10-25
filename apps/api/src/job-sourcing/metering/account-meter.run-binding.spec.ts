import { describe, expect, it } from 'vitest'
import { RUN_ATTEMPT_PREFIX } from '../ownership/run-ownership'
import { type AccountMeterBinding, type MeterDb, createAccountMeter } from './account-meter.store'

/**
 * r5 Task 2.5 T7 — a RUN attempt's meter binding must name its run. Without a run id the binding
 * skips fencing (no `assertOwned`) and writes reservations with `run_id` NULL, which the end-of-run
 * settlement, keyed by run id, never settles. The database double throws on first contact: the
 * refusal happens at construction, before anything is read or written.
 */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('the database was touched')
    },
  },
) as MeterDb

const binding = (over: Partial<AccountMeterBinding>): AccountMeterBinding => ({
  accountKey: 'jsearch:rapidapi-main',
  windows: { REQUEST: 'MONTH' },
  attemptId: 'model-call-1',
  cycleId: '00000000-0000-4000-8000-000000000001',
  runId: null,
  ...over,
})

describe('a run attempt binding without its run id (T7)', () => {
  it('the ledger issues run attempts with the prefix this guard reads', () => {
    expect(RUN_ATTEMPT_PREFIX).toBe('run-')
  })

  it('is refused at construction, before the database is touched', () => {
    expect(() =>
      createAccountMeter(untouchable, binding({ attemptId: `run-${'a'.repeat(8)}` })),
    ).toThrow('the meter binding is invalid: runId a run attempt binding names its run')
  })

  it('a non-run reservation with no run id is still a legal binding', () => {
    expect(() => createAccountMeter(untouchable, binding({}))).not.toThrow()
  })

  it('a run attempt that names its run (with owner and epoch) is a legal binding', () => {
    expect(() =>
      createAccountMeter(
        untouchable,
        binding({
          attemptId: 'run-abc',
          runId: '00000000-0000-4000-8000-000000000002',
          ownerToken: 'w:1',
          fencingEpoch: 1,
        }),
      ),
    ).not.toThrow()
  })
})
