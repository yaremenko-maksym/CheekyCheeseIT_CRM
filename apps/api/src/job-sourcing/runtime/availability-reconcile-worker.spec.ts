import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateInventory = vi.fn()
const claim = vi.fn()
const complete = vi.fn()
const fail = vi.fn()

vi.mock('../availability/inventory-counter-updater', () => ({
  updateInventoryMissCounter: (...a: unknown[]) => updateInventory(...a),
}))
vi.mock('../ownership/dirty-work.store', async (orig) => ({
  ...(await orig<typeof import('../ownership/dirty-work.store')>()),
  claimDirtyBatch: (...a: unknown[]) => claim(...a),
  completeDirty: (...a: unknown[]) => complete(...a),
  failDirty: (...a: unknown[]) => fail(...a),
}))

import {
  AVAILABILITY_CLAIM_KINDS,
  createAvailabilityReconcileSteps,
  reconcileOpportunityAvailability,
  reconcileSourceRecordAvailability,
  resolveInventoryInput,
} from './availability-reconcile-worker'
import type { ClaimedDirtyWork } from '../ownership/dirty-work.store'
import { RecomputeWorker } from './recompute-worker'

const dialect = new PgDialect()
const render = (q: unknown) => dialect.sqlToQuery(q as SQL).sql

const OPP = '0000000a-0000-4000-8000-000000000001'
const REC = '0000000b-0000-4000-8000-000000000002'

const work = (kind: ClaimedDirtyWork['entityKind'], entityId: string, targetVersion = 3) =>
  ({
    id: 'aaaaaaaa-0000-4000-8000-000000000000',
    owner: 'o',
    fencingEpoch: 1,
    entityKind: kind,
    entityId,
    targetVersion,
    reason: 'R',
    retryCount: 0,
  }) satisfies ClaimedDirtyWork

/** A db whose `execute` returns the queued row-sets in order and records each rendered statement. */
function dbOf(...rowSets: Record<string, unknown>[][]) {
  const queue = [...rowSets]
  const sqls: string[] = []
  const execute = vi.fn(async (q: unknown) => {
    sqls.push(render(q))
    return { rows: queue.shift() ?? [] }
  })
  const db = { execute, transaction: async (fn: (tx: unknown) => unknown) => fn({ execute }) }
  return { db, execute, sqls }
}

beforeEach(() => {
  updateInventory.mockReset().mockResolvedValue({})
  claim.mockReset().mockResolvedValue([])
  complete.mockReset().mockResolvedValue('DONE')
  fail.mockReset().mockResolvedValue('RETRY')
})

describe('resolveInventoryInput', () => {
  it('builds the board key `${type}:${namespace}` and reads sourceId + configVersion', async () => {
    const { db, sqls } = dbOf([
      { source_id: 'src-1', source_type: 'GREENHOUSE_ATS', namespace: 'acme', config_version: 4 },
    ])
    const input = await resolveInventoryInput(db as never, REC)
    expect(input).toEqual({
      sourceRecordId: REC,
      sourceId: 'src-1',
      board: 'GREENHOUSE_ATS:acme',
      configVersion: 4,
    })
    // The resolve reads the record and joins its source on (source_type, namespace).
    expect(sqls[0]).toContain('FROM job_source_records')
    expect(sqls[0]).toContain('JOIN job_sources')
  })

  it('is null when the record has no matching source', async () => {
    const { db } = dbOf([])
    expect(await resolveInventoryInput(db as never, REC)).toBeNull()
  })
})

describe('reconcileSourceRecordAvailability', () => {
  it('invokes the S8c updater with the resolved input, then completes', async () => {
    const { db } = dbOf([
      { source_id: 'src-1', source_type: 'GREENHOUSE_ATS', namespace: 'acme', config_version: 2 },
    ])
    const w = work('SOURCE_RECORD', REC)
    const outcome = await reconcileSourceRecordAvailability(db as never, w)
    expect(updateInventory).toHaveBeenCalledWith(db, {
      sourceRecordId: REC,
      sourceId: 'src-1',
      board: 'GREENHOUSE_ATS:acme',
      configVersion: 2,
    })
    expect(complete).toHaveBeenCalledWith(db, w)
    expect(outcome).toBe('DONE')
  })

  it('skips the updater for an orphan record but still completes the row', async () => {
    const { db } = dbOf([])
    await reconcileSourceRecordAvailability(db as never, work('SOURCE_RECORD', REC))
    expect(updateInventory).not.toHaveBeenCalled()
    expect(complete).toHaveBeenCalledTimes(1)
  })
})

