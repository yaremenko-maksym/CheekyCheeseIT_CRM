import { describe, expect, it, vi } from 'vitest'
import type { SourceObservation } from '../normalize/observation'
import type {
  CollectionContext,
  DetailOutcome,
  DetailTarget,
  ReportingJobSourceProvider,
  ValidatedSourceConfig,
} from '../providers/reporting-provider'
import { type ClaimedDetail, type DetailTailPort, runDetailTail } from './detail-tail'

/**
 * SFS U10 part 3 — the detail tail's orchestration (#4/#7), tested over a fake port and provider:
 * which outcome drives which side effect, and that a transport refusal propagates (ends the run).
 */

const ctx = {} as CollectionContext
const config = {} as unknown as ValidatedSourceConfig
// A FOUND observation whose identity key matches the claimed record's default key below (CR-M-9).
const OBS_KEY = '["v1","NATIVE_ID","REMOTIVE_API","ns","42"]'
const observation = { identity: { identityKey: OBS_KEY } } as SourceObservation

function claimed(
  nativeId: string | null,
  id = 'rec',
  identityKey: string | null = OBS_KEY,
): ClaimedDetail {
  return {
    handle: { id, owner: 'w', fencingEpoch: 1 } as ClaimedDetail['handle'],
    recordId: id,
    nativeId,
    identityKey,
  }
}

function port(rows: readonly ClaimedDetail[], over: Partial<DetailTailPort> = {}) {
  const calls = {
    write: [] as ClaimedDetail[],
    gone: [] as ClaimedDetail[],
    fail: [] as [ClaimedDetail, string, boolean][],
    release: [] as ClaimedDetail[][],
  }
  const p: DetailTailPort = {
    claim: vi.fn(async () => rows),
    writeFound: vi.fn(async (r) => {
      calls.write.push(r)
      return 'DEFERRED' as const
    }),
    recordGone: vi.fn(async (r) => {
      calls.gone.push(r)
    }),
    fail: vi.fn(async (r, code, poison) => {
      calls.fail.push([r, code, poison])
      return 'RETRY' as const
    }),
    release: vi.fn(async (r) => {
      calls.release.push([...r])
    }),
    ...over,
  }
  return { p, calls }
}

const providerWith = (
  collectDetail: (
    c: ValidatedSourceConfig,
    r: DetailTarget,
    x: CollectionContext,
  ) => Promise<DetailOutcome>,
): Pick<ReportingJobSourceProvider, 'collectDetail'> => ({ collectDetail })

