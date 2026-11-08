import { describe, expect, it } from 'vitest'
import { shouldReloadOnControllerChange } from './sw-reload'

describe('shouldReloadOnControllerChange', () => {
  it('returns false on first-ever SW install (no controller at load)', () => {
    expect(
      shouldReloadOnControllerChange({
        hadControllerAtLoad: false,
        alreadyReloading: false,
        pageVisible: false,
      }),
    ).toBe(false)
  })

  it('returns true when a new SW takes over an already-controlled, hidden page', () => {
    expect(
      shouldReloadOnControllerChange({
        hadControllerAtLoad: true,
        alreadyReloading: false,
        pageVisible: false,
      }),
    ).toBe(true)
  })

  it('returns false on double-fire to prevent reload loop', () => {
    expect(
      shouldReloadOnControllerChange({
        hadControllerAtLoad: true,
        alreadyReloading: true,
        pageVisible: false,
      }),
    ).toBe(false)
  })

  it('returns false when no controller and already reloading (edge case)', () => {
    expect(
      shouldReloadOnControllerChange({
        hadControllerAtLoad: false,
        alreadyReloading: true,
        pageVisible: false,
      }),
    ).toBe(false)
  })

  it('returns false while the page is visible (reload must not interrupt use)', () => {
    expect(
      shouldReloadOnControllerChange({
        hadControllerAtLoad: true,
        alreadyReloading: false,
        pageVisible: true,
      }),
    ).toBe(false)
  })
})
