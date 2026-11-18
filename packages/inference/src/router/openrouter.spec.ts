import { describe, expect, it } from 'vitest'
import {
  isFreePricing,
  OPENROUTER_BASE_URL,
  OPENROUTER_IGNORE_MAX,
  openRouterProviderFields,
  routeChatFields,
} from './openrouter'

/** The free-only checks 2 and 3 of ADR §3.5, on their own. */
describe('isFreePricing (§3.5 check 2)', () => {
  it.each([
    ['every field the string "0"', { prompt: '0', completion: '0', request: '0', image: '0' }],
    ['every field the number 0', { prompt: 0, completion: 0 }],
    ['a padded "0.0"', { prompt: ' 0.0 ', completion: '0' }],
  ])('%s is free', (_l, pricing) => {
    expect(isFreePricing(pricing)).toBe(true)
  })

  it.each([
    ['a price above 0', { prompt: '0.0000001', completion: '0' }],
    ['a number above 0', { prompt: 0, completion: 1e-9 }],
    ['a blank string', { prompt: '', completion: '0' }],
    ['a whitespace string', { prompt: '  ', completion: '0' }],
    ['a null field', { prompt: null, completion: '0' }],
    ['a non-numeric string', { prompt: 'free', completion: '0' }],
    ['a boolean field', { prompt: false, completion: '0' }],
    ['an empty object', {}],
    ['an array', ['0', '0']],
    ['null', null],
    ['missing', undefined],
    ['a string', '0'],
  ])('%s is not free', (_l, pricing) => {
    expect(isFreePricing(pricing)).toBe(false)
  })
})

describe('openRouterProviderFields (§3.5 check 3)', () => {
  it('builds every routing field from the route', () => {
    expect(
      openRouterProviderFields({ dataCollection: 'deny', providerIgnore: ['a', 'b.c'] }),
    ).toStrictEqual({
      max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
      require_parameters: true,
      data_collection: 'deny',
      ignore: ['a', 'b.c'],
    })
  })

  it('an absent ignore list is empty, and the list is a copy', () => {
    const ignore = ['x']
    const fields = openRouterProviderFields({ dataCollection: 'allow', providerIgnore: ignore })
    expect(fields?.ignore).toEqual(['x'])
    expect(fields?.ignore).not.toBe(ignore)
    expect(openRouterProviderFields({ dataCollection: 'allow' })?.ignore).toEqual([])
  })

  it('accepts exactly the maximum ignore count', () => {
    const ignore = Array.from({ length: OPENROUTER_IGNORE_MAX }, (_, i) => `p${i}`)
    expect(
      openRouterProviderFields({ dataCollection: 'allow', providerIgnore: ignore }),
    ).not.toBeNull()
  })

  it.each([
    ['no dataCollection', {}],
    ['an unknown dataCollection', { dataCollection: 'maybe' }],
    ['an upper-case dataCollection', { dataCollection: 'ALLOW' }],
    ['a non-string ignore entry', { dataCollection: 'allow', providerIgnore: [1] }],
    ['an upper-case slug', { dataCollection: 'allow', providerIgnore: ['Groq'] }],
    ['a slug with a space', { dataCollection: 'allow', providerIgnore: ['a b'] }],
    ['a slug starting with a dash', { dataCollection: 'allow', providerIgnore: ['-a'] }],
    ['a slug over 64 chars', { dataCollection: 'allow', providerIgnore: ['a'.repeat(65)] }],
    [
      'one ignore entry over the maximum',
      {
        dataCollection: 'allow',
        providerIgnore: Array.from({ length: OPENROUTER_IGNORE_MAX + 1 }, (_, i) => `p${i}`),
      },
    ],
    [
      'an ignore value that is not a list',
      { dataCollection: 'allow', providerIgnore: 'a' as never },
    ],
  ])('%s: nothing can be built', (_l, route) => {
    expect(openRouterProviderFields(route)).toBeNull()
  })

  it('a 64-char slug is accepted', () => {
    expect(
      openRouterProviderFields({ dataCollection: 'allow', providerIgnore: ['a'.repeat(64)] }),
    ).not.toBeNull()
  })
})

describe('routeChatFields', () => {
  it('an OpenRouter route carries its routing fields, or null when they cannot be built', () => {
    expect(routeChatFields({ provider: 'openrouter', dataCollection: 'allow' })).toStrictEqual({
      providerRouting: {
        max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
        require_parameters: true,
        data_collection: 'allow',
        ignore: [],
      },
    })
    expect(routeChatFields({ provider: 'openrouter' })).toStrictEqual({ providerRouting: null })
  })

  it('every other provider carries no routing key at all', () => {
    for (const provider of ['gemini', 'groq', 'cloudflare'])
      expect(routeChatFields({ provider, dataCollection: 'allow' })).toStrictEqual({})
  })

  it('the base URL is the package constant on openrouter.ai', () => {
    expect(OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1')
  })
})
