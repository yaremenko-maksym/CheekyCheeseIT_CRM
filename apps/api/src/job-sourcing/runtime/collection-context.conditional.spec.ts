import { describe, expect, it } from 'vitest'
import type { BoundedFetchOptions } from '../http/bounded-fetch'
import { SourceHttpStatusError } from '../http/source-errors'
import type { StoredValidators } from '../http/stored-validators'
import type { ClaimedRun } from '../ownership/job-run-ledger'
import { type ContextDeps, buildCollectionContext } from './collection-context'

/**
 * Source fetch strategy U6b: the production context sends the stored validators of a host that has
 * shown them on the run's FIRST request, maps a `304` to a conditional answer, and reports the
 * validators to store when the run succeeds. The transport is a recording double.
 */
const HOST = 'feeds.example.com'
const URL1 = `https://${HOST}/jobs.xml`
const STORED: StoredValidators = {
  url: URL1,
  etag: '"v1"',
  lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
}

const RUN: ClaimedRun = {
  runId: '00000000-0000-4000-8000-0000000000aa',
  ownerToken: 'w:1',
  fencingEpoch: 1,
  sourceId: '00000000-0000-4000-8000-0000000000bb',
  cycleId: '00000000-0000-4000-8000-0000000000cc',
  attemptId: 'run-x',
  accountKey: null,
  sourceType: 'SMARTRECRUITERS_API',
  checkpoint: null,
}

type Transport = NonNullable<ContextDeps['transport']>

function world(transport: Transport, validators: StoredValidators | null) {
  const seen: { url: string; opts: BoundedFetchOptions }[] = []
  const recording: Transport = async (url, opts) => {
    seen.push({ url, opts })
    return transport(url, opts)
  }
  const control = buildCollectionContext(
    {
      transport: recording,
      recordBan: async () => undefined,
      savePage: async () => undefined,
      monotonicNow: () => 0,
      now: () => new Date('2026-10-25T10:00:00Z'),
    },
    {
      run: { ...RUN, validators },
      hostKey: HOST,
      floorHours: 0,
      banScope: undefined,
      allowedHosts: [HOST],
      requestsPerRun: null,
      meter: null,
      secrets: [],
      policyVersion: 1,
      deadline: new Date('2026-10-25T11:00:00Z'),
      leaseMs: 60_000,
      pageWriteTimeoutMs: 5_000,
    },
  )
  return { ...control, seen }
}

const ok =
  (headers?: { etag: string | null; lastModified: string | null }): Transport =>
  async (_url, opts) => {
    opts.onValidators?.(headers !== undefined, headers ?? { etag: null, lastModified: null })
    return '<rss/>'
  }
const notModified: Transport = async () => {
  throw new SourceHttpStatusError(HOST, 304)
}

describe('U6b: sending the stored validators', () => {
  it('sends If-None-Match and If-Modified-Since from the stored validators on the first request', async () => {
    const w = world(ok(), STORED)
    await w.ctx.fetchText({ url: URL1 })
    expect(w.seen[0]?.opts.headers).toMatchObject({
      'if-none-match': '"v1"',
      'if-modified-since': 'Wed, 21 Oct 2026 07:28:00 GMT',
    })
  })

  it('sends only the validator the host showed', async () => {
    const w = world(ok(), { url: URL1, etag: '"v1"', lastModified: null })
    await w.ctx.fetchText({ url: URL1 })
    expect(w.seen[0]?.opts.headers).toEqual({ 'if-none-match': '"v1"' })
  })

  it('changes nothing for a host that has not shown validators', async () => {
    const w = world(ok(), null)
    await w.ctx.fetchText({ url: URL1 })
    expect(w.seen[0]?.opts.headers).toBeUndefined()
  })

  it('does not send them to a different URL', async () => {
    const w = world(ok(), STORED)
    await w.ctx.fetchText({ url: `${URL1}?page=2` })
    expect(w.seen[0]?.opts.headers).toBeUndefined()
  })

  it('sends them on the first request only', async () => {
    const w = world(ok(), STORED)
    await w.ctx.fetchText({ url: `https://${HOST}/other` })
    await w.ctx.fetchText({ url: URL1 })
    expect(w.seen[1]?.opts.headers).toBeUndefined()
  })

  it('never makes a POST conditional', async () => {
    const w = world(ok(), STORED)
    await w.ctx.fetchText({ url: URL1, method: 'POST', body: '{}' })
    expect(w.seen[0]?.opts.headers).toBeUndefined()
  })

  it('keeps the adapter`s own headers beside the conditional ones', async () => {
    const w = world(ok(), STORED)
    await w.ctx.fetchText({ url: URL1, headers: { accept: 'application/rss+xml' } })
    expect(w.seen[0]?.opts.headers).toMatchObject({
      accept: 'application/rss+xml',
      'if-none-match': '"v1"',
    })
  })
})

