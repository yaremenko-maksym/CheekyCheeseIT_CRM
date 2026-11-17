import { describe, expect, it } from 'vitest'
import { KEY_MARKER, scriptedFetch, type Reply, type Sent } from './__test-helpers__/router-harness'
import {
  CLOUDFLARE_ACCOUNT,
  cloudflareEntry,
  cloudflarePage,
  type CloudflareEntryOptions,
} from './__test-helpers__/cloudflare-listing'
import { CLOUDFLARE_LISTING_MAX_PAGES, CLOUDFLARE_LISTING_PAGE_SIZE } from './cloudflare'
import { fetchModelListing, type ListingResult } from './model-listing'

const MISTRAL = '@cf/mistralai/mistral-small-3.1-24b-instruct'
const OSS = '@cf/openai/gpt-oss-20b'
const GEMMA = '@cf/google/gemma-4-26b-a4b-it'

async function list(
  reply: (s: Sent) => Reply,
  account: { accountId: string | undefined } = { accountId: CLOUDFLARE_ACCOUNT },
): Promise<{ result: ListingResult; sent: Sent[] }> {
  const fake = scriptedFetch(reply)
  const result = await fetchModelListing({
    provider: 'cloudflare',
    apiKey: KEY_MARKER,
    accountId: account.accountId,
    timeoutMs: 5_000,
    fetchImpl: fake.fetchImpl,
  })
  return { result, sent: fake.sent }
}

const onePage = (entries: unknown[]) => (): Reply => cloudflarePage(entries)
const ids = (r: ListingResult): string[] => (r.kind === 'ok' ? r.models.map((m) => m.id) : [])

