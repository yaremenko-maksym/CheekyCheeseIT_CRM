import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_MODEL_PATTERN,
  isValidProviderModelId,
  OPENROUTER_FREE_MODEL_PATTERN,
  type ModelProvider,
  isVisionCapable,
  parseGeminiModelId,
} from './model-id'

describe('parseGeminiModelId (ADR §3.4 Gemini family pattern)', () => {
  it.each([
    ['gemini-2.5-flash', '2.5', 'flash'],
    ['gemini-3-flash-preview', '3', 'flash'],
    ['gemini-2.5-flash-lite', '2.5', 'flash-lite'],
    ['gemini-2.5-pro', '2.5', 'pro'],
    ['gemini-12.34-pro', '12.34', 'pro'],
    ['gemini-2.5-flash-preview-09-2025', '2.5', 'flash'],
  ])('admits %s', (id, version, variant) => {
    expect(parseGeminiModelId(id)).toEqual({ id, version, variant })
  })

  it('strips the models/ prefix', () => {
    expect(parseGeminiModelId('models/gemini-2.5-flash')).toEqual({
      id: 'gemini-2.5-flash',
      version: '2.5',
      variant: 'flash',
    })
  })

  it.each([
    'gemini-2.5-flash-001', // revision suffix
    'gemini-flash-latest', // alias
    'gemini-2.5-flash-image',
    'gemini-2.5-flash-preview-9-2025',
    'gemini-2.5-flash-preview-09-25',
    'gemini-2.5-flash-preview-09',
    'gemini-2.-flash',
    'gemini-.5-flash',
    'gemini-2.5.1-flash',
    'gemini-2.5-ultra',
    'xgemini-2.5-flash',
    ' gemini-2.5-flash',
    'gemini-2.5-flash\n',
    'models/models/gemini-2.5-flash',
    'Models/gemini-2.5-flash',
    'gemma-4-e4b',
    'gemini-2.5-flash-preview-09-2025x',
    '',
  ])('refuses %j', (id) => {
    expect(parseGeminiModelId(id)).toBeNull()
  })

  // `gemini-` + digits + `-flash`: the family pattern has no upper bound on the version digits.
  const geminiOfLength = (length: number): string =>
    `gemini-${'1'.repeat(length - 'gemini--flash'.length)}-flash`

  it('holds a family id to the common 128-character limit (SR-M-1)', () => {
    const atLimit = geminiOfLength(128)
    expect(atLimit).toHaveLength(128)
    expect(parseGeminiModelId(atLimit)?.id).toBe(atLimit)
    expect(parseGeminiModelId(geminiOfLength(129))).toBeNull()
    expect(parseGeminiModelId(`models/${atLimit}`)?.id).toBe(atLimit)
    expect(parseGeminiModelId(`models/${geminiOfLength(129)}`)).toBeNull()
  })

  it('applies the same limit when a stored id is validated (SR-M-1)', () => {
    expect(isValidProviderModelId('gemini', geminiOfLength(128))).toBe(true)
    expect(isValidProviderModelId('gemini', geminiOfLength(129))).toBe(false)
  })
})

describe('isVisionCapable (vision routes research, decision input 1)', () => {
  it.each([
    ['gemini', 'gemini-2.5-flash', true],
    ['gemini', 'gemini-3-pro-preview', true],
    ['gemini', 'gemma-3-27b-it', false],
    ['groq', 'openai/gpt-oss-120b', false],
    ['groq', 'gemini-2.5-flash', false],
  ] as const)('%s %s -> %s', (provider, id, expected) => {
    expect(isVisionCapable(provider, id)).toBe(expected)
  })
})

describe('isValidProviderModelId for cloudflare (@cf/<vendor>/<name>)', () => {
  it.each([
    '@cf/mistralai/mistral-small-3.1-24b-instruct',
    '@cf/openai/gpt-oss-20b',
    '@cf/google/gemma-4-26b-a4b-it',
    '@cf/meta/llama-3.1-8b-instruct-awq',
  ])('accepts %s', (id) => {
    expect(isValidProviderModelId('cloudflare', id)).toBe(true)
  })

  it.each([
    ['no @cf/ prefix', 'mistralai/mistral-small-3.1-24b-instruct'],
    ['another catalogue prefix', '@hf/thebloke/mistral-7b-instruct'],
    ['no vendor', '@cf/mistral-small'],
    ['an extra segment', '@cf/a/b/c'],
    ['an empty vendor', '@cf//name'],
    ['an empty name', '@cf/vendor/'],
    ['a parent segment', '@cf/vendor/..'],
    ['a dotted traversal', '@cf/vendor/a..b'],
    ['an upper-case letter', '@cf/Vendor/name'],
    ['whitespace', '@cf/vendor/na me'],
    ['a query string', '@cf/vendor/name?x=1'],
    ['a trailing newline', '@cf/vendor/name\n'],
    ['a leading dot in the name', '@cf/vendor/.name'],
  ])('refuses %s', (_why, id) => {
    expect(isValidProviderModelId('cloudflare', id)).toBe(false)
  })

  it('caps the length at 128 characters', () => {
    const ofLength = (n: number): string => '@cf/v/' + 'a'.repeat(n - '@cf/v/'.length)
    expect(isValidProviderModelId('cloudflare', ofLength(128))).toBe(true)
    expect(isValidProviderModelId('cloudflare', ofLength(129))).toBe(false)
  })

  it('is anchored at both ends', () => {
    expect(CLOUDFLARE_MODEL_PATTERN.test('x@cf/vendor/name')).toBe(false)
    expect(CLOUDFLARE_MODEL_PATTERN.test('@cf/vendor/name/')).toBe(false)
  })

  it('does not admit a cloudflare id for another provider, or a groq id for cloudflare', () => {
    expect(isValidProviderModelId('groq', '@cf/openai/gpt-oss-20b')).toBe(false)
    expect(isValidProviderModelId('gemini', '@cf/google/gemma-4-26b-a4b-it')).toBe(false)
    expect(isValidProviderModelId('cloudflare', 'openai/gpt-oss-20b')).toBe(false)
  })

  it('is never vision-capable', () => {
    expect(isVisionCapable('cloudflare', '@cf/google/gemma-4-26b-a4b-it')).toBe(false)
  })
})