describe('U6b: a 304', () => {
  it('reaches the adapter as a conditional 304 with no body', async () => {
    const w = world(notModified, STORED)
    await expect(w.ctx.fetchText({ url: URL1 })).resolves.toEqual({
      status: 304,
      bodyText: '',
      headers: {},
      etag: null,
      conditional: true,
    })
    expect(w.metrics()).toMatchObject({ lastHttpStatus: 304, nextValidators: STORED })
  })

  it.each([404, 500])(
    'a %i to the validators we sent is not a conditional answer',
    async (status) => {
      const w = world(async () => {
        throw new SourceHttpStatusError(HOST, status)
      }, STORED)
      const answer = await w.ctx.fetchText({ url: URL1 })
      expect(answer.status).toBe(status)
      expect(answer.conditional).toBeUndefined()
      // a failed first request leaves the stored validators as they were
      expect(w.metrics().nextValidators).toEqual(STORED)
    },
  )

  it('is NOT conditional when the context sent no validators (a host answering 304 unasked)', async () => {
    const w = world(notModified, null)
    const answer = await w.ctx.fetchText({ url: URL1 })
    expect(answer.status).toBe(304)
    expect(answer.conditional).toBeUndefined()
    expect(w.metrics().nextValidators).toBeNull()
  })
})

describe('U6b: the validators to store', () => {
  it('records what the first 200 carried, keyed by its URL', async () => {
    const w = world(ok({ etag: '"v2"', lastModified: null }), null)
    await w.ctx.fetchText({ url: URL1 })
    expect(w.metrics().nextValidators).toEqual({ url: URL1, etag: '"v2"', lastModified: null })
  })

  it('replaces stored validators with those of the new 200, and drops them when it carries none', async () => {
    const fresh = world(ok({ etag: '"v2"', lastModified: null }), STORED)
    await fresh.ctx.fetchText({ url: URL1 })
    expect(fresh.metrics().nextValidators).toMatchObject({ etag: '"v2"' })
    const bare = world(ok(), STORED)
    await bare.ctx.fetchText({ url: URL1 })
    expect(bare.metrics().nextValidators).toBeNull()
  })

  it('ignores validators of later requests', async () => {
    const w = world(ok({ etag: '"p2"', lastModified: null }), null)
    await w.ctx.fetchText({ url: URL1 })
    await w.ctx.fetchText({ url: `${URL1}?page=2` })
    expect(w.metrics().nextValidators).toMatchObject({ url: URL1 })
  })

  it('does not store anything for a value that cannot be sent back as a header', async () => {
    const w = world(ok({ etag: '"a"\r\nx: y', lastModified: null }), null)
    await w.ctx.fetchText({ url: URL1 })
    expect(w.metrics().nextValidators).toBeNull()
  })

  it('carries stored validators forward when the run made no request', () => {
    expect(world(ok(), STORED).metrics().nextValidators).toEqual(STORED)
  })
})
