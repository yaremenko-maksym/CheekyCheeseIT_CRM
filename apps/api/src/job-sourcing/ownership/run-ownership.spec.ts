import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { manualTermRefusal } from './ledger-policy'
import {
  RunFencedError,
  assertOwned,
  isWellFormedHandle,
  ownershipPredicate,
  type RunHandle,
} from './run-ownership'

/**
 * r5 Task 2.5 T3 — the ownership predicate and its guard, as units. The predicate's semantics
 * (a wrong token, a superseded epoch, an expired lease all own nothing) are proven against real
 * Postgres by `job-run-ledger.integration.spec.ts`; these cases pin the text and the pre-SQL guard.
 */
const dialect = new PgDialect()
const RUN = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'
const good: RunHandle = { runId: RUN, ownerToken: 'w:token', fencingEpoch: 3 }

function executor(rows: Record<string, unknown>[]) {
  const seen: { sql: string; params: unknown[] }[] = []
  return {
    seen,
    tx: {
      execute: (q: SQL) => {
        seen.push(dialect.sqlToQuery(q))
        return Promise.resolve({ rows })
      },
    },
  }
}

describe('isWellFormedHandle', () => {
  it('accepts a uuid, a token and a positive integer epoch', () => {
    expect(isWellFormedHandle(good)).toBe(true)
  })

  it.each([
    ['a non-uuid run id', { runId: 'run-1' }],
    ['an empty token', { ownerToken: '' }],
    ['an over-long token', { ownerToken: 'x'.repeat(201) }],
    ['a non-string token', { ownerToken: 7 as unknown as string }],
    ['an array token (it has a length)', { ownerToken: ['w:token'] as unknown as string }],
    ['a run id with a prefix', { runId: `x${RUN}` }],
    ['a run id with a suffix', { runId: `${RUN}x` }],
    ['epoch 0', { fencingEpoch: 0 }],
    ['a negative epoch', { fencingEpoch: -1 }],
    ['a fractional epoch', { fencingEpoch: 1.5 }],
  ])('refuses %s', (_label, over) => {
    expect(isWellFormedHandle({ ...good, ...over })).toBe(false)
  })

  it('a token of exactly the column bound is accepted', () => {
    expect(isWellFormedHandle({ ...good, ownerToken: 'x'.repeat(200) })).toBe(true)
  })
})

describe('ownershipPredicate', () => {
  it('is the ADR`s five terms, with the three handle values as parameters', () => {
    const q = dialect.sqlToQuery(ownershipPredicate(good))
    expect(q.sql).toBe(
      "id = $1::uuid AND owner_token = $2 AND fencing_epoch = $3 AND outcome = 'STARTED' AND lease_expires_at > clock_timestamp()",
    )
    expect(q.params).toEqual([RUN, 'w:token', 3])
  })
})

describe('assertOwned', () => {
  it('locks the run row under the predicate and returns what it read', async () => {
    const { tx, seen } = executor([{ id: RUN, account_key: 'acct:a', source_id: 'src-1' }])
    expect(await assertOwned(tx, good)).toEqual({
      runId: RUN,
      accountKey: 'acct:a',
      sourceId: 'src-1',
    })
    expect(seen[0]!.sql).toMatch(
      /^SELECT id, account_key, source_id FROM job_collection_runs WHERE .* FOR UPDATE$/,
    )
  })

  it('no row is RUN_FENCED', async () => {
    const { tx } = executor([])
    const err = await assertOwned(tx, good).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RunFencedError)
    expect((err as RunFencedError).code).toBe('RUN_FENCED')
    expect((err as RunFencedError).name).toBe('RunFencedError')
    expect((err as RunFencedError).message).toBe('the run is not owned by this executor')
  })

  it('a malformed handle is RUN_FENCED before any SQL, and says so', async () => {
    const { tx, seen } = executor([{ id: RUN }])
    await expect(assertOwned(tx, { ...good, fencingEpoch: 0 })).rejects.toThrow(
      new RunFencedError('a malformed run handle owns nothing'),
    )
    await expect(assertOwned(tx, { ...good, fencingEpoch: 0 })).rejects.toBeInstanceOf(
      RunFencedError,
    )
    expect(seen).toEqual([])
  })
})

describe('manualTermRefusal — the manual due terms, first failure wins', () => {
  const pass = {
    t_enabled: true,
    t_active: true,
    t_manifest: true,
    t_trigger: true,
    t_cap: true,
    t_cool: true,
    t_idle: true,
    t_due: true,
    host_key: 'remotive.com',
  }

  it('all terms true is no refusal', () => {
    expect(manualTermRefusal(pass)).toBeNull()
  })

  it.each([
    ['t_enabled', 'DISABLED'],
    ['t_active', 'NOT_ACTIVE'],
    ['t_manifest', 'NO_MANIFEST_ENTRY'],
    ['t_trigger', 'TRIGGER_MODE'],
    ['t_cap', 'FAILURE_CAP'],
    ['t_cool', 'COOLING_DOWN'],
    ['t_idle', 'ALREADY_RUNNING'],
  ])('%s false refuses %s', (term, reason) => {
    expect(manualTermRefusal({ ...pass, [term]: false })).toBe(reason)
  })

  it('anything but a literal true refuses (a NULL from the database included)', () => {
    expect(manualTermRefusal({ ...pass, t_enabled: null })).toBe('DISABLED')
  })

  it('the remaining host term: a paused host, or no host key', () => {
    expect(manualTermRefusal({ ...pass, t_due: false })).toBe('HOST_PAUSED')
    expect(manualTermRefusal({ ...pass, t_due: false, host_key: null })).toBe('HOST_KEY_MISSING')
  })

  it('the earlier term wins when two fail', () => {
    expect(manualTermRefusal({ ...pass, t_cap: false, t_cool: false })).toBe('FAILURE_CAP')
  })
})
