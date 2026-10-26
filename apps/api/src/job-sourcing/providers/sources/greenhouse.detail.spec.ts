import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture } from '../../../test/source-fixtures'
import {
  createGreenhouseProvider,
  fetchGreenhouseDetail,
  GREENHOUSE_LIMITS,
  greenhouseDetailRequest,
  greenhouseProvider,
  parseGreenhouseDetail,
} from './greenhouse.provider'

/**
 * U6a: the list without `content`, and the detail by id. No request leaves the machine: the list
 * fixture is the authentic Airbnb capture with the keys `content=true` adds removed (the keys the
 * Job Board API documents as added by that flag: content, departments, offices), and the detail
 * fixture is one authentic job object of that capture, whole.
 */

const NOW = new Date('2026-10-26T04:00:00Z')
type Job = Record<string, unknown> & { id: number }
const captured = () => (sourceFixture('greenhouse', 'airbnb-board') as { jobs: Job[] }).jobs
const stripped = (j: Job): Job => {
  const { content: _c, departments: _d, offices: _o, ...rest } = j
  return rest as Job
}
const listBody = () => JSON.stringify({ jobs: captured().map(stripped), meta: { total: 3 } })
const config = () => greenhouseProvider.parseConfig({ configVersion: 1, board: 'airbnb' })
const LIST_URL = 'https://boards-api.greenhouse.io/v1/boards/airbnb/jobs'
const detailUrl = (id: number) => `https://boards-api.greenhouse.io/v1/boards/airbnb/jobs/${id}`
const CAP = 10_485_760

describe('ON_DEMAND list', () => {
  const provider = createGreenhouseProvider('ON_DEMAND')
  const cfg = () => provider.parseConfig({ configVersion: 1, board: 'airbnb' })

  it('makes exactly one request, the list URL without content, and stores 3 revisions without a description', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: listBody() }] })
    const batch = await provider.collectReport(cfg(), f.ctx)
    expect(f.sent).toEqual([
      { url: LIST_URL, headers: { accept: 'application/json' }, maxBytes: CAP },
    ])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 3,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.normalized.descriptionMd)).toEqual(['', '', ''])
    expect(batch.observations[0]?.normalized.title).toBe('Tech Lead Manager, Oracle ERP')
  })

  it('a job missing a required list field is isolated as invalid, the board goes on', async () => {
    const jobs = captured().map(stripped)
    const { title: _t, ...noTitle } = jobs[0]!
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: JSON.stringify({ jobs: [noTitle, jobs[1]] }) }],
    })
    const batch = await provider.collectReport(cfg(), f.ctx)
    expect(batch.counts).toMatchObject({ raw: 2, normalized: 1, invalid: 1 })
  })

  it('a body without a jobs array is PARSE_DRIFT', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: '{"nope":[]}' }] })
    const batch = await provider.collectReport(cfg(), f.ctx)
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })

  it('keeps the 10 MiB cap on the request, so a list over it is refused by the transport', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: listBody() }] })
    await provider.collectReport(cfg(), f.ctx)
    expect(f.sent[0]?.maxBytes).toBe(GREENHOUSE_LIMITS.maxBytes)
  })
})

describe('IN_LIST mode (today) is unchanged', () => {
  it('the default provider asks for content=true, byte for byte', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: listBody() }] })
    await greenhouseProvider.collectReport(config(), f.ctx)
    expect(f.sent).toEqual([
      { url: `${LIST_URL}?content=true`, headers: { accept: 'application/json' }, maxBytes: CAP },
    ])
  })

  it('createGreenhouseProvider(IN_LIST) asks the same URL', async () => {
    const p = createGreenhouseProvider('IN_LIST')
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: listBody() }] })
    await p.collectReport(p.parseConfig({ configVersion: 1, board: 'airbnb' }), f.ctx)
    expect(f.sent[0]?.url).toBe(`${LIST_URL}?content=true`)
  })
})

