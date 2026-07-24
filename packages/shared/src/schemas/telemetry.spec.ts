import { describe, expect, it } from 'vitest'
import { reportErrorSchema, telemetryEventSchema, telemetryEventsBatchSchema } from './telemetry'

describe('reportErrorSchema', () => {
  it('accepts a minimal valid error report', () => {
    const result = reportErrorSchema.safeParse({ message: 'Something broke' })
    expect(result.success).toBe(true)
  })

  it('accepts a full error report with stack/route/meta', () => {
    const result = reportErrorSchema.safeParse({
      message: 'TypeError: cannot read x of undefined',
      stack: 'at foo (bundle.js:1:1)\nat bar (bundle.js:2:2)',
      route: '/finance',
      meta: { ua: 'Mozilla/5.0', viewport: '1920x1080', appVersion: '1.2.3' },
    })
    expect(result.success).toBe(true)
  })

  it('rejects an empty message', () => {
    const result = reportErrorSchema.safeParse({ message: '' })
    expect(result.success).toBe(false)
  })

  it('rejects a message over 500 chars', () => {
    const result = reportErrorSchema.safeParse({ message: 'x'.repeat(501) })
    expect(result.success).toBe(false)
  })

  it('rejects a stack over 8000 chars', () => {
    const result = reportErrorSchema.safeParse({ message: 'ok', stack: 'x'.repeat(8001) })
    expect(result.success).toBe(false)
  })

  it('rejects unknown meta keys being required — extra optional fields all omit-able', () => {
    const result = reportErrorSchema.safeParse({ message: 'ok', meta: {} })
    expect(result.success).toBe(true)
  })
})

describe('telemetryEventSchema / telemetryEventsBatchSchema', () => {
  it('accepts a minimal route_enter event', () => {
    const result = telemetryEventSchema.safeParse({ event: 'route_enter', route: '/team' })
    expect(result.success).toBe(true)
  })

  it('accepts a feature_click with target', () => {
    const result = telemetryEventSchema.safeParse({
      event: 'feature_click',
      route: '/vacancies',
      target: 'create-vacancy-button',
    })
    expect(result.success).toBe(true)
  })

  it('accepts route_leave with durationMs', () => {
    const result = telemetryEventSchema.safeParse({
      event: 'route_leave',
      route: '/team',
      durationMs: 4200,
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown event type', () => {
    const result = telemetryEventSchema.safeParse({ event: 'click', route: '/team' })
    expect(result.success).toBe(false)
  })

  it('rejects a negative durationMs', () => {
    const result = telemetryEventSchema.safeParse({
      event: 'route_leave',
      route: '/team',
      durationMs: -1,
    })
    expect(result.success).toBe(false)
  })

  it('rejects an empty route', () => {
    const result = telemetryEventSchema.safeParse({ event: 'route_enter', route: '' })
    expect(result.success).toBe(false)
  })

  it('accepts a batch of up to 50 events', () => {
    const events = Array.from({ length: 50 }, () => ({ event: 'route_enter', route: '/team' }))
    const result = telemetryEventsBatchSchema.safeParse({ events })
    expect(result.success).toBe(true)
  })

  it('rejects a batch of 51 events', () => {
    const events = Array.from({ length: 51 }, () => ({ event: 'route_enter', route: '/team' }))
    const result = telemetryEventsBatchSchema.safeParse({ events })
    expect(result.success).toBe(false)
  })

  it('rejects an empty batch', () => {
    const result = telemetryEventsBatchSchema.safeParse({ events: [] })
    expect(result.success).toBe(false)
  })
})
