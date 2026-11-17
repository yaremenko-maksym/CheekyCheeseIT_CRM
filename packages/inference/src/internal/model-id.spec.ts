import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_MODEL_PATTERN,
  isValidProviderModelId,
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
