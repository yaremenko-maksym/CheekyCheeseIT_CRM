import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  claimDirtyBatch,
  completeDirty,
  DirtyKindUnsupportedError,
  DirtyWorkFencedError,
  type DirtyWorkHandle,
  dirtyWorkStatements,
  enqueueDirty,
  failDirty,
  recoverExpiredDirty,
} from './dirty-work.store'

/**
 * r5 Task 4.6 S3 — the dirty-work store against a scripted executor. The real-DB behaviour
 * (SKIP LOCKED, lease expiry, version comparison) is proven in the integration spec; this spec
 * pins validation, outcome mapping and the parameters each statement carries.
 */
const dialect = new PgDialect()
const render = (q: SQL) => dialect.sqlToQuery(q)

const ID = '0b6a6f6e-8f43-4c55-9c4a-6c3f3e1f2a10'
const ENTITY = '7d9b0d1c-2e5f-4a8b-9c6d-1e2f3a4b5c6d'

function scripted(rows: Record<string, unknown>[] = []) {
  const seen: { sql: string; params: unknown[] }[] = []
  const tx: SqlExecutor = {
    execute: (q: SQL) => {
      seen.push(render(q))
      return Promise.resolve({ rows })
    },
  }
  return { tx, seen }
}

const handle = (over: Partial<DirtyWorkHandle> = {}): DirtyWorkHandle => ({
  id: ID,
  owner: 'worker-1',
  fencingEpoch: 3,
  entityKind: 'OPPORTUNITY',
  ...over,
})

describe('enqueueDirty', () => {
  it('reports a returned row as inserted and no row (a duplicate) as a no-op', async () => {
    await expect(
      enqueueDirty(scripted([{ id: ID }]).tx, 'OPPORTUNITY', ENTITY, 2, 'R'),
    ).resolves.toEqual({ inserted: true })
    await expect(enqueueDirty(scripted([]).tx, 'OPPORTUNITY', ENTITY, 2, 'R')).resolves.toEqual({
      inserted: false,
    })
  })

  it('inserts with ON CONFLICT DO NOTHING on the unique key, with the given values', async () => {
    const { tx, seen } = scripted([{ id: ID }])
    await enqueueDirty(tx, 'SOURCE_RECORD', ENTITY, 7, 'SOURCE_REVISION')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.sql).toContain(
      'ON CONFLICT (entity_kind, entity_id, target_version, reason) DO NOTHING',
    )
    expect(seen[0]!.params).toEqual(['SOURCE_RECORD', ENTITY, 7, 'SOURCE_REVISION'])
  })

  it.each([
    ['an unknown kind', 'NOPE', ENTITY, 1, 'R'],
    ['a non-uuid entity', 'OPPORTUNITY', 'x', 1, 'R'],
    ['version 0', 'OPPORTUNITY', ENTITY, 0, 'R'],
    ['a fractional version', 'OPPORTUNITY', ENTITY, 1.5, 'R'],
    ['a blank reason', 'OPPORTUNITY', ENTITY, 1, '   '],
    ['a 101-character reason', 'OPPORTUNITY', ENTITY, 1, 'R'.repeat(101)],
  ])('refuses %s before any SQL', async (_label, kind, id, version, reason) => {
    const { tx, seen } = scripted()
    await expect(enqueueDirty(tx, kind as 'OPPORTUNITY', id, version, reason)).rejects.toThrow()
    expect(seen).toHaveLength(0)
  })

  it('accepts a 100-character reason and version 1', async () => {
    const { tx, seen } = scripted([{ id: ID }])
    await enqueueDirty(tx, 'OPPORTUNITY', ENTITY, 1, 'R'.repeat(100))
    expect(seen).toHaveLength(1)
  })
})

