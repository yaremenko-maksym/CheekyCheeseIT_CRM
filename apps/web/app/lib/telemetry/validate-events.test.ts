import { describe, expect, it, vi } from 'vitest'
import type { TelemetryEventDto } from '@crm/shared'
import { buildValidatedEventsBatch } from './validate-events'

function validEvent(overrides: Partial<TelemetryEventDto> = {}): TelemetryEventDto {
  return { event: 'route_enter', route: '/team', ...overrides }
}

describe('buildValidatedEventsBatch', () => {
  it('returns null for an empty input array (nothing to send)', () => {
    expect(buildValidatedEventsBatch([])).toBeNull()
  })

  it('passes through a batch of fully valid events unchanged', () => {
    const events = [validEvent(), validEvent({ event: 'feature_click', target: 'vacancy-create' })]
    expect(buildValidatedEventsBatch(events)).toEqual({ events })
  })

  it('drops an event with an invalid `event` enum value, keeps the valid ones', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const bad = { event: 'not_a_real_event', route: '/team' } as unknown as TelemetryEventDto
    const good = validEvent()
    const result = buildValidatedEventsBatch([bad, good])
    expect(result).toEqual({ events: [good] })
    expect(debugSpy).toHaveBeenCalled()
    debugSpy.mockRestore()
  })

  it('drops an event missing the required `route` field', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const bad = { event: 'route_enter' } as unknown as TelemetryEventDto
    expect(buildValidatedEventsBatch([bad])).toBeNull()
    expect(debugSpy).toHaveBeenCalled()
    debugSpy.mockRestore()
  })

  it('drops an event whose `route` exceeds the schema max length (500)', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const bad = validEvent({ route: '/'.padEnd(501, 'a') })
    expect(buildValidatedEventsBatch([bad])).toBeNull()
    expect(debugSpy).toHaveBeenCalled()
    debugSpy.mockRestore()
  })

  it('returns null when EVERY event in the batch is invalid (never sends an empty batch)', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const bad1 = { event: 'bogus' } as unknown as TelemetryEventDto
    const bad2 = { event: 'also_bogus' } as unknown as TelemetryEventDto
    expect(buildValidatedEventsBatch([bad1, bad2])).toBeNull()
    debugSpy.mockRestore()
  })

  it('never throws — a malformed row is swallowed via safeParse, not an exception', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const veryBad = null as unknown as TelemetryEventDto
    expect(() => buildValidatedEventsBatch([veryBad])).not.toThrow()
    debugSpy.mockRestore()
  })

  it('keeps a valid optional `durationMs` on route_leave events', () => {
    const withOptional = validEvent({ event: 'route_leave', durationMs: 4200 })
    expect(buildValidatedEventsBatch([withOptional])).toEqual({ events: [withOptional] })
  })
})
