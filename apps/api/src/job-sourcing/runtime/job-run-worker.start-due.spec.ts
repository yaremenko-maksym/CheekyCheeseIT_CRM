import { describe, expect, it, vi } from 'vitest'
import type { ClaimedRun } from '../ownership/job-run-ledger'
import { JobRunWorker, type RunReport } from './job-run-worker'

/**
 * r5 Task 2.5 T5 — `startDue` (the claim awaited, the runs not), `runDue` over it, `activeRuns`.
 * The runs themselves are stubbed: their behaviour is `job-run-worker.spec.ts` and the integration
 * specs. The real-Postgres case of the hung ban re-write is in `job-sourcing.cron.integration.spec.ts`.
 */
const run = (n: number): ClaimedRun =>
  ({ runId: `run-${n}`, sourceId: `src-${n}`, sourceType: 'JOBICY_API' }) as unknown as ClaimedRun
const report = (n: number): RunReport => ({
  runId: `run-${n}`,
  sourceId: `src-${n}`,
  sourceType: 'JOBICY_API',
  outcome: 'SUCCEEDED',
  errorCode: null,
  finished: true,
  counts: null,
})

function build(claimed: ClaimedRun[], poolSize = 3) {
  const claimDue = vi.fn().mockResolvedValue({ claimed, refused: [] })
  const worker = new JobRunWorker(
    {
      ledger: {
        claimDue,
        recoverExpired: vi.fn().mockResolvedValue(0),
        options: { leaseMs: 6_000, runMaxAgeMs: 60_000 },
      },
    } as never,
    { owner: 'spec', poolSize, heartbeatMs: 1_000, runDeadlineMs: 5_000, deadlineGraceMs: 500 },
  )
  return { worker, claimDue }
}

describe('JobRunWorker.startDue', () => {
  it('forwards the scope and the free slots to the claim, and returns before the runs end', async () => {
    const { worker, claimDue } = build([run(1), run(2)])
    let finish!: () => void
    vi.spyOn(worker, 'runClaimed').mockImplementation(
      (r) =>
        new Promise<RunReport>((resolve) => {
          finish = () => resolve(report(Number(r.runId.slice(4))))
        }),
    )
    const started = await worker.startDue({
      cycleId: 'cyc',
      onlyIds: ['id-1'],
      onlyTypes: ['JOBICY_API'],
    })
    expect(claimDue).toHaveBeenCalledWith({
      cycleId: 'cyc',
      owner: 'spec',
      limit: 3,
      onlyIds: ['id-1'],
      onlyTypes: ['JOBICY_API'],
    })
    expect(started.claimed).toBe(2)
    let settled = false
    void started.settled.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false) // the claim returned, the runs have not ended
    finish()
  })

  it('runDue awaits the reports of what startDue claimed', async () => {
    const { worker } = build([run(1), run(2)])
    vi.spyOn(worker, 'runClaimed').mockImplementation(async (r) => report(Number(r.runId.slice(4))))
    expect((await worker.runDue({ cycleId: 'cyc' })).map((r) => r.runId)).toEqual([
      'run-1',
      'run-2',
    ])
  })

  it('claims nothing when no slot is free, and does not call the ledger', async () => {
    const { worker, claimDue } = build([run(1)], 1)
    let release!: () => void
    vi.spyOn(worker, 'runClaimed').mockImplementation(async () => {
      await new Promise<void>((r) => {
        release = r
      })
      return report(1)
    })
    const first = await worker.startDue({ cycleId: 'cyc' })
    expect(first.claimed).toBe(1)
    // the stub does not hold a slot (the real runClaimed does); hold one as it would
    ;(worker as unknown as { active: number }).active = 1
    expect(worker.activeRuns).toBe(1)
    claimDue.mockClear()
    const second = await worker.startDue({ cycleId: 'cyc' })
    expect(second.claimed).toBe(0)
    expect(await second.settled).toEqual([])
    expect(claimDue).not.toHaveBeenCalled()
    release()
  })

  it('frees the slots a claim held when the claim throws', async () => {
    const { worker, claimDue } = build([])
    claimDue.mockRejectedValueOnce(new Error('db down'))
    await expect(worker.startDue({ cycleId: 'cyc' })).rejects.toThrow('db down')
    expect(worker.activeRuns).toBe(0)
  })
})
