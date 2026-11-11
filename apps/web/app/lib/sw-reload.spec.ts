import { describe, expect, it, vi } from 'vitest'
import { pollForUpdates, shouldReloadOnControllerChange } from './sw-reload'

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

  // task-ios-file-input-freeze: the iOS photo picker / camera hides and
  // re-shows the page. A pending SW update must not reload (and wipe) a form
  // that is open or an upload that is still in flight at that moment.
  it('returns false on a hidden page while the user is busy (open dialog / write in flight)', () => {
    expect(
      shouldReloadOnControllerChange({
        hadControllerAtLoad: true,
        alreadyReloading: false,
        pageVisible: false,
        userBusy: true,
      }),
    ).toBe(false)
  })

  it('reloads on a hidden page once the user is no longer busy', () => {
    expect(
      shouldReloadOnControllerChange({
        hadControllerAtLoad: true,
        alreadyReloading: false,
        pageVisible: false,
        userBusy: false,
      }),
    ).toBe(true)
  })
})

describe('pollForUpdates', () => {
  it('checks for an update AND re-runs the deferred reload on every tick', async () => {
    vi.useFakeTimers()
    try {
      const update = vi.fn().mockRejectedValue(new Error('offline'))
      const onTick = vi.fn()
      const id = pollForUpdates({ update }, onTick, 60_000)

      await vi.advanceTimersByTimeAsync(59_999)
      expect(update).not.toHaveBeenCalled()
      expect(onTick).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(update).toHaveBeenCalledTimes(1)
      expect(onTick).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(onTick).toHaveBeenCalledTimes(2)
      clearInterval(id)
    } finally {
      vi.useRealTimers()
    }
  })
})
