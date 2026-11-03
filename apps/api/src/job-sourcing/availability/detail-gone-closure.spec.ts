import { jobErrorCodeSchema } from '@crm/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import type { MeterDb } from '../metering/account-meter.store'
import { dirtyConsumerOf } from '../ownership/dirty-work.store'
import type { ClaimedDetail, DetailTailPort, DetailTailPortDeps } from '../runtime/detail-tail'
import { createDetailTailPort } from '../runtime/detail-tail'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  DETAIL_GONE_BOARD_UNCONFIRMED,
  DETAIL_GONE_CLOSE_REASON,
  DETAIL_GONE_LISTED_THIS_RUN,
  DETAIL_GONE_UNCONTRACTED,
  closeRecordByDetailGone,
  createDetailGoneClosurePort,
  detailTailPortFactory,
  hasDetailGoneContract,
} from './detail-gone-closure'

/** r5 Task 4.6 S8g — the 404/410 detail-closure path (ADR availability-reconciliation, D2 + S8g). */
const dialect = new PgDialect()
const RECORD = '0b7f6c1e-2d3a-4b5c-8d9e-1f2a3b4c5d6e'
const OPP_A = '1c8a7d2f-3e4b-4c5d-9e0f-2a3b4c5d6e7f'
const OPP_B = '2d9b8e3a-4f5c-4d6e-8f1a-3b4c5d6e7f8a'
const RUN = '3e0c9f4b-5a6d-4e7f-9a2b-4c5d6e7f8a9b'
const DW = '4f1d0a5c-6b7e-4f8a-8b3c-5d6e7f8a9b0c'

const goneEvidence = {
  kind: 'DETAIL_GONE' as const,
  httpStatus: 404 as const,
  adapterVersion: 'greenhouse-2',
  board: 'GREENHOUSE_ATS:acme',
  configVersion: 3,
  runId: RUN,
  observedAt: '2026-11-03T08:30:00.000Z',
}

/**
 * An executor that answers the close UPDATE with `closed` and the owner read with `owners`,
 * recording every statement (sql text + params) in order.
 */
function scripted({
  closed = true,
  owners = [OPP_A] as string[],
  alive = true,
  listed = false,
  probeRows = undefined as Record<string, unknown>[] | undefined,
} = {}) {
  const seen: { sql: string; params: unknown[] }[] = []
  const tx: SqlExecutor = {
    execute: (q: SQL) => {
      const r = dialect.sqlToQuery(q)
      seen.push(r)
      if (r.sql.includes('FROM job_run_records'))
        return Promise.resolve({ rows: probeRows ?? [{ listed, alive }] })
      if (r.sql.includes('UPDATE job_source_records'))
        return Promise.resolve({ rows: closed ? [{ id: RECORD }] : [] })
      if (r.sql.includes('FROM job_opportunity_sources'))
        return Promise.resolve({
          rows: owners.map((id, i) => ({ opportunity_id: id, revision: 7 + i })),
        })
      if (r.sql.includes('UPDATE job_dirty_work'))
        return Promise.resolve({ rows: [{ status: 'DONE' }] })
      return Promise.resolve({ rows: [{ id: DW }] })
    },
  }
  const enqueues = () =>
    seen
      .filter((s) => s.sql.includes('INSERT INTO job_dirty_work'))
      .map((s) => s.params.slice(0, 4))
  return { tx, seen, enqueues }
}

describe('DETAIL_GONE_CLOSE_REASON', () => {
  it('is the AVAILABILITY-prefixed reason, so the availability consumer (never match) claims it', () => {
    expect(DETAIL_GONE_CLOSE_REASON).toBe('AVAILABILITY:DETAIL_GONE')
    expect(dirtyConsumerOf(DETAIL_GONE_CLOSE_REASON)).toBe('AVAILABILITY')
  })
})

describe('hasDetailGoneContract (only a tested adapter contract confirms closure)', () => {
  it.each([
    ['GREENHOUSE_ATS', true],
    // An aggregator 404 is visibility loss, never employer closure.
    ['REMOTIVE_API', false],
    // An ATS without a proven detail-by-id GONE contract yet.
    ['LEVER_ATS', false],
    ['SMARTRECRUITERS_ATS', false],
  ] as const)('%s -> %s', (type, expected) => {
    expect(hasDetailGoneContract(type)).toBe(expected)
  })
})

