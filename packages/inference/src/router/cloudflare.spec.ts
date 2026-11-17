import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_LISTING_MAX_PAGES,
  cloudflareChatBaseUrl,
  cloudflareListingUrl,
  fitsCloudflareAllowance,
  isCloudflareAccountId,
  isCloudflareListedVendor,
} from './cloudflare'

const ID = '0123456789abcdef0123456789abcdef'

describe('isCloudflareAccountId', () => {
  it('accepts exactly 32 lower-case hex characters', () => {
    expect(isCloudflareAccountId(ID)).toBe(true)
  })

  it.each([
    ['31 characters', ID.slice(1)],
    ['33 characters', `${ID}0`],
    ['upper-case hex', ID.toUpperCase()],
    ['a non-hex letter', `${ID.slice(1)}g`],
    ['a path segment', `${ID.slice(3)}/..`],
    ['a trailing newline', `${ID}\n`],
    ['another host', 'evil.example/'],
    ['empty', ''],
  ])('refuses %s', (_why, id) => {
    expect(isCloudflareAccountId(id)).toBe(false)
  })
})

describe('isCloudflareListedVendor (review F3)', () => {
  it('admits the four vendors of the pinned chain and nothing else', () => {
    for (const v of ['mistralai', 'google', 'openai', 'meta']) {
      expect(isCloudflareListedVendor(`@cf/${v}/m`)).toBe(true)
    }
    for (const id of [
      '@cf/metax/m',
      '@cf/xmeta/m',
      '@cf/meta',
      'x@cf/meta/m',
      '@hf/meta/m',
      '@cf/qwen/meta/m',
      'meta',
    ]) {
      expect(isCloudflareListedVendor(id)).toBe(false)
    }
  })
})

describe('Cloudflare URLs (SR-M-8 exception: the account id is the only interpolated value)', () => {
  it('builds the OpenAI-compatible base URL under the fixed host', () => {
    expect(cloudflareChatBaseUrl(ID)).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ID}/ai/v1`,
    )
  })

  it('builds the Text Generation search URL of one page', () => {
    expect(cloudflareListingUrl(ID, 1)).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ID}/ai/models/search?task=Text%20Generation&hide_experimental=true&per_page=50&page=1`,
    )
    expect(cloudflareListingUrl(ID, CLOUDFLARE_LISTING_MAX_PAGES)).toContain(
      `&page=${CLOUDFLARE_LISTING_MAX_PAGES}`,
    )
  })

  it('refuses to build either URL from an id outside the pattern', () => {
    expect(() => cloudflareChatBaseUrl('x/../../evil')).toThrow()
    expect(() => cloudflareListingUrl(ID.toUpperCase(), 1)).toThrow()
  })

  it('refuses a page outside 1..CLOUDFLARE_LISTING_MAX_PAGES', () => {
    expect(() => cloudflareListingUrl(ID, 0)).toThrow()
    expect(() => cloudflareListingUrl(ID, CLOUDFLARE_LISTING_MAX_PAGES + 1)).toThrow()
    expect(() => cloudflareListingUrl(ID, 1.5)).toThrow('cloudflare listing page refused')
  })

  it('never puts the id in the thrown message', () => {
    const bad = `${ID}Z`
    let message = ''
    try {
      cloudflareChatBaseUrl(bad)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).not.toBe('')
    expect(message).not.toContain(ID)
  })
})

describe('fitsCloudflareAllowance (10 000 Neurons a day at the ceiling rates)', () => {
  // 16 000 * 31 876 + 2 048 * 50 488 = 613 415 424 Neuron-millionths, about 613.4 Neurons a call.
  const route = { contextTokens: 16_000, maxAnswerTokens: 2_048 }

  it('admits the largest daily request count whose worst case stays inside the allowance', () => {
    expect(fitsCloudflareAllowance({ ...route, requestsPerDay: 16 })).toBe(true)
    expect(fitsCloudflareAllowance({ ...route, requestsPerDay: 17 })).toBe(false)
  })

  it('weights answer tokens by the output rate, not the input rate', () => {
    // 10 000 / (1 000 * 31 876 + 1 000 * 50 488 Neuron-millionths) = 121.4 calls.
    const small = { contextTokens: 1_000, maxAnswerTokens: 1_000 }
    expect(fitsCloudflareAllowance({ ...small, requestsPerDay: 121 })).toBe(true)
    expect(fitsCloudflareAllowance({ ...small, requestsPerDay: 122 })).toBe(false)
  })

  it('admits a request count exactly at the allowance', () => {
    // 313 715 * 31 876 = 9 999 979 340 <= 10 000 * 1e6.
    expect(
      fitsCloudflareAllowance({ contextTokens: 313_715, maxAnswerTokens: 0, requestsPerDay: 1 }),
    ).toBe(true)
    // 9 888 * 31 876 + 191 824 * 50 488 = 10 000 000 000 exactly: the allowance itself still fits.
    expect(
      fitsCloudflareAllowance({
        contextTokens: 9_888,
        maxAnswerTokens: 191_824,
        requestsPerDay: 1,
      }),
    ).toBe(true)
    // 313 716 * 31 876 = 10 000 011 216 > 10 000 000 000.
    expect(
      fitsCloudflareAllowance({ contextTokens: 313_716, maxAnswerTokens: 0, requestsPerDay: 1 }),
    ).toBe(false)
  })
})