describe('claimDirtyBatch', () => {
  const row = (id: string, created: string, epoch = 2) => ({
    id,
    entity_kind: 'OPPORTUNITY',
    entity_id: ENTITY,
    target_version: '4',
    reason: 'CANONICAL_REVISION',
    fencing_epoch: String(epoch),
    retry_count: 1,
    created_at: created,
  })

  it('defaults to a batch of 200 and a five-minute lease, SKIP LOCKED', async () => {
    const { tx, seen } = scripted()
    await claimDirtyBatch(tx, { owner: 'w' })
    expect(seen[0]!.sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(seen[0]!.sql).toContain("WHERE status = 'PENDING'")
    expect(seen[0]!.sql).toContain('fencing_epoch = d.fencing_epoch + 1')
    expect(seen[0]!.params).toEqual([200, 'w', 300_000])
  })

  it('passes an explicit batch size and lease', async () => {
    const { tx, seen } = scripted()
    await claimDirtyBatch(tx, { owner: 'w', batchSize: 1000, leaseMs: 3_600_000 })
    expect(seen[0]!.params).toEqual([1000, 'w', 3_600_000])
  })

  it.each([
    ['batch 0', { batchSize: 0 }],
    ['batch above the cap', { batchSize: 1001 }],
    ['a fractional batch', { batchSize: 2.5 }],
    ['lease 0', { leaseMs: 0 }],
    ['a lease above an hour', { leaseMs: 3_600_001 }],
  ])('refuses %s before any SQL', async (_label, over) => {
    const { tx, seen } = scripted()
    await expect(claimDirtyBatch(tx, { owner: 'w', ...over })).rejects.toThrow(RangeError)
    expect(seen).toHaveLength(0)
  })

  it.each([
    ['an empty owner', ''],
    ['a 201-character owner', 'o'.repeat(201)],
  ])('refuses %s', async (_label, owner) => {
    const { tx, seen } = scripted()
    await expect(claimDirtyBatch(tx, { owner })).rejects.toThrow(RangeError)
    expect(seen).toHaveLength(0)
  })

  it('accepts a 200-character owner', async () => {
    const { tx, seen } = scripted()
    await claimDirtyBatch(tx, { owner: 'o'.repeat(200) })
    expect(seen).toHaveLength(1)
  })

  it('maps rows to numeric handles carrying the owner, oldest first', async () => {
    const later = '1b6a6f6e-8f43-4c55-9c4a-6c3f3e1f2a10'
    const a = '2b6a6f6e-8f43-4c55-9c4a-6c3f3e1f2a10'
    const b = '3b6a6f6e-8f43-4c55-9c4a-6c3f3e1f2a10'
    const { tx } = scripted([
      row(later, '2026-10-26T10:00:01Z', 5),
      row(b, '2026-10-26T10:00:00Z'),
      row(a, '2026-10-26T10:00:00Z'),
    ])
    const got = await claimDirtyBatch(tx, { owner: 'w' })
    expect(got.map((w) => w.id)).toEqual([a, b, later])
    expect(got[2]).toEqual({
      id: later,
      owner: 'w',
      fencingEpoch: 5,
      entityKind: 'OPPORTUNITY',
      entityId: ENTITY,
      targetVersion: 4,
      reason: 'CANONICAL_REVISION',
      retryCount: 1,
    })
  })
})

describe('completeDirty', () => {
  it('returns DONE / DEFERRED as the statement reports', async () => {
    await expect(completeDirty(scripted([{ status: 'DONE' }]).tx, handle())).resolves.toBe('DONE')
    await expect(completeDirty(scripted([{ status: 'DEFERRED' }]).tx, handle())).resolves.toBe(
      'DEFERRED',
    )
  })

  it('refuses a stale handle (no row) as fenced', async () => {
    await expect(completeDirty(scripted([]).tx, handle())).rejects.toBeInstanceOf(
      DirtyWorkFencedError,
    )
  })

  it('names id, owner, epoch, kind, CLAIMED and a live lease, and reads the version by kind', async () => {
    const { tx, seen } = scripted([{ status: 'DONE' }])
    await completeDirty(tx, handle({ entityKind: 'SOURCE_RECORD' }))
    const s = seen[0]!.sql
    expect(s).toContain('FROM job_source_record_heads WHERE source_record_id = w.entity_id')
    expect(s).toContain('claim_owner = $')
    expect(s).toContain('fencing_epoch = $')
    expect(s).toContain("status = 'CLAIMED' AND lease_expires_at > clock_timestamp()")
    expect(seen[0]!.params).toEqual([
      ID,
      'ENTITY_MISSING',
      'VERSION_STALE',
      ID,
      'worker-1',
      3,
      'SOURCE_RECORD',
    ])
  })

  it('reads an opportunity version from job_opportunities.revision', async () => {
    const { tx, seen } = scripted([{ status: 'DONE' }])
    await completeDirty(tx, handle())
    expect(seen[0]!.sql).toContain('SELECT revision FROM job_opportunities WHERE id = w.entity_id')
  })

  it.each(['SENIOR', 'EXCLUSION', 'PROJECT_CLIENT'] as const)(
    'refuses kind %s, which has no version source, before any SQL',
    async (entityKind) => {
      const { tx, seen } = scripted([{ status: 'DONE' }])
      await expect(completeDirty(tx, handle({ entityKind }))).rejects.toBeInstanceOf(
        DirtyKindUnsupportedError,
      )
      expect(seen).toHaveLength(0)
    },
  )

  it.each([
    ['a non-uuid id', { id: 'nope' }],
    ['an empty owner', { owner: '' }],
    ['a 201-character owner', { owner: 'o'.repeat(201) }],
    ['epoch 0', { fencingEpoch: 0 }],
    ['a fractional epoch', { fencingEpoch: 1.5 }],
  ])('refuses %s as fenced before any SQL', async (_label, over) => {
    const { tx, seen } = scripted([{ status: 'DONE' }])
    await expect(completeDirty(tx, handle(over))).rejects.toBeInstanceOf(DirtyWorkFencedError)
    expect(seen).toHaveLength(0)
  })

  it('accepts epoch 1 and a 200-character owner', async () => {
    const { tx } = scripted([{ status: 'DONE' }])
    await expect(
      completeDirty(tx, handle({ fencingEpoch: 1, owner: 'o'.repeat(200) })),
    ).resolves.toBe('DONE')
  })
})

describe('failDirty', () => {
  it('maps PENDING to RETRY and FAILED to FAILED', async () => {
    await expect(
      failDirty(scripted([{ status: 'PENDING' }]).tx, handle(), 'HTTP_500'),
    ).resolves.toBe('RETRY')
    await expect(
      failDirty(scripted([{ status: 'FAILED' }]).tx, handle(), 'HTTP_500'),
    ).resolves.toBe('FAILED')
  })

  it('refuses a stale handle', async () => {
    await expect(failDirty(scripted([]).tx, handle(), 'HTTP_500')).rejects.toBeInstanceOf(
      DirtyWorkFencedError,
    )
  })

  it('carries the code and a default budget of 5 attempts', async () => {
    const { tx, seen } = scripted([{ status: 'PENDING' }])
    await failDirty(tx, handle(), 'HTTP_500')
    expect(seen[0]!.params.slice(0, 3)).toEqual([5, 5, 'HTTP_500'])
    expect(seen[0]!.sql).toContain('retry_count = retry_count + 1')
  })

  it('carries an explicit budget', async () => {
    const { tx, seen } = scripted([{ status: 'PENDING' }])
    await failDirty(tx, handle(), 'HTTP_500', { maxAttempts: 20 })
    expect(seen[0]!.params.slice(0, 2)).toEqual([20, 20])
  })

  it.each([
    ['a lowercase code', 'oops', {}],
    ['budget 0', 'HTTP_500', { maxAttempts: 0 }],
    ['a budget above 20', 'HTTP_500', { maxAttempts: 21 }],
  ])('refuses %s before any SQL', async (_label, code, opts) => {
    const { tx, seen } = scripted([{ status: 'PENDING' }])
    await expect(failDirty(tx, handle(), code, opts)).rejects.toThrow()
    expect(seen).toHaveLength(0)
  })

  it('refuses a malformed handle before any SQL', async () => {
    const { tx, seen } = scripted([{ status: 'PENDING' }])
    await expect(failDirty(tx, handle({ fencingEpoch: 0 }), 'HTTP_500')).rejects.toBeInstanceOf(
      DirtyWorkFencedError,
    )
    expect(seen).toHaveLength(0)
  })
})

describe('recoverExpiredDirty', () => {
  it('counts requeued and failed rows', async () => {
    const { tx } = scripted([{ status: 'PENDING' }, { status: 'FAILED' }, { status: 'PENDING' }])
    await expect(recoverExpiredDirty(tx)).resolves.toEqual({ requeued: 2, failed: 1 })
  })

  it('bumps the epoch, counts the attempt, defaults to 200 rows and 5 attempts', async () => {
    const { tx, seen } = scripted()
    await expect(recoverExpiredDirty(tx)).resolves.toEqual({ requeued: 0, failed: 0 })
    const s = seen[0]!.sql
    expect(s).toContain("status = 'CLAIMED' AND lease_expires_at <= clock_timestamp()")
    expect(s).toContain('FOR UPDATE SKIP LOCKED')
    expect(s).toContain('fencing_epoch = d.fencing_epoch + 1')
    expect(s).toContain('retry_count = d.retry_count + 1')
    expect(seen[0]!.params).toEqual([200, 5, 5, 'LEASE_EXPIRED'])
  })

  it('carries explicit options and refuses out-of-range ones', async () => {
    const { tx, seen } = scripted()
    await recoverExpiredDirty(tx, { batchSize: 10, maxAttempts: 2 })
    expect(seen[0]!.params).toEqual([10, 2, 2, 'LEASE_EXPIRED'])
    await expect(recoverExpiredDirty(tx, { batchSize: 1001 })).rejects.toThrow(RangeError)
    await expect(recoverExpiredDirty(tx, { maxAttempts: 21 })).rejects.toThrow(RangeError)
    expect(seen).toHaveLength(1)
  })
})

describe('dirtyWorkStatements', () => {
  it('claims oldest-first within the batch limit', () => {
    const s = render(dirtyWorkStatements.claim('w', 5, 1000)).sql
    expect(s).toContain('ORDER BY created_at, id')
    expect(s).toContain("SET status = 'CLAIMED'")
  })
})