describe('runDetailTail', () => {
  it('an IN_LIST provider (no collectDetail) claims nothing and does nothing', async () => {
    const { p } = port([claimed('1')])
    const report = await runDetailTail({}, config, ctx, p, 5)
    expect(report.claimed).toBe(0)
    expect(p.claim).not.toHaveBeenCalled()
  })

  it('detailPerRun < 1 is a no-op (nothing is claimed)', async () => {
    const { p } = port([claimed('1')])
    const provider = providerWith(async () => ({ kind: 'GONE' }))
    await runDetailTail(provider, config, ctx, p, 0)
    expect(p.claim).not.toHaveBeenCalled()
  })

  it('passes detailPerRun to the claim; a batch of exactly 1 is claimable, not a no-op', async () => {
    const { p } = port([])
    const provider = providerWith(async () => ({ kind: 'GONE' }))
    await runDetailTail(provider, config, ctx, p, 1)
    expect(p.claim).toHaveBeenCalledWith(1)
  })

  it('FOUND: fetches by the record native id and writes it through the store (DEFERRED counted)', async () => {
    const { p, calls } = port([claimed('42')])
    const collectDetail = vi.fn(async (): Promise<DetailOutcome> => ({
      kind: 'FOUND',
      observation,
    }))
    const report = await runDetailTail({ collectDetail }, config, ctx, p, 5)
    expect(collectDetail).toHaveBeenCalledWith(config, { nativeId: '42' }, ctx)
    expect(calls.write).toHaveLength(1)
    expect(report).toMatchObject({ claimed: 1, fetched: 1, deferred: 1, gone: 0, failed: 0 })
  })

  it('FOUND with a DONE completion is not counted as deferred', async () => {
    const { p } = port([claimed('42')], { writeFound: vi.fn(async () => 'DONE' as const) })
    const provider = providerWith(async () => ({ kind: 'FOUND', observation }))
    const report = await runDetailTail(provider, config, ctx, p, 5)
    expect(report).toMatchObject({ fetched: 1, deferred: 0 })
  })

  it('GONE: records availability evidence and never fails', async () => {
    const { p, calls } = port([claimed('42')])
    const provider = providerWith(async () => ({ kind: 'GONE' }))
    const report = await runDetailTail(provider, config, ctx, p, 5)
    expect(calls.gone).toHaveLength(1)
    expect(report).toMatchObject({ gone: 1, fetched: 0, failed: 0 })
  })

  it('FAILED: fails with DETAIL_<code>, counting a retry while attempts remain', async () => {
    const { p, calls } = port([claimed('42')])
    const provider = providerWith(async () => ({ kind: 'FAILED', code: 'UPSTREAM', status: 500 }))
    const report = await runDetailTail(provider, config, ctx, p, 5)
    expect(calls.fail).toEqual([[expect.anything(), 'DETAIL_UPSTREAM', false]])
    expect(report).toMatchObject({ retried: 1, failed: 0 })
  })

  it('FAILED that reaches the attempt cap is counted as failed', async () => {
    const { p } = port([claimed('42')], { fail: vi.fn(async () => 'FAILED' as const) })
    const provider = providerWith(async () => ({
      kind: 'FAILED',
      code: 'PARSE_DRIFT',
      status: 200,
    }))
    const report = await runDetailTail(provider, config, ctx, p, 5)
    expect(report).toMatchObject({ failed: 1, retried: 0 })
  })

  it('a record with no native id is failed as a non-retryable data defect, without fetching', async () => {
    const collectDetail = vi.fn(async (): Promise<DetailOutcome> => ({ kind: 'GONE' }))
    const { p, calls } = port([claimed(null)])
    const report = await runDetailTail({ collectDetail }, config, ctx, p, 5)
    expect(collectDetail).not.toHaveBeenCalled()
    expect(calls.fail).toEqual([[expect.anything(), 'DETAIL_NO_NATIVE_ID', true]])
    expect(report).toMatchObject({ unfetchable: 1, failed: 1 })
  })

  it('a transport refusal thrown by collectDetail propagates (the run stops and bans the host)', async () => {
    const boom = new Error('refused')
    const { p } = port([claimed('42')])
    const provider = providerWith(async () => {
      throw boom
    })
    await expect(runDetailTail(provider, config, ctx, p, 5)).rejects.toBe(boom)
  })

  it('processes every claimed row (a mixed batch)', async () => {
    const rows = [claimed('1', 'a'), claimed('2', 'b'), claimed('3', 'c')]
    const outcomes: DetailOutcome[] = [
      { kind: 'FOUND', observation },
      { kind: 'GONE' },
      { kind: 'FAILED', code: 'PAYLOAD_TOO_LARGE', status: 200 },
    ]
    let i = 0
    const provider = providerWith(async () => outcomes[i++] as DetailOutcome)
    const { p } = port(rows)
    const report = await runDetailTail(provider, config, ctx, p, 5)
    expect(report).toMatchObject({ claimed: 3, fetched: 1, gone: 1, retried: 1 })
  })

  it('CR-M-6: an aborted tail releases the UNTRIED rows without spending an attempt', async () => {
    // Three claimed up front; the SECOND throws (a ban). The first is tried; the third was never
    // tried and must be released (not left to lease-expiry, which would count a spent attempt).
    const rows = [claimed('1', 'a'), claimed('2', 'b'), claimed('3', 'c')]
    const boom = new Error('refused')
    let i = 0
    const provider = providerWith(async (): Promise<DetailOutcome> => {
      if (i++ === 1) throw boom
      return { kind: 'GONE' }
    })
    const { p, calls } = port(rows)
    await expect(runDetailTail(provider, config, ctx, p, 5)).rejects.toBe(boom)
    // Only the untried row 'c' is released; the in-flight 'b' stays claimed, 'a' was handled.
    expect(calls.release).toEqual([[rows[2]]])
    // No `fail` on the untried row: its attempt counter is untouched (the whole point).
    expect(calls.fail).toEqual([])
  })

  it('CR-M-6: the LAST row throwing releases nothing (no untried rows remain)', async () => {
    const rows = [claimed('1', 'a'), claimed('2', 'b')]
    const boom = new Error('refused')
    let i = 0
    const provider = providerWith(async (): Promise<DetailOutcome> => {
      if (i++ === 1) throw boom
      return { kind: 'GONE' }
    })
    const { p, calls } = port(rows)
    await expect(runDetailTail(provider, config, ctx, p, 5)).rejects.toBe(boom)
    expect(calls.release).toEqual([])
  })

  it('CR-M-9: a FOUND whose observation identity differs from the claimed record is rejected, not written', async () => {
    // The claimed record's identity key is OTHER_KEY; the adapter returns an observation keyed
    // OBS_KEY — a different posting. Writing it would duplicate; instead fail loud (poison, no write).
    const row = claimed('42', 'rec', '["v1","NATIVE_ID","REMOTIVE_API","ns","99"]')
    const { p, calls } = port([row])
    const provider = providerWith(async () => ({ kind: 'FOUND', observation }))
    const report = await runDetailTail(provider, config, ctx, p, 5)
    expect(calls.write).toEqual([]) // never written → no duplicate record
    expect(calls.fail).toEqual([[row, 'DETAIL_IDENTITY_MISMATCH', true]]) // poison, never DONE
    expect(report).toMatchObject({ mismatched: 1, failed: 1, fetched: 0 })
  })

  it('CR-M-9: a FOUND whose identity matches is written as before', async () => {
    const { p, calls } = port([claimed('42', 'rec', OBS_KEY)])
    const provider = providerWith(async () => ({ kind: 'FOUND', observation }))
    const report = await runDetailTail(provider, config, ctx, p, 5)
    expect(calls.write).toHaveLength(1)
    expect(report).toMatchObject({ fetched: 1, mismatched: 0 })
  })
})
