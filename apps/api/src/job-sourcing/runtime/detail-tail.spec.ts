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
const observation = {} as SourceObservation

function claimed(nativeId: string | null, id = 'rec'): ClaimedDetail {
  return {
    handle: { id, owner: 'w', fencingEpoch: 1 } as ClaimedDetail['handle'],
    recordId: id,
    nativeId,
  }
}

function port(rows: readonly ClaimedDetail[], over: Partial<DetailTailPort> = {}) {
  const calls = {
    write: [] as ClaimedDetail[],
    gone: [] as ClaimedDetail[],
    fail: [] as [ClaimedDetail, string, boolean][],
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
})
