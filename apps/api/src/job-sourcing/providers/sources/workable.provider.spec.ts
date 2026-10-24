import { describe, expect, it } from 'vitest'
import { expectNoneOf, expectOnlyPublicRequests } from '../../../test/ats-b-assertions'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture, sourceFixtureText } from '../../../test/source-fixtures'
import { boardVerdictOf } from './ats-config'
import { WORKABLE_LIMITS, workableAllowedHosts, workableProvider } from './workable.provider'

/**
 * Workable through its public provider. Expected values are hand-read from the authentic captures
 * in `__fixtures__/workable/` (see the provenance files) and written as literals; none was
 * produced by running the mapper.
 */

const NOW = new Date('2026-10-24T04:00:00Z')
const HF = { name: 'Hugging Face', evidence: 'the envelope name is "Hugging Face"' }
const FELLOWS = { name: 'Hire Fellows', evidence: 'the envelope name is "Hire Fellows"' }

const cfg = (board = 'huggingface', extra: Record<string, unknown> = {}) =>
  workableProvider.parseConfig({ configVersion: 1, board, employer: HF, ...extra })

type Account = { name: string; description: string | null; jobs: Record<string, unknown>[] }
const account = (name: string) => sourceFixture('workable', name) as Account
const huggingface = () => account('huggingface-account')
const hirefellows = () => account('hirefellows-account')
const wrap = (jobs: unknown[], name = 'Hugging Face') => ({ name, description: null, jobs })

async function run(
  body: unknown,
  config = cfg(),
  status = 200,
  headers: Record<string, string> = {},
) {
  const f = fakeCollectionContext({
    now: NOW,
    responses: [
      { status, headers, bodyText: typeof body === 'string' ? body : JSON.stringify(body) },
    ],
  })
  const batch = await workableProvider.collectReport(config, f.ctx)
  return { batch, f }
}
type Batch = Awaited<ReturnType<typeof run>>['batch']
const byId = (batch: Batch, id: string) =>
  batch.observations.find((o) => o.identity.nativeId === id)

/** A job with only what the schema requires. */
const job = (shortcode: string, extra: Record<string, unknown> = {}) => ({
  shortcode,
  title: `Job ${shortcode}`,
  url: `https://apply.workable.com/j/${shortcode}`,
  ...extra,
})

describe('the request (public, one address, nothing authorised)', () => {
  it('asks the widget address with details=true, once, for JSON', async () => {
    const { f } = await run(huggingface())
    // EXACT on purpose (see the Greenhouse spec): nothing is authorised here, so an exact assertion
    // must catch a credential header appearing on the wire. `maxBytes` is in the expected object
    // because the cap is pinned as a deliberate choice by the test below, not derived here.
    expect(f.sent).toEqual([
      {
        url: 'https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true',
        headers: { accept: 'application/json' },
        maxBytes: 10_485_760,
      },
    ])
  })

  it('declares its 10 MiB response cap on the request, so the transport does not refuse it at 2 MiB', async () => {
    const { f } = await run(huggingface())
    expect(f.sent[0]?.maxBytes).toBe(10_485_760)
  })

  it('puts the configured subdomain in the path and nowhere else', async () => {
    const { f } = await run(hirefellows(), cfg('hirefellows', { employer: FELLOWS }))
    expect(f.sent[0]?.url).toBe(
      'https://apply.workable.com/api/v1/widget/accounts/hirefellows?details=true',
    )
  })

  it('never builds an /spi/ request, a token-bearing one or a credentialed one (AC1), whatever the answer', async () => {
    for (const [body, status] of [
      [huggingface(), 200],
      [wrap([]), 200],
      ['Not Found', 404],
      ['', 401],
      ['', 429],
    ] as const) {
      const { f } = await run(body, cfg(), status)
      expectOnlyPublicRequests(f.sent, /^apply\.workable\.com$/, ['accept'])
    }
  })

  it('is the WORKABLE_ATS provider', () => {
    expect(workableProvider.type).toBe('WORKABLE_ATS')
  })

  it('declares the bounds it runs under', () => {
    expect(WORKABLE_LIMITS).toEqual({
      maxBytes: 10 * 1024 * 1024,
      maxItemsPerPage: 2000,
      maxPages: 1,
    })
  })
})