describe('reconcileOpportunityAvailability', () => {
  it('writes the new availability and bumps revision when the derived state changed', async () => {
    const { db, sqls } = dbOf(
      [{ revision: 3, availability: 'OPEN' }],
      [{ availability: 'CLOSED' }, { availability: 'CLOSED' }],
    )
    const outcome = await reconcileOpportunityAvailability(db as never, work('OPPORTUNITY', OPP, 3))
    expect(outcome).toBe('DONE')
    // The active-record states are read from the link table joined to the records.
    expect(sqls.some((s) => s.includes('FROM job_opportunity_sources'))).toBe(true)
    expect(sqls.some((s) => s.includes('JOIN job_source_records'))).toBe(true)
    const update = sqls.find((s) => s.includes('UPDATE job_opportunities'))
    expect(update).toBeDefined()
    expect(update).toContain('revision')
    expect(update).toContain('availability')
  })

  it('writes nothing when the derived availability is unchanged (idempotent)', async () => {
    const { db, sqls } = dbOf([{ revision: 3, availability: 'OPEN' }], [{ availability: 'OPEN' }])
    await reconcileOpportunityAvailability(db as never, work('OPPORTUNITY', OPP, 3))
    expect(sqls.some((s) => s.includes('UPDATE job_opportunities'))).toBe(false)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('derives UNKNOWN and still closes when there are no active records', async () => {
    const { db, sqls } = dbOf([{ revision: 3, availability: 'OPEN' }], [])
    await reconcileOpportunityAvailability(db as never, work('OPPORTUNITY', OPP, 3))
    // OPEN -> UNKNOWN is a change, so a bump is written.
    expect(sqls.some((s) => s.includes('UPDATE job_opportunities'))).toBe(true)
  })

  it('completes without deriving when the revision moved on (stale target)', async () => {
    const { db, sqls } = dbOf([{ revision: 4, availability: 'OPEN' }])
    await reconcileOpportunityAvailability(db as never, work('OPPORTUNITY', OPP, 3))
    expect(sqls).toHaveLength(1)
    expect(sqls.some((s) => s.includes('UPDATE job_opportunities'))).toBe(false)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('completes without deriving when the opportunity is missing', async () => {
    const { db, sqls } = dbOf([])
    await reconcileOpportunityAvailability(db as never, work('OPPORTUNITY', OPP, 3))
    expect(sqls).toHaveLength(1)
    expect(complete).toHaveBeenCalledTimes(1)
  })
})

describe('createAvailabilityReconcileSteps', () => {
  it('claims only the two availability kinds', async () => {
    const { db } = dbOf()
    await createAvailabilityReconcileSteps(db as never).claim('owner', 50)
    expect(claim).toHaveBeenCalledWith(db, {
      owner: 'owner',
      batchSize: 50,
      kinds: AVAILABILITY_CLAIM_KINDS,
    })
    expect(AVAILABILITY_CLAIM_KINDS).toEqual(['SOURCE_RECORD', 'OPPORTUNITY'])
  })

  it('routes SOURCE_RECORD to the inventory updater', async () => {
    const { db } = dbOf([
      { source_id: 's', source_type: 'GREENHOUSE_ATS', namespace: 'n', config_version: 1 },
    ])
    await createAvailabilityReconcileSteps(db as never).process(work('SOURCE_RECORD', REC))
    expect(updateInventory).toHaveBeenCalledTimes(1)
  })

  it('routes OPPORTUNITY to re-derivation', async () => {
    const { db, sqls } = dbOf([{ revision: 3, availability: 'OPEN' }], [{ availability: 'OPEN' }])
    await createAvailabilityReconcileSteps(db as never).process(work('OPPORTUNITY', OPP, 3))
    expect(sqls.some((s) => s.includes('FROM job_opportunities'))).toBe(true)
    expect(updateInventory).not.toHaveBeenCalled()
  })

  it('completes any other kind untouched (claim never hands them out)', async () => {
    const { db } = dbOf()
    const w = work('SENIOR', OPP)
    await createAvailabilityReconcileSteps(db as never).process(w)
    expect(complete).toHaveBeenCalledWith(db, w)
    expect(updateInventory).not.toHaveBeenCalled()
  })

  it('forwards failures to the store', async () => {
    const { db } = dbOf()
    const w = work('OPPORTUNITY', OPP)
    await createAvailabilityReconcileSteps(db as never).fail(w, 'CODE', { maxAttempts: 1 })
    expect(fail).toHaveBeenCalledWith(db, w, 'CODE', { maxAttempts: 1 })
  })
})

describe('CR-M-2: batch resilience when a row throws mid-process', () => {
  const OPP2 = '0000000c-0000-4000-8000-000000000003'

  it('fails/retries the throwing row through the store and still finishes the rest of the batch', async () => {
    const workA = work('OPPORTUNITY', OPP, 3)
    const workB = work('OPPORTUNITY', OPP2, 3)
    claim.mockResolvedValueOnce([workA, workB])
    // The first row's transaction throws; the second succeeds (OPEN -> CLOSED -> bump).
    const okTx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ revision: 3, availability: 'OPEN' }] })
        .mockResolvedValueOnce({ rows: [{ availability: 'CLOSED' }] })
        .mockResolvedValue({ rows: [] }),
    }
    let txCall = 0
    const db = {
      execute: vi.fn(),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
        txCall += 1
        if (txCall === 1) throw new Error('boom mid-process')
        return fn(okTx)
      }),
    }
    const worker = new RecomputeWorker(createAvailabilityReconcileSteps(db as never), {
      owner: 'o',
      batchSize: 10,
    })

    const report = await worker.runOnce()

    expect(report).toMatchObject({ claimed: 2, done: 1, retried: 1, failed: 0, fenced: 0 })
    // The throwing row went through the store's fail path (retryable, not aborting the batch).
    expect(fail).toHaveBeenCalledTimes(1)
    expect(fail.mock.calls[0]?.[1]).toBe(workA)
    expect(complete).toHaveBeenCalledTimes(1)
  })
})
