import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../test/fake-collection-context'
import { RunFencedError } from '../ownership/run-ownership'
import type { CollectionContext } from './reporting-provider'
import { createJSearchProvider } from './sources/jsearch.provider'

/**
 * r5 Task 2.5 T7 (ADR T7, "When markSent is refused with RUN_FENCED mid-run"): the paged loop's
 * `markSent` failure branch. A fenced-out executor sends NOTHING, the attempt stops at once, the
 * request is reported `RUN_FENCED` (ownership, not `PERSISTENCE`), and no `reconcile` is attempted
 * -- the store would refuse it too; the run's end-of-run settlement releases the reservation.
 */
const KEY = 'fake0000rapid0000key0000fake0000rapid0000key0000xyz'
const provider = createJSearchProvider({
  credential: { configured: true, apiKey: KEY, secrets: [KEY] },
})
const config = provider.parseConfig({ configVersion: 1, query: 'senior backend developer remote' })

function harness(markSentError: unknown) {
  const f = fakeCollectionContext({ responses: [] })
  const calls: string[] = []
  const ctx: CollectionContext = {
    ...f.ctx,
    async fetchText(request) {
      calls.push('fetchText')
      return f.ctx.fetchText(request)
    },
    meter: {
      async reserve(unit, amount) {
        calls.push('reserve')
        return { id: 'r1', unit, amount }
      },
      async markSent() {
        calls.push('markSent')
        throw markSentError
      },
      async reconcile(_r, resolution) {
        calls.push(`reconcile:${resolution}`)
      },
    },
  }
  return { ctx, calls, f }
}

describe('a markSent refused with RUN_FENCED (T7)', () => {
  it('sends nothing, stops the attempt, reports RUN_FENCED and attempts no reconcile', async () => {
    const h = harness(new RunFencedError())
    const batch = await provider.collectReport(config, h.ctx)
    expect(h.calls).toEqual(['reserve', 'markSent'])
    expect(h.f.sent).toEqual([])
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.map((r) => r.error?.code)).toEqual(['RUN_FENCED'])
  })

  it('reads the code, so the context`s own lease refusal (same code) is RUN_FENCED too', async () => {
    const h = harness(Object.assign(new Error('the lease passed'), { code: 'RUN_FENCED' }))
    const batch = await provider.collectReport(config, h.ctx)
    expect(h.calls).toEqual(['reserve', 'markSent'])
    expect(batch.requests.map((r) => r.error?.code)).toEqual(['RUN_FENCED'])
  })

  it('any other markSent failure stays PERSISTENCE and the reservation is released', async () => {
    const h = harness(new Error('connection reset'))
    const batch = await provider.collectReport(config, h.ctx)
    expect(h.calls).toEqual(['reserve', 'markSent', 'reconcile:RELEASED'])
    expect(h.f.sent).toEqual([])
    expect(batch.requests.map((r) => r.error?.code)).toEqual(['PERSISTENCE'])
  })
})
