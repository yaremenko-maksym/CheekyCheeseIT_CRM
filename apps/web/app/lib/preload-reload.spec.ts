import { describe, expect, it } from 'vitest'
import {
  decidePreloadReload,
  PRELOAD_RELOAD_MAX,
  PRELOAD_RELOAD_THROTTLE_MS,
} from './preload-reload'

const NOW = 1_000_000

describe('decidePreloadReload', () => {
  it('reloads on the first error (no prior state)', () => {
    expect(decidePreloadReload(NOW, { last: 0, count: 0 })).toEqual({
      shouldReload: true,
      nextCount: 1,
    })
  })

  it('throttles a second error inside the window without reloading', () => {
    const result = decidePreloadReload(NOW, {
      last: NOW - (PRELOAD_RELOAD_THROTTLE_MS - 1),
      count: 1,
    })
    expect(result).toEqual({ shouldReload: false, nextCount: 1 })
  })

  it('allows a reload once the throttle window has elapsed', () => {
    const result = decidePreloadReload(NOW, {
      last: NOW - PRELOAD_RELOAD_THROTTLE_MS,
      count: 1,
    })
    expect(result).toEqual({ shouldReload: true, nextCount: 2 })
  })

  it('increments the counter on each accepted reload', () => {
    expect(decidePreloadReload(NOW, { last: 0, count: 0 }).nextCount).toBe(1)
    expect(decidePreloadReload(NOW, { last: 0, count: 1 }).nextCount).toBe(2)
    expect(decidePreloadReload(NOW, { last: 0, count: 2 }).nextCount).toBe(3)
  })

  it('reloads while count is below the cap', () => {
    const result = decidePreloadReload(NOW, {
      last: 0,
      count: PRELOAD_RELOAD_MAX - 1,
    })
    expect(result).toEqual({ shouldReload: true, nextCount: PRELOAD_RELOAD_MAX })
  })

  it('gives up once the cap is reached, even when the throttle would allow it', () => {
    const result = decidePreloadReload(NOW, {
      last: 0,
      count: PRELOAD_RELOAD_MAX,
    })
    expect(result).toEqual({
      shouldReload: false,
      nextCount: PRELOAD_RELOAD_MAX,
    })
  })

  it('keeps the counter untouched when throttled, regardless of the cap', () => {
    const result = decidePreloadReload(NOW, {
      last: NOW - 1,
      count: PRELOAD_RELOAD_MAX + 5,
    })
    expect(result).toEqual({
      shouldReload: false,
      nextCount: PRELOAD_RELOAD_MAX + 5,
    })
  })

  it('honours custom throttle and max options', () => {
    expect(decidePreloadReload(NOW, { last: NOW - 50, count: 0 }, { throttleMs: 100 })).toEqual({
      shouldReload: false,
      nextCount: 0,
    })
    expect(decidePreloadReload(NOW, { last: 0, count: 1 }, { max: 1 })).toEqual({
      shouldReload: false,
      nextCount: 1,
    })
  })
})