describe('the Cloudflare listing request', () => {
  it('reads page 1 of the Text Generation search under the account, key only in the header', async () => {
    const { sent } = await list(onePage([]))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT}/ai/models/search?task=Text%20Generation&hide_experimental=true&per_page=50&page=1`,
    )
    expect(sent[0]!.url).not.toContain(KEY_MARKER)
    expect(sent[0]!.headers).toEqual({ Authorization: `Bearer ${KEY_MARKER}` })
  })

  it('sends nothing without a valid account id, and fails with no response', async () => {
    for (const accountId of [undefined, 'not-an-account', CLOUDFLARE_ACCOUNT.toUpperCase()]) {
      const { result, sent } = await list(onePage([]), { accountId })
      expect(sent).toHaveLength(0)
      expect(result).toEqual({ kind: 'failed', noResponse: true })
    }
  })

  it('reads the next page while a page is full, and stops at a short one', async () => {
    const full = Array.from({ length: CLOUDFLARE_LISTING_PAGE_SIZE }, (_, i) =>
      cloudflareEntry(`@cf/meta/m${i}`),
    )
    const { result, sent } = await list((s) =>
      s.url.endsWith('&page=1') ? cloudflarePage(full) : cloudflarePage([cloudflareEntry(OSS)]),
    )
    expect(sent.map((s) => s.url.slice(-7))).toEqual(['&page=1', '&page=2'])
    expect(ids(result)).toHaveLength(CLOUDFLARE_LISTING_PAGE_SIZE + 1)
    expect(ids(result).at(-1)).toBe(OSS)
  })

  it('fails closed when the last page it may read is still full: the catalogue was cut', async () => {
    let n = 0
    const full = (): Reply =>
      cloudflarePage(
        Array.from({ length: CLOUDFLARE_LISTING_PAGE_SIZE }, () =>
          cloudflareEntry(`@cf/meta/m${n++}`),
        ),
      )
    const { result, sent } = await list(full)
    expect(sent).toHaveLength(CLOUDFLARE_LISTING_MAX_PAGES)
    expect(result).toEqual({ kind: 'failed', noResponse: false })
  })

  it('fails the whole listing when a later page fails', async () => {
    const full = Array.from({ length: CLOUDFLARE_LISTING_PAGE_SIZE }, (_, i) =>
      cloudflareEntry(`@cf/meta/m${i}`),
    )
    const later = await list((s) =>
      s.url.endsWith('&page=1') ? cloudflarePage(full) : { status: 500, body: '' },
    )
    expect(later.result).toEqual({ kind: 'failed', noResponse: false })
    const auth = await list((s) =>
      s.url.endsWith('&page=1') ? cloudflarePage(full) : { status: 403, body: '' },
    )
    expect(auth.result).toEqual({ kind: 'auth' })
  })

  it('a later page that never answered still commits the unit: page 1 did', async () => {
    const full = Array.from({ length: CLOUDFLARE_LISTING_PAGE_SIZE }, (_, i) =>
      cloudflareEntry(`@cf/meta/m${i}`),
    )
    const fake = scriptedFetch(() => cloudflarePage(full))
    let calls = 0
    const result = await fetchModelListing({
      provider: 'cloudflare',
      apiKey: KEY_MARKER,
      accountId: CLOUDFLARE_ACCOUNT,
      timeoutMs: 5_000,
      fetchImpl: async (url, init) => {
        calls += 1
        if (calls === 2) throw new TypeError('connection reset')
        return fake.fetchImpl(url, init)
      },
    })
    expect(calls).toBe(2)
    expect(result).toEqual({ kind: 'failed', noResponse: false })
  })

  it('a first page that never answered releases the unit', async () => {
    const result = await fetchModelListing({
      provider: 'cloudflare',
      apiKey: KEY_MARKER,
      accountId: CLOUDFLARE_ACCOUNT,
      timeoutMs: 5_000,
      fetchImpl: async () => {
        throw new TypeError('connection refused')
      },
    })
    expect(result).toEqual({ kind: 'failed', noResponse: true })
  })

  it('reads 401 and 403 as auth', async () => {
    expect((await list(() => ({ status: 401, body: '' }))).result).toEqual({ kind: 'auth' })
    expect((await list(() => ({ status: 403, body: '' }))).result).toEqual({ kind: 'auth' })
  })

  it('fails a body outside the v4 envelope', async () => {
    const { result } = await list(() => ({ status: 200, body: JSON.stringify({ data: [] }) }))
    expect(result).toEqual({ kind: 'failed', noResponse: false })
  })
})

describe('which Cloudflare entries are kept (planned deprecation, context, price)', () => {
  it('keeps a Text Generation model with a context and a price at or below the ceiling', async () => {
    const { result } = await list(
      onePage([
        cloudflareEntry(MISTRAL, { context: '128000', price: [0.351, 0.555] }),
        cloudflareEntry(GEMMA, { context: '256000', price: [0.1, 0.3] }),
      ]),
    )
    expect(result).toEqual({
      kind: 'ok',
      models: [
        { id: MISTRAL, context: 128_000, active: true },
        { id: GEMMA, context: 256_000, active: true },
      ],
      dropped: 0,
      beyondCap: 0,
    })
  })

  it('drops a model with any planned deprecation date, past or future', async () => {
    const { result } = await list(
      onePage([
        cloudflareEntry(MISTRAL, { deprecation: '2026-11-20' }),
        cloudflareEntry(OSS, { deprecation: '2099-01-01' }),
        cloudflareEntry(GEMMA),
      ]),
    )
    expect(ids(result)).toEqual([GEMMA])
    expect(result).toMatchObject({ dropped: 2 })
  })

  it('drops a model priced above the ceiling on either side', async () => {
    const { result } = await list(
      onePage([
        cloudflareEntry('@cf/meta/dear-in', { price: [0.352, 0.3] }),
        cloudflareEntry('@cf/meta/dear-out', { price: [0.1, 0.556] }),
        cloudflareEntry(GEMMA),
      ]),
    )
    expect(ids(result)).toEqual([GEMMA])
  })

  it.each([
    ['no properties', { properties: undefined }],
    ['no context window', { context: undefined }],
    ['a context that is not a positive integer', { context: '128k' }],
    ['a zero context', { context: '0' }],
    ['a context with a leading zero', { context: '0128000' }],
    ['no price', { price: undefined }],
    [
      'a price without the input side',
      { priceList: [{ unit: 'per M output tokens', price: 0.3, currency: 'USD' }] },
    ],
    [
      'a price without the output side',
      { priceList: [{ unit: 'per M input tokens', price: 0.1, currency: 'USD' }] },
    ],
    ['a price in another currency', { currency: 'EUR' }],
    [
      'a price that is not a number',
      {
        priceList: [
          { unit: 'per M input tokens', price: '0.1', currency: 'USD' },
          { unit: 'per M output tokens', price: 0.3, currency: 'USD' },
        ],
      },
    ],
    ['a negative price', { price: [-1, 0.3] }],
    ['a zero input price', { price: [0, 0.3] }],
    ['a zero output price', { price: [0.1, 0] }],
    ['another task', { task: 'Text Embeddings' }],
    ['no task', { task: undefined }],
  ] as [string, CloudflareEntryOptions][])(
    'drops an entry with %s (fail closed: unknown is never "no deprecation")',
    async (_why, over) => {
      const { result } = await list(onePage([cloudflareEntry(OSS, over), cloudflareEntry(GEMMA)]))
      expect(ids(result)).toEqual([GEMMA])
      expect(result).toMatchObject({ dropped: 1 })
    },
  )

  it('drops an id outside @cf/<vendor>/<name> and a repeated id', async () => {
    const { result } = await list(
      onePage([
        cloudflareEntry('@hf/thebloke/mistral-7b-instruct'),
        cloudflareEntry('@cf/meta/../../x'),
        cloudflareEntry(GEMMA),
        cloudflareEntry(GEMMA),
      ]),
    )
    expect(ids(result)).toEqual([GEMMA])
    expect(result).toMatchObject({ dropped: 3 })
  })

  it('admits additions only from the vendors of the pinned chain (amendment 2026-11-17, F3)', async () => {
    const { result } = await list(
      onePage([
        cloudflareEntry('@cf/qwen/qwen3-30b-a3b-fp8'),
        cloudflareEntry('@cf/metax/m'),
        cloudflareEntry('@cf/meta/llama-4-scout-17b-16e-instruct'),
        cloudflareEntry('@cf/mistralai/m'),
        cloudflareEntry('@cf/google/g'),
        cloudflareEntry(OSS),
      ]),
    )
    expect(ids(result)).toEqual([
      '@cf/meta/llama-4-scout-17b-16e-instruct',
      '@cf/mistralai/m',
      '@cf/google/g',
      OSS,
    ])
    expect(result).toMatchObject({ dropped: 2 })
  })

  it('a hostile id never reaches the result', async () => {
    const hostile = `@cf/meta/${'x'.repeat(300)}`
    const { result } = await list(onePage([cloudflareEntry(hostile)]))
    expect(JSON.stringify(result)).not.toContain('xxxxxxxxxx')
  })
})