describe('isValidProviderModelId for openrouter (<author>/<model>:free only, ADR §3.5 check 1)', () => {
  it.each([
    'nvidia/nemotron-3.5-super-vl:free',
    'dots-studio/dots-3-note-preview:free',
    'xingchen-agi/xing4.0-29b-a4b:free',
    'meta-llama/llama-3.3-70b-instruct:free',
  ])('accepts %s', (id) => {
    expect(isValidProviderModelId('openrouter', id)).toBe(true)
  })

  it.each([
    ['no suffix', 'vendor/model-x'],
    [':online (web search)', 'vendor/model-x:online'],
    [':extended', 'vendor/model-x:extended'],
    [':nitro', 'vendor/model-x:nitro'],
    [':floor', 'vendor/model-x:floor'],
    [':thinking', 'vendor/model-x:thinking'],
    ['an unknown suffix', 'vendor/model-x:beta'],
    ['two suffixes', 'meta-llama/llama-3.3-70b-instruct:free:online'],
    ['a suffix after :free', 'vendor/model-x:freely'],
    ['an empty suffix', 'vendor/model-x:'],
    ['the openrouter author (auto)', 'openrouter/auto'],
    ['the openrouter author (free)', 'openrouter/free'],
    ['the openrouter author with :free', 'openrouter/auto:free'],
    ['no author', 'llama-3.3-70b-instruct:free'],
    ['an empty author', '/llama:free'],
    ['an empty model', 'meta-llama/:free'],
    ['an extra segment', 'a/b/c:free'],
    ['a parent segment', 'meta-llama/..:free'],
    ['a dotted traversal', 'meta-llama/a..b:free'],
    ['a leading dot in the author', '.meta/llama:free'],
    ['an upper-case author', 'Meta-Llama/llama:free'],
    ['an upper-case suffix', 'meta-llama/llama:FREE'],
    ['an upper-case openrouter author', 'OpenRouter/auto:free'],
    ['whitespace', 'meta-llama/lla ma:free'],
    ['a query string', 'meta-llama/llama:free?x=1'],
    ['a trailing newline', 'meta-llama/llama:free\n'],
    ['a URL', 'https://openrouter.ai/api/v1:free'],
  ])('refuses %s', (_why, id) => {
    expect(isValidProviderModelId('openrouter', id)).toBe(false)
  })

  it('caps the length at 128 characters', () => {
    const ofLength = (n: number): string => 'a/' + 'b'.repeat(n - 'a/:free'.length) + ':free'
    expect(isValidProviderModelId('openrouter', ofLength(128))).toBe(true)
    expect(isValidProviderModelId('openrouter', ofLength(129))).toBe(false)
  })

  it('is anchored at both ends', () => {
    expect(OPENROUTER_FREE_MODEL_PATTERN.test('x a/b:free')).toBe(false)
    expect(OPENROUTER_FREE_MODEL_PATTERN.test('a/b:free ')).toBe(false)
  })

  it('is never vision-capable', () => {
    expect(isVisionCapable('openrouter', 'nvidia/nemotron-3.5-super-vl:free')).toBe(false)
  })
})

describe('isValidProviderModelId: one rule per provider (SR-L-4)', () => {
  const SAMPLES: Record<ModelProvider, string> = {
    gemini: 'gemini-2.5-flash',
    groq: 'openai/gpt-oss-120b',
    cloudflare: '@cf/openai/gpt-oss-20b',
    openrouter: 'nvidia/nemotron-3.5-super-vl:free',
  }
  const providers = Object.keys(SAMPLES) as ModelProvider[]
  const pairs = providers.flatMap((owner) =>
    providers.filter((other) => other !== owner).map((other) => [owner, other] as const),
  )

  it.each(pairs)('a %s id is refused by the %s rule', (owner, other) => {
    expect(isValidProviderModelId(owner, SAMPLES[owner])).toBe(true)
    expect(isValidProviderModelId(other, SAMPLES[owner])).toBe(false)
  })

  it('refuses a groq id with :free for groq and a groq id without :free for openrouter', () => {
    expect(isValidProviderModelId('groq', 'openai/gpt-oss-120b:free')).toBe(false)
    expect(isValidProviderModelId('openrouter', 'openai/gpt-oss-120b')).toBe(false)
  })
})
