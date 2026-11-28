/**
 * Unit spec of the per-process cap on concurrent runs (backlog 436): more runs than the cap start
 * with a writer that blocks; the number of runs past their claim never exceeds the cap, the rest
 * wait in FIFO order without touching their row, a run that crashes frees its slot, and every run
 * completes after release. Runs block inside the writer, so the counts read at each quiet point
 * (every microtask drained) are the counts of runs holding a slot at that moment.
 */
import { Logger } from '@nestjs/common'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RESUME_LAYOUT, RESUME_SECTION_ORDER, type ResumeFacts } from '@crm/shared'
import type { SeniorResume } from '../../database/schema'
import type { WriterReply } from './inference-clients'
import { VerificationRunner } from './verification-runner'

vi.mock('./run-end', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ownsRun: async () => true,
}))

const FACTS: ResumeFacts = {
  headline: 'Senior Backend Engineer',
  location: { city: 'Lisbon', country: 'Portugal' },
  workFormat: 'remote',
  skills: ['TypeScript'],
  experience: [
    {
      company: 'Acme Corp',
      role: 'Tech Lead',
      location: null,
      start: '2021-03',
      end: null,
      current: true,
      technologies: ['TypeScript'],
      notes: ['Led the payments team'],
    },
  ],
  education: [],
  languages: [{ name: 'English', level: 'C1' }],
  links: [],
}
const ROW = {
  id: 'r-1',
  userId: 'u-1',
  facts: FACTS,
  templateName: 'classic',
  layout: { ...DEFAULT_RESUME_LAYOUT, sectionOrder: [...RESUME_SECTION_ORDER] },
  stagedEditedPaths: [],
} as unknown as SeniorResume
const USER = { displayName: 'Jane Doe', email: 'jane.doe@unit.spec', legalFullName: null }

/** Run ids whose claim (QUEUED → CHECKING on that run id) went through, in order. */
let claimed: string[]

/**
 * A DB double that answers by query, not by a script, so interleaved runs cannot take each
 * other's rows: the claim returns the row, the owner read the user; everything else finds nothing.
 */
function routedDb() {
  const query = (op: 'update' | 'select', cols?: object) => {
    let set: Record<string, unknown> | undefined
    let where: SQL | undefined
    const chain = {
      set(values: Record<string, unknown>) {
        set = values
        return chain
      },
      from: () => chain,
      leftJoin: () => chain,
      limit: () => chain,
      returning: () => chain,
      for: () => chain,
      where(cond: SQL | undefined) {
        where = cond
        return chain
      },
      then<T>(resolve: (rows: unknown[]) => T, reject?: (err: unknown) => T) {
        let rows: unknown[] = []
        if (op === 'update' && set?.verificationStatus === 'CHECKING') {
          const runId = runIdOf(where)
          claimed.push(runId)
          rows = [{ ...ROW, verificationRunId: runId }]
        } else if (op === 'select' && cols && 'displayName' in cols) {
          rows = [USER]
        }
        return Promise.resolve(rows).then(resolve, reject)
      },
    }
    return chain
  }
  const handle = {
    update: (_table: unknown) => query('update'),
    select: (cols?: object) => query('select', cols),
  }
  return {
    db: { ...handle, transaction: async <T>(fn: (tx: typeof handle) => Promise<T>) => fn(handle) },
  }
}

const dialect = new PgDialect()

/** The run id bound in a claim's WHERE (`id = $1 and verification_run_id = $2 and ...`). */
function runIdOf(where: SQL | undefined): string {
  const params = where ? dialect.sqlToQuery(where).params : []
  const runId = params.find((p) => typeof p === 'string' && p.startsWith('run-'))
  return typeof runId === 'string' ? runId : 'unknown'
}

type Pending = { resolve: (r: WriterReply) => void; reject: (e: unknown) => void }
let pending: Pending[]
const writer = {
  write: vi.fn(
    (_task: string, _payload: string) =>
      new Promise<WriterReply>((resolve, reject) => {
        pending.push({ resolve, reject })
      }),
  ),
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

function makeRunner(cap: number) {
  const config = {
    get: (key: string) => (key === 'RESUME_VERIFICATION_MAX_CONCURRENT_RUNS' ? cap : undefined),
  }
  return new VerificationRunner(
    routedDb() as never,
    { upload: vi.fn(async () => {}), delete: vi.fn(async () => {}) } as never,
    {} as never,
    {} as never,
    writer as never,
    {} as never,
    {} as never,
    config as never,
  )
}

beforeEach(() => {
  claimed = []
  pending = []
  vi.clearAllMocks()
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => {})
  }
})
afterEach(() => vi.restoreAllMocks())

describe('VerificationRunner: per-process cap on concurrent runs (backlog 436)', () => {
  it('never more than the cap past their claim; FIFO; a crashing run frees its slot; all complete', async () => {
    const runner = makeRunner(2)
    const ids = ['run-1', 'run-2', 'run-3', 'run-4', 'run-5']
    const finished: string[] = []
    const runs = ids.map((id) => runner.run('r-1', id).then(() => finished.push(id)))
    let peak = 0
    const quietPoint = async () => {
      await settle()
      peak = Math.max(peak, claimed.length - finished.length)
    }

    await quietPoint()
    expect(claimed).toEqual(['run-1', 'run-2'])
    expect(pending).toHaveLength(2)
    // The waiting runs have not touched their rows.
    expect(runner.waitingRunIds()).toEqual(['run-3', 'run-4', 'run-5'])

    // run-1's writer rejects: the run crashes (STALLED path) and its slot goes to run-3.
    pending.shift()?.reject(new Error('provider exploded'))
    await quietPoint()
    expect(finished).toEqual(['run-1'])
    expect(claimed).toEqual(['run-1', 'run-2', 'run-3'])
    expect(runner.waitingRunIds()).toEqual(['run-4', 'run-5'])

    // Every later writer call answers unavailable: each run ends FAILED and frees its slot.
    // LIMITS_EXHAUSTED is never retried, so no run sleeps out the writer retry delay here.
    // Bounded: one release per remaining run; a run stuck waiting would fail the length check.
    for (let round = 0; round < ids.length - 1; round += 1) {
      expect(pending.length).toBeGreaterThan(0)
      pending.shift()?.resolve({ kind: 'unavailable', reason: 'LIMITS_EXHAUSTED' } as WriterReply)
      await quietPoint()
    }
    expect(finished).toHaveLength(ids.length)
    await Promise.all(runs)
    expect(claimed).toEqual(ids)
    expect(peak).toBe(2)
    expect(runner.waitingRunIds()).toEqual([])
  })

  it('without a configured value the cap is 3', async () => {
    const runner = new VerificationRunner(
      routedDb() as never,
      { upload: vi.fn(async () => {}), delete: vi.fn(async () => {}) } as never,
      {} as never,
      {} as never,
      writer as never,
      {} as never,
      {} as never,
    )
    const runs = ['run-1', 'run-2', 'run-3', 'run-4'].map((id) => runner.run('r-1', id))
    await settle()
    expect(claimed).toEqual(['run-1', 'run-2', 'run-3'])
    expect(runner.waitingRunIds()).toEqual(['run-4'])
    // Bounded: each round ends at least one run; four rounds end all of them.
    for (let round = 0; round < 4; round += 1) {
      pending.shift()?.reject(new Error('stop'))
      await settle()
    }
    expect(claimed).toEqual(['run-1', 'run-2', 'run-3', 'run-4'])
    await Promise.all(runs)
  })
})
