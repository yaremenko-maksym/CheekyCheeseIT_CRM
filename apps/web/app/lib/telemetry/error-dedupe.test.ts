import { describe, expect, it } from 'vitest'
import { ErrorDedupe, errorDedupeKey } from './error-dedupe'

describe('errorDedupeKey', () => {
  it('combines source and message', () => {
    expect(errorDedupeKey('Boom', 'WEB')).toBe('WEB::Boom')
  })

  it('caps the key length so a pathological message cannot grow unboundedly', () => {
    const huge = 'x'.repeat(1000)
    expect(errorDedupeKey(huge, 'WEB').length).toBeLessThanOrEqual(300)
  })
})

describe('ErrorDedupe', () => {
  it('sends the first occurrence of a key', () => {
    const dedupe = new ErrorDedupe()
    expect(dedupe.shouldSend('WEB::Boom')).toBe(true)
  })

  it('suppresses a repeat of the SAME key within the session', () => {
    const dedupe = new ErrorDedupe()
    dedupe.shouldSend('WEB::Boom')
    expect(dedupe.shouldSend('WEB::Boom')).toBe(false)
    expect(dedupe.shouldSend('WEB::Boom')).toBe(false)
  })

  it('treats different keys independently', () => {
    const dedupe = new ErrorDedupe()
    expect(dedupe.shouldSend('WEB::Boom')).toBe(true)
    expect(dedupe.shouldSend('WEB::Crash')).toBe(true)
    expect(dedupe.shouldSend('WEB::Boom')).toBe(false)
  })

  it('differentiates by source, not just message', () => {
    const dedupe = new ErrorDedupe()
    expect(dedupe.shouldSend(errorDedupeKey('Boom', 'WEB'))).toBe(true)
    expect(dedupe.shouldSend(errorDedupeKey('Boom', 'API'))).toBe(true)
  })
})