describe('closeRecordByDetailGone', () => {
  it('writes the record CLOSED with the parsed DETAIL_GONE evidence and enqueues every active owner', async () => {
    const s = scripted({ owners: [OPP_A, OPP_B] })
    await expect(closeRecordByDetailGone(s.tx, RECORD, goneEvidence)).resolves.toBe(true)
    const update = s.seen.find((q) => q.sql.includes('UPDATE job_source_records'))
    expect(update?.sql).toContain(`availability = 'CLOSED'::job_availability`)
    expect(JSON.parse(String(update?.params[0]))).toEqual(goneEvidence)
    expect(s.enqueues()).toEqual([
      ['OPPORTUNITY', OPP_A, 7, DETAIL_GONE_CLOSE_REASON],
      ['OPPORTUNITY', OPP_B, 8, DETAIL_GONE_CLOSE_REASON],
    ])
  })

  it('an already-CLOSED record is not re-closed and enqueues nothing (no duplicate work)', async () => {
    const s = scripted({ closed: false })
    await expect(closeRecordByDetailGone(s.tx, RECORD, goneEvidence)).resolves.toBe(false)
    expect(s.seen.some((q) => q.sql.includes('FROM job_opportunity_sources'))).toBe(false)
    expect(s.enqueues()).toEqual([])
  })

  it.each([
    ['a malformed (non-strict) evidence', { ...goneEvidence, kind: 'WINDOW_DROPPED' as const }],
    ['a non-closing status', { ...goneEvidence, httpStatus: 500 }],
  ])('refuses %s before any SQL', async (_label, evidence) => {
    const s = scripted()
    await expect(closeRecordByDetailGone(s.tx, RECORD, evidence as never)).rejects.toThrow()
    expect(s.seen).toHaveLength(0)
  })

  it('names the reason in its refusal of a non-DETAIL_GONE kind', async () => {
    const s = scripted()
    const { httpStatus: _h, adapterVersion: _a, ...common } = goneEvidence
    await expect(
      closeRecordByDetailGone(s.tx, RECORD, { ...common, kind: 'WINDOW_DROPPED' }),
    ).rejects.toThrow(
      new RangeError('closeRecordByDetailGone: only DETAIL_GONE evidence closes here'),
    )
    expect(s.seen).toHaveLength(0)
  })
})

const handle = {
  id: DW,
  entityKind: 'SOURCE_RECORD' as const,
  owner: 'w',
  fencingEpoch: 1,
  entityId: RECORD,
  targetVersion: 1,
  reason: 'DETAIL_FETCH',
  retryCount: 0,
}
const row: ClaimedDetail = { handle, recordId: RECORD, nativeId: '42', identityKey: 'k' }

function baseFake(): DetailTailPort & { [K in keyof DetailTailPort]: ReturnType<typeof vi.fn> } {
  return {
    claim: vi.fn(async () => []),
    writeFound: vi.fn(async () => 'DONE' as const),
    recordGone: vi.fn(async () => undefined),
    fail: vi.fn(async () => 'FAILED' as const),
    release: vi.fn(async () => undefined),
  }
}

function depsFor(type: DetailTailPortDeps['source']['type'], tx: SqlExecutor) {
  const transaction = vi.fn((fn: (t: SqlExecutor) => Promise<unknown>) => fn(tx))
  const deps = {
    db: { transaction } as unknown as MeterDb,
    owner: 'w',
    source: { type, namespace: 'acme' },
    handle: {} as DetailTailPortDeps['handle'],
    runId: RUN,
    adapterVersion: 'greenhouse-2',
    configVersion: 3,
    now: () => new Date('2026-11-03T08:30:00.000Z'),
  } satisfies DetailTailPortDeps
  return { deps, transaction }
}

