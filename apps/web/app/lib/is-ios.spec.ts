import { describe, expect, it } from 'vitest'
import { isIosDevice } from './is-ios'

const desktop = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel' }

describe('isIosDevice', () => {
  it('detects iPhone UA', () => {
    expect(
      isIosDevice({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        platform: 'iPhone',
        maxTouchPoints: 5,
      }),
    ).toBe(true)
  })

  it('detects iPad UA and iPod UA', () => {
    expect(
      isIosDevice({ userAgent: 'Mozilla/5.0 (iPad;)', platform: 'iPad', maxTouchPoints: 5 }),
    ).toBe(true)
    expect(
      isIosDevice({ userAgent: 'Mozilla/5.0 (iPod touch;)', platform: 'x', maxTouchPoints: 0 }),
    ).toBe(true)
  })

  it('detects iPadOS desktop-class UA via MacIntel + multi-touch', () => {
    expect(isIosDevice({ ...desktop, maxTouchPoints: 5 })).toBe(true)
  })

  it('is false for a real Mac (no multi-touch)', () => {
    expect(isIosDevice({ ...desktop, maxTouchPoints: 0 })).toBe(false)
    expect(isIosDevice({ ...desktop, maxTouchPoints: 1 })).toBe(false)
  })

  it('is false for Android and Windows', () => {
    expect(
      isIosDevice({
        userAgent: 'Mozilla/5.0 (Linux; Android 14)',
        platform: 'Linux armv8l',
        maxTouchPoints: 5,
      }),
    ).toBe(false)
    expect(
      isIosDevice({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
        platform: 'Win32',
        maxTouchPoints: 10,
      }),
    ).toBe(false)
  })
})
