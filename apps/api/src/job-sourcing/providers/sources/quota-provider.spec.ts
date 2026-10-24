import { describe, expect, it } from 'vitest'
import { MIN_API_CREDENTIAL_CHARS } from '../../../config/env'
import { MIN_REDACTABLE_SECRET_CHARS, redactSecrets } from '../reporting-provider'
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
    const ctx = { secrets: ['aa'], marker: 1 } as never
    const out = withSecrets(ctx, ['bb', 'cc']) as unknown as { secrets: string[]; marker: number }
    expect(out.secrets).toEqual(['aa', 'bb', 'cc'])
    expect(out.marker).toBe(1)
    expect((ctx as unknown as { secrets: string[] }).secrets).toEqual(['aa'])
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

/** R2-SR-L-1: the precondition fails loudly where the filter lives, and the two floors cannot drift. */
describe('the redactable-secret floor', () => {
  it('is 2: a one-character secret has no usable form', () => {
    expect(MIN_REDACTABLE_SECRET_CHARS).toBe(2)
  })

  it('a 2-character secret IS redacted (AT the floor), a 1-character one is reported verbatim', () => {
    expect(redactSecrets('key=ab here', ['ab'])).toBe('key=[REDACTED] here')
    expect(redactSecrets('key=Z here', ['Z'])).toBe('key=Z here')
  })

  it('registering a secret below the floor throws, naming a length and never the value', () => {
    const ctx = { secrets: [] } as never
    expect(() => withSecrets(ctx, ['Z'])).toThrow(
      'a secret of 1 character(s) cannot be redacted (minimum 2)',
    )
    expect(() => withSecrets(ctx, ['ok-long-enough', ''])).toThrow(
      'a secret of 0 character(s) cannot be redacted (minimum 2)',
    )
    expect(() => withSecrets(ctx, ['ab'])).not.toThrow()
  })

  it('the env boundary floor can never sit beneath the redactor floor', () => {
    expect(MIN_API_CREDENTIAL_CHARS).toBeGreaterThanOrEqual(MIN_REDACTABLE_SECRET_CHARS)
  })
})