describe('a redirect answer is a failure: the loop never reads Location (the documented www address redirects; this one is the final address)', () => {
  it('a 302 to another host ends the attempt after one request, naming the status only', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        {
          status: 302,
          headers: { location: 'https://evil.example/steal' },
          bodyText: '<html>302</html>',
        },
        { status: 200, bodyText: JSON.stringify(huggingface()) },
      ],
    })
    const batch = await workableProvider.collectReport(cfg(), f.ctx)
    expect(f.sent).toHaveLength(1)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.observations).toEqual([])
    expect(batch.requests.map((r) => [r.status, r.error?.code])).toEqual([[302, 'UPSTREAM']])
    expectNoneOf(batch, ['evil.example', 'steal'])
  })

  it('the documented www form, which redirects to the address above, is never requested; every request is on the declared host', async () => {
    const { f } = await run(huggingface())
    expect(f.sent.map((r) => new URL(r.url).host)).toEqual(['apply.workable.com'])
    expect(workableAllowedHosts()).toEqual(['apply.workable.com'])
    for (const r of f.sent) expect(workableAllowedHosts()).toContain(new URL(r.url).host)
  })
})

describe('the Hugging Face capture (6 jobs, all kept)', () => {
  it('turns the 6 jobs into 6 observations, a complete inventory', async () => {
    const { batch } = await run(huggingface())
    expect(batch.counts).toEqual({
      raw: 6,
      normalized: 6,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.scope).toEqual({
      namespace: 'workable:huggingface',
      query: null,
      configVersion: 1,
      window: null,
    })
  })

  it('maps every field of the first job (hand-read from the capture)', async () => {
    const { batch } = await run(huggingface())
    const o = byId(batch, '81B46579FE')
    expect(o?.identity).toMatchObject({
      provider: 'WORKABLE_ATS',
      namespace: 'workable:huggingface',
      nativeId: '81B46579FE',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe('https://apply.workable.com/j/81B46579FE')
    expect(o?.applicationUrl).toBe('https://apply.workable.com/j/81B46579FE/apply')
    expect(o?.normalized.title).toBe('Open-Source Machine Learning Engineer - EMEA Remote')
    expect(o?.normalized.companyName).toBe('Hugging Face')
    expect(o?.normalized.location).toBe('Paris, Île-de-France, France')
    expect(o?.normalized.remote).toBe(true)
    expect(o?.normalized.employmentType).toBe('Full-time')
    expect(o?.normalized.tags).toEqual(['Open Source', 'Engineering'])
    expect(o?.normalized.seniorityHint ?? null).toBeNull()
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2026-05-29T00:00:00.000Z')
    expect(o?.adapterVersion).toBe('workable-1')
  })

  it('collapses a repeated place ("New York" twice) and keeps the others whole', async () => {
    const { batch } = await run(huggingface())
    expect(byId(batch, '19A136F8E2')?.normalized.location).toBe('New York, United States')
    expect(byId(batch, '9E2A4C02C7')?.normalized.location).toBe('Paris, Île-de-France, France')
  })

  it('keeps a hidden location: the country is the only place a remote job states', async () => {
    const { batch } = await run(huggingface())
    expect(byId(batch, 'DB4D7C0EC8')?.normalized.location).toBe('France')
    expect(byId(batch, 'F88446C814')?.normalized.location).toBe('United States')
  })

  it('reads experience as the seniority hint, and an empty one as none', async () => {
    const { batch } = await run(huggingface())
    expect(byId(batch, '9E2A4C02C7')?.normalized.seniorityHint).toBe('Mid-Senior level')
    expect(byId(batch, '0BD8C06DB3')?.normalized.seniorityHint ?? null).toBeNull()
  })

  it('a department and a function with the same word are one tag; an empty function is no tag', async () => {
    const { batch } = await run(huggingface())
    expect(byId(batch, '9E2A4C02C7')?.normalized.tags).toEqual(['Science'])
    expect(byId(batch, 'DB4D7C0EC8')?.normalized.tags).toEqual(['Product'])
  })

  it('dates the job by its publication day at UTC midnight, never by its older creation (Wild Card: published 2024-10-17, created 2022-10-19)', async () => {
    const { batch } = await run(huggingface())
    const o = byId(batch, '0BD8C06DB3')
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2024-10-17T00:00:00.000Z')
    expect(o?.normalized.dates.map((d) => [d.semantics, d.raw])).toEqual([
      ['PUBLISHED', '2024-10-17'],
    ])
  })

  it('identity is the account plus the shortcode: a renamed title and URL is the same posting, another account is not', async () => {
    const a = await run(huggingface())
    const renamed = await run(
      wrap([
        { ...huggingface().jobs[0], title: 'Renamed', url: 'https://apply.workable.com/j/other' },
      ]),
    )
    expect(renamed.batch.observations[0]?.identity.identityKey).toBe(
      byId(a.batch, '81B46579FE')?.identity.identityKey,
    )
    const elsewhere = await run(
      wrap([huggingface().jobs[0]], 'Hire Fellows'),
      cfg('hirefellows', { employer: FELLOWS }),
    )
    expect(elsewhere.batch.observations[0]?.identity.identityKey).not.toBe(
      byId(a.batch, '81B46579FE')?.identity.identityKey,
    )
  })
})

describe('the Hire Fellows capture (remote and on-site, empty and multiple values)', () => {
  const fellows = () => run(hirefellows(), cfg('hirefellows', { employer: FELLOWS }))

  it('turns the 3 kept jobs into 3 observations', async () => {
    const { batch } = await fellows()
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 3,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('telecommuting false is "not remote", true is "remote"', async () => {
    const { batch } = await fellows()
    expect(byId(batch, '09D3268344')?.normalized.remote).toBe(true)
    expect(byId(batch, 'D598232CFB')?.normalized.remote).toBe(false)
    expect(byId(batch, '5EAE844505')?.normalized.remote).toBe(false)
  })

  it('an empty employment type and an empty department are no employment type and no tag', async () => {
    const { batch } = await fellows()
    const o = byId(batch, '5EAE844505')
    expect(o?.normalized.employmentType ?? null).toBeNull()
    expect(o?.normalized.tags).toEqual([])
    expect(o?.normalized.location).toBe('Riyadh, Riyadh Province, Saudi Arabia')
  })

  it('joins several locations with "; " in the order sent', async () => {
    const { batch } = await fellows()
    expect(byId(batch, '09D3268344')?.normalized.location).toBe(
      'Bahrain; Pakistan; India; Egypt; Morocco; Tunisia',
    )
  })

  it('falls back to the top-level city, state and country when the locations array is empty', async () => {
    const { batch } = await run(
      wrap([job('AAAAAAAAAA', { locations: [], city: 'Lyon', state: 'Rhône', country: 'France' })]),
    )
    expect(batch.observations[0]?.normalized.location).toBe('Lyon, Rhône, France')
  })

  it('no location anywhere is no location', async () => {
    for (const extra of [
      {},
      { locations: null },
      { locations: [{}], city: '', state: '', country: '' },
    ]) {
      const { batch } = await run(wrap([job('AAAAAAAAAA', extra)]))
      expect(batch.observations[0]?.normalized.location ?? null).toBeNull()
    }
  })
})

describe('the account envelope guards the employer evidence (no company is injected into a job)', () => {
  it('maps the verified employer and nothing from the envelope onto the jobs', async () => {
    const { batch } = await run(wrap([job('AAAAAAAAAA')], 'Hugging Face'))
    expect(batch.observations[0]?.normalized.companyName).toBe('Hugging Face')
  })

  it('a name that differs by a space or an accent is a different name, not the same one', async () => {
    for (const name of ['HuggingFace', 'Hugging  Face!', 'Hüggingface', 'Hugging Fac']) {
      const { batch } = await run(wrap([job('AAAAAAAAAA')], name))
      expect(batch.outcome).toBe('FAILED')
    }
  })

  it('spacing is ignored on the evidence side too: "Hugging   Face" in the config is "Hugging Face"', async () => {
    const config = cfg('huggingface', { employer: { name: 'Hugging \t  Face', evidence: 'x' } })
    const { batch } = await run(wrap([job('AAAAAAAAAA')], 'Hugging Face'), config)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('ignores case and spacing when comparing the envelope name with the evidence', async () => {
    const { batch } = await run(wrap([job('AAAAAAAAAA')], '  HUGGING   face '))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations).toHaveLength(1)
  })

  it('refuses the whole page when the account is now named something else, and stores nothing', async () => {
    const { batch } = await run(wrap([job('AAAAAAAAAA')], 'Acme Corp'))
    expect(batch.outcome).toBe('FAILED')
    expect(batch.observations).toEqual([])
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    expect(batch.requests.at(-1)?.error?.message).toContain('"Acme Corp"')
    expect(batch.requests.at(-1)?.error?.message).toContain('"Hugging Face"')
  })

  it('with no verified employer every job is quarantined, none is named after the account', async () => {
    const config = workableProvider.parseConfig({ configVersion: 1, board: 'huggingface' })
    const { batch } = await run(huggingface(), config)
    expect(batch.observations).toEqual([])
    expect(batch.counts).toEqual({
      raw: 6,
      normalized: 0,
      invalid: 0,
      quarantined: 6,
      discarded: 0,
    })
  })

  it('a body without the envelope name is drift, not an account with no name', async () => {
    const { batch } = await run({ jobs: [] })
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })
})

describe('detail absent versus enriched (details=true puts the description on the job)', () => {
  it('a job with a description has it, converted to text', async () => {
    const { batch } = await run(huggingface())
    const md = byId(batch, '81B46579FE')?.normalized.descriptionMd ?? ''
    expect(md.startsWith("At Hugging Face, we're on a journey to democratize good AI.")).toBe(true)
  })

  it('a job the account sent without a description is still an observation, with none', async () => {
    const { batch } = await run(wrap([job('AAAAAAAAAA')]))
    expect(batch.counts.normalized).toBe(1)
    expect(batch.observations[0]?.normalized.descriptionMd ?? '').toBe('')
  })
})

describe('empty, missing and unreadable accounts', () => {
  it('an account with no jobs is a valid empty inventory (Hotjar), not a dead board', async () => {
    const { batch } = await run(
      sourceFixtureText('workable', 'hotjar-empty-account'),
      cfg('hotjar', { employer: { name: 'Hotjar', evidence: 'envelope name' } }),
    )
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.counts).toEqual({
      raw: 0,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
  })

  it('an account that does not exist answers 404 text and is a BOARD problem, not an outage', async () => {
    const { batch } = await run('Not Found', cfg('cheeky-nonexistent-account-0001'), 404)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.map((r) => [r.status, r.error?.code])).toEqual([[404, 'UPSTREAM']])
    expect(boardVerdictOf(batch)).toBe('BOARD_NOT_FOUND')
  })

  it('401, 403 and 429 are access and rate problems of the SOURCE, never "board not found"', async () => {
    for (const [status, code] of [
      [401, 'ACCESS_POLICY'],
      [403, 'ACCESS_POLICY'],
      [429, 'RATE_LIMIT'],
    ] as const) {
      const { batch } = await run('', cfg(), status)
      expect(batch.requests.map((r) => r.error?.code)).toEqual([code])
      expect(boardVerdictOf(batch)).toBe('SOURCE_FAILED')
    }
  })

  it('a body that is not JSON is drift', async () => {
    const { batch } = await run('<html>maintenance</html>')
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })

  it('error reports carry the status and never the response body or headers (AC2, by value)', async () => {
    const secret = 'tok_live_9f3a7c2e41b8d605'
    const { batch } = await run(`{"error":"${secret}"}`, cfg(), 401, {
      'www-authenticate': `Bearer realm="${secret}"`,
      'set-cookie': `wmc=${secret}`,
    })
    expect(batch.requests.map((r) => r.error?.message)).toEqual(['provider answered HTTP 401'])
    expectNoneOf(batch, [secret, 'Bearer', 'wmc'])
  })
})

describe('one bad job is isolated, not a failed account', () => {
  it('a job without a shortcode is invalid; its neighbours are kept', async () => {
    const { shortcode: _gone, ...broken } = job('AAAAAAAAAA')
    const { batch } = await run(wrap([broken, job('BBBBBBBBBB')]))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 1,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['BBBBBBBBBB'])
  })

  it('an empty shortcode is invalid, not an identity', async () => {
    const { batch } = await run(wrap([job('')]))
    expect(batch.counts.invalid).toBe(1)
    expect(batch.observations).toEqual([])
  })

  it('a date that is not a date is kept raw and flagged, the job is still observed', async () => {
    const { batch } = await run(wrap([job('AAAAAAAAAA', { published_on: 'yesterday' })]))
    const o = batch.observations[0]
    expect(o?.normalized.publishedAt).toBeNull()
    expect(o?.evidence).toContainEqual({
      field: 'date.PUBLISHED',
      kind: 'DATE_UNCERTAIN',
      detail: 'INVALID',
    })
  })
})