describe('createDetailGoneClosurePort (flag on)', () => {
  it('delegates every non-GONE method to the U10 base port unchanged', () => {
    const base = baseFake()
    const { deps } = depsFor('GREENHOUSE_ATS', scripted().tx)
    const port = createDetailGoneClosurePort(base, deps)
    expect(port.claim).toBe(base.claim)
    expect(port.writeFound).toBe(base.writeFound)
    expect(port.fail).toBe(base.fail)
    expect(port.release).toBe(base.release)
  })

  it('Greenhouse GONE: locks the record, closes it with DETAIL_GONE evidence, enqueues owners, completes the row — one transaction', async () => {
    const base = baseFake()
    const s = scripted()
    const { deps, transaction } = depsFor('GREENHOUSE_ATS', s.tx)
    await createDetailGoneClosurePort(base, deps).recordGone(row)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(base.recordGone).not.toHaveBeenCalled()
    expect(base.fail).not.toHaveBeenCalled()
    const order = s.seen.map((q) =>
      q.sql.includes('FOR UPDATE')
        ? 'lock'
        : q.sql.includes('FROM job_run_records')
          ? 'alive'
          : q.sql.includes('UPDATE job_source_records')
            ? 'close'
            : q.sql.includes('INSERT INTO job_dirty_work')
              ? 'enqueue'
              : q.sql.includes('UPDATE job_dirty_work')
                ? 'complete'
                : 'read',
    )
    expect(order).toEqual(['lock', 'alive', 'close', 'read', 'enqueue', 'complete'])
    expect(s.seen[0]?.params).toEqual([RECORD])
    const close = s.seen.find((q) => q.sql.includes('UPDATE job_source_records'))
    const written = JSON.parse(String(close?.params[0])) as Record<string, unknown>
    expect(written).toEqual(goneEvidence)
    // CR-L: the S8 board key, asserted as a literal (not the impl's template).
    expect(written['board']).toBe('GREENHOUSE_ATS:acme')
    expect(s.enqueues()).toEqual([['OPPORTUNITY', OPP_A, 7, DETAIL_GONE_CLOSE_REASON]])
    // The probe: (1) did THIS run list this very record; (2) did it list another posting of the board.
    const probe = s.seen.find((q) => q.sql.includes('FROM job_run_records'))
    expect(probe?.params).toEqual([RUN, RECORD, RUN, 'GREENHOUSE_ATS', 'acme', RECORD])
  })

  it('SR-M-1: a board this run did not observe alive never closes: no close, no enqueue, the row is retried (not poisoned)', async () => {
    const base = baseFake()
    const s = scripted({ alive: false })
    const { deps, transaction } = depsFor('GREENHOUSE_ATS', s.tx)
    await createDetailGoneClosurePort(base, deps).recordGone(row)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(s.seen.some((q) => q.sql.includes('UPDATE job_source_records'))).toBe(false)
    expect(s.seen.some((q) => q.sql.includes('UPDATE job_dirty_work'))).toBe(false)
    expect(s.enqueues()).toEqual([])
    expect(base.fail).toHaveBeenCalledTimes(1)
    expect(base.fail).toHaveBeenCalledWith(row, DETAIL_GONE_BOARD_UNCONFIRMED, false)
    expect(DETAIL_GONE_BOARD_UNCONFIRMED).toBe('DETAIL_GONE_BOARD_UNCONFIRMED')
  })

  it.each([
    ['another posting of the board was also observed', true],
    // (b) the only posting this run observed is the one being closed: no proof the board is alive.
    ['it is the only posting this run observed', false],
  ])(
    'SR-M-2: a posting THIS run listed is never closed on GONE (%s): retried, no close, no enqueue',
    async (_label, alive) => {
      const base = baseFake()
      const s = scripted({ listed: true, alive })
      const { deps, transaction } = depsFor('GREENHOUSE_ATS', s.tx)
      await createDetailGoneClosurePort(base, deps).recordGone(row)
      expect(transaction).toHaveBeenCalledTimes(1)
      expect(s.seen.some((q) => q.sql.includes('UPDATE job_source_records'))).toBe(false)
      expect(s.seen.some((q) => q.sql.includes('UPDATE job_dirty_work'))).toBe(false)
      expect(s.enqueues()).toEqual([])
      expect(base.fail).toHaveBeenCalledTimes(1)
      expect(base.fail).toHaveBeenCalledWith(row, DETAIL_GONE_LISTED_THIS_RUN, false)
    },
  )

  it('a probe that returns NO row fails closed: board unconfirmed, retried, no close, no throw', async () => {
    const base = baseFake()
    const s = scripted({ probeRows: [] })
    const { deps } = depsFor('GREENHOUSE_ATS', s.tx)
    await expect(createDetailGoneClosurePort(base, deps).recordGone(row)).resolves.toBeUndefined()
    expect(s.seen.some((q) => q.sql.includes('UPDATE job_source_records'))).toBe(false)
    expect(s.seen.some((q) => q.sql.includes('UPDATE job_dirty_work'))).toBe(false)
    expect(s.enqueues()).toEqual([])
    expect(base.fail).toHaveBeenCalledWith(row, DETAIL_GONE_BOARD_UNCONFIRMED, false)
  })

  it.each([
    // Each read on its own: a missing flag is false, never truthy by accident.
    ['only listed=true', { listed: true }, DETAIL_GONE_LISTED_THIS_RUN],
    ['listed=false, alive absent', { listed: false }, DETAIL_GONE_BOARD_UNCONFIRMED],
    ['listed absent, alive=false', { alive: false }, DETAIL_GONE_BOARD_UNCONFIRMED],
  ])('a partial probe row (%s) refuses with the matching code', async (_label, probe, code) => {
    const base = baseFake()
    const s = scripted({ probeRows: [probe] })
    const { deps } = depsFor('GREENHOUSE_ATS', s.tx)
    await createDetailGoneClosurePort(base, deps).recordGone(row)
    expect(s.seen.some((q) => q.sql.includes('UPDATE job_source_records'))).toBe(false)
    expect(base.fail).toHaveBeenCalledWith(row, code, false)
  })

  it('listed absent with alive=true still closes (absent listed reads as not listed)', async () => {
    const base = baseFake()
    const s = scripted({ probeRows: [{ alive: true }] })
    const { deps } = depsFor('GREENHOUSE_ATS', s.tx)
    await createDetailGoneClosurePort(base, deps).recordGone(row)
    expect(s.seen.some((q) => q.sql.includes('UPDATE job_source_records'))).toBe(true)
    expect(base.fail).not.toHaveBeenCalled()
  })

  it('both refusal codes are valid typed error codes (failDirty parses them)', () => {
    expect(DETAIL_GONE_LISTED_THIS_RUN).toBe('DETAIL_GONE_LISTED_THIS_RUN')
    for (const code of [
      DETAIL_GONE_LISTED_THIS_RUN,
      DETAIL_GONE_BOARD_UNCONFIRMED,
      DETAIL_GONE_UNCONTRACTED,
    ])
      expect(jobErrorCodeSchema.parse(code)).toBe(code)
  })

  it('a board WITHOUT a tested GONE contract never closes: the row is failed poisoned, no transaction', async () => {
    const base = baseFake()
    const s = scripted()
    const { deps, transaction } = depsFor('REMOTIVE_API', s.tx)
    await createDetailGoneClosurePort(base, deps).recordGone(row)
    expect(base.fail).toHaveBeenCalledWith(row, DETAIL_GONE_UNCONTRACTED, true)
    expect(DETAIL_GONE_UNCONTRACTED).toBe('DETAIL_GONE_UNCONTRACTED')
    expect(transaction).not.toHaveBeenCalled()
    expect(base.recordGone).not.toHaveBeenCalled()
    expect(s.seen).toHaveLength(0)
  })
})

describe('detailTailPortFactory (the dark flag)', () => {
  it('flag OFF is exactly the U10 port factory (behaviour unchanged)', () => {
    expect(detailTailPortFactory(false)).toBe(createDetailTailPort)
  })

  it('flag ON wraps the U10 port: GONE takes the S8g contract-gated path', async () => {
    const s = scripted()
    const { deps } = depsFor('REMOTIVE_API', s.tx)
    const factory = detailTailPortFactory(true)
    expect(factory).not.toBe(createDetailTailPort)
    // An uncontracted board reaches `fail` through the real base port (its failDirty SQL runs).
    await factory({
      ...deps,
      db: { ...deps.db, execute: s.tx.execute } as unknown as MeterDb,
    }).recordGone(row)
    expect(s.seen.some((q) => q.sql.includes('UPDATE job_source_records'))).toBe(false)
    expect(s.seen.some((q) => q.params.includes(DETAIL_GONE_UNCONTRACTED))).toBe(true)
  })
})