describe('greenhouseDetailRequest', () => {
  it('is the documented per-job URL on the board, with the list cap and no credential', () => {
    expect(greenhouseDetailRequest('airbnb', 8102684)).toEqual({
      url: detailUrl(8102684),
      headers: { accept: 'application/json' },
      maxBytes: CAP,
    })
  })

  it('is pure: equal inputs give equal, unshared results', () => {
    const a = greenhouseDetailRequest('stripe', 1)
    const b = greenhouseDetailRequest('stripe', 1)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    expect(a.headers).not.toBe(b.headers)
  })

  it.each(['', 'a/b', 'a?x=1', 'A', '../x', 'a b', '-a', 'a'.repeat(65), 'a.b'])(
    'refuses the board token %j',
    (board) => {
      expect(() => greenhouseDetailRequest(board, 1)).toThrow(/board/)
    },
  )

  it.each([0, -1, 1.5, Number.NaN, 2 ** 53, Number.POSITIVE_INFINITY])(
    'refuses the id %s',
    (id) => {
      expect(() => greenhouseDetailRequest('airbnb', id)).toThrow(/id/)
    },
  )
})

describe('parseGreenhouseDetail', () => {
  const body = (id = 8102684) => JSON.stringify(captured().find((j) => j.id === id))
  const parse = (status: number, text: string, id = 8102684) =>
    parseGreenhouseDetail(config(), id, { status, bodyText: text })

  it('200 with the posting: FOUND, with the description and the list fields', () => {
    const r = parse(200, body())
    expect(r.kind).toBe('FOUND')
    if (r.kind !== 'FOUND') return
    expect(r.fields.nativeId).toBe('8102684')
    expect(r.fields.title).toBe('Tech Lead Manager, Oracle ERP')
    expect(r.fields.description).toContain('<')
    expect(r.fields.description?.length).toBeGreaterThan(1000)
    expect(r.fields.tags).toEqual(['Software Engineering'])
  })

  it('404 is GONE, an answer and not a failure', () => {
    expect(parse(404, '')).toEqual({ kind: 'GONE' })
  })

  it.each([500, 502, 503, 400, 410])('%s is FAILED UPSTREAM carrying the status', (status) => {
    expect(parse(status, '')).toMatchObject({ kind: 'FAILED', code: 'UPSTREAM', status })
  })

  it('a body that is not JSON is PARSE_DRIFT', () => {
    expect(parse(200, '<html>')).toMatchObject({ kind: 'FAILED', code: 'PARSE_DRIFT' })
  })

  it('a posting missing a required field is PARSE_DRIFT', () => {
    const { title: _t, ...rest } = JSON.parse(body()) as Job
    expect(parse(200, JSON.stringify(rest))).toMatchObject({ kind: 'FAILED', code: 'PARSE_DRIFT' })
  })

  it('a posting with another id than the one asked for is PARSE_DRIFT, never stored under the asked id', () => {
    const r = parse(200, body(8303135))
    expect(r).toMatchObject({ kind: 'FAILED', code: 'PARSE_DRIFT' })
  })

  it('a body over the cap is refused before it is parsed', () => {
    const big = JSON.stringify({ ...(JSON.parse(body()) as Job), pad: 'x'.repeat(CAP) })
    expect(parse(200, big)).toMatchObject({ kind: 'FAILED', code: 'PAYLOAD_TOO_LARGE' })
  })
})

describe('fetchGreenhouseDetail', () => {
  const found = JSON.stringify(captured()[0])

  it('sends one request to the per-job URL and returns the parsed answer', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: found }] })
    const r = await fetchGreenhouseDetail(f.ctx, config(), 8102684)
    expect(f.sent).toEqual([greenhouseDetailRequest('airbnb', 8102684)])
    expect(r.kind).toBe('FOUND')
  })

  it('a 404 is GONE after exactly one request, never retried', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ status: 404 }, { bodyText: found }],
    })
    expect(await fetchGreenhouseDetail(f.ctx, config(), 8102684)).toEqual({ kind: 'GONE' })
    expect(f.sent).toHaveLength(1)
  })

  it('lets a transport refusal propagate, so the run can stop and ban the host', async () => {
    const boom = new Error('refused')
    const f = fakeCollectionContext({ now: NOW, responses: [{ throws: boom }] })
    await expect(fetchGreenhouseDetail(f.ctx, config(), 8102684)).rejects.toBe(boom)
  })
})
