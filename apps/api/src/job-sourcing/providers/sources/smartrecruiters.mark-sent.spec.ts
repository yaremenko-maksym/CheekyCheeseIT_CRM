import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { RunFencedError } from '../../ownership/run-ownership'
import { SMARTRECRUITERS_OWNER_DECISION } from '../owner-decisions'
import type { CollectionContext } from '../reporting-provider'
import {
  createSmartRecruitersProvider,
  SMARTRECRUITERS_BOUNDS,
  smartrecruitersProvider,
} from './smartrecruiters.provider'

/**
 * r5 Task 2.5 T7 (ADR T7, "markSent: its home", AC 7): the SmartRecruiters adapter bypasses the
 * paged loop for its detail requests, so it carries the awaited `markSent` itself. Every request
 * it sends -- the list AND each detail -- is preceded by a committed `markSent` of its own
 * reservation; a rejected `markSent` sends nothing.
 */
const live = createSmartRecruitersProvider(SMARTRECRUITERS_BOUNDS, {
  ownerDecision: SMARTRECRUITERS_OWNER_DECISION,
})
const config = smartrecruitersProvider.parseConfig({ configVersion: 1, board: 'acme' })

const listBody = (ids: string[]) =>
  JSON.stringify({
    limit: 100,
    offset: 0,
    totalFound: ids.length,
    content: ids.map((id) => ({
      id,
      name: `Posting ${id}`,
      company: { identifier: 'Acme', name: 'Acme Inc' },
      releasedDate: '2026-10-01T10:00:00.000Z',
      location: { city: 'Berlin', country: 'de', remote: true },
      ref: `https://api.smartrecruiters.com/api-v1/companies/Acme/postings/${id}`,
    })),
  })
const detailBody = (id: string) =>
  JSON.stringify({
    id,
    name: `Posting ${id}`,
    postingUrl: `https://jobs.smartrecruiters.com/Acme/${id}-posting`,
    applyUrl: `https://www.smartrecruiters.com/Acme/${id}-posting?oga=true`,
    active: true,
    jobAd: { sections: { jobDescription: { title: 'Job', text: '<p>Do things.</p>' } } },
  })

function harness(markSent: (reservationId: string) => Promise<void>) {
  const events: string[] = []
  let n = 0
  const f = fakeCollectionContext({ responses: [] })
  const ctx: CollectionContext = {
    ...f.ctx,
    async fetchText(request) {
      const id = /\/postings\/([^/?]+)$/.exec(request.url)?.[1]
      events.push(`fetch:${id ?? 'list'}`)
      return {
        status: 200,
        bodyText: id === undefined ? listBody(['111', '222']) : detailBody(id),
        headers: {},
        etag: null,
      }
    },
    meter: {
      async reserve(unit, amount) {
        n += 1
        events.push(`reserve:r${n}`)
        return { id: `r${n}`, unit, amount }
      },
      async markSent(r) {
        await markSent(r.id)
        events.push(`markSent:${r.id}`)
      },
      async reconcile(r, resolution) {
        events.push(`reconcile:${r.id}:${resolution}`)
      },
    },
  }
  return { ctx, events }
}

describe('SmartRecruiters marks every request sent before it leaves (T7, AC 7)', () => {
  it('the list and each detail: reserve -> markSent (committed) -> fetch -> reconcile', async () => {
    const h = harness(async () => {})
    await live.collectReport(config, h.ctx)
    expect(h.events).toEqual([
      'reserve:r1',
      'markSent:r1',
      'fetch:list',
      'reconcile:r1:USED',
      'reserve:r2',
      'markSent:r2',
      'fetch:111',
      'reconcile:r2:USED',
      'reserve:r3',
      'markSent:r3',
      'fetch:222',
      'reconcile:r3:USED',
    ])
  })

  it('a detail whose markSent is refused RUN_FENCED is not sent, and is not reconciled', async () => {
    const h = harness(async (id) => {
      if (id === 'r2') throw new RunFencedError()
    })
    const batch = await live.collectReport(config, h.ctx)
    expect(h.events).toEqual([
      'reserve:r1',
      'markSent:r1',
      'fetch:list',
      'reconcile:r1:USED',
      'reserve:r2',
    ])
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'RUN_FENCED',
      message: 'the request was not sent: the run is fenced out',
    })
  })

  it('a markSent failing for another reason is not sent, and the reservation is RELEASED', async () => {
    const h = harness(async (id) => {
      if (id === 'r1') throw new Error('connection reset')
    })
    const batch = await live.collectReport(config, h.ctx)
    expect(h.events).toEqual(['reserve:r1', 'reconcile:r1:RELEASED'])
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PERSISTENCE',
      message:
        'the request was not sent, its reservation could not be marked sent: connection reset',
    })
  })

  it('says so when the release fails too', async () => {
    const h = harness(async () => {
      throw 'not an error'
    })
    h.ctx.meter.reconcile = async () => {
      throw new Error('down')
    }
    const batch = await live.collectReport(config, h.ctx)
    expect(batch.requests.at(-1)?.error?.message).toBe(
      'the request was not sent, its reservation could not be marked sent (nor released): the meter failed',
    )
  })

  it('a refusal the context raises on the send keeps its own code (not a network blink)', async () => {
    const h = harness(async () => {})
    h.ctx.fetchText = async () => {
      throw Object.assign(new Error('the run is closed (DEADLINE)'), { code: 'DEADLINE' })
    }
    const batch = await live.collectReport(config, h.ctx)
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'DEADLINE',
      message: 'the run is closed (DEADLINE)',
    })
  })
})
