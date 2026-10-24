import { describe, expect, it } from 'vitest'
import { SourceNotReadyError, requireApiKey, resolveMeter, withSecrets } from './quota-provider'

describe('SourceNotReadyError', () => {
  it('carries its name, the source and the variable - and a message with no value', () => {
    const error = new SourceNotReadyError('JOOBLE_API', 'JOOBLE_API_KEY')
    expect(error.name).toBe('SourceNotReadyError')
    expect(error.sourceType).toBe('JOOBLE_API')
    expect(error.envKey).toBe('JOOBLE_API_KEY')
    expect(error.message).toBe('JOOBLE_API: JOOBLE_API_KEY is not configured')
  })
})

describe('requireApiKey', () => {
  it('returns the key of a configured credential', () => {
    expect(
      requireApiKey('REED_API', 'REED_API_KEY', { configured: true, apiKey: 'k', secrets: ['k'] }),
    ).toBe('k')
  })
})

describe('withSecrets', () => {
  it('adds to the worker secrets and leaves the rest of the context as it was', () => {
    const ctx = { secrets: ['a'], marker: 1 } as never
    const out = withSecrets(ctx, ['b', 'c']) as unknown as { secrets: string[]; marker: number }
    expect(out.secrets).toEqual(['a', 'b', 'c'])
    expect(out.marker).toBe(1)
    expect((ctx as unknown as { secrets: string[] }).secrets).toEqual(['a'])
  })
})

describe('resolveMeter', () => {
  it('defaults to one REQUEST, and keeps a valid agreement as given', () => {
    expect(resolveMeter(undefined)).toEqual({ unit: 'REQUEST', amountPerRequest: 1 })
    expect(resolveMeter({ unit: 'RECORD', amountPerRequest: 50 })).toEqual({
      unit: 'RECORD',
      amountPerRequest: 50,
    })
  })

  it('refuses an amount below 1 and one that is not whole', () => {
    expect(() => resolveMeter({ unit: 'REQUEST', amountPerRequest: 0 })).toThrow()
    expect(() => resolveMeter({ unit: 'REQUEST', amountPerRequest: 1.5 })).toThrow()
    expect(resolveMeter({ unit: 'REQUEST', amountPerRequest: 1 }).amountPerRequest).toBe(1)
  })
})
